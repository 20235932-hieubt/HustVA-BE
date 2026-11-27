import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const root = fileURLToPath(new URL('../../', import.meta.url));
const workspace = resolve(root, '..');
const args = process.argv.slice(2).filter((a) => a !== '--');
const env = {
  ...process.env,
  PYTHONUTF8: '1',
  RAGAS_DO_NOT_TRACK: 'true',
  UV_CACHE_DIR: resolve(workspace, '.local/uv-cache'),
  UV_PYTHON_INSTALL_DIR: resolve(workspace, '.local/uv-python'),
  UV_PROJECT_ENVIRONMENT: resolve(workspace, '.local/ragas-venv'),
};
if (!args.includes('--check') && !args.includes('--help')) {
  const build = spawnSync(
    process.execPath,
    ['node_modules/typescript/bin/tsc'],
    { cwd: root, env, stdio: 'inherit' },
  );
  if (build.status !== 0) process.exit(build.status ?? 2);
}
const result = spawnSync(
  'uv',
  [
    'run',
    '--project',
    'services/ragas',
    '--frozen',
    '--python',
    '3.12',
    'hustva-ragas',
    '--backend-root',
    root,
    ...args,
  ],
  { cwd: root, env, stdio: 'inherit' },
);
if (result.error)
  console.error(
    'Cần cài uv và bảo đảm lệnh uv có trong PATH. Xem services/ragas/README.md.',
  );
process.exitCode = result.status ?? 2;
