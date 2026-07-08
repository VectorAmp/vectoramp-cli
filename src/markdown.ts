import chalk from 'chalk';

/**
 * Lightweight terminal renderer for markdown fragments returned by Intelligence.
 * It intentionally covers the common chat shapes without adding a full markdown
 * parser dependency to the CLI: headings, bullets, emphasis, inline code, and
 * fenced code blocks.
 */
export function renderTerminalMarkdown(markdown: string): string {
  if (!markdown) return markdown;
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  const rendered: string[] = [];
  let inFence = false;
  let fenceLanguage = '';

  for (const line of lines) {
    const fence = line.match(/^\s*```\s*([^`]*)\s*$/);
    if (fence) {
      inFence = !inFence;
      fenceLanguage = inFence ? fence[1].trim() : '';
      if (inFence) {
        if (rendered.length && rendered[rendered.length - 1] !== '') rendered.push('');
        rendered.push(chalk.dim(`╭─ code${fenceLanguage ? ` · ${fenceLanguage}` : ''} ─`));
      } else {
        rendered.push(chalk.dim('╰────────'));
        rendered.push('');
      }
      continue;
    }

    if (inFence) {
      rendered.push(`${chalk.dim('│')} ${chalk.cyan(line)}`);
      continue;
    }

    rendered.push(renderMarkdownLine(line));
  }

  return rendered.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

/**
 * Pragmatic streaming markdown renderer for terminal output.
 *
 * Streaming and markdown are at odds: emphasis, lists, and code fences can be
 * split across chunks, so rendering each raw chunk leaks markdown markers. This
 * renderer keeps only the current incomplete line buffered, writes completed
 * lines immediately, and flushes the final partial line on end. That preserves
 * live output for normal chat responses while still cleaning the common markdown
 * shapes this CLI supports.
 */
export class TerminalMarkdownStreamRenderer {
  private static readonly PARTIAL_FLUSH_CHARS = 120;
  private readonly renderer = new TerminalMarkdownLineRenderer();
  private buffer = '';

  constructor(private readonly writeOutput: (value: string) => void) {}

  write(chunk: string): void {
    if (!chunk) return;
    this.buffer += chunk.replace(/\r\n/g, '\n');
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex !== -1) {
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.writeOutput(`${this.renderer.renderLine(line)}\n`);
      newlineIndex = this.buffer.indexOf('\n');
    }
    this.flushLongPartialLine();
  }

  end(): void {
    if (this.buffer) {
      this.writeOutput(this.renderer.renderLine(this.buffer));
      this.buffer = '';
    }
    this.writeOutput('\n');
  }

  private flushLongPartialLine(): void {
    while (!this.renderer.isInsideFence() && this.buffer.length >= TerminalMarkdownStreamRenderer.PARTIAL_FLUSH_CHARS) {
      const splitIndex = findPartialFlushIndex(this.buffer, TerminalMarkdownStreamRenderer.PARTIAL_FLUSH_CHARS);
      if (splitIndex <= 0) return;
      const partial = this.buffer.slice(0, splitIndex);
      this.buffer = this.buffer.slice(splitIndex);
      this.writeOutput(this.renderer.renderLine(partial));
    }
  }
}

class TerminalMarkdownLineRenderer {
  private inFence = false;
  private fenceLanguage = '';

  isInsideFence(): boolean { return this.inFence; }

  renderLine(line: string): string {
    const fence = line.match(/^\s*```\s*([^`]*)\s*$/);
    if (fence) {
      this.inFence = !this.inFence;
      this.fenceLanguage = this.inFence ? fence[1].trim() : '';
      if (this.inFence) return chalk.dim(`╭─ code${this.fenceLanguage ? ` · ${this.fenceLanguage}` : ''} ─`);
      return chalk.dim('╰────────');
    }

    if (this.inFence) return `${chalk.dim('│')} ${chalk.cyan(line)}`;

    return renderMarkdownLine(line);
  }
}

function findPartialFlushIndex(buffer: string, target: number): number {
  const searchStart = Math.max(0, target - 40);
  const searchEnd = Math.min(buffer.length, target + 40);
  for (let index = searchEnd; index >= searchStart; index -= 1) {
    if (/\s/.test(buffer[index] ?? '')) return index + 1;
  }
  return buffer.length >= target * 2 ? target : -1;
}

function renderMarkdownLine(line: string): string {
  const heading = line.match(/^(#{1,6})\s+(.+)$/);
  if (heading) return chalk.bold.cyan(heading[2]);

  const bullet = line.match(/^(\s*)[-*+]\s+(.+)$/);
  if (bullet) return `${bullet[1]}${chalk.cyan('•')} ${renderInlineMarkdown(bullet[2])}`;

  const ordered = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
  if (ordered) return `${ordered[1]}${chalk.cyan(`${ordered[2]}.`)} ${renderInlineMarkdown(ordered[3])}`;

  return renderInlineMarkdown(line);
}

function renderInlineMarkdown(input: string): string {
  const placeholders: string[] = [];
  const store = (value: string) => {
    const key = `\u0000${placeholders.length}\u0000`;
    placeholders.push(value);
    return key;
  };

  let output = input.replace(/`([^`\n]+)`/g, (_match, code: string) => store(chalk.cyan(code)));
  output = output.replace(/\*\*([^*\n]+)\*\*/g, (_match, text: string) => chalk.bold(text));
  output = output.replace(/__([^_\n]+)__/g, (_match, text: string) => chalk.bold(text));
  output = output.replace(/(^|\W)\*([^*\n]+)\*(?=\W|$)/g, (_match, prefix: string, text: string) => `${prefix}${chalk.italic(text)}`);
  output = output.replace(/(^|\W)_([^_\n]+)_(?=\W|$)/g, (_match, prefix: string, text: string) => `${prefix}${chalk.italic(text)}`);

  return output.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => placeholders[Number(index)] ?? '');
}
