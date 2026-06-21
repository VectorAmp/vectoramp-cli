import { readFile, readdir, stat } from 'node:fs/promises';
import { basename, extname, join, relative } from 'node:path';
import { joinUrl, toSnakeCasePayload } from './utils.js';
import type { VectorAmpConfig } from './config.js';
import { toSourceBody, type SourceDescriptor, type SourceInput } from './sources.js';

export interface RequestOptions { query?: Record<string, unknown>; body?: unknown; headers?: HeadersInit; rawBody?: BodyInit }
export interface DatasetDocumentListParams { limit?: number; cursor?: string; status?: string }
export interface StreamEvent { event?: string; data?: unknown; id?: string; retry?: number }
export interface IngestFile { path: string; content: string; metadata?: Record<string, unknown> }

/** A raw vector record. `id` accepts a string OR a number and is preserved as-is
 * on the wire (numbers serialize as JSON numbers, not strings). */
export interface VectorRecord {
  id?: string | number;
  values?: number[];
  vector?: number[];
  metadata?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SearchOptions {
  topK?: number;
  filters?: Record<string, unknown>;
  advancedFilters?: unknown[];
  includeDocuments?: boolean;
  includeMetadata?: boolean;
  includeEmbeddings?: boolean;
  hybrid?: boolean;
  sparseQuery?: string;
  alpha?: number;
  rerank?: boolean | Record<string, unknown>;
  embeddingProvider?: string;
  embeddingModel?: string;
  [key: string]: unknown;
}

const TEXT_EXTENSIONS = new Set(['.txt', '.md', '.mdx', '.json', '.jsonl', '.csv', '.tsv', '.html', '.xml', '.yaml', '.yml']);
const RERANK_OBJECT = { enabled: true, provider: 'vectoramp', model: 'VectorAmp-Rerank-v1' };

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
    let body: BodyInit | undefined;
    if (options.rawBody !== undefined) body = options.rawBody;
    else if (options.body !== undefined) { headers.set('Content-Type', 'application/json'); body = JSON.stringify(options.body); }
    const res = await this.fetchImpl(url, { method, headers, body });
    if (!res.ok) {
      const errBody = await parseBody(res);
      throw new VectorAmpApiError(errorMessage(errBody) ?? `VectorAmp API request failed: ${res.status} ${res.statusText}`, res.status, errBody);
    }
    if (res.status === 204) return undefined as T;
    return parseBody(res) as Promise<T>;
  }

  /** Download a raw response body. Fetch follows redirects by default, preserving the final object bytes. */
  async download(method: string, path: string, options: RequestOptions = {}): Promise<ArrayBuffer> {
    const url = this.url(path, options.query);
    const headers = new Headers(options.headers);
    headers.set('Accept', '*/*');
    if (this.config.apiKey) headers.set('X-API-Key', this.config.apiKey);
    const res = await this.fetchImpl(url, { method, headers });
    if (!res.ok) {
      const errBody = await parseBody(res);
      throw new VectorAmpApiError(errorMessage(errBody) ?? `VectorAmp API request failed: ${res.status} ${res.statusText}`, res.status, errBody);
    }
    return res.arrayBuffer();
  }

  async *stream(path: string, body: unknown): AsyncIterable<StreamEvent> {
    const url = this.url(path);
    const headers = new Headers({ Accept: 'text/event-stream', 'Content-Type': 'application/json' });
    if (this.config.apiKey) headers.set('X-API-Key', this.config.apiKey);
    const res = await this.fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body) });
    if (!res.ok) {
      const errBody = await parseBody(res);
      throw new VectorAmpApiError(errorMessage(errBody) ?? `VectorAmp stream failed: ${res.status} ${res.statusText}`, res.status, errBody);
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

  // ---- Datasets ------------------------------------------------------------

  listDatasets(params: Record<string, unknown> = {}) { return this.request<unknown>('GET', '/datasets', { query: { ...params } }); }
  getDataset(id: string) { return this.request<unknown>('GET', `/datasets/${encodeURIComponent(id)}`); }

  /** Create a SABLE dataset. The request field is `dim` (not `dimension`), and
   * `index_type` is always forced to "sable" — never accepted from the caller. */
  createDataset(body: Record<string, unknown>) {
    const { dimension, dim, indexType, index_type, ...rest } = body as Record<string, unknown>;
    const payload: Record<string, unknown> = { ...rest };
    const resolvedDim = dim ?? dimension;
    if (resolvedDim !== undefined) payload.dim = resolvedDim;
    payload.indexType = 'sable';
    return this.request<unknown>('POST', '/datasets', { body: toSnakeCasePayload(payload) });
  }

  deleteDataset(id: string) { return this.request<void>('DELETE', `/datasets/${encodeURIComponent(id)}`); }
  stats(id: string) { return this.request<unknown>('GET', `/datasets/${encodeURIComponent(id)}/stats`); }

  /** List retained source documents using cursor pagination; pass next_cursor as cursor for the next page. */
  listDocuments(id: string, params: DatasetDocumentListParams = {}) { return this.request<unknown>('GET', `/datasets/${encodeURIComponent(id)}/documents`, { query: { ...params } }); }
  /** Download retained original document bytes; redirects are followed by fetch. */
  downloadDocument(id: string, documentId: string) { return this.download('GET', `/datasets/${encodeURIComponent(id)}/documents/${encodeURIComponent(documentId)}/download`); }

  /** Semantic / hybrid search. Accepts a bare text query, a float vector, or an
   * explicit options object. `top_k` defaults to 10; `rerank:true` expands to the
   * full rerank object; hybrid accepts `sparse_query`/`alpha`. */
  search(id: string, query: string | number[] | Record<string, unknown>, options: SearchOptions = {}) {
    const body = buildSearchBody(query, options);
    return this.request<unknown>('POST', `/datasets/${encodeURIComponent(id)}/search`, { body: toSnakeCasePayload(body) });
  }

  embed(id: string, input: string | string[], options: Record<string, unknown> = {}) {
    const texts = Array.isArray(input) ? input : [input];
    return this.request<{ embeddings?: number[][]; embedding?: number[]; dim?: number }>('POST', `/datasets/${encodeURIComponent(id)}/embed`, { body: toSnakeCasePayload({ texts, ...options }) });
  }

  /** Insert raw vector records. Numeric ids are preserved as JSON numbers. */
  insert(id: string, vectors: VectorRecord | VectorRecord[]) {
    const list = Array.isArray(vectors) ? vectors : [vectors];
    return this.request<unknown>('POST', `/datasets/${encodeURIComponent(id)}/insert`, { body: { vectors: list.map(normalizeVector) } });
  }
  /** Alias of insert(); both names are part of the locked surface. */
  insertVectors(id: string, vectors: VectorRecord | VectorRecord[]) { return this.insert(id, vectors); }

  /** Embed texts then insert them. Auto-generates ids when omitted and copies the
   * source text into metadata.text. Accepts a single string or a list. */
  async addTexts(id: string, texts: string | unknown[], metadata?: Record<string, unknown> | Record<string, unknown>[], ids?: (string | number)[]) {
    const textList = (Array.isArray(texts) ? texts : [texts]).map((text) => String(text));
    const embedded = await this.embed(id, textList);
    const embeddings = embedded.embeddings ?? (embedded.embedding ? [embedded.embedding] : []);
    if (embeddings.length !== textList.length) throw new Error(`VectorAmp API returned ${embeddings.length} embeddings for ${textList.length} texts`);
    const metaList = Array.isArray(metadata) ? metadata : undefined;
    const sharedMeta = Array.isArray(metadata) ? undefined : metadata;
    const vectors: VectorRecord[] = textList.map((text, index) => ({
      id: ids?.[index] ?? `text-${index + 1}`,
      values: embeddings[index],
      metadata: { ...(sharedMeta ?? {}), ...(metaList?.[index] ?? {}), text },
    }));
    return this.insert(id, vectors);
  }

  // ---- Ingestion sources & jobs -------------------------------------------

  createSource(body: SourceInput) { return this.request<{ id?: string } & Record<string, unknown>>('POST', '/ingestion/sources', { body: toSnakeCasePayload(toSourceBody(body)) }); }
  listSources(params: Record<string, unknown> = {}) { return this.request<unknown>('GET', '/ingestion/sources', { query: { ...params } }); }
  getSource(sourceId: string) { return this.request<unknown>('GET', `/ingestion/sources/${encodeURIComponent(sourceId)}`); }

  startJob(body: { sourceId: string; datasetId: string; pipelineId?: string }) { return this.request<{ job_id?: string } & Record<string, unknown>>('POST', '/ingestion/jobs', { body: toSnakeCasePayload(body) }); }
  listJobs(params: Record<string, unknown> = {}) { return this.request<unknown>('GET', '/ingestion/jobs', { query: { ...params } }); }
  getJob(jobId: string) { return this.request<{ status?: string } & Record<string, unknown>>('GET', `/ingestion/jobs/${encodeURIComponent(jobId)}`); }
  retryJob(jobId: string) { return this.request<unknown>('POST', `/ingestion/jobs/${encodeURIComponent(jobId)}/retry`); }

  /** Poll a job until it reaches a terminal state (completed/failed/cancelled)
   * or the timeout elapses. */
  async waitForJob(jobId: string, options: { intervalMs?: number; timeoutMs?: number; onPoll?: (job: { status?: string } & Record<string, unknown>) => void } = {}): Promise<{ status?: string } & Record<string, unknown>> {
    const interval = options.intervalMs ?? 2000;
    const deadline = Date.now() + (options.timeoutMs ?? 5 * 60_000);
    const terminal = new Set(['completed', 'failed', 'cancelled', 'canceled', 'error']);
    while (true) {
      const job = await this.getJob(jobId);
      options.onPoll?.(job);
      const status = typeof job.status === 'string' ? job.status.toLowerCase() : undefined;
      if (status && terminal.has(status)) return job;
      if (Date.now() + interval > deadline) return job;
      await sleep(interval);
    }
  }

  /** Create the source (from a helper descriptor or string) then start a job that
   * ingests it into the dataset. Replaces the old phantom
   * `/datasets/{id}/ingestions/*` flow. */
  async ingestSource(id: string, src: SourceInput, options: { pipelineId?: string } = {}) {
    const descriptor: SourceDescriptor = toSourceBody(src);
    const source = await this.createSource(descriptor);
    const sourceId = source.id;
    if (!sourceId) throw new Error('Source creation did not return an id.');
    return this.startJob({ sourceId, datasetId: id, pipelineId: options.pipelineId });
  }

  /** Hide the full presigned upload flow: create a `file_upload` source, init the
   * upload, PUT each file's bytes, complete the upload, then start the ingestion
   * job. Accepts already-read IngestFile records. */
  async ingestFiles(id: string, files: IngestFile[], options: { sourceId?: string; sourceName?: string; pipelineId?: string } = {}) {
    if (!files.length) throw new Error('No files to ingest.');
    let sourceId = options.sourceId;
    if (!sourceId) {
      const name = options.sourceName ?? `cli-upload-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '')}`;
      const created = await this.createSource({ sourceType: 'file_upload', name, config: {} });
      sourceId = created.id;
      if (!sourceId) throw new Error('file_upload source creation did not return an id.');
    }
    const init = await this.request<{ job_id?: string; uploads?: Array<{ file_id: string; upload_url: string }> }>(
      'POST', `/ingestion/sources/${encodeURIComponent(sourceId)}/upload/init`,
      { body: { files: files.map((file) => ({ name: file.path, size_bytes: Buffer.byteLength(file.content), content_type: contentType(file.path) })) } },
    );
    const uploads = init.uploads ?? [];
    if (uploads.length !== files.length) throw new Error(`Upload init returned ${uploads.length} slots for ${files.length} files.`);
    for (let i = 0; i < uploads.length; i += 1) {
      const res = await this.fetchImpl(uploads[i].upload_url, { method: 'PUT', headers: { 'Content-Type': contentType(files[i].path) }, body: files[i].content });
      if (!res.ok) throw new VectorAmpApiError(`Upload failed for ${files[i].path}: ${res.status} ${res.statusText}`, res.status);
    }
    await this.request('POST', `/ingestion/sources/${encodeURIComponent(sourceId)}/upload/complete`, { body: { job_id: init.job_id, file_ids: uploads.map((upload) => upload.file_id) } });
    return this.startJob({ sourceId, datasetId: id, pipelineId: options.pipelineId });
  }

  // ---- Schedules -----------------------------------------------------------

  listSchedules(params: Record<string, unknown> = {}) { return this.request<unknown>('GET', '/ingestion/schedules', { query: { ...params } }); }
  getSchedule(scheduleId: string) { return this.request<unknown>('GET', `/ingestion/schedules/${encodeURIComponent(scheduleId)}`); }
  createSchedule(body: Record<string, unknown>) { return this.request<unknown>('POST', '/ingestion/schedules', { body: toSnakeCasePayload(body) }); }
  updateSchedule(scheduleId: string, body: Record<string, unknown>) { return this.request<unknown>('PATCH', `/ingestion/schedules/${encodeURIComponent(scheduleId)}`, { body: toSnakeCasePayload(body) }); }
  deleteSchedule(scheduleId: string) { return this.request<unknown>('DELETE', `/ingestion/schedules/${encodeURIComponent(scheduleId)}`); }
  triggerSchedule(scheduleId: string) { return this.request<unknown>('POST', `/ingestion/schedules/${encodeURIComponent(scheduleId)}/trigger`); }

  // ---- Intelligence --------------------------------------------------------

  /** RAG query. Defaults: top_k 5, include_sources true, dataset "all" when unscoped. */
  ask(body: Record<string, unknown>) { return this.request<unknown>('POST', '/intelligence/query', { body: toSnakeCasePayload(applyAskDefaults(body, false)) }); }
  askStream(body: Record<string, unknown>) { return this.stream('/intelligence/query', toSnakeCasePayload(applyAskDefaults(body, true))); }

  createSession(body: Record<string, unknown> = {}) { return this.request<unknown>('POST', '/intelligence/sessions', { body: toSnakeCasePayload(body) }); }
  listSessions(params: Record<string, unknown> = {}) { return this.request<unknown>('GET', '/intelligence/sessions', { query: { ...params } }); }
  getSession(sessionId: string) { return this.request<unknown>('GET', `/intelligence/sessions/${encodeURIComponent(sessionId)}`); }
  deleteSession(sessionId: string) { return this.request<unknown>('DELETE', `/intelligence/sessions/${encodeURIComponent(sessionId)}`); }
  appendMessage(sessionId: string, body: Record<string, unknown>) { return this.request<unknown>('POST', `/intelligence/sessions/${encodeURIComponent(sessionId)}/messages`, { body: toSnakeCasePayload(body) }); }
  listMessages(sessionId: string, params: Record<string, unknown> = {}) { return this.request<unknown>('GET', `/intelligence/sessions/${encodeURIComponent(sessionId)}/messages`, { query: { ...params } }); }

  private url(path: string, query?: Record<string, unknown>): string {
    const url = new URL(joinUrl(this.config.baseUrl!, this.config.apiPrefix!, path));
    for (const [key, value] of Object.entries(query ?? {})) if (value !== undefined) url.searchParams.set(key, String(value));
    return url.toString();
  }
}

/** Build a search request body from a text/vector/options input. */
export function buildSearchBody(query: string | number[] | Record<string, unknown>, options: SearchOptions = {}): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  if (typeof query === 'string') body.queryText = query;
  else if (Array.isArray(query)) body.query = query;
  else Object.assign(body, query);
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) continue;
    if (key === 'rerank') { body.rerank = value === true ? { ...RERANK_OBJECT } : value; continue; }
    body[key] = value;
  }
  if (body.topK === undefined && body.top_k === undefined) body.topK = 10;
  return body;
}

/** Normalize a vector record: keep numeric ids numeric, map vector→values. */
function normalizeVector(record: VectorRecord): Record<string, unknown> {
  const { id, values, vector, metadata, ...rest } = record;
  const out: Record<string, unknown> = { ...rest };
  if (id !== undefined) out.id = id; // string OR number preserved as-is
  const resolvedValues = values ?? vector;
  if (resolvedValues !== undefined) out.values = resolvedValues;
  if (metadata !== undefined) out.metadata = metadata;
  return out;
}

function applyAskDefaults(body: Record<string, unknown>, stream: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = { ...body };
  if (out.includeSources === undefined && out.include_sources === undefined) out.includeSources = true;
  if (out.topK === undefined && out.top_k === undefined) out.topK = 5;
  if (out.datasetId === undefined && out.dataset_id === undefined) out.datasetId = 'all';
  out.stream = stream;
  return out;
}

function contentType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case '.json': case '.jsonl': return 'application/json';
    case '.csv': return 'text/csv';
    case '.tsv': return 'text/tab-separated-values';
    case '.html': return 'text/html';
    case '.xml': return 'application/xml';
    case '.md': case '.mdx': return 'text/markdown';
    case '.yaml': case '.yml': return 'application/yaml';
    case '.pdf': return 'application/pdf';
    default: return 'text/plain';
  }
}

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

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
