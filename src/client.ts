import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import { joinUrl, toSnakeCasePayload } from './utils.js';
import type { VectorAmpConfig } from './config.js';

export interface RequestOptions { query?: Record<string, unknown>; body?: unknown; headers?: HeadersInit }
export interface StreamEvent { event?: string; data?: unknown; id?: string; retry?: number }
export interface IngestFile { path: string; content: string; metadata?: Record<string, unknown> }

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.mdx', '.json', '.jsonl', '.csv', '.tsv', '.html', '.xml', '.yaml', '.yml']);

export class VectorAmpApiError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: unknown) { super(message); }
}

export class VectorAmpClient {
  constructor(private readonly config: Required<Pick<VectorAmpConfig, 'baseUrl' | 'apiPrefix'>> & VectorAmpConfig, private readonly fetchImpl: typeof fetch = globalThis.fetch) {
    if (!fetchImpl) throw new Error('Node.js 18+ fetch support is required.');
  }

  async request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const url = this.url(path, options.query);
    const headers = new Headers(options.headers);
    headers.set('Accept', 'application/json');
    if (this.config.apiKey) headers.set('X-API-Key', this.config.apiKey);
    if (options.body !== undefined) headers.set('Content-Type', 'application/json');
    const res = await this.fetchImpl(url, { method, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
    if (!res.ok) {
      const body = await parseBody(res);
      throw new VectorAmpApiError(errorMessage(body) ?? `VectorAmp API request failed: ${res.status} ${res.statusText}`, res.status, body);
    }
    if (res.status === 204) return undefined as T;
    return parseBody(res) as Promise<T>;
  }

  async *stream(path: string, body: unknown): AsyncIterable<StreamEvent> {
    const url = this.url(path);
    const headers = new Headers({ Accept: 'text/event-stream', 'Content-Type': 'application/json' });
    if (this.config.apiKey) headers.set('X-API-Key', this.config.apiKey);
    const res = await this.fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const body = await parseBody(res);
      throw new VectorAmpApiError(errorMessage(body) ?? `VectorAmp stream failed: ${res.status} ${res.statusText}`, res.status, body);
    }
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split(/\r?\n\r?\n/);
        buffer = parts.pop() ?? '';
        for (const part of parts) {
          const event = parseSse(part);
          if (event) yield event;
        }
      }
      const event = parseSse(buffer + decoder.decode());
      if (event) yield event;
    } finally { reader.releaseLock(); }
  }

  listDatasets(params: Record<string, unknown> = {}) { return this.request<unknown>('GET', '/datasets', { query: params }); }
  getDataset(id: string) { return this.request<unknown>('GET', `/datasets/${encodeURIComponent(id)}`); }
  createDataset(body: Record<string, unknown>) { return this.request<unknown>('POST', '/datasets', { body: toSnakeCasePayload({ ...body, indexType: 'sable' }) }); }
  deleteDataset(id: string) { return this.request<void>('DELETE', `/datasets/${encodeURIComponent(id)}`); }
  search(id: string, body: Record<string, unknown>) { return this.request<unknown>('POST', `/datasets/${encodeURIComponent(id)}/search`, { body: toSnakeCasePayload(body) }); }
  addTexts(id: string, texts: unknown[], metadata?: Record<string, unknown>) { return this.request<unknown>('POST', `/datasets/${encodeURIComponent(id)}/texts`, { body: toSnakeCasePayload({ texts, metadata }) }); }
  createSource(body: Record<string, unknown>) { return this.request<{ id?: string } & Record<string, unknown>>('POST', '/ingestion/sources', { body: toSnakeCasePayload(body) }); }
  ingestSource(id: string, body: Record<string, unknown>) { return this.request<unknown>('POST', `/datasets/${encodeURIComponent(id)}/ingestions/sources`, { body: toSnakeCasePayload(body) }); }
  ingestFiles(id: string, body: Record<string, unknown>) { return this.request<unknown>('POST', `/datasets/${encodeURIComponent(id)}/ingestions/filesystem`, { body: toSnakeCasePayload(body) }); }
  ask(body: Record<string, unknown>) { return this.request<unknown>('POST', '/intelligence/query', { body: toSnakeCasePayload(body) }); }
  askStream(body: Record<string, unknown>) { return this.stream('/intelligence/query', toSnakeCasePayload({ ...body, stream: true })); }

  private url(path: string, query?: Record<string, unknown>): string {
    const url = new URL(joinUrl(this.config.baseUrl!, this.config.apiPrefix!, path));
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    return url.toString();
  }
}

export async function collectFiles(root: string, options: { extensions?: string[]; maxBytesPerFile?: number; onFile?: (file: IngestFile, count: number) => void } = {}): Promise<IngestFile[]> {
  const allowed = options.extensions ? new Set(options.extensions.map((e) => e.startsWith('.') ? e.toLowerCase() : `.${e.toLowerCase()}`)) : TEXT_EXTENSIONS;
  const maxBytes = options.maxBytesPerFile ?? 1024 * 1024;
  const files: IngestFile[] = [];
  async function walk(path: string): Promise<void> {
    const info = await stat(path);
    if (info.isFile()) return addFile(path, dirnameOf(path));
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const absolute = join(path, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) await addFile(absolute, root);
    }
  }
  async function addFile(absolute: string, base: string): Promise<void> {
    if (!allowed.has(extname(absolute).toLowerCase())) return;
    const info = await stat(absolute);
    if (info.size > maxBytes) return;
    const file = { path: relative(base, absolute) || basename(absolute), content: await readFile(absolute, 'utf8') };
    files.push(file);
    options.onFile?.(file, files.length);
  }
  await walk(root);
  return files;
}

function dirnameOf(path: string): string { return path.slice(0, Math.max(0, path.lastIndexOf('/'))) || process.cwd(); }
async function parseBody(res: Response): Promise<unknown> { const text = await res.text(); if (!text) return undefined; try { return JSON.parse(text); } catch { return text; } }
function errorMessage(body: unknown): string | undefined {
  if (body === undefined || body === null || body === '') return undefined;
  if (typeof body === 'string') return body;
  if (Array.isArray(body)) return body.map(formatErrorValue).filter(Boolean).join('; ') || undefined;
  if (typeof body === 'object') {
    const record = body as Record<string, unknown>;
    for (const key of ['message', 'error', 'detail', 'title']) {
      const formatted = formatErrorValue(record[key]);
      if (formatted) return formatted;
    }
    return formatErrorValue(record);
  }
  return String(body);
}
function formatErrorValue(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(formatErrorValue).filter(Boolean).join('; ') || undefined;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const msg = formatErrorValue(record.msg ?? record.message ?? record.error);
    const loc = Array.isArray(record.loc) ? record.loc.join('.') : formatErrorValue(record.loc);
    if (msg && loc) return `${loc}: ${msg}`;
    if (msg) return msg;
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}
function parseSse(chunk: string): StreamEvent | undefined {
  if (!chunk.trim()) return undefined;
  const data: string[] = []; const event: StreamEvent = {};
  for (const line of chunk.split(/\r?\n/)) {
    const i = line.indexOf(':'); const field = i === -1 ? line : line.slice(0, i); const val = i === -1 ? '' : line.slice(i + 1).replace(/^ /, '');
    if (field === 'data') data.push(val); if (field === 'event') event.event = val; if (field === 'id') event.id = val;
  }
  const payload = data.join('\n');
  return { ...event, data: payload === '[DONE]' ? '[DONE]' : safeJson(payload) };
}
function safeJson(text: string): unknown { if (!text) return undefined; try { return JSON.parse(text); } catch { return text; } }
