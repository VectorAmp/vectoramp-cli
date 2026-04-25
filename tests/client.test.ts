import { describe, expect, it } from 'vitest';
import { VectorAmpClient } from '../src/client.js';

function json(body: unknown, init: ResponseInit = {}) { return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init }); }

describe('VectorAmpClient', () => {
  it('sends auth, prefix, and SABLE dataset creation', async () => {
    const calls: any[] = [];
    const fetch = (async (url: string, init: RequestInit) => { calls.push({ url, init }); return json({ id: 'ds_1' }); }) as typeof globalThis.fetch;
    const client = new VectorAmpClient({ apiKey: 'k', baseUrl: 'https://api.example.com', apiPrefix: '/api/v1' }, fetch);
    await client.createDataset({ name: 'docs', dimension: 1536, indexType: 'hnsw' });
    expect(calls[0].url).toBe('https://api.example.com/api/v1/datasets');
    expect(new Headers(calls[0].init.headers).get('X-API-Key')).toBe('k');
    expect(JSON.parse(calls[0].init.body as string)).toMatchObject({ name: 'docs', dimension: 1536, index_type: 'sable' });
  });

  it('normalizes text search requests', async () => {
    const calls: any[] = [];
    const fetch = (async (_url: string, init: RequestInit) => { calls.push(init); return json({ results: [] }); }) as typeof globalThis.fetch;
    const client = new VectorAmpClient({ baseUrl: 'https://api.example.com', apiPrefix: '/api/v1' }, fetch);
    await client.search('ds', { queryText: 'hello', topK: 3 });
    expect(JSON.parse(calls[0].body as string)).toEqual({ query_text: 'hello', top_k: 3 });
  });

  it('parses api errors', async () => {
    const fetch = (async () => new Response(JSON.stringify({ error: 'nope' }), { status: 401, statusText: 'Unauthorized' })) as typeof globalThis.fetch;
    const client = new VectorAmpClient({ baseUrl: 'https://api.example.com', apiPrefix: '/api/v1' }, fetch);
    await expect(client.listDatasets()).rejects.toThrow('nope');
  });
});
