import { describe, expect, it } from 'vitest';
import { VectorAmpClient } from '../src/client.js';

function json(body: unknown, init: ResponseInit = {}) { return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init }); }

describe('VectorAmpClient', () => {
  it('sends auth, prefix, and SABLE dataset creation', async () => {
    const calls: any[] = [];
    const fetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return json({ id: 'ds_1' }); }) as typeof globalThis.fetch;
    const client = new VectorAmpClient({ apiKey: 'k', baseUrl: 'https://api.example.com', apiPrefix: '' }, fetch);
    await client.createDataset({ name: 'docs', dimension: 1536, indexType: 'hnsw' });
    expect(calls[0].url).toBe('https://api.example.com/datasets');
    expect(new Headers(calls[0].init.headers).get('X-API-Key')).toBe('k');
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({ name: 'docs', dimension: 1536, index_type: 'sable' });
  });

  it('normalizes text search requests', async () => {
    const calls: any[] = [];
    const fetch = (async (_url: string, init: RequestInit) => { calls.push(init); return json({ results: [] }); }) as typeof globalThis.fetch;
    const client = new VectorAmpClient({ baseUrl: 'https://api.example.com', apiPrefix: '' }, fetch);
    await client.search('ds', { queryText: 'hello', topK: 3 });
    expect(JSON.parse(calls[0].body as string)).toEqual({ query_text: 'hello', top_k: 3 });
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

  it('uses the public intelligence query payload and stream endpoint', async () => {
    const calls: any[] = [];
    const fetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return json({ answer: 'ok' }); }) as typeof globalThis.fetch;
    const client = new VectorAmpClient({ baseUrl: 'https://api.example.com', apiPrefix: '' }, fetch);
    await client.ask({ query: 'dogs', datasetId: 'ds_1', includeSources: true, stream: false });
    expect(calls[0].url).toBe('https://api.example.com/intelligence/query');
    expect(JSON.parse(calls[0].init.body as string)).toEqual({ query: 'dogs', dataset_id: 'ds_1', include_sources: true, stream: false });
  });
});
