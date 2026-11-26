import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { hashPattern } from './password.js';

export const normalizeUsername = (value: string) => value.trim().toLowerCase();
export const accountSchema = z.strictObject({
  accountId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/u),
  username: z.string().trim().min(1).max(100).transform(normalizeUsername),
  passwordHash: z.string().regex(hashPattern),
  studentId: z.string().regex(/^\d{8,9}$/u),
  displayName: z.string().trim().min(1).max(100).optional(),
  enabled: z.boolean(),
});
export type DemoAccount = z.infer<typeof accountSchema>;
export async function loadDemoAccounts(file: string) {
  try {
    const accounts = z
      .array(accountSchema)
      .min(1)
      .max(1000)
      .parse(JSON.parse(await readFile(file, 'utf8')));
    if (
      new Set(accounts.map((a) => a.username)).size !== accounts.length ||
      new Set(accounts.map((a) => a.accountId)).size !== accounts.length
    )
      throw new Error();
    const version = createHash('sha256')
      .update(JSON.stringify(accounts))
      .digest('hex');
    return { accounts, version };
  } catch {
    throw new Error('DEMO_ACCOUNTS_INVALID');
  }
}
