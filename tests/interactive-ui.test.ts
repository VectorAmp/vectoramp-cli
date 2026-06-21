import { describe, expect, it } from 'vitest';
import { commandHelp, completeSlashCommand, extractDatasets, filterCommands, filterDatasets, formatCwd, normalizeSlashCommand, promptRuleWidth, renderBanner, renderPromptRule, SLASH_COMMANDS } from '../src/interactive-ui.js';

describe('interactive command catalog', () => {
  it('filters slash commands by typed prefix', () => {
    expect(filterCommands('/se').map((command) => command.name)).toEqual(['/search']);
    expect(filterCommands('/dat').map((command) => command.name)).toEqual(['/datasets']);
    // /datasets (picker) and /use (direct switch) are now distinct commands.
    expect(filterCommands('/us').map((command) => command.name)).toEqual(['/use']);
    expect(filterCommands('/use ')).toEqual([]);
    expect(filterCommands('/ask dogs')).toEqual([]);
    expect(filterCommands('plain text')).toEqual([]);
  });

  it('completes slash commands on tab', () => {
    expect(completeSlashCommand('/sea')).toBe('/search ');
    expect(completeSlashCommand('/dat')).toBe('/datasets ');
    expect(completeSlashCommand('/us')).toBe('/use ');
    expect(completeSlashCommand('/s')).toBeUndefined();
    expect(completeSlashCommand('/search query')).toBeUndefined();
  });

  it('keeps descriptions for every command shown in the palette', () => {
    expect(SLASH_COMMANDS.every((command) => command.description.length > 0)).toBe(true);
  });

  it('normalizes status/new/quit aliases and documents them in help', () => {
    expect(normalizeSlashCommand('/status')).toBe('/context');
    expect(normalizeSlashCommand('/context')).toBe('/context');
    expect(normalizeSlashCommand('/new')).toBe('/reset');
    expect(normalizeSlashCommand('/quit')).toBe('/exit');
    expect(commandHelp()).toContain('/context (/status)');
  });

  it('exposes both the dataset picker and a direct /use switch', () => {
    const names = SLASH_COMMANDS.map((command) => command.name);
    expect(names).toContain('/datasets');
    expect(names).toContain('/use');
    expect(names).toContain('/context');
  });
});

describe('dataset picker helpers', () => {
  const response = {
    datasets: [
      { id: 'ds_docs', name: 'Docs' },
      { dataset_id: 'ds_support', name: 'Support tickets', description: 'help desk' },
    ],
  };

  it('extracts datasets from public list responses', () => {
    expect(extractDatasets(response)).toEqual([
      { id: 'ds_docs', name: 'Docs', description: undefined },
      { id: 'ds_support', name: 'Support tickets', description: 'help desk' },
    ]);
  });

  it('filters datasets by id, name, or description', () => {
    const datasets = extractDatasets(response);
    expect(filterDatasets('support', datasets).map((dataset) => dataset.id)).toEqual(['ds_support']);
    expect(filterDatasets('help', datasets).map((dataset) => dataset.id)).toEqual(['ds_support']);
    expect(filterDatasets('', datasets).map((dataset) => dataset.id)).toEqual(['ds_docs', 'ds_support']);
  });
});

describe('interactive banner', () => {
  it('includes VectorAmp branding and current working directory context', () => {
    const banner = renderBanner({ cwd: '/tmp/project', datasetId: 'ds_123' });
    expect(banner).toContain('[ VectorAmp ]');
    expect(banner).toContain('/tmp/project');
    expect(banner).toContain('ds_123');
    expect(banner).toContain('│ cwd /tmp/project');
    expect(banner).toContain('│ ctx active dataset: ds_123');
  });

  it('shortens home-relative cwd paths', () => {
    expect(formatCwd('/home/jonathan/repos/app', '/home/jonathan')).toBe('~/repos/app');
    expect(formatCwd('/home/jonathan', '/home/jonathan')).toBe('~');
    expect(formatCwd('/srv/app', '/home/jonathan')).toBe('/srv/app');
  });
});


describe('prompt rendering helpers', () => {
  it('uses almost the full terminal width while enforcing a usable minimum', () => {
    expect(promptRuleWidth(120)).toBe(116);
    expect(promptRuleWidth(40)).toBe(56);
    expect(renderPromptRule(72)).toContain('─'.repeat(68));
  });
});
