import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProgram, interactive } from '../src/commands.js';
import { InteractiveTerminal } from '../src/interactive-ui.js';

const stripAnsi = (value: string) => value.replace(/\u001b\[[0-9;]*m/g, '');

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

it('creates OpenAI embedding datasets with inferred dim', async () => {
  const calls: any[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: 'ds_openai' }), { headers: { 'content-type': 'application/json' }, status: 201 });
  }) as typeof globalThis.fetch;
  await buildProgram({ fetch }).parseAsync(['node', 'vectoramp', '--base-url', 'https://api.test', 'datasets', 'create', 'docs', '--openai', 'small']);
  const body = JSON.parse(calls[0].init.body as string);
  expect(body).toMatchObject({
    name: 'docs',
    dim: 1536,
    metric: 'cosine',
    embedding: { provider: 'openai', model: 'text-embedding-3-small' },
    index_type: 'sable'
  });
  // The deprecated `dimension` field is never sent.
  expect(body.dimension).toBeUndefined();
});

it('creates a dataset from a name only with VectorAmp defaults', async () => {
  const calls: any[] = [];
  const fetch = (async (_url: string, init: RequestInit) => { calls.push(init); return new Response(JSON.stringify({ id: 'ds_min' }), { headers: { 'content-type': 'application/json' }, status: 201 }); }) as typeof globalThis.fetch;
  await buildProgram({ fetch }).parseAsync(['node', 'vectoramp', '--base-url', 'https://api.test', 'datasets', 'create', 'docs']);
  expect(JSON.parse(calls[0].body as string)).toMatchObject({
    name: 'docs',
    dim: 2560,
    metric: 'cosine',
    embedding: { provider: 'vectoramp', model: 'VectorAmp-Embedding-4B' },
    index_type: 'sable',
  });
});

it('creates a hybrid dataset with --hybrid', async () => {
  const calls: any[] = [];
  const fetch = (async (_url: string, init: RequestInit) => { calls.push(init); return new Response(JSON.stringify({ id: 'ds_h' }), { headers: { 'content-type': 'application/json' }, status: 201 }); }) as typeof globalThis.fetch;
  await buildProgram({ fetch }).parseAsync(['node', 'vectoramp', '--base-url', 'https://api.test', 'datasets', 'create', 'docs', '--hybrid', '--dim', '768', '--metric', 'dot']);
  expect(JSON.parse(calls[0].body as string)).toMatchObject({ name: 'docs', dim: 768, metric: 'dot', hybrid: true, index_type: 'sable' });
});

it('requires --dim for custom embedding models', async () => {
  const fetch = (async () => new Response('{}', { headers: { 'content-type': 'application/json' } })) as typeof globalThis.fetch;
  await expect(
    buildProgram({ fetch }).parseAsync(['node', 'vectoramp', '--base-url', 'https://api.test', 'datasets', 'create', 'docs', '--embedding-provider', 'cohere', '--embedding-model', 'embed-v3'])
  ).rejects.toThrow(/dimension required/i);
});

it('inserts raw vectors with a numeric id preserved as a number', async () => {
  const calls: any[] = [];
  const fetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify({ inserted: 1 }), { headers: { 'content-type': 'application/json' } }); }) as typeof globalThis.fetch;
  await buildProgram({ fetch }).parseAsync(['node', 'vectoramp', '--base-url', 'https://api.test', '--dataset', 'ds_1', 'vectors', 'insert', '--id', '42', '--values', '[0.1,0.2]', '--metadata', '{"k":"v"}']);
  expect(calls[0].url).toBe('https://api.test/datasets/ds_1/insert');
  const raw = calls[0].init.body as string;
  expect(raw).toContain('"id":42');
  expect(raw).not.toContain('"id":"42"');
  expect(JSON.parse(raw)).toEqual({ vectors: [{ id: 42, values: [0.1, 0.2], metadata: { k: 'v' } }] });
});

it('searches with --filter, --sparse hybrid, and --rerank', async () => {
  const calls: any[] = [];
  const fetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify({ results: [] }), { headers: { 'content-type': 'application/json' } }); }) as typeof globalThis.fetch;
  await buildProgram({ fetch }).parseAsync([
    'node', 'vectoramp', '--base-url', 'https://api.test', '--dataset', 'ds_1', 'datasets', 'search', 'refund policy',
    '--filter', 'source_type=web', '--filter', 'priority=2', '--sparse', 'refund', '--alpha', '0.4', '--rerank', '--top-k', '5',
  ]);
  expect(calls[0].url).toBe('https://api.test/datasets/ds_1/search');
  expect(JSON.parse(calls[0].init.body as string)).toMatchObject({
    query_text: 'refund policy',
    top_k: 5,
    advanced_filters: [{ field: 'source_type', op: 'eq', value: 'web' }, { field: 'priority', op: 'eq', value: 2 }],
    hybrid: true,
    sparse_query: 'refund',
    alpha: 0.4,
    rerank: { enabled: true, model: 'VectorAmp-Rerank-v1' },
  });
});

it('searches by a raw vector with --vector and no positional query', async () => {
  const calls: any[] = [];
  const fetch = (async (_url: string, init: RequestInit) => { calls.push(init); return new Response(JSON.stringify({ results: [] }), { headers: { 'content-type': 'application/json' } }); }) as typeof globalThis.fetch;
  // No positional query — `search` must accept a raw vector on its own (regression: the
  // positional was required, which broke `datasets search --vector ...`).
  await buildProgram({ fetch }).parseAsync(['node', 'vectoramp', '--base-url', 'https://api.test', '--dataset', 'ds_1', 'datasets', 'search', '--vector', '[0.1,0.2,0.3]']);
  expect(JSON.parse(calls[0].body as string)).toMatchObject({ query: [0.1, 0.2, 0.3] });
});

it('errors clearly when search has neither a query nor --vector', async () => {
  const fetch = (async () => new Response('{}', { headers: { 'content-type': 'application/json' } })) as typeof globalThis.fetch;
  await expect(
    buildProgram({ fetch }).parseAsync(['node', 'vectoramp', '--base-url', 'https://api.test', '--dataset', 'ds_1', 'datasets', 'search']),
  ).rejects.toThrow(/Provide a text query/);
});

it('lists and downloads documents via the documents subcommands', async () => {
  const calls: any[] = [];
  const bytes = new Uint8Array([1, 2, 3]);
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (String(url).endsWith('/download')) return new Response(bytes, { headers: { 'content-type': 'application/octet-stream' } });
    return new Response(JSON.stringify({ documents: [{ id: 'doc_1' }], next_cursor: 'cur2' }), { headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  const out = join(configDir, 'doc.bin');
  await buildProgram({ fetch }).parseAsync(['node', 'vectoramp', '--base-url', 'https://api.test', 'documents', 'list', 'ds_1', '--limit', '2', '--status', 'ready']);
  expect(calls[0].url).toBe('https://api.test/datasets/ds_1/documents?limit=2&status=ready');
  await buildProgram({ fetch }).parseAsync(['node', 'vectoramp', '--base-url', 'https://api.test', 'documents', 'download', 'ds_1', 'doc_1', '--output', out]);
  expect(calls[1].url).toBe('https://api.test/datasets/ds_1/documents/doc_1/download');
});

it('creates a confluence source with cloud id config', async () => {
  const calls: any[] = [];
  const fetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return new Response(JSON.stringify({ id: 'src_conf' }), { headers: { 'content-type': 'application/json' }, status: 201 }); }) as typeof globalThis.fetch;
  await buildProgram({ fetch }).parseAsync(['node', 'vectoramp', '--base-url', 'https://api.test', 'sources', 'confluence', 'https://acme.atlassian.net', '--config', '{"spaces":["ENG"]}', '--name', 'wiki']);
  expect(calls[0].url).toBe('https://api.test/ingestion/sources');
  expect(JSON.parse(calls[0].init.body as string)).toMatchObject({
    source_type: 'confluence',
    name: 'wiki',
    config: { base_url: 'https://acme.atlassian.net', spaces: ['ENG'] },
  });
});

it('starts ingestion from a source via the real create-source + jobs flow', async () => {
  const calls: any[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (String(url).endsWith('/ingestion/sources')) return new Response(JSON.stringify({ id: 'src_w' }), { headers: { 'content-type': 'application/json' }, status: 201 });
    return new Response(JSON.stringify({ job_id: 'job_1', status: 'pending' }), { headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  await buildProgram({ fetch }).parseAsync(['node', 'vectoramp', '--base-url', 'https://api.test', '--dataset', 'ds_1', 'sources', 'ingest', 'web', 'https://docs.example.com']);
  expect(calls[0].url).toBe('https://api.test/ingestion/sources');
  expect(calls[1].url).toBe('https://api.test/ingestion/jobs');
  expect(JSON.parse(calls[1].init.body as string)).toEqual({ source_id: 'src_w', dataset_id: 'ds_1' });
  expect(calls.some((c) => String(c.url).includes('/ingestions/'))).toBe(false);
});

it('gets a job and polls until terminal with jobs get --poll', async () => {
  const calls: any[] = [];
  const statuses = ['running', 'completed'];
  let i = 0;
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ job_id: 'job_1', status: statuses[Math.min(i++, statuses.length - 1)] }), { headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  await buildProgram({ fetch }).parseAsync(['node', 'vectoramp', '--base-url', 'https://api.test', '--json', 'jobs', 'get', 'job_1', '--poll', '--interval', '1', '--timeout', '1000']);
  expect(calls[0].url).toBe('https://api.test/ingestion/jobs/job_1');
  expect(logs.join('\n')).toContain('completed');
});

it('emits machine-readable JSON without spinner noise under --json', async () => {
  const fetch = (async () => new Response(JSON.stringify({ datasets: [{ id: 'ds_1' }] }), { headers: { 'content-type': 'application/json' } })) as typeof globalThis.fetch;
  await buildProgram({ fetch }).parseAsync(['node', 'vectoramp', '--base-url', 'https://api.test', '--json', 'datasets', 'list']);
  expect(JSON.parse(logs.join('\n'))).toEqual({ datasets: [{ id: 'ds_1' }] });
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
    return new Response(JSON.stringify({ answer: '**Dogs found**\n\n- `photo-1`' }), { headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  await buildProgram({ fetch }).parseAsync(['node', 'vectoramp', '--base-url', 'https://api.test', '--dataset', 'ds_123', 'ask', 'Do I have any pictures of dogs?']);
  expect(calls[0].url).toBe('https://api.test/intelligence/query');
  expect(JSON.parse(calls[0].init.body as string)).toMatchObject({ query: 'Do I have any pictures of dogs?', dataset_id: 'ds_123', include_sources: true, stream: false });
  expect(stripAnsi(logs.join('\n'))).toContain('Dogs found\n\n• photo-1');
});

it('one-off ask forwards --top-k', async () => {
  const calls: any[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ answer: 'ok' }), { headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  await buildProgram({ fetch }).parseAsync(['node', 'vectoramp', '--base-url', 'https://api.test', '--dataset', 'ds_123', 'ask', '--top-k', '12', 'hello?']);
  expect(JSON.parse(calls[0].init.body as string)).toMatchObject({ query: 'hello?', top_k: 12 });
});

it('renders one-off ask markdown for terminals', async () => {
  const fetch = (async () => new Response(JSON.stringify({ answer: '**Summary**\n- use `dogs`\n```txt\nhello\n```' }), { headers: { 'content-type': 'application/json' } })) as typeof globalThis.fetch;
  await buildProgram({ fetch }).parseAsync(['node', 'vectoramp', '--base-url', 'https://api.test', '--dataset', 'ds_123', 'ask', 'format?']);
  const output = logs.join('\n').replace(/\u001b\[[0-9;]*m/g, '');
  expect(output).toContain('Summary');
  expect(output).toContain('• use dogs');
  expect(output).toContain('│ hello');
  expect(output).not.toContain('**Summary**');
  expect(output).not.toContain('```');
});

it('interactive ask renders streamed markdown for terminals before the stream completes', async () => {
  const writes: string[] = [];
  let writesBeforeDone = 0;
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    start(c) {
      c.enqueue(enc.encode('data: {"chunk_type":"text","content":"**Summary**\\n- use `dogs`\\n```txt\\n"}\n\n'));
      setTimeout(() => {
        c.enqueue(enc.encode('data: {"chunk_type":"text","content":"hello\\n```"}\n\n'));
        const finishWhenWritten = (attempt = 0) => {
          if (writes.length > 1 || attempt > 20) {
            writesBeforeDone = writes.length;
            c.enqueue(enc.encode('data: {"chunk_type":"done"}\n\n'));
            c.close();
            return;
          }
          setTimeout(() => finishWhenWritten(attempt + 1), 1);
        };
        finishWhenWritten();
      }, 0);
    }
  });
  const fetch = (async () => new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })) as unknown as typeof globalThis.fetch;

  const lines: (string | undefined)[] = ['format?', undefined];
  let i = 0;
  vi.spyOn(InteractiveTerminal.prototype, 'readLine').mockImplementation(async () => lines[i++]);
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; });

  await interactive({ fetch }, { baseUrl: 'https://api.test', dataset: 'ds_1', history: 10 });

  const output = writes.join('').replace(/\u001b\[[0-9;]*m/g, '');
  expect(writesBeforeDone).toBeGreaterThan(1);
  expect(output).toContain('Summary');
  expect(output).toContain('• use dogs');
  expect(output).toContain('╭─ code · txt ─');
  expect(output).toContain('│ hello');
  expect(output).not.toContain('**Summary**');
  expect(output).not.toContain('`dogs`');
  expect(output).not.toContain('```');
});

it('interactive REPL accumulates and sends multi-turn conversation history', async () => {
  const bodies: any[] = [];
  const sse = (answer: string) => {
    const enc = new TextEncoder();
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(enc.encode(`data: {"chunk_type":"text","content":${JSON.stringify(answer)}}\n\n`));
        c.enqueue(enc.encode('data: {"chunk_type":"done"}\n\n'));
        c.close();
      }
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  let n = 0;
  const fetch = (async (url: string, init: RequestInit) => {
    bodies.push({ url, body: init?.body ? JSON.parse(init.body as string) : null });
    return sse(`answer-${++n}`);
  }) as unknown as typeof globalThis.fetch;

  const lines: (string | undefined)[] = ['first question', 'second question', undefined];
  let i = 0;
  vi.spyOn(InteractiveTerminal.prototype, 'readLine').mockImplementation(async () => lines[i++]);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

  await interactive({ fetch }, { baseUrl: 'https://api.test', dataset: 'ds_1', history: 10 });

  const asks = bodies.filter((b) => String(b.url).endsWith('/intelligence/query'));
  expect(asks).toHaveLength(2);
  // First turn carries no prior history.
  expect(asks[0].body).toMatchObject({ query: 'first question', dataset_id: 'ds_1', stream: true });
  expect(asks[0].body.conversation_history).toBeUndefined();
  // Second turn includes the first user message and the streamed assistant answer.
  expect(asks[1].body).toMatchObject({ query: 'second question', stream: true });
  expect(asks[1].body.conversation_history).toEqual([
    { role: 'user', content: 'first question' },
    { role: 'assistant', content: 'answer-1' }
  ]);
});

it('interactive /use switches the active dataset and resets history before asking', async () => {
  const bodies: any[] = [];
  const sse = (answer: string) => {
    const enc = new TextEncoder();
    const stream = new ReadableStream({ start(c) { c.enqueue(enc.encode(`data: {"chunk_type":"text","content":${JSON.stringify(answer)}}\n\n`)); c.enqueue(enc.encode('data: {"chunk_type":"done"}\n\n')); c.close(); } });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const fetch = (async (url: string, init: RequestInit) => { bodies.push({ url, body: init?.body ? JSON.parse(init.body as string) : null }); return sse('ok'); }) as unknown as typeof globalThis.fetch;

  const lines: (string | undefined)[] = ['/use ds_target', 'after switch?', undefined];
  let i = 0;
  vi.spyOn(InteractiveTerminal.prototype, 'readLine').mockImplementation(async () => lines[i++]);
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

  await interactive({ fetch }, { baseUrl: 'https://api.test', dataset: 'ds_start', history: 10 });

  const asks = bodies.filter((b) => String(b.url).endsWith('/intelligence/query'));
  expect(asks).toHaveLength(1);
  // The question after /use must target the switched dataset, with no leftover history.
  expect(asks[0].body).toMatchObject({ query: 'after switch?', dataset_id: 'ds_target' });
  expect(asks[0].body.conversation_history).toBeUndefined();
});
