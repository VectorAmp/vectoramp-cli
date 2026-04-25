import { createInterface } from 'node:readline/promises';
import { emitKeypressEvents } from 'node:readline';
import { stdin as defaultInput, stdout as defaultOutput } from 'node:process';
import { homedir } from 'node:os';
import chalk from 'chalk';

export interface SlashCommand {
  name: string;
  description: string;
  usage: string;
}

export interface DatasetChoice {
  id: string;
  name?: string;
  description?: string;
}

export const SLASH_COMMANDS: SlashCommand[] = [
  { name: '/help', usage: '/help', description: 'Show interactive commands' },
  { name: '/use', usage: '/use', description: 'Pick an active dataset from your account' },
  { name: '/search', usage: '/search <query>', description: 'Semantic search in the active dataset' },
  { name: '/add-texts', usage: '/add-texts <text>', description: 'Add inline text to the active dataset' },
  { name: '/ingest-files', usage: '/ingest-files <path>', description: 'Upload local text files into the active dataset' },
  { name: '/ask', usage: '/ask <question>', description: 'Ask Intelligence against the active dataset' },
  { name: '/sources', usage: '/sources <web|s3|gdrive> <uri>', description: 'Create an ingestion source' },
  { name: '/config', usage: '/config', description: 'Show resolved local CLI config' },
  { name: '/exit', usage: '/exit', description: 'Leave interactive mode' },
];

export function commandHelp(): string {
  const width = Math.max(...SLASH_COMMANDS.map((command) => command.usage.length));
  return SLASH_COMMANDS.map((command) => `${command.usage.padEnd(width)}  ${command.description}`).join('\n');
}

export function filterCommands(input: string, commands: SlashCommand[] = SLASH_COMMANDS): SlashCommand[] {
  if (!input.startsWith('/')) return [];
  if (/\s/.test(input)) return [];
  const token = input.split(/\s+/, 1)[0].toLowerCase();
  return commands.filter((command) => command.name.toLowerCase().startsWith(token));
}

export function completeSlashCommand(input: string, commands: SlashCommand[] = SLASH_COMMANDS): string | undefined {
  if (!input.startsWith('/') || /\s/.test(input)) return undefined;
  const matches = filterCommands(input, commands);
  if (matches.length === 1) return `${matches[0].name} `;
  if (matches.length < 2) return undefined;
  const prefix = commonPrefix(matches.map((match) => match.name));
  return prefix.length > input.length ? prefix : undefined;
}

export function extractDatasets(response: unknown): DatasetChoice[] {
  const list: unknown[] = Array.isArray(response)
    ? response
    : Array.isArray((response as any)?.datasets)
      ? (response as any).datasets
      : Array.isArray((response as any)?.data)
        ? (response as any).data
        : Array.isArray((response as any)?.items)
          ? (response as any).items
          : [];
  return list.map((raw): DatasetChoice => {
    const item = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    return {
      id: String(item.id ?? item.dataset_id ?? item.datasetId ?? ''),
      name: item.name === undefined ? undefined : String(item.name),
      description: item.description === undefined ? undefined : String(item.description),
    };
  }).filter((item) => item.id);
}

export function filterDatasets(query: string, datasets: DatasetChoice[]): DatasetChoice[] {
  const q = query.trim().toLowerCase();
  if (!q) return datasets;
  return datasets.filter((dataset) => [dataset.id, dataset.name, dataset.description].filter(Boolean).some((value) => value!.toLowerCase().includes(q)));
}

export function formatCwd(cwd: string, home = homedir()): string {
  if (!home || cwd === home) return '~';
  return cwd.startsWith(`${home}/`) ? `~/${cwd.slice(home.length + 1)}` : cwd;
}

export function renderBanner(options: { cwd?: string; datasetId?: string } = {}): string {
  const cwd = formatCwd(options.cwd ?? process.cwd());
  const dataset = options.datasetId ? `active dataset: ${options.datasetId}` : 'no active dataset';
  return [
    chalk.cyan('╭────────────────────────────────────────╮'),
    chalk.cyan('│') + chalk.bold('              [ VectorAmp ]             ') + chalk.cyan('│'),
    chalk.cyan('╰────────────────────────────────────────╯'),
    `${chalk.dim('cwd')} ${cwd}`,
    `${chalk.dim('ctx')} ${dataset}`,
    '',
    chalk.dim('Type / for commands. Plain text asks Intelligence.'),
    '',
  ].join('\n');
}

export class InteractiveTerminal {
  private renderedLines = 0;
  private readonly input: NodeJS.ReadStream;
  private readonly output: NodeJS.WriteStream;

  constructor(input: NodeJS.ReadStream = defaultInput, output: NodeJS.WriteStream = defaultOutput) {
    this.input = input;
    this.output = output;
  }

  get isRawCapable(): boolean {
    return Boolean(this.input.isTTY && this.output.isTTY && this.input.setRawMode);
  }

  async readLine(prompt = 'vectoramp'): Promise<string | undefined> {
    if (!this.isRawCapable) {
      const rl = createInterface({ input: this.input, output: this.output, prompt: `${prompt}> ` });
      const answer = await rl.question(`${prompt}> `);
      rl.close();
      return answer;
    }
    return this.readRawLine(prompt);
  }

  async pickDataset(datasets: DatasetChoice[], initialFilter = ''): Promise<DatasetChoice | undefined> {
    if (!datasets.length) return undefined;
    if (!this.isRawCapable) {
      const rl = createInterface({ input: this.input, output: this.output });
      this.output.write(datasets.map((dataset, index) => `${index + 1}. ${datasetLabel(dataset)}`).join('\n') + '\n');
      const answer = await rl.question('Select dataset by number or id: ');
      rl.close();
      const numeric = Number(answer);
      return Number.isInteger(numeric) && numeric >= 1 ? datasets[numeric - 1] : datasets.find((dataset) => dataset.id === answer.trim());
    }
    return this.readRawPicker('dataset', datasets, initialFilter);
  }

  private async readRawLine(prompt: string): Promise<string | undefined> {
    let buffer = '';
    let selected = 0;
    const render = () => {
      const palette = filterCommands(buffer).slice(0, 8);
      if (selected >= palette.length) selected = Math.max(0, palette.length - 1);
      this.clearRender();
      this.output.write(`\n${chalk.cyan(prompt)} ${chalk.dim('›')} ${buffer}\n`);
      this.output.write(`${chalk.dim('─'.repeat(56))}`);
      let lines = 3;
      if (palette.length) {
        const width = Math.max(...palette.map((command) => command.name.length), 10);
        this.output.write('\n');
        for (let i = 0; i < palette.length; i += 1) {
          const command = palette[i];
          const row = `${command.name.padEnd(width)}  ${chalk.dim(command.description)}`;
          this.output.write(i === selected ? chalk.inverse(` ${row} `) : ` ${row} `);
          if (i < palette.length - 1) this.output.write('\n');
        }
        lines += palette.length;
      }
      this.renderedLines = lines;
    };

    return this.withRawMode<string | undefined>((resolve) => {
      const onKeypress = (_chunk: string, key: any) => {
        const palette = filterCommands(buffer).slice(0, 8);
        if (key?.ctrl && key.name === 'c') { cleanup(); this.output.write('\n'); resolve(undefined); return; }
        if (key?.name === 'return' && palette.length) {
          const completion = palette[selected]?.name ? `${palette[selected].name} ` : completeSlashCommand(buffer);
          if (completion) buffer = completion;
          render();
          return;
        }
        if (key?.name === 'return') { cleanup(); this.clearRender(); this.output.write(`${chalk.cyan(prompt)} ${chalk.dim('›')} ${buffer}\n`); resolve(buffer); return; }
        if (key?.name === 'backspace') { buffer = buffer.slice(0, -1); selected = 0; render(); return; }
        if (key?.name === 'up' && palette.length) { selected = (selected - 1 + palette.length) % palette.length; render(); return; }
        if (key?.name === 'down' && palette.length) { selected = (selected + 1) % palette.length; render(); return; }
        if (key?.name === 'tab') {
          const completion = palette[selected]?.name ? `${palette[selected].name} ` : completeSlashCommand(buffer);
          if (completion) buffer = completion;
          render();
          return;
        }
        if (_chunk && !key?.ctrl && !key?.meta && _chunk >= ' ') { buffer += _chunk; selected = 0; render(); }
      };
      const cleanup = () => this.input.off('keypress', onKeypress);
      this.input.on('keypress', onKeypress);
      render();
    });
  }

  private async readRawPicker(label: string, datasets: DatasetChoice[], initialFilter: string): Promise<DatasetChoice | undefined> {
    let query = initialFilter;
    let selected = 0;
    const render = () => {
      const matches = filterDatasets(query, datasets).slice(0, 10);
      if (selected >= matches.length) selected = Math.max(0, matches.length - 1);
      this.clearRender();
      this.output.write(`${chalk.dim('─'.repeat(56))}\n`);
      this.output.write(`${chalk.cyan('/use')} ${chalk.dim(`${label} filter ›`)} ${query}\n`);
      let lines = 2;
      if (!matches.length) { this.output.write(chalk.yellow(' no matching datasets')); lines += 1; }
      else {
        const width = Math.max(...matches.map((dataset) => dataset.id.length), 10);
        this.output.write(`${chalk.dim(' uuid'.padEnd(width + 1))}  ${chalk.dim('name')}\n`);
        lines += 1;
        for (let i = 0; i < matches.length; i += 1) {
          const dataset = matches[i];
          const row = `${dataset.id.padEnd(width)}  ${chalk.dim(dataset.name ?? '')}`;
          this.output.write(i === selected ? chalk.inverse(` ${row} `) : ` ${row} `);
          if (i < matches.length - 1) this.output.write('\n');
        }
        lines += matches.length;
      }
      this.renderedLines = lines;
    };

    return this.withRawMode<DatasetChoice | undefined>((resolve) => {
      const onKeypress = (_chunk: string, key: any) => {
        const matches = filterDatasets(query, datasets).slice(0, 10);
        if (key?.ctrl && key.name === 'c') { cleanup(); this.output.write('\n'); resolve(undefined); return; }
        if (key?.name === 'escape') { cleanup(); this.clearRender(); resolve(undefined); return; }
        if (key?.name === 'return') { cleanup(); this.clearRender(); resolve(matches[selected]); return; }
        if (key?.name === 'tab') { cleanup(); this.clearRender(); resolve(matches[selected]); return; }
        if (key?.name === 'backspace') { query = query.slice(0, -1); selected = 0; render(); return; }
        if (key?.name === 'up' && matches.length) { selected = (selected - 1 + matches.length) % matches.length; render(); return; }
        if (key?.name === 'down' && matches.length) { selected = (selected + 1) % matches.length; render(); return; }
        if (_chunk && !key?.ctrl && !key?.meta && _chunk >= ' ') { query += _chunk; selected = 0; render(); }
      };
      const cleanup = () => this.input.off('keypress', onKeypress);
      this.input.on('keypress', onKeypress);
      render();
    });
  }

  private async withRawMode<T>(executor: (resolve: (value: T) => void) => void): Promise<T> {
    emitKeypressEvents(this.input);
    this.input.setRawMode(true);
    this.input.resume();
    try {
      return await new Promise<T>(executor);
    } finally {
      this.input.setRawMode(false);
      this.renderedLines = 0;
    }
  }

  private clearRender() {
    for (let i = 0; i < this.renderedLines; i += 1) {
      this.output.write('\x1b[2K\r');
      if (i < this.renderedLines - 1) this.output.write('\x1b[1A');
    }
  }
}

function commonPrefix(values: string[]): string {
  if (!values.length) return '';
  let prefix = values[0];
  for (const value of values.slice(1)) while (!value.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return prefix;
}

function datasetLabel(dataset: DatasetChoice): string {
  return dataset.name ? `${dataset.id} — ${dataset.name}` : dataset.id;
}
