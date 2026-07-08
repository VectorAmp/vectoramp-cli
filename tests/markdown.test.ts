import { describe, expect, it } from 'vitest';
import { renderTerminalMarkdown, TerminalMarkdownStreamRenderer } from '../src/markdown.js';

const stripAnsi = (value: string) => value.replace(/\u001b\[[0-9;]*m/g, '');

describe('renderTerminalMarkdown', () => {
  it('renders common inline markdown into terminal text', () => {
    const out = stripAnsi(renderTerminalMarkdown('This is **bold**, *italic*, and `code`.'));
    expect(out).toBe('This is bold, italic, and code.');
  });

  it('renders headings, bullets, ordered lists, and fenced code blocks without raw markdown markers', () => {
    const out = stripAnsi(renderTerminalMarkdown(['## Items', '- **first** item', '* `second` item', '1. _third_ item', '```ts', 'const ok = true;', '```'].join('\n')));
    expect(out).toBe(['Items', '• first item', '• second item', '1. third item', '', '╭─ code · ts ─', '│ const ok = true;', '╰────────'].join('\n'));
    expect(out).not.toContain('```');
  });
});

describe('TerminalMarkdownStreamRenderer', () => {
  it('writes completed lines before the stream ends and flushes the final partial line', () => {
    const writes: string[] = [];
    const renderer = new TerminalMarkdownStreamRenderer((value) => writes.push(value));
    renderer.write('Streaming plain text.\n');
    renderer.write('- `dog`');
    expect(stripAnsi(writes.join(''))).toBe('Streaming plain text.\n');
    renderer.end();
    expect(stripAnsi(writes.join(''))).toBe('Streaming plain text.\n• dog\n');
  });

  it('renders fenced code blocks incrementally by line', () => {
    const writes: string[] = [];
    const renderer = new TerminalMarkdownStreamRenderer((value) => writes.push(value));
    renderer.write('```ts\n');
    renderer.write('const ok = true;\n');
    renderer.write('```\n');
    renderer.end();
    expect(stripAnsi(writes.join(''))).toBe(['╭─ code · ts ─', '│ const ok = true;', '╰────────', '', ''].join('\n'));
  });

  it('flushes long partial prose before a newline so streaming remains live', () => {
    const writes: string[] = [];
    const renderer = new TerminalMarkdownStreamRenderer((value) => writes.push(value));
    const longLine = 'This is a long streamed answer without newline chunks. '.repeat(5);

    renderer.write(longLine);

    expect(writes.length).toBeGreaterThan(0);
    expect(stripAnsi(writes.join(''))).toContain('This is a long streamed answer');

    renderer.end();
    expect(stripAnsi(writes.join(''))).toBe(`${longLine}\n`);
  });
});
