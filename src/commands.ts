import chalk from 'chalk';
import ora from 'ora';
import cliProgress from 'cli-progress';
import { Command } from 'commander';
import { readFile, writeFile } from 'node:fs/promises';
import { readConfig, resolveConfig, writeConfig } from './config.js';
import { collectFiles, VectorAmpClient, type IngestFile, type VectorRecord, type SearchOptions, type MetadataSchema } from './client.js';
import { embeddingDimensions, openai } from './embeddings.js';
import { compact, parseJsonOption, printJson } from './utils.js';
import { SOURCE_TYPES } from './sources.js';
import { commandHelp, extractDatasets, InteractiveTerminal, normalizeSlashCommand, renderBanner } from './interactive-ui.js';
import { renderTerminalMarkdown, TerminalMarkdownStreamRenderer } from './markdown.js';

export interface CliIO { stdout?: NodeJS.WriteStream; stderr?: NodeJS.WriteStream; fetch?: typeof fetch }

type GlobalOpts = { apiKey?: string; baseUrl?: string; apiPrefix?: string; dataset?: string; json?: boolean; history?: number };

const DEFAULT_DIM = 2560;

export function buildProgram(io: CliIO = {}): Command {
  const program = new Command();
  program.name('vectoramp').alias('va').description('VectorAmp CLI for datasets, ingestion, search, and Intelligence').version('0.3.0')
    .option('--api-key <key>', 'API key (defaults to VECTORAMP_API_KEY or local config)')
    .option('--base-url <url>', 'API base URL (defaults to VECTORAMP_BASE_URL or https://api.vectoramp.com)')
    .option('--api-prefix <prefix>', 'API path prefix (defaults to none for the public REST API)')
    .option('-d, --dataset <id>', 'Dataset id to use')
    .option('--history <n>', 'Max prior messages to include in interactive follow-ups', (v) => parseInt(v, 10), 10)
    .option('--json', 'Print raw JSON output');

  program.action(async () => interactive(io, program.opts<GlobalOpts>()));

  program.command('ask <question...>').description('Ask VectorAmp Intelligence').option('--stream', 'Stream output using SSE when available').option('-k, --top-k <n>', 'Number of context chunks to retrieve', parseInt).option('--dataset <id>', 'Dataset id (defaults to "all")').action(async (question, opts) => {
    const ctx = await context({ ...program.opts(), dataset: opts.dataset ?? program.opts().dataset }, io);
    await ask(ctx, question.join(' '), opts.stream, { topK: opts.topK });
  });

  const datasets = program.command('datasets').alias('dataset').description('Manage datasets');
  datasets.command('list').option('--limit <n>', 'Page size', parseInt).option('--offset <n>', 'Offset', parseInt).action(async (opts) => {
    const ctx = await context(program.opts(), io); await spin(ctx, 'Listing datasets', async () => show(ctx, await ctx.client.listDatasets(compact(opts))));
  });
  datasets.command('create <name>')
    .description('Create a SABLE dataset. Name only works; defaults VectorAmp-Embedding-4B / dim 2560 / cosine.')
    .option('--dim <n>', 'Vector dimension. Inferred for built-in embeddings.', parseInt)
    .option('--metric <metric>', 'Distance metric (default cosine)')
    .option('--openai <small|large>', 'Use OpenAI text-embedding-3-small or text-embedding-3-large')
    .option('--openai-api-key <key>', 'Save this OpenAI API key as an org secret before creating the dataset')
    .option('--openai-api-key-env <name>', 'Read an OpenAI API key from an environment variable and save it before creating the dataset')
    .option('--embedding-secret-ref <ref>', 'Stored embedding secret reference (default emb:openai:api_key for OpenAI)')
    .option('--embedding-provider <provider>', 'Embedding provider override')
    .option('--embedding-model <model>', 'Embedding model override')
    .option('--hybrid', 'Enable hybrid (dense + sparse) search')
    .option('--metadata <json>', 'Metadata JSON')
    .option('--metadata-schema <json>', 'Typed metadata schema JSON array')
    .action(async (name, opts) => {
      const ctx = await context(program.opts(), io);
      const embedding = resolveEmbeddingOptions(opts);
      const dim = opts.dim ?? embeddingDimensions[embedding.model] ?? (isDefaultEmbedding(embedding) ? DEFAULT_DIM : undefined);
      if (!dim) throw new Error('Vector dimension required for custom embedding models. Pass --dim <n>.');
      const body = compact({
        name,
        dim,
        metric: opts.metric ?? 'cosine',
        embedding,
        hybrid: opts.hybrid ? true : undefined,
        metadata: parseJsonOption(opts.metadata, undefined),
        schema: parseJsonOption<MetadataSchema | undefined>(opts.metadataSchema, undefined),
      });
      const apiKey = resolveSecretValue({ value: opts.openaiApiKey, env: opts.openaiApiKeyEnv });
      const secretRef = opts.embeddingSecretRef ?? (embedding.provider === 'openai' ? 'emb:openai:api_key' : undefined);
      if (secretRef) (body.embedding as Record<string, unknown>).secretRef = secretRef;
      await spin(ctx, 'Creating SABLE dataset', async () => show(ctx, apiKey
        ? await ctx.client.createDatasetWithOpenAISecret({ apiKey, secretRef, dataset: body })
        : await ctx.client.createDataset(body)));
    });
  datasets.command('get <id>').action(async (id) => { const ctx = await context(program.opts(), io); await spin(ctx, 'Fetching dataset', async () => show(ctx, await ctx.client.getDataset(id))); });
  datasets.command('schema-patch <id> <schema>')
    .description('Add or update typed metadata schema fields from a JSON array')
    .action(async (id, schema) => {
      const ctx = await context(program.opts(), io);
      await spin(ctx, 'Patching metadata schema', async () => show(ctx, await ctx.client.patchMetadataSchema(id, parseJsonOption<MetadataSchema>(schema, []))));
    });
  datasets.command('schema-replace <id> <schema>')
    .description('Replace the complete typed metadata schema from a JSON array')
    .action(async (id, schema) => {
      const ctx = await context(program.opts(), io);
      await spin(ctx, 'Replacing metadata schema', async () => show(ctx, await ctx.client.replaceMetadataSchema(id, parseJsonOption<MetadataSchema>(schema, []))));
    });
  datasets.command('stats <id>').description('Vector count and index status').action(async (id) => { const ctx = await context(program.opts(), io); await spin(ctx, 'Fetching stats', async () => show(ctx, await ctx.client.stats(id))); });
  datasets.command('delete <id>').option('-y, --yes', 'Skip confirmation').action(async (id, opts) => {
    if (!opts.yes) throw new Error('Refusing to delete without --yes');
    const ctx = await context(program.opts(), io); await spin(ctx, 'Deleting dataset', async () => { await ctx.client.deleteDataset(id); print(ctx, { deleted: id }, chalk.green(`Deleted ${id}`)); });
  });
  datasets.command('delete-vectors <dataset-id> <ids...>').description('Delete vector ids from a dataset').option('-y, --yes', 'Skip confirmation').option('--write-concern <value>', 'default, one, quorum, or all').action(async (datasetId, ids, opts) => {
    if (!opts.yes) throw new Error('Refusing to delete vectors without --yes');
    const ctx = await context(program.opts(), io);
    const parsedIds = ids.map(parseVectorId);
    await spin(ctx, `Deleting ${parsedIds.length} vector(s)`, async () => show(ctx, await ctx.client.deleteVectors(datasetId, parsedIds, { writeConcern: opts.writeConcern })));
  });
  datasets.command('search [query...]')
    .description('Semantic or hybrid search. Use --vector for a raw vector query, --filter for metadata filters, --sparse for hybrid.')
    .option('-k, --top-k <n>', 'Number of results (default 10)', parseInt)
    .option('--rerank', 'Enable VectorAmp reranking (VectorAmp-Rerank-v1)')
    .option('--filter <k=v...>', 'Metadata filter, repeatable (e.g. --filter team=support)', collectFilter, {})
    .option('--vector <id-or-json>', 'Search by a raw float vector (JSON array) instead of text')
    .option('--hybrid', 'Enable hybrid dense + sparse search')
    .option('--sparse <text>', 'Sparse/keyword query for hybrid search (implies --hybrid)')
    .option('--alpha <n>', 'Hybrid blend weight (0 sparse .. 1 dense)', parseFloat)
    .option('--dataset <id>', 'Dataset id')
    .action(async (query: string[] = [], opts) => {
      const ctx = await context({ ...program.opts(), dataset: opts.dataset ?? program.opts().dataset }, io); await requireDataset(ctx);
      const text = query.join(' ').trim();
      if (!opts.vector && !text) throw new Error('Provide a text query, or --vector <json> for a raw vector search.');
      const queryInput = opts.vector ? parseVectorQuery(opts.vector) : text;
      const options: SearchOptions = compact({
        topK: opts.topK,
        rerank: opts.rerank ? true : undefined,
        filters: Object.keys(opts.filter ?? {}).length ? opts.filter : undefined,
        hybrid: opts.hybrid || opts.sparse ? true : undefined,
        sparseQuery: opts.sparse,
        alpha: opts.alpha,
        // Return the matched text + metadata so results are useful (and so the
        // document text comes back; metadata-only can lag the document store).
        includeMetadata: true,
        includeDocuments: true,
      }) as SearchOptions;
      await spin(ctx, 'Searching', async () => show(ctx, await ctx.client.search(ctx.datasetId!, queryInput, options)));
    });
  datasets.command('add-texts <texts...>').option('--file <path>', 'Read one text payload from file').option('--metadata <json>', 'Metadata JSON').option('--dataset <id>', 'Dataset id').action(async (texts, opts) => {
    const ctx = await context({ ...program.opts(), dataset: opts.dataset ?? program.opts().dataset }, io); await requireDataset(ctx);
    if (opts.file) texts.push(await (await import('node:fs/promises')).readFile(opts.file, 'utf8'));
    await spin(ctx, 'Adding texts', async () => show(ctx, await ctx.client.addTexts(ctx.datasetId!, texts, parseJsonOption(opts.metadata, undefined))));
  });
  datasets.command('ask <question...>').option('--stream', 'Stream output').option('-k, --top-k <n>', 'Number of context chunks to retrieve', parseInt).option('--dataset <id>', 'Dataset id').action(async (question, opts) => {
    const ctx = await context({ ...program.opts(), dataset: opts.dataset ?? program.opts().dataset }, io); await requireDataset(ctx); await ask(ctx, question.join(' '), opts.stream, { topK: opts.topK });
  });
  datasets.command('ingest-files <path>').option('--dataset <id>', 'Dataset id').option('--extensions <list>', 'Comma-separated extensions').option('--max-bytes-per-file <n>', 'Max bytes per file', parseInt).option('--source-id <id>', 'Existing file_upload source id').option('--source-name <name>', 'Name for auto-created file_upload source').action(async (root, opts) => ingestFilesCommand(await context({ ...program.opts(), dataset: opts.dataset ?? program.opts().dataset }, io), root, opts));

  // Dataset documents: `documents list <dataset>` / `documents download <dataset> <docId>`.
  const documents = program.command('documents').alias('docs').description('List and download retained dataset source documents');
  documents.command('list <dataset>').description('List retained dataset documents (cursor pagination)').option('--limit <n>', 'Page size', parseInt).option('--cursor <cursor>', 'Cursor from next_cursor').option('--status <status>', 'Filter by document status').action(async (dataset, opts) => {
    const ctx = await context({ ...program.opts(), dataset }, io); await spin(ctx, 'Listing documents', async () => show(ctx, await ctx.client.listDocuments(dataset, compact(opts))));
  });
  documents.command('download <dataset> <document-id>').description('Download retained original document bytes').option('-o, --output <path>', 'Write downloaded bytes to file').action(async (dataset, documentId, opts) => {
    const ctx = await context({ ...program.opts(), dataset }, io);
    await spin(ctx, 'Downloading document', async () => {
      const bytes = Buffer.from(await ctx.client.downloadDocument(dataset, documentId));
      if (opts.output) { await writeFile(opts.output, bytes); print(ctx, { output: opts.output, bytes: bytes.length }, chalk.green(`Wrote ${opts.output}`)); }
      else process.stdout.write(bytes);
    });
  });
  // Back-compat aliases under `datasets ...`.
  datasets.command('documents <id>').alias('docs').description('List retained dataset source documents').option('--limit <n>', 'Page size', parseInt).option('--cursor <cursor>', 'Cursor from next_cursor').option('--status <status>', 'Filter by document status').action(async (id, opts) => {
    const ctx = await context({ ...program.opts(), dataset: id }, io); await spin(ctx, 'Listing documents', async () => show(ctx, await ctx.client.listDocuments(id, compact(opts))));
  });
  datasets.command('download-document <id> <document-id>').description('Download retained original document bytes').option('-o, --output <path>', 'Write downloaded bytes to file').action(async (id, documentId, opts) => {
    const ctx = await context({ ...program.opts(), dataset: id }, io);
    await spin(ctx, 'Downloading document', async () => {
      const bytes = Buffer.from(await ctx.client.downloadDocument(id, documentId));
      if (opts.output) { await writeFile(opts.output, bytes); print(ctx, { output: opts.output, bytes: bytes.length }, chalk.green(`Wrote ${opts.output}`)); }
      else process.stdout.write(bytes);
    });
  });

  const secrets = program.command('secrets').description('Manage organization provider secrets');
  secrets.command('put <name>').description('Create or update an organization provider secret').option('--value <value>', 'Secret plaintext value').option('--file <path>', 'Read secret plaintext from a file').option('--env <name>', 'Read secret plaintext from an environment variable').action(async (name, opts) => {
    const value = await resolveSecretValueAsync(opts);
    if (!value) throw new Error('Provide --value, --file, or --env');
    const ctx = await context(program.opts(), io);
    await spin(ctx, 'Saving organization secret', async () => show(ctx, await ctx.client.putOrgSecret({ name, value })));
  });

  // Raw vector operations.
  const vectors = program.command('vectors').description('Insert and manage raw vectors');
  vectors.command('insert')
    .description('Insert raw vector records. Numeric ids stay numeric on the wire.')
    .option('--dataset <id>', 'Dataset id')
    .option('--id <id>', 'Vector id (string or integer; integers stay numbers)')
    .option('--values <json>', 'Vector values as a JSON array')
    .option('--metadata <json>', 'Metadata JSON')
    .option('--vectors <json>', 'Insert a JSON array of {id,values,metadata} records')
    .action(async (opts) => {
      const ctx = await context({ ...program.opts(), dataset: opts.dataset ?? program.opts().dataset }, io); await requireDataset(ctx);
      const records: VectorRecord[] = opts.vectors
        ? parseJsonOption<VectorRecord[]>(opts.vectors, [])
        : [compact({ id: parseVectorId(opts.id), values: opts.values ? parseJsonOption<number[]>(opts.values, []) : undefined, metadata: parseJsonOption(opts.metadata, undefined) }) as VectorRecord];
      if (!records.length || (!opts.vectors && opts.values === undefined)) throw new Error('Provide --values <json> or --vectors <json>.');
      await spin(ctx, `Inserting ${records.length} vector(s)`, async () => show(ctx, await ctx.client.insert(ctx.datasetId!, records)));
    });

  const sources = program.command('sources').description('Create ingestion sources');
  for (const type of SOURCE_TYPES) {
    sources.command(`${type} [uri]`).option('--name <name>').option('--config <json>').description(`Create ${type} source`).action(async (uri, opts) => {
      const ctx = await context(program.opts(), io);
      await spin(ctx, `Creating ${type} source`, async () => show(ctx, await ctx.client.createSource(compact({ sourceType: type, config: buildSourceConfig(type, uri, opts.config), name: opts.name }) as any)));
    });
  }
  sources.command('ingest <type> <uri>').option('--dataset <id>').option('--config <json>').option('--pipeline-id <id>').description('Create a source and start ingestion into the active dataset').action(async (type, uri, opts) => {
    const ctx = await context({ ...program.opts(), dataset: opts.dataset ?? program.opts().dataset }, io); await requireDataset(ctx);
    await spin(ctx, 'Starting source ingestion', async () => show(ctx, await ctx.client.ingestSource(ctx.datasetId!, compact({ sourceType: type, config: buildSourceConfig(type, uri, opts.config) }) as any, { pipelineId: opts.pipelineId })));
  });
  sources.command('list').option('--limit <n>', 'Page size', parseInt).option('--offset <n>', 'Offset', parseInt).action(async (opts) => {
    const ctx = await context(program.opts(), io); await spin(ctx, 'Listing sources', async () => show(ctx, await ctx.client.listSources(compact(opts))));
  });
  sources.command('get <source-id>').action(async (id) => { const ctx = await context(program.opts(), io); await spin(ctx, 'Fetching source', async () => show(ctx, await ctx.client.getSource(id))); });

  const jobs = program.command('jobs').description('Manage ingestion jobs');
  jobs.command('list').option('--dataset-id <id>', 'Filter by dataset').option('--limit <n>', 'Page size', parseInt).option('--offset <n>', 'Offset', parseInt).action(async (opts) => {
    const ctx = await context(program.opts(), io); await spin(ctx, 'Listing jobs', async () => show(ctx, await ctx.client.listJobs(compact(opts))));
  });
  jobs.command('get <job-id>').description('Fetch ingestion job status; --poll waits for a terminal state').option('--poll', 'Poll until the job completes/fails').option('--interval <ms>', 'Poll interval in ms', parseInt).option('--timeout <ms>', 'Max time to poll in ms', parseInt).action(async (jobId, opts) => {
    const ctx = await context(program.opts(), io);
    if (opts.poll) {
      const spinner = startSpinner(ctx, 'Polling job');
      const job = await ctx.client.waitForJob(jobId, { intervalMs: opts.interval, timeoutMs: opts.timeout, onPoll: (j) => { if (spinner) spinner.text = `Polling job (${j.status ?? 'pending'})`; } });
      if (spinner) spinner.stop();
      show(ctx, job);
    } else {
      await spin(ctx, 'Fetching job', async () => show(ctx, await ctx.client.getJob(jobId)));
    }
  });
  jobs.command('retry <job-id>').description('Retry an eligible failed or cancelled ingestion job as a fresh full rerun').action(async (jobId) => {
    const ctx = await context(program.opts(), io);
    await spin(ctx, 'Retrying ingestion job', async () => show(ctx, await ctx.client.retryJob(jobId)));
  });

  const schedules = program.command('schedules').alias('schedule').description('Manage recurring ingestion schedules');
  schedules.command('list').option('--limit <n>', 'Page size', parseInt).option('--offset <n>', 'Offset', parseInt).action(async (opts) => {
    const ctx = await context(program.opts(), io);
    await spin(ctx, 'Listing schedules', async () => show(ctx, await ctx.client.listSchedules(compact(opts))));
  });
  schedules.command('get <schedule-id>').action(async (id) => {
    const ctx = await context(program.opts(), io);
    await spin(ctx, 'Fetching schedule', async () => show(ctx, await ctx.client.getSchedule(id)));
  });
  schedules.command('create')
    .requiredOption('--source-id <id>', 'Ingestion source id to pull from')
    .requiredOption('--dataset-id <id>', 'Dataset to ingest into')
    .requiredOption('--cron <expr>', 'Cron expression, 5 fields (e.g. "0 * * * *")')
    .option('--timezone <tz>', 'IANA timezone (defaults to UTC)')
    .option('--pipeline-id <id>', 'Pipeline id (defaults to ingestion default)')
    .option('--no-enabled', 'Create the schedule disabled')
    .option('--name <name>', 'Human-readable name')
    .option('--metadata <json>', 'Metadata JSON blob')
    .action(async (opts) => {
      const ctx = await context(program.opts(), io);
      const body = compact({
        sourceId: opts.sourceId,
        datasetId: opts.datasetId,
        cron: opts.cron,
        timezone: opts.timezone,
        pipelineId: opts.pipelineId,
        enabled: opts.enabled === false ? false : undefined,
        name: opts.name,
        metadata: parseJsonOption(opts.metadata, undefined),
      });
      await spin(ctx, 'Creating schedule', async () => show(ctx, await ctx.client.createSchedule(body)));
    });
  schedules.command('update <schedule-id>')
    .option('--cron <expr>', 'New cron expression')
    .option('--timezone <tz>', 'New timezone')
    .option('--pipeline-id <id>', 'New pipeline id')
    .option('--enable', 'Enable the schedule')
    .option('--disable', 'Disable the schedule')
    .option('--name <name>', 'New name')
    .option('--metadata <json>', 'New metadata JSON blob')
    .action(async (id, opts) => {
      if (opts.enable && opts.disable) throw new Error('--enable and --disable are mutually exclusive');
      const enabled = opts.enable ? true : opts.disable ? false : undefined;
      const body = compact({
        cron: opts.cron,
        timezone: opts.timezone,
        pipelineId: opts.pipelineId,
        enabled,
        name: opts.name,
        metadata: parseJsonOption(opts.metadata, undefined),
      });
      if (Object.keys(body).length === 0) throw new Error('Provide at least one field to update.');
      const ctx = await context(program.opts(), io);
      await spin(ctx, 'Updating schedule', async () => show(ctx, await ctx.client.updateSchedule(id, body)));
    });
  schedules.command('delete <schedule-id>').option('-y, --yes', 'Skip confirmation').action(async (id, opts) => {
    if (!opts.yes) throw new Error('Refusing to delete without --yes');
    const ctx = await context(program.opts(), io);
    await spin(ctx, 'Deleting schedule', async () => show(ctx, await ctx.client.deleteSchedule(id)));
  });
  schedules.command('trigger <schedule-id>').description('Kick off an immediate run for the schedule, outside its cron cadence').action(async (id) => {
    const ctx = await context(program.opts(), io);
    await spin(ctx, 'Triggering schedule', async () => show(ctx, await ctx.client.triggerSchedule(id)));
  });

  const configCmd = program.command('config').description('Manage local config');
  configCmd.command('show').action(async () => printJson(await readConfig()));
  configCmd.command('set').option('--api-key <key>').option('--base-url <url>').option('--api-prefix <prefix>').option('--dataset <id>').action(async (opts) => {
    const next = { ...(await readConfig()), ...compact({ apiKey: opts.apiKey, baseUrl: opts.baseUrl, apiPrefix: opts.apiPrefix, datasetId: opts.dataset }) };
    await writeConfig(next); console.log(chalk.green('Saved VectorAmp config'));
  });
  configCmd.command('use <dataset>').description('Set default dataset').action(async (dataset) => { const next = { ...(await readConfig()), datasetId: dataset }; await writeConfig(next); console.log(chalk.green(`Using dataset ${dataset}`)); });

  program.exitOverride();
  return program;
}

function isDefaultEmbedding(embedding: { provider: string; model: string }): boolean {
  return embedding.provider === 'vectoramp' && embedding.model === 'VectorAmp-Embedding-4B';
}

function resolveEmbeddingOptions(opts: { openai?: string; embeddingProvider?: string; embeddingModel?: string }) {
  if (opts.openai) {
    if (opts.openai !== 'small' && opts.openai !== 'large') throw new Error('--openai must be "small" or "large"');
    return openai(opts.openai);
  }
  return {
    provider: opts.embeddingProvider ?? 'vectoramp',
    model: opts.embeddingModel ?? 'VectorAmp-Embedding-4B',
  };
}

function resolveSecretValue(opts: { value?: string; env?: string }): string | undefined {
  if (opts.value) return opts.value;
  if (opts.env) {
    const value = process.env[opts.env];
    if (!value) throw new Error(`Environment variable ${opts.env} is not set`);
    return value;
  }
  return undefined;
}

async function resolveSecretValueAsync(opts: { value?: string; file?: string; env?: string }): Promise<string | undefined> {
  const direct = resolveSecretValue(opts);
  if (direct !== undefined) return direct;
  if (opts.file) return (await readFile(opts.file, 'utf8')).trim();
  return undefined;
}

/** Collect repeatable `--filter k=v` options into a record. */
function collectFilter(value: string, previous: Record<string, unknown> = {}): Record<string, unknown> {
  const eq = value.indexOf('=');
  if (eq === -1) throw new Error(`Invalid --filter "${value}". Use key=value.`);
  const key = value.slice(0, eq);
  const raw = value.slice(eq + 1);
  return { ...previous, [key]: coerceFilterValue(raw) };
}

function coerceFilterValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw !== '' && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

/** `--vector` accepts a JSON array of floats. */
function parseVectorQuery(value: string): number[] {
  const parsed = parseJsonOption<unknown>(value, undefined);
  if (!Array.isArray(parsed) || parsed.some((n) => typeof n !== 'number')) {
    throw new Error('--vector must be a JSON array of numbers, e.g. [0.1,0.2,0.3].');
  }
  return parsed as number[];
}

/** A vector id may be a string OR an integer; integers are preserved as numbers. */
function parseVectorId(value: string | undefined): string | number | undefined {
  if (value === undefined) return undefined;
  if (/^-?\d+$/.test(value)) return Number(value);
  return value;
}

/** Merge a positional URI into the right config key for each source type. */
function buildSourceConfig(type: string, uri: string | undefined, configJson: string | undefined): Record<string, unknown> {
  const config = parseJsonOption<Record<string, unknown>>(configJson, {});
  if (!uri) return config;
  if (type === 'web') return { start_urls: [uri], ...config };
  if (type === 's3' || type === 'gcs') return { bucket: uri.replace(/^s3:\/\/|^gs:\/\//, '').split('/')[0], ...config };
  if (type === 'gdrive') return { folder_ids: [uri], ...config };
  if (type === 'confluence' || type === 'jira') return { base_url: uri, ...config };
  return { uri, ...config };
}

async function context(opts: GlobalOpts, io: CliIO) {
  const config = await resolveConfig({ apiKey: opts.apiKey, baseUrl: opts.baseUrl, apiPrefix: opts.apiPrefix, datasetId: opts.dataset });
  return { config, client: new VectorAmpClient(config, io.fetch), json: Boolean(opts.json), datasetId: opts.dataset ?? config.datasetId };
}
async function requireDataset(ctx: { datasetId?: string }) { if (!ctx.datasetId) throw new Error('Dataset id required. Pass --dataset <id> or run `vectoramp config use <id>`.'); }

/** Spinners are noise in machine-readable (`--json`) mode, so suppress them. */
function startSpinner(ctx: { json: boolean }, text: string) { return ctx.json ? undefined : ora(text).start(); }
async function spin<T>(ctx: { json: boolean }, text: string, fn: () => Promise<T>): Promise<T> {
  const spinner = startSpinner(ctx, text);
  try { const out = await fn(); spinner?.succeed(); return out; } catch (e) { spinner?.fail(); throw e; }
}
function show(ctx: { json: boolean }, value: unknown) { printJson(value); }
function print(ctx: { json: boolean }, jsonValue: unknown, human: string) { if (ctx.json) printJson(jsonValue); else console.log(human); }

export interface ConversationTurn { role: 'user' | 'assistant' | 'system'; content: string }

interface AskOptions { conversationHistory?: ConversationTurn[]; topK?: number }

// Returns the assistant's answer text so callers (e.g. the interactive REPL) can
// accumulate multi-turn conversation history. `conversationHistory` is sent
// verbatim; the caller decides how many prior turns to include.
async function ask(
  ctx: Awaited<ReturnType<typeof context>>,
  question: string,
  stream: boolean,
  opts: AskOptions = {}
): Promise<string> {
  const body = compact({
    query: question,
    datasetId: ctx.datasetId,
    topK: opts.topK,
    conversationHistory: opts.conversationHistory?.length ? opts.conversationHistory : undefined,
  });
  if (stream && !ctx.json) {
    const spinner = ora('Asking VectorAmp').start();
    let wroteChunk = false;
    let answer = '';
    const markdownStream = new TerminalMarkdownStreamRenderer((value) => { process.stdout.write(value); });
    try {
      for await (const event of ctx.client.askStream(body)) {
        if (event.event === 'done' || event.data === '[DONE]') break;
        const chunk = renderAskStreamChunk(event.data);
        if (!chunk) continue;
        if (!wroteChunk) { spinner.stop(); wroteChunk = true; }
        answer += chunk;
        markdownStream.write(chunk);
      }
      if (!wroteChunk) spinner.stop();
      else markdownStream.end();
      return answer;
    } catch (error) {
      if (wroteChunk) process.stdout.write('\n');
      else spinner.stop();
      console.error(chalk.yellow(`Streaming unavailable, falling back: ${(error as Error).message}`));
    }
  }
  const response = await spin(ctx, 'Asking VectorAmp', async () => ctx.client.ask(body));
  showAsk(ctx, response);
  return response && typeof response === 'object' && typeof (response as any).answer === 'string'
    ? (response as any).answer
    : '';
}

function showAsk(ctx: { json: boolean }, value: unknown) {
  if (ctx.json) { printJson(value); return; }
  if (value && typeof value === 'object' && typeof (value as any).answer === 'string') console.log(renderTerminalMarkdown((value as any).answer));
  else show(ctx, value);
}

function renderAskStreamChunk(data: unknown): string {
  if (typeof data === 'string') return data;
  if (!data || typeof data !== 'object') return '';
  const chunk: any = data;
  if (chunk.chunk_type === 'done' || chunk.chunkType === 'done') return '';
  if (chunk.chunk_type === 'error' || chunk.chunkType === 'error') return chunk.content ? `\n${chunk.content}` : '';
  return chunk.content ?? chunk.delta ?? chunk.answer ?? '';
}

async function ingestFilesCommand(ctx: Awaited<ReturnType<typeof context>>, root: string, opts: any) {
  await requireDataset(ctx);
  const useBar = !ctx.json;
  const progress = useBar ? new cliProgress.SingleBar({ format: 'Reading files |{bar}| {value} files' }, cliProgress.Presets.shades_classic) : undefined;
  progress?.start(1, 0);
  const files: IngestFile[] = await collectFiles(root, { extensions: opts.extensions?.split(','), maxBytesPerFile: opts.maxBytesPerFile, onFile: (_file, count) => { progress?.setTotal(Math.max(count, 1)); progress?.update(count); } });
  progress?.stop();
  if (!files.length) throw new Error('No ingestible text files found.');
  await spin(ctx, `Uploading ${files.length} file(s)`, async () => show(ctx, await ctx.client.ingestFiles(ctx.datasetId!, files, compact({ sourceId: opts.sourceId, sourceName: opts.sourceName }))));
}

export async function interactive(io: CliIO = {}, initial: GlobalOpts = {}) {
  const terminal = new InteractiveTerminal();
  let ctx = await context(initial, io);
  console.log(renderBanner({ cwd: process.cwd(), datasetId: ctx.datasetId }));

  // Multi-turn conversation: the Intelligence API is stateless, so the REPL keeps
  // the running transcript and sends a window of the most recent messages with
  // each follow-up. `--history <n>` controls how many prior messages are included.
  const historyWindow = typeof initial.history === 'number' && initial.history >= 0 ? initial.history : 10;
  const history: ConversationTurn[] = [];
  const askTurn = async (question: string) => {
    const answer = await ask(ctx, question, true, { conversationHistory: history.slice(-historyWindow) });
    history.push({ role: 'user', content: question });
    if (answer) history.push({ role: 'assistant', content: answer });
  };

  while (true) {
    const datasetLabel = ctx.datasetId ?? 'no dataset';
    const line = await terminal.readLine(`VectorAmp:${datasetLabel}`);
    if (line === undefined) break;
    const trimmed = line.trim();
    const [rawCmd, ...args] = trimmed.split(/\s+/);
    const cmd = normalizeSlashCommand(rawCmd);
    try {
      if (!cmd || cmd === '') continue;
      if (cmd === '/exit') break;
      if (cmd === '/help') console.log(commandHelp());
      else if (cmd === '/context' || cmd === '/status') console.log(renderBanner({ cwd: process.cwd(), datasetId: ctx.datasetId }));
      else if (cmd === '/datasets') {
        const response = await spin(ctx, 'Fetching datasets', () => ctx.client.listDatasets({ limit: 50, offset: 0 }));
        const choice = await terminal.pickDataset(extractDatasets(response), args.join(' '));
        if (!choice) { console.log(chalk.yellow('No dataset selected.')); continue; }
        await writeConfig({ ...(await readConfig()), datasetId: choice.id });
        ctx = await context({ ...initial, dataset: choice.id }, io);
        history.length = 0;
        console.log(chalk.green(`Using ${choice.name ? `${choice.name} (${choice.id})` : choice.id}. Conversation reset.`));
      }
      else if (cmd === '/use') {
        // `/use <id>` switches dataset directly without the picker.
        if (!args[0]) { console.log(chalk.yellow('Usage: /use <dataset-id>')); continue; }
        await writeConfig({ ...(await readConfig()), datasetId: args[0] });
        ctx = await context({ ...initial, dataset: args[0] }, io);
        history.length = 0;
        console.log(chalk.green(`Using ${args[0]}. Conversation reset.`));
      }
      else if (cmd === '/config') printJson(await readConfig());
      else if (cmd === '/search') { await requireDataset(ctx); show(ctx, await ctx.client.search(ctx.datasetId!, args.join(' '))); }
      else if (cmd === '/add-texts') { await requireDataset(ctx); show(ctx, await ctx.client.addTexts(ctx.datasetId!, [args.join(' ')])); }
      else if (cmd === '/ingest-files') { if (!args[0]) { console.log(chalk.yellow('Usage: /ingest-files <path>')); continue; } await ingestFilesCommand(ctx, args[0], {}); }
      else if (cmd === '/reset' || cmd === '/new') { history.length = 0; console.log(chalk.green('Conversation history cleared.')); }
      else if (cmd === '/ask') await askTurn(args.join(' '));
      else if (cmd === '/sources') show(ctx, await ctx.client.createSource(compact({ sourceType: args[0], config: buildSourceConfig(args[0], args[1], undefined) }) as any));
      else if (!cmd.startsWith('/')) await askTurn(trimmed);
      else console.log(chalk.red(`Unknown command ${cmd}. Try /help.`));
    } catch (error) { console.error(chalk.red((error as Error).message)); }
  }
}
