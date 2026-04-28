import chalk from 'chalk';
import ora from 'ora';
import cliProgress from 'cli-progress';
import { Command } from 'commander';
import { writeFile } from 'node:fs/promises';
import { readConfig, resolveConfig, writeConfig } from './config.js';
import { collectFiles, VectorAmpClient } from './client.js';
import { compact, parseJsonOption, printJson } from './utils.js';
import { commandHelp, extractDatasets, InteractiveTerminal, normalizeSlashCommand, renderBanner } from './interactive-ui.js';

export interface CliIO { stdout?: NodeJS.WriteStream; stderr?: NodeJS.WriteStream; fetch?: typeof fetch }

type GlobalOpts = { apiKey?: string; baseUrl?: string; apiPrefix?: string; dataset?: string; json?: boolean };

export function buildProgram(io: CliIO = {}): Command {
  const program = new Command();
  program.name('vectoramp').alias('va').description('VectorAmp CLI for datasets, ingestion, search, and Intelligence').version('0.1.0')
    .option('--api-key <key>', 'API key (defaults to VECTORAMP_API_KEY or local config)')
    .option('--base-url <url>', 'API base URL (defaults to VECTORAMP_BASE_URL or https://api.vectoramp.com)')
    .option('--api-prefix <prefix>', 'API path prefix (defaults to none for the public REST API)')
    .option('-d, --dataset <id>', 'Dataset id to use')
    .option('--json', 'Print raw JSON output');

  program.action(async () => interactive(io, program.opts<GlobalOpts>()));

  program.command('ask <question...>').description('Ask VectorAmp Intelligence').option('--stream', 'Stream output using SSE when available').action(async (question, opts) => {
    const ctx = await context(program.opts(), io);
    await ask(ctx, question.join(' '), opts.stream);
  });

  const datasets = program.command('datasets').alias('dataset').description('Manage datasets');
  datasets.command('list').option('--limit <n>', 'Page size', parseInt).option('--offset <n>', 'Offset', parseInt).action(async (opts) => {
    const ctx = await context(program.opts(), io); await spin('Listing datasets', async () => show(ctx, await ctx.client.listDatasets(compact(opts))));
  });
  datasets.command('create <name>').requiredOption('--dimension <n>', 'Vector dimension', parseInt).option('--metadata <json>', 'Metadata JSON').action(async (name, opts) => {
    const ctx = await context(program.opts(), io); const body = { name, dimension: opts.dimension, metadata: parseJsonOption(opts.metadata, undefined) };
    await spin('Creating SABLE dataset', async () => show(ctx, await ctx.client.createDataset(body)));
  });
  datasets.command('get <id>').action(async (id) => { const ctx = await context(program.opts(), io); await spin('Fetching dataset', async () => show(ctx, await ctx.client.getDataset(id))); });
  datasets.command('documents <id>').alias('docs').description('List retained dataset source documents').option('--limit <n>', 'Page size', parseInt).option('--cursor <cursor>', 'Cursor from next_cursor').option('--status <status>', 'Filter by document status').action(async (id, opts) => {
    const ctx = await context(program.opts(), io); await spin('Listing documents', async () => show(ctx, await ctx.client.listDocuments(id, compact(opts))));
  });
  datasets.command('download-document <id> <document-id>').description('Download retained original document bytes').option('-o, --output <path>', 'Write downloaded bytes to file').action(async (id, documentId, opts) => {
    const ctx = await context(program.opts(), io);
    await spin('Downloading document', async () => {
      const bytes = Buffer.from(await ctx.client.downloadDocument(id, documentId));
      if (opts.output) { await writeFile(opts.output, bytes); console.log(chalk.green(`Wrote ${opts.output}`)); }
      else process.stdout.write(bytes);
    });
  });
  datasets.command('delete <id>').option('-y, --yes', 'Skip confirmation').action(async (id, opts) => {
    if (!opts.yes) throw new Error('Refusing to delete without --yes');
    const ctx = await context(program.opts(), io); await spin('Deleting dataset', async () => { await ctx.client.deleteDataset(id); console.log(chalk.green(`Deleted ${id}`)); });
  });
  datasets.command('search <query...>').option('-k, --top-k <n>', 'Number of results', parseInt).option('--dataset <id>', 'Dataset id').action(async (query, opts) => {
    const ctx = await context({ ...program.opts(), dataset: opts.dataset ?? program.opts().dataset }, io); await requireDataset(ctx);
    await spin('Searching', async () => show(ctx, await ctx.client.search(ctx.datasetId!, compact({ queryText: query.join(' '), topK: opts.topK }))));
  });
  datasets.command('add-texts <texts...>').option('--file <path>', 'Read one text payload from file').option('--metadata <json>', 'Metadata JSON').option('--dataset <id>', 'Dataset id').action(async (texts, opts) => {
    const ctx = await context({ ...program.opts(), dataset: opts.dataset ?? program.opts().dataset }, io); await requireDataset(ctx);
    if (opts.file) texts.push(await (await import('node:fs/promises')).readFile(opts.file, 'utf8'));
    await spin('Adding texts', async () => show(ctx, await ctx.client.addTexts(ctx.datasetId!, texts, parseJsonOption(opts.metadata, undefined))));
  });
  datasets.command('ask <question...>').option('--stream', 'Stream output').option('--dataset <id>', 'Dataset id').action(async (question, opts) => {
    const ctx = await context({ ...program.opts(), dataset: opts.dataset ?? program.opts().dataset }, io); await requireDataset(ctx); await ask(ctx, question.join(' '), opts.stream);
  });
  datasets.command('ingest-files <path>').option('--dataset <id>', 'Dataset id').option('--extensions <list>', 'Comma-separated extensions').option('--max-bytes-per-file <n>', 'Max bytes per file', parseInt).option('--source-id <id>', 'Existing file_upload source id').option('--source-name <name>', 'Name for auto-created file_upload source').action(async (root, opts) => ingestFiles(await context({ ...program.opts(), dataset: opts.dataset ?? program.opts().dataset }, io), root, opts));

  const sources = program.command('sources').description('Create ingestion sources');
  for (const type of ['web', 's3', 'gdrive', 'confluence', 'jira', 'file_upload'] as const) {
    sources.command(`${type} [uri]`).option('--name <name>').option('--config <json>').description(`Create ${type} source`).action(async (uri, opts) => {
      const ctx = await context(program.opts(), io);
      await spin(`Creating ${type} source`, async () => show(ctx, await ctx.client.createSource(compact({ sourceType: type, uri, name: opts.name, config: parseJsonOption(opts.config, undefined) }))));
    });
  }
  sources.command('ingest <type> <uri>').option('--dataset <id>').option('--config <json>').description('Create/use an inline source and start ingestion').action(async (type, uri, opts) => {
    const ctx = await context({ ...program.opts(), dataset: opts.dataset ?? program.opts().dataset }, io); await requireDataset(ctx);
    await spin('Starting source ingestion', async () => show(ctx, await ctx.client.ingestSource(ctx.datasetId!, compact({ sourceType: type, uri, config: parseJsonOption(opts.config, undefined) }))));
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

async function context(opts: GlobalOpts, io: CliIO) {
  const config = await resolveConfig({ apiKey: opts.apiKey, baseUrl: opts.baseUrl, apiPrefix: opts.apiPrefix, datasetId: opts.dataset });
  return { config, client: new VectorAmpClient(config, io.fetch), json: Boolean(opts.json), datasetId: opts.dataset ?? config.datasetId };
}
async function requireDataset(ctx: { datasetId?: string }) { if (!ctx.datasetId) throw new Error('Dataset id required. Pass --dataset <id> or run `vectoramp config use <id>`.'); }
async function spin<T>(text: string, fn: () => Promise<T>): Promise<T> { const spinner = ora(text).start(); try { const out = await fn(); spinner.succeed(); return out; } catch (e) { spinner.fail(); throw e; } }
function show(ctx: { json: boolean }, value: unknown) { if (ctx.json) printJson(value); else printJson(value); }

async function ask(ctx: Awaited<ReturnType<typeof context>>, question: string, stream: boolean) {
  const body = compact({ query: question, datasetId: ctx.datasetId, includeSources: true });
  if (stream) {
    const spinner = ora('Asking VectorAmp').start();
    let wroteChunk = false;
    try {
      for await (const event of ctx.client.askStream(body)) {
        if (event.event === 'done' || event.data === '[DONE]') break;
        const chunk = renderAskStreamChunk(event.data);
        if (!chunk) continue;
        if (!wroteChunk) { spinner.stop(); wroteChunk = true; }
        process.stdout.write(chunk);
      }
      if (!wroteChunk) spinner.stop();
      process.stdout.write('\n'); return;
    } catch (error) {
      if (wroteChunk) process.stdout.write('\n');
      else spinner.stop();
      console.error(chalk.yellow(`Streaming unavailable, falling back: ${(error as Error).message}`));
    }
  }
  await spin('Asking VectorAmp', async () => showAsk(ctx, await ctx.client.ask({ ...body, stream: false })));
}

function showAsk(ctx: { json: boolean }, value: unknown) {
  if (ctx.json) { printJson(value); return; }
  if (value && typeof value === 'object' && typeof (value as any).answer === 'string') console.log((value as any).answer);
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


async function ingestFiles(ctx: Awaited<ReturnType<typeof context>>, root: string, opts: any) {
  await requireDataset(ctx);
  const progress = new cliProgress.SingleBar({ format: 'Reading files |{bar}| {value} files' }, cliProgress.Presets.shades_classic);
  progress.start(1, 0);
  const files = await collectFiles(root, { extensions: opts.extensions?.split(','), maxBytesPerFile: opts.maxBytesPerFile, onFile: (_file, count) => { progress.setTotal(Math.max(count, 1)); progress.update(count); } });
  progress.stop();
  if (!files.length) throw new Error('No ingestible text files found.');
  await spin(`Uploading ${files.length} file(s)`, async () => show(ctx, await ctx.client.ingestFiles(ctx.datasetId!, compact({ root, files, sourceId: opts.sourceId, sourceName: opts.sourceName }))));
}

export async function interactive(io: CliIO = {}, initial: GlobalOpts = {}) {
  const terminal = new InteractiveTerminal();
  let ctx = await context(initial, io);
  console.log(renderBanner({ cwd: process.cwd(), datasetId: ctx.datasetId }));

  while (true) {
    const line = await terminal.readLine('VectorAmp');
    if (line === undefined) break;
    const trimmed = line.trim();
    const [rawCmd, ...args] = trimmed.split(/\s+/);
    const cmd = normalizeSlashCommand(rawCmd);
    try {
      if (!cmd || cmd === '') continue;
      if (cmd === '/exit' || cmd === '/quit') break;
      if (cmd === '/help') console.log(commandHelp());
      else if (cmd === '/datasets') {
        const response = await spin('Fetching datasets', () => ctx.client.listDatasets({ limit: 50, offset: 0 }));
        const choice = await terminal.pickDataset(extractDatasets(response), args.join(' '));
        if (!choice) { console.log(chalk.yellow('No dataset selected.')); continue; }
        await writeConfig({ ...(await readConfig()), datasetId: choice.id });
        ctx = await context({ ...initial, dataset: choice.id }, io);
        console.log(chalk.green(`Using ${choice.name ? `${choice.name} (${choice.id})` : choice.id}`));
      }
      else if (cmd === '/config') printJson(await readConfig());
      else if (cmd === '/search') { await requireDataset(ctx); show(ctx, await ctx.client.search(ctx.datasetId!, { queryText: args.join(' ') })); }
      else if (cmd === '/add-texts') { await requireDataset(ctx); show(ctx, await ctx.client.addTexts(ctx.datasetId!, [args.join(' ')])); }
      else if (cmd === '/ingest-files') await ingestFiles(ctx, args[0], {});
      else if (cmd === '/ask') await ask(ctx, args.join(' '), true);
      else if (cmd === '/sources') show(ctx, await ctx.client.createSource({ sourceType: args[0], uri: args[1] }));
      else if (!cmd.startsWith('/')) await ask(ctx, trimmed, true);
      else console.log(chalk.red(`Unknown command ${cmd}. Try /help.`));
    } catch (error) { console.error(chalk.red((error as Error).message)); }
  }
}
