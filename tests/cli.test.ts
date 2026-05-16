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

it('stores default dataset via config use', async () => {
  await buildProgram({}).parseAsync(['node', 'vectoramp', 'config', 'use', 'ds_123']);
  expect(logs.join('\n')).toContain('ds_123');
});


it('manages schedules via list/create/update/delete/trigger commands', async () => {
  const calls: any[] = [];
  const responses = [
    { schedules: [{ id: 'sch_1', cron: '0 * * * *', enabled: true }], total: 1, limit: 10, offset: 0 },
    { id: 'sch_2', cron: '0 0 * * *', enabled: true },
    { id: 'sch_2', enabled: false },
    { deleted: true },
    { job_id: 'job_42' },
  ];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: init?.method, body: init?.body });
    return new Response(JSON.stringify(responses.shift()), { headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;

  await buildProgram({ fetch }).parseAsync([
    'node', 'vectoramp', '--base-url', 'https://api.test',
    'schedules', 'list', '--limit', '10', '--offset', '0'
  ]);
  expect(calls[0].url).toBe('https://api.test/ingestion/schedules?limit=10&offset=0');

  await buildProgram({ fetch }).parseAsync([
    'node', 'vectoramp', '--base-url', 'https://api.test',
    'schedules', 'create',
    '--source-id', 'src_1',
    '--dataset-id', 'ds_1',
    '--cron', '0 0 * * *',
    '--timezone', 'UTC',
  ]);
  expect(calls[1].method).toBe('POST');
  expect(calls[1].url).toBe('https://api.test/ingestion/schedules');
  expect(JSON.parse(calls[1].body as string)).toEqual({
    source_id: 'src_1',
    dataset_id: 'ds_1',
    cron: '0 0 * * *',
    timezone: 'UTC',
  });

  await buildProgram({ fetch }).parseAsync([
    'node', 'vectoramp', '--base-url', 'https://api.test',
    'schedules', 'update', 'sch_2', '--disable'
  ]);
  expect(calls[2].method).toBe('PATCH');
  expect(JSON.parse(calls[2].body as string)).toEqual({ enabled: false });

  await buildProgram({ fetch }).parseAsync([
    'node', 'vectoramp', '--base-url', 'https://api.test',
    'schedules', 'delete', 'sch_2', '--yes'
  ]);
  expect(calls[3].method).toBe('DELETE');

  await buildProgram({ fetch }).parseAsync([
    'node', 'vectoramp', '--base-url', 'https://api.test',
    'schedules', 'trigger', 'sch_1'
  ]);
  expect(calls[4].method).toBe('POST');
  expect(calls[4].url).toBe('https://api.test/ingestion/schedules/sch_1/trigger');
  expect(logs.join('\n')).toContain('job_42');
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
