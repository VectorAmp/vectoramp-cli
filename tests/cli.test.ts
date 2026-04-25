import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProgram } from '../src/commands.js';

let configDir: string;
let logs: string[];

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'vectoramp-cli-'));
  process.env.VECTORAMP_CONFIG = join(configDir, 'config.json');
  logs = [];
  vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => { logs.push(String(msg)); });
});

afterEach(async () => {
  vi.restoreAllMocks();
  delete process.env.VECTORAMP_CONFIG;
  await rm(configDir, { recursive: true, force: true });
});

it('runs dataset list against mock transport', async () => {
  const fetch = (async () => new Response(JSON.stringify({ data: [{ id: 'ds_1' }] }), { headers: { 'content-type': 'application/json' } })) as typeof globalThis.fetch;
  await buildProgram({ fetch }).parseAsync(['node', 'vectoramp', '--base-url', 'https://api.test', 'datasets', 'list']);
  expect(logs.join('\n')).toContain('ds_1');
});

it('stores default dataset via config use', async () => {
  await buildProgram({}).parseAsync(['node', 'vectoramp', 'config', 'use', 'ds_123']);
  expect(logs.join('\n')).toContain('ds_123');
});
