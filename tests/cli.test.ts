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

it('runs dataset document listing with cursor params', async () => {
  const calls: any[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ documents: [{ id: 'doc_1' }], next_cursor: 'cur2' }), { headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  await buildProgram({ fetch }).parseAsync(['node', 'vectoramp', '--base-url', 'https://api.test', 'datasets', 'documents', 'ds_123', '--limit', '2', '--cursor', 'cur1', '--status', 'ready']);
  expect(calls[0].url).toBe('https://api.test/datasets/ds_123/documents?limit=2&cursor=cur1&status=ready');
  expect(logs.join('\n')).toContain('doc_1');
});

it('creates OpenAI embedding datasets with inferred dimension', async () => {
  const calls: any[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: 'ds_openai' }), { headers: { 'content-type': 'application/json' }, status: 201 });
  }) as typeof globalThis.fetch;
  await buildProgram({ fetch }).parseAsync(['node', 'vectoramp', '--base-url', 'https://api.test', 'datasets', 'create', 'docs', '--openai', 'small']);
  expect(JSON.parse(calls[0].init.body as string)).toMatchObject({
    name: 'docs',
    dimension: 1536,
    embedding: { provider: 'openai', model: 'text-embedding-3-small' },
    index_type: 'sable'
  });
});

it('stores default dataset via config use', async () => {
  await buildProgram({}).parseAsync(['node', 'vectoramp', 'config', 'use', 'ds_123']);
  expect(logs.join('\n')).toContain('ds_123');
});


it('runs one-off ask with public intelligence payload', async () => {
  const calls: any[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ answer: 'dogs found' }), { headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  await buildProgram({ fetch }).parseAsync(['node', 'vectoramp', '--base-url', 'https://api.test', '--dataset', 'ds_123', 'ask', 'Do I have any pictures of dogs?']);
  expect(calls[0].url).toBe('https://api.test/intelligence/query');
  expect(JSON.parse(calls[0].init.body as string)).toMatchObject({ query: 'Do I have any pictures of dogs?', dataset_id: 'ds_123', include_sources: true, stream: false });
  expect(logs.join('\n')).toContain('dogs found');
});
