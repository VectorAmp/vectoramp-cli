import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import chalk from 'chalk';
import ora from 'ora';
import cliProgress from 'cli-progress';
import { Command } from 'commander';
import { readConfig, resolveConfig, writeConfig } from './config.js';
import { collectFiles, VectorAmpClient } from './client.js';
import { compact, parseJsonOption, printJson } from './utils.js';

export interface CliIO { stdout?: NodeJS.WriteStream; stderr?: NodeJS.WriteStream; fetch?: typeof fetch }

type GlobalOpts = { apiKey?: string; baseUrl?: string; apiPrefix?: string; dataset?: string; json?: boolean };

export function buildProgram(io: CliIO = {}): Command {
  const program = new Command();
  program.name('vectoramp').alias('va').description('VectorAmp CLI for datasets, ingestion, search, and Intelligence').version('0.1.0')
    .option('--api-key <key>', 'API key (defaults to VECTORAMP_API_KEY or local config)')
    .option('--base-url <url>', 'API base URL (defaults to VECTORAMP_BASE_URL or https://api.vectoramp.com)')
    .option('--api-prefix <prefix>', 'API prefix', '/api/v1')
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
  for (const type of ['web', 's3', 'gdrive', 'file_upload'] as const) {
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
  const body = compact({ question, datasetId: ctx.datasetId });
  if (stream) {
    try {
      for await (const event of ctx.client.askStream(body)) {
        if (event.event === 'done' || event.data === '[DONE]') break;
        const data: any = event.data;
        process.stdout.write(typeof data === 'string' ? data : (data?.delta ?? data?.answer ?? JSON.stringify(data)));
      }
      process.stdout.write('\n'); return;
    } catch (error) { console.error(chalk.yellow(`Streaming unavailable, falling back: ${(error as Error).message}`)); }
  }
  await spin('Asking VectorAmp', async () => show(ctx, await ctx.client.ask(body)));
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
  const rl = createInterface({ input, output, prompt: chalk.cyan('vectoramp> ') });
  let ctx = await context(initial, io);
  console.log(chalk.bold('VectorAmp interactive mode. Type /help for commands, /exit to quit.'));
  rl.prompt();
  for await (const line of rl) {
    const [cmd, ...args] = line.trim().split(/\s+/);
    try {
      if (!cmd || cmd === '') { rl.prompt(); continue; }
      if (cmd === '/exit' || cmd === '/quit') break;
      if (cmd === '/help') console.log('/use <dataset> | /search <query> | /add-texts <text> | /ingest-files <path> | /ask <q> | /sources <web|s3|gdrive> <uri> | /config | /exit');
      else if (cmd === '/use') { await writeConfig({ ...(await readConfig()), datasetId: args[0] }); ctx = await context({ ...initial, dataset: args[0] }, io); console.log(chalk.green(`Using ${args[0]}`)); }
      else if (cmd === '/config') printJson(await readConfig());
      else if (cmd === '/search') { await requireDataset(ctx); show(ctx, await ctx.client.search(ctx.datasetId!, { queryText: args.join(' ') })); }
      else if (cmd === '/add-texts') { await requireDataset(ctx); show(ctx, await ctx.client.addTexts(ctx.datasetId!, [args.join(' ')])); }
      else if (cmd === '/ingest-files') await ingestFiles(ctx, args[0], {});
      else if (cmd === '/ask') await ask(ctx, args.join(' '), true);
      else if (cmd === '/sources') show(ctx, await ctx.client.createSource({ sourceType: args[0], uri: args[1] }));
      else if (!cmd.startsWith('/')) await ask(ctx, line.trim(), true);
      else console.log(chalk.red(`Unknown command ${cmd}. Try /help.`));
    } catch (error) { console.error(chalk.red((error as Error).message)); }
    rl.prompt();
  }
  rl.close();
}
