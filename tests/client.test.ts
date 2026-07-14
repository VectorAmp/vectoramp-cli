import { describe, expect, it } from 'vitest';
import { VectorAmpClient } from '../src/client.js';
import { confluenceSource } from '../src/sources.js';

function json(body: unknown, init: ResponseInit = {}) { return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init }); }

describe('VectorAmpClient', () => {
  it('sends auth, prefix, and SABLE dataset creation with dim (not dimension)', async () => {
    const calls: any[] = [];
    const fetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return json({ id: 'ds_1' }); }) as typeof globalThis.fetch;
    const client = new VectorAmpClient({ apiKey: 'k', baseUrl: 'https://api.example.com', apiPrefix: '' }, fetch);
    // Caller passes dimension and an index type; both are normalized away.
    await client.createDataset({ name: 'docs', dimension: 1536, indexType: 'hnsw' });
    expect(calls[0].url).toBe('https://api.example.com/datasets');
    expect(new Headers(calls[0].init.headers).get('X-API-Key')).toBe('k');
    const body = JSON.parse(calls[0].init.body as string);
    expect(body).toMatchObject({ name: 'docs', dim: 1536, index_type: 'sable' });
    // The deprecated `dimension` field and the caller's index type are never sent.
    expect(body.dimension).toBeUndefined();
    expect(body.index_type).toBe('sable');
  });

  it('supports minimal (name only) and hybrid dataset creation', async () => {
    const calls: any[] = [];
    const fetch = (async (_url: string, init: RequestInit) => { calls.push(init); return json({ id: 'ds_1' }); }) as typeof globalThis.fetch;
    const client = new VectorAmpClient({ baseUrl: 'https://api.example.com', apiPrefix: '' }, fetch);
    await client.createDataset({ name: 'docs' });
    expect(JSON.parse(calls[0].body as string)).toEqual({ name: 'docs', index_type: 'sable' });
    await client.createDataset({ name: 'docs', dim: 2560, hybrid: true });
    expect(JSON.parse(calls[1].body as string)).toMatchObject({ name: 'docs', dim: 2560, hybrid: true, index_type: 'sable' });
  });

  it('deletes vectors preserving numeric ids as JSON numbers', async () => {
    const calls: any[] = [];
    const fetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return json({ deleted: 2 }); }) as typeof globalThis.fetch;
    const client = new VectorAmpClient({ baseUrl: 'https://api.example.com', apiPrefix: '' }, fetch);
    await client.deleteVectors('ds', [42, 'doc-7'], { writeConcern: 'quorum' });
    expect(calls[0].url).toBe('https://api.example.com/datasets/ds/vectors');
    expect(calls[0].init.method).toBe('DELETE');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ ids: [42, 'doc-7'], write_concern: 'quorum' });
  });

  it('saves an OpenAI org secret before creating a dataset when requested', async () => {
    const calls: any[] = [];
    const fetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return json({ id: 'ds_1' }); }) as typeof globalThis.fetch;
    const client = new VectorAmpClient({ baseUrl: 'https://api.example.com', apiPrefix: '' }, fetch);
    await client.createDatasetWithOpenAISecret({ apiKey: 'sk-test', secretRef: 'emb:openai:api_key', dataset: { name: 'docs', dim: 1536, embedding: { model: 'text-embedding-3-small' } } });
    expect(calls[0].url).toBe('https://api.example.com/org-secrets/emb%3Aopenai%3Aapi_key');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ value: 'sk-test' });
    expect(calls[1].url).toBe('https://api.example.com/datasets');
    expect(JSON.parse(calls[1].init.body as string)).toMatchObject({ name: 'docs', dim: 1536, embedding: { provider: 'openai', model: 'text-embedding-3-small', secret_ref: 'emb:openai:api_key' }, index_type: 'sable' });
  });

  it('inserts raw vectors preserving numeric ids as JSON numbers', async () => {
    const calls: any[] = [];
    const fetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return json({ inserted: 2 }); }) as typeof globalThis.fetch;
    const client = new VectorAmpClient({ baseUrl: 'https://api.example.com', apiPrefix: '' }, fetch);
    await client.insert('ds', [
      { id: 42, values: [0.1, 0.2], metadata: { k: 'v' } },
      { id: 'doc-7', vector: [0.3, 0.4] },
    ]);
    expect(calls[0].url).toBe('https://api.example.com/datasets/ds/insert');
    const raw = calls[0].init.body as string;
    // The numeric id must be serialized as a JSON number, not a quoted string.
    expect(raw).toContain('"id":42');
    expect(raw).not.toContain('"id":"42"');
    const body = JSON.parse(raw);
    expect(body.vectors[0]).toEqual({ id: 42, values: [0.1, 0.2], metadata: { k: 'v' } });
    expect(body.vectors[1]).toEqual({ id: 'doc-7', values: [0.3, 0.4] });
    expect(typeof body.vectors[0].id).toBe('number');
  });

  it('searches with filters, hybrid sparse query, and rerank expansion', async () => {
    const calls: any[] = [];
    const fetch = (async (_url: string, init: RequestInit) => { calls.push(init); return json({ results: [] }); }) as typeof globalThis.fetch;
    const client = new VectorAmpClient({ baseUrl: 'https://api.example.com', apiPrefix: '' }, fetch);
    await client.search('ds', 'refunds', { filters: { source_type: 'web', priority: 2, sourceType: 'crawler' }, hybrid: true, sparseQuery: 'refund', alpha: 0.5, rerank: true });
    const body = JSON.parse(calls[0].body as string);
    expect(body).toMatchObject({
      query_text: 'refunds',
      top_k: 10,
      advanced_filters: [
        { field: 'source_type', op: 'eq', value: 'web' },
        { field: 'priority', op: 'eq', value: 2 },
        { field: 'sourceType', op: 'eq', value: 'crawler' },
      ],
      hybrid: true,
      sparse_query: 'refund',
      alpha: 0.5,
      rerank: { enabled: true, provider: 'vectoramp', model: 'VectorAmp-Rerank-v1' },
    });
  });

  it('searches by a raw float vector', async () => {
    const calls: any[] = [];
    const fetch = (async (_url: string, init: RequestInit) => { calls.push(init); return json({ results: [] }); }) as typeof globalThis.fetch;
    const client = new VectorAmpClient({ baseUrl: 'https://api.example.com', apiPrefix: '' }, fetch);
    await client.search('ds', [0.1, 0.2, 0.3], { topK: 3 });
    expect(JSON.parse(calls[0].body as string)).toEqual({ query: [0.1, 0.2, 0.3], top_k: 3 });
  });

  it('normalizes text search requests', async () => {
    const calls: any[] = [];
    const fetch = (async (_url: string, init: RequestInit) => { calls.push(init); return json({ results: [] }); }) as typeof globalThis.fetch;
    const client = new VectorAmpClient({ baseUrl: 'https://api.example.com', apiPrefix: '' }, fetch);
    await client.search('ds', { queryText: 'hello', topK: 3, rerank: { enabled: true } });
    expect(JSON.parse(calls[0].body as string)).toEqual({ query_text: 'hello', top_k: 3, rerank: { enabled: true } });
  });


  it('lists and downloads dataset documents with cursor params and raw bytes', async () => {
    const calls: any[] = [];
    const bytes = new Uint8Array([0, 1, 255, 86, 65]);
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/download')) return new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
      return json({ documents: [{ id: 'doc_1', file_name: 'a.pdf', download_available: true }], next_cursor: 'cur2', limit: 2 });
    }) as typeof globalThis.fetch;
    const client = new VectorAmpClient({ apiKey: 'k', baseUrl: 'https://api.example.com', apiPrefix: '' }, fetch);

    const page = await client.listDocuments('ds', { limit: 2, cursor: 'cur1', status: 'ready' });
    const body = await client.downloadDocument('ds', 'doc_1');

    expect(page).toMatchObject({ next_cursor: 'cur2' });
    expect(calls[0].url).toBe('https://api.example.com/datasets/ds/documents?limit=2&cursor=cur1&status=ready');
    expect(calls[1].url).toBe('https://api.example.com/datasets/ds/documents/doc_1/download');
    expect(new Headers(calls[1].init.headers).get('Accept')).toBe('*/*');
    expect(Array.from(new Uint8Array(body))).toEqual(Array.from(bytes));
  });

  it('parses api errors', async () => {
    const fetch = (async () => new Response(JSON.stringify({ error: 'nope' }), { status: 401, statusText: 'Unauthorized' })) as typeof globalThis.fetch;
    const client = new VectorAmpClient({ baseUrl: 'https://api.example.com', apiPrefix: '' }, fetch);
    await expect(client.listDatasets()).rejects.toThrow('nope');
  });

  it('formats structured api validation errors without object stringification', async () => {
    const fetch = (async () => new Response(JSON.stringify({ detail: [{ loc: ['body', 'query'], msg: 'Field required' }] }), { status: 422, statusText: 'Unprocessable Entity' })) as typeof globalThis.fetch;
    const client = new VectorAmpClient({ baseUrl: 'https://api.example.com', apiPrefix: '' }, fetch);
    await expect(client.ask({ question: 'dogs' })).rejects.toThrow('body.query: Field required');
  });

  it('uses the public intelligence query payload with RAG defaults', async () => {
    const calls: any[] = [];
    const fetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return json({ answer: 'ok' }); }) as typeof globalThis.fetch;
    const client = new VectorAmpClient({ baseUrl: 'https://api.example.com', apiPrefix: '' }, fetch);
    await client.ask({ query: 'dogs', datasetId: 'ds_1' });
    expect(calls[0].url).toBe('https://api.example.com/intelligence/query');
    // Defaults: include_sources true, top_k 5, stream false.
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ query: 'dogs', dataset_id: 'ds_1', include_sources: true, top_k: 5, stream: false });
  });

  it('defaults the RAG dataset to "all" when unscoped', async () => {
    const calls: any[] = [];
    const fetch = (async (_url: string, init: RequestInit) => { calls.push(init); return json({ answer: 'ok' }); }) as typeof globalThis.fetch;
    const client = new VectorAmpClient({ baseUrl: 'https://api.example.com', apiPrefix: '' }, fetch);
    await client.ask({ query: 'dogs' });
    expect(JSON.parse(calls[0].body as string)).toMatchObject({ query: 'dogs', dataset_id: 'all' });
  });

  it('embeds then inserts when adding texts, copying source text into metadata.text', async () => {
    const calls: any[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith('/embed')) return json({ embeddings: [[0.1], [0.2]] });
      return json({ inserted: 2 });
    }) as typeof globalThis.fetch;
    const client = new VectorAmpClient({ baseUrl: 'https://api.example.com', apiPrefix: '' }, fetch);
    await client.addTexts('ds', ['first', 'second'], { source: 'docs' });
    expect(calls[0].url).toBe('https://api.example.com/datasets/ds/embed');
    expect(calls[1].url).toBe('https://api.example.com/datasets/ds/insert');
    const inserted = JSON.parse(calls[1].init.body as string);
    expect(inserted.vectors).toEqual([
      { id: 'text-1', values: [0.1], metadata: { source: 'docs', text: 'first' } },
      { id: 'text-2', values: [0.2], metadata: { source: 'docs', text: 'second' } },
    ]);
  });

  it('ingestSource creates a source then starts a real /ingestion/jobs job', async () => {
    const calls: any[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method, body: init.body });
      if (url.endsWith('/ingestion/sources')) return json({ id: 'src_99' }, { status: 201 });
      return json({ job_id: 'job_1', status: 'pending' });
    }) as typeof globalThis.fetch;
    const client = new VectorAmpClient({ baseUrl: 'https://api.example.com', apiPrefix: '' }, fetch);
    await client.ingestSource('ds_1', confluenceSourceInput());
    expect(calls[0].url).toBe('https://api.example.com/ingestion/sources');
    expect(JSON.parse(calls[0].body as string)).toMatchObject({ source_type: 'confluence', config: { cloud_id: 'cid-1' } });
    expect(calls[1].url).toBe('https://api.example.com/ingestion/jobs');
    expect(JSON.parse(calls[1].body as string)).toEqual({ source_id: 'src_99', dataset_id: 'ds_1' });
    // Never hits the old phantom dataset-scoped ingestion path.
    expect(calls.some((c) => String(c.url).includes('/ingestions/'))).toBe(false);
  });

  it('ingestFiles runs the presigned upload flow and returns the upload job (no separate job start)', async () => {
    const calls: any[] = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method, body: init.body });
      if (url.endsWith('/ingestion/sources')) return json({ id: 'src_up' }, { status: 201 });
      if (url.endsWith('/upload/init')) return json({ job_id: 'up_1', uploads: [{ file_id: 'f1', upload_url: 'https://s3.example.com/put/f1' }] });
      if (url.includes('s3.example.com')) return new Response(null, { status: 200 });
      if (url.endsWith('/upload/complete')) return json({ ok: true });
      return json({ job_id: 'job_up', status: 'pending' });
    }) as typeof globalThis.fetch;
    const client = new VectorAmpClient({ baseUrl: 'https://api.example.com', apiPrefix: '' }, fetch);
    const result = await client.ingestFiles('ds_1', [{ path: 'a.md', content: '# hello' }], { sourceName: 'docs-upload' });
    // The upload flow already creates/runs the job; we return that job, not a new one.
    expect(result).toMatchObject({ job_id: 'up_1', source_id: 'src_up' });
    const urls = calls.map((c) => c.url);
    expect(urls[0]).toBe('https://api.example.com/ingestion/sources');
    // file_upload source carries metadata.dataset_id so the upload handler finds it.
    expect(JSON.parse(calls[0].body as string)).toMatchObject({ metadata: { dataset_id: 'ds_1' } });
    expect(urls[1]).toBe('https://api.example.com/ingestion/sources/src_up/upload/init');
    expect(urls[2]).toBe('https://s3.example.com/put/f1');
    expect(calls[2].method).toBe('PUT');
    expect(urls[3]).toBe('https://api.example.com/ingestion/sources/src_up/upload/complete');
    expect(JSON.parse(calls[3].body as string)).toEqual({ job_id: 'up_1', file_ids: ['f1'] });
    // No separate /ingestion/jobs start, and no phantom /ingestions/ paths.
    expect(calls.some((c) => String(c.url).endsWith('/ingestion/jobs'))).toBe(false);
    expect(calls.some((c) => String(c.url).includes('/ingestions/'))).toBe(false);
  });

  it('getJob and waitForJob poll until a terminal status', async () => {
    const statuses = ['running', 'running', 'completed'];
    let i = 0;
    const fetch = (async () => json({ job_id: 'job_1', status: statuses[Math.min(i++, statuses.length - 1)] })) as typeof globalThis.fetch;
    const client = new VectorAmpClient({ baseUrl: 'https://api.example.com', apiPrefix: '' }, fetch);
    const job = await client.waitForJob('job_1', { intervalMs: 1, timeoutMs: 1000 });
    expect(job).toMatchObject({ status: 'completed' });
  });
});

function confluenceSourceInput() {
  return confluenceSource({ cloudId: 'cid-1', username: 'u', apiToken: 't', spaces: ['ENG'] });
}
