import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import { findTool, toolCatalog, type ToolDefinition } from './catalog.js';
import { HustClient } from './client.js';
import { readToolConfig, type ToolConfig } from './config.js';
import {
  UpstreamError,
  type ToolResult,
  type ToolSettings,
  type ToolStatus,
} from './contracts.js';

export const settingsPatch = z
  .strictObject({
    enabled: z.boolean().optional(),
    timeoutMs: z.number().int().min(1000).max(120000).optional(),
    retries: z.number().int().min(0).max(2).optional(),
  })
  .refine((value) => Object.keys(value).length > 0);
const storedSettings = z.strictObject({
  version: z.literal(1),
  tools: z.record(
    z.string(),
    z.strictObject({
      enabled: z.boolean(),
      timeoutMs: z.number().int().min(1000).max(120000),
      retries: z.number().int().min(0).max(2),
    }),
  ),
});
interface Metric {
  calls: number;
  active: number;
  durationMs: number;
  statuses: Partial<Record<ToolStatus, number>>;
}
export class ToolManager {
  private client: HustClient;
  private settings: Record<string, ToolSettings> = {};
  private metrics = new Map<string, Metric>();
  private mutations: Promise<unknown> = Promise.resolve();
  private ready: Promise<void>;
  private active = 0;
  constructor(
    private config: ToolConfig = readToolConfig(),
    fetcher: typeof fetch = fetch,
  ) {
    this.client = new HustClient(config, fetcher);
    this.ready = this.load();
    // Lazy routers must not create an unhandled rejection on startup.
    void this.ready.catch(() => undefined);
  }

  private defaults(tool: ToolDefinition): ToolSettings {
    return {
      enabled: tool.defaultEnabled,
      timeoutMs: tool.timeoutMs,
      retries: 1,
    };
  }
  private async load() {
    try {
      const saved = storedSettings.parse(
        JSON.parse(
          await readFile(join(this.config.dataDir, 'settings.json'), 'utf8'),
        ),
      );
      for (const [id, settings] of Object.entries(saved.tools))
        if (findTool(id)) this.settings[id] = settings;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new Error('TOOL_SETTINGS_INVALID');
    }
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(operation);
    this.mutations = next.catch(() => undefined);
    return next;
  }
  private async atomicSave(file: string, data: unknown) {
    await mkdir(this.config.dataDir, { recursive: true });
    const target = join(this.config.dataDir, file);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async list() {
    await this.ready;
    return toolCatalog.map((tool) => ({
      id: tool.id,
      description: tool.description,
      source: tool.source,
      endpoint: tool.endpoint,
      warnings: tool.warnings,
      inputSchema: z.toJSONSchema(tool.schema),
      settings: { ...(this.settings[tool.id] ?? this.defaults(tool)) },
      configured: this.client.configured(),
      metrics: structuredClone(
        this.metrics.get(tool.id) ?? {
          calls: 0,
          active: 0,
          durationMs: 0,
          statuses: {},
        },
      ),
    }));
  }

  async update(id: string, input: unknown) {
    await this.ready;
    const tool = findTool(id);
    if (!tool) return undefined;
    const patch = settingsPatch.parse(input);
    return this.serialize(async () => {
      const settings = {
        ...(this.settings[id] ?? this.defaults(tool)),
        ...patch,
      };
      const next = { ...this.settings, [id]: settings };
      await this.atomicSave('settings.json', { version: 1, tools: next });
      this.settings = next;
      return { ...settings };
    });
  }

  async execute(
    id: string,
    input: unknown,
    callerSignal?: AbortSignal,
  ): Promise<ToolResult> {
    await this.ready;
    const tool = findTool(id);
    const base = (status: ToolStatus, errorCode?: string): ToolResult => ({
      tool: tool?.id ?? 'unknown',
      status,
      data: null,
      warnings: [...(tool?.warnings ?? [])],
      ...(errorCode ? { errorCode } : {}),
    });
    if (!tool) return base('not_found', 'TOOL_NOT_FOUND');
    const parsed = tool.schema.safeParse(input);
    if (!parsed.success)
      return base('invalid_arguments', 'TOOL_ARGUMENTS_INVALID');
    const args = parsed.data;
    const settings = { ...(this.settings[id] ?? this.defaults(tool)) };
    if (!settings.enabled) return base('disabled', 'TOOL_DISABLED');
    if (!this.client.configured())
      return base('not_configured', 'UPSTREAM_NOT_CONFIGURED');
    if (this.active >= 8) return base('busy', 'TOOL_CONCURRENCY_LIMIT');
    const deadline = AbortSignal.timeout(settings.timeoutMs);
    const signal = callerSignal
      ? AbortSignal.any([callerSignal, deadline])
      : deadline;
    const metric = this.metrics.get(id) ?? {
      calls: 0,
      active: 0,
      durationMs: 0,
      statuses: {},
    };
    this.metrics.set(id, metric);
    metric.calls++;
    metric.active++;
    this.active++;
    const started = performance.now();
    let result: ToolResult;
    try {
      signal.throwIfAborted();
      const data = await this.client.call(tool, args, settings.retries, signal);
      result = {
        ...base(
          data == null || (Array.isArray(data) && data.length === 0)
            ? 'empty'
            : 'success',
        ),
        data,
      };
      signal.throwIfAborted();
    } catch (error) {
      result = signal.aborted
        ? base(
            callerSignal?.aborted ? 'cancelled' : 'timeout',
            callerSignal?.aborted ? 'TOOL_CANCELLED' : 'TOOL_TIMEOUT',
          )
        : base(
            'error',
            error instanceof UpstreamError
              ? error.code
              : 'TOOL_EXECUTION_FAILED',
          );
    } finally {
      metric.active--;
      this.active--;
    }
    if (result.status === 'empty')
      result.warnings.push('Chưa có dữ liệu; không suy đoán hoặc bịa số liệu.');
    if (['error', 'timeout'].includes(result.status))
      result.warnings.push('Chưa lấy được dữ liệu từ HUST.');
    result.durationMs = Math.round(performance.now() - started);
    metric.durationMs += result.durationMs;
    metric.statuses[result.status] = (metric.statuses[result.status] ?? 0) + 1;
    return result;
  }
}
