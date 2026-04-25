import { describe, expect, it } from 'vitest';
import { completeSlashCommand, extractDatasets, filterCommands, filterDatasets, renderBanner, SLASH_COMMANDS } from '../src/interactive-ui.js';

describe('interactive command catalog', () => {
  it('filters slash commands by typed prefix', () => {
    expect(filterCommands('/se').map((command) => command.name)).toEqual(['/search']);
    expect(filterCommands('plain text')).toEqual([]);
  });

  it('completes slash commands on tab', () => {
    expect(completeSlashCommand('/sea')).toBe('/search ');
    expect(completeSlashCommand('/s')).toBeUndefined();
    expect(completeSlashCommand('/search query')).toBeUndefined();
  });

  it('keeps descriptions for every command shown in the palette', () => {
    expect(SLASH_COMMANDS.every((command) => command.description.length > 0)).toBe(true);
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
  });
});
