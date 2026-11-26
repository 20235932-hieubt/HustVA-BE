import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { readDemoConfig } from './demo-config.js';
import {
  accountSchema,
  loadDemoAccounts,
  normalizeUsername,
} from './demo-accounts.js';
import { hashPassword } from './password.js';

// Password is accepted only from an interactive hidden prompt, never argv.
async function hiddenPassword(): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('INTERACTIVE_TERMINAL_REQUIRED');
  process.stdout.write('Demo password (minimum 12 characters): ');
  process.stdin.setRawMode(true);
  process.stdin.resume();
  try {
    return await new Promise((resolve, reject) => {
      let value = '';
      const onData = (chunk: Buffer) => {
        for (const ch of chunk.toString()) {
          if (ch === '\u0003' || ch === '\r' || ch === '\n') {
            process.stdin.off('data', onData);
            if (ch === '\u0003') reject(new Error('CANCELLED'));
            else resolve(value);
            return;
          }
          if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
          else if (ch >= ' ') value += ch;
        }
      };
      process.stdin.on('data', onData);
    });
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write('\n');
  }
}
async function main() {
  const config = readDemoConfig();
  const prompt = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  const username = normalizeUsername(await prompt.question('Demo username: '));
  const studentId = (await prompt.question('Approved student ID: ')).trim();
  prompt.close();
  const password = await hiddenPassword();
  if (password.length < 12 || password.length > 256)
    throw new Error('PASSWORD_LENGTH_INVALID');
  const account = accountSchema.parse({
    accountId: randomUUID(),
    username,
    studentId,
    passwordHash: await hashPassword(password),
    enabled: true,
  });
  let accounts = [] as Awaited<ReturnType<typeof loadDemoAccounts>>['accounts'];
  try {
    await readFile(config.accountsFile);
    accounts = (await loadDemoAccounts(config.accountsFile)).accounts;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  if (accounts.some((a) => a.username === username))
    throw new Error('USERNAME_EXISTS');
  await mkdir(dirname(config.accountsFile), { recursive: true });
  await writeFile(
    config.accountsFile,
    JSON.stringify([...accounts, account], null, 2),
    { mode: 0o600 },
  );
  console.log('Demo account saved. Restart the backend to load the mapping.');
}
void main().catch(() => {
  console.error('DEMO_ACCOUNT_CREATION_FAILED');
  process.exitCode = 1;
});
