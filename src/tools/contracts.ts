export type ToolStatus =
  | 'success'
  | 'empty'
  | 'error'
  | 'timeout'
  | 'cancelled'
  | 'disabled'
  | 'invalid_arguments'
  | 'not_configured'
  | 'not_found'
  | 'busy';

export interface ToolResult {
  tool: string;
  status: ToolStatus;
  data: unknown;
  warnings: string[];
  errorCode?: string;
  durationMs?: number;
}

export interface ToolSettings {
  enabled: boolean;
  timeoutMs: number;
  retries: number;
}

export class UpstreamError extends Error {
  constructor(
    public code: string,
    public retryable = false,
  ) {
    super(code);
  }
}
