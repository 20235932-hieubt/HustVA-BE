import { resolve } from 'node:path';

export interface ToolConfig {
  partnerUrl?: string;
  partnerToken?: string;
  partnerAuthorization?: string;
  managementToken?: string;
  dataDir: string;
}

export function readToolConfig(
  env: NodeJS.ProcessEnv = process.env,
): ToolConfig {
  function url(key: string) {
    const value = env[key]?.trim();
    if (!value) return undefined;
    const parsed = new URL(value);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw new Error(
        `${key} must be an HTTP(S) URL without credentials, query or fragment.`,
      );
    return parsed.toString();
  }
  return {
    partnerUrl: url('HUST_BASE_API_URL'),
    partnerToken: env.HUST_API_TOKEN,
    partnerAuthorization: env.HUST_AUTHORIZATION_TOKEN,
    managementToken: env.TOOL_MANAGEMENT_TOKEN,
    dataDir: resolve(env.TOOL_DATA_DIR || '.local/tools'),
  };
}
