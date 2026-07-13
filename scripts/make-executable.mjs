import { chmod } from 'node:fs/promises';

if (process.platform !== 'win32') {
  await Promise.all([
    chmod(new URL('../dist/index.js', import.meta.url), 0o755),
    chmod(new URL('../dist/setup.js', import.meta.url), 0o755),
  ]);
}
