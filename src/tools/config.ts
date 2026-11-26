import { resolve } from 'node:path';
import { logger } from '../observability/logger.js';

export interface ToolConfig {
  partnerUrl?: string;
  partnerToken?: string;
  partnerAuthorization?: string;
  managementToken?: string;
  /** MSSV the student-bound tools read. Set only for a demo student; never taken from chat. */
  studentId?: string;
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
  // A malformed MSSV only disables the student tools; the rest of the API keeps running.
  let studentId = env.DEMO_STUDENT_ID?.trim() || undefined;
  if (studentId && !/^\d{8,10}$/u.test(studentId)) {
    logger.warn('tools.config.invalid', {
      errorCode: 'DEMO_STUDENT_ID_INVALID',
    });
    studentId = undefined;
  }
  return {
    partnerUrl: url('HUST_BASE_API_URL'),
    partnerToken: env.HUST_API_TOKEN,
    partnerAuthorization: env.HUST_AUTHORIZATION_TOKEN,
    managementToken: env.TOOL_MANAGEMENT_TOKEN,
    studentId,
    dataDir: resolve(env.TOOL_DATA_DIR || '.local/tools'),
  };
}
