import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const envFile = resolve(process.cwd(), '../../.env');
for (const line of readFileSync(envFile, 'utf8').split(/\r?\n/)) {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
  if (match) delete process.env[match[1]];
}
process.loadEnvFile(envFile);

const next = createRequire(import.meta.url).resolve('next/dist/bin/next');
const port = process.env.WEB_PORT || '3001';
const child = spawn(process.execPath, [next, 'dev', '-p', port, '--webpack'], { stdio: 'inherit', env: process.env });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
