import { describe, expect, it } from 'vitest';
import {
  confluenceSource, fileUploadSource, gcsSource, googleDriveSource, jiraSource,
  s3Source, source, toSourceBody, webSource,
} from '../src/sources.js';

describe('ingestion source helpers', () => {
  it('builds a web source from a bare URL string', () => {
    expect(webSource('https://docs.example.com')).toEqual({
      sourceType: 'web',
      name: undefined,
      description: undefined,
      config: { start_urls: ['https://docs.example.com'] },
      metadata: undefined,
    });
  });

  it('builds a web source with crawl options', () => {
    const built = webSource({ startUrls: ['https://a.com', 'https://b.com'], maxDepth: 2, includeAssets: false, name: 'docs' });
    expect(built.config).toEqual({ start_urls: ['https://a.com', 'https://b.com'], max_depth: 2, include_assets: false });
    expect(built.name).toBe('docs');
  });

  it('builds s3 and gcs sources and requires a bucket', () => {
    expect(s3Source({ bucket: 'b', prefix: 'p/', region: 'us-west-2' }).config).toEqual({ bucket: 'b', prefix: 'p/', region: 'us-west-2' });
    expect(gcsSource({ bucket: 'g', projectId: 'proj' }).config).toMatchObject({ bucket: 'g', project_id: 'proj' });
    expect(() => s3Source({ bucket: '' })).toThrow(/bucket/);
  });

  it('builds a google_drive source from folder ids', () => {
    expect(googleDriveSource({ folderIds: ['fid'] }).config).toMatchObject({ folder_ids: ['fid'] });
    expect(() => googleDriveSource({})).toThrow(/folderIds|fileIds/);
  });

  it('builds a jira source with project keys', () => {
    expect(jiraSource({ cloudId: 'c', projectKeys: ['ENG'], includeComments: true }).config).toMatchObject({ cloud_id: 'c', projects: ['ENG'], include_comments: true });
  });

  it('builds a confluence source (the previously missing helper)', () => {
    const built = confluenceSource({ cloudId: 'cid', username: 'u', apiToken: 't', spaces: ['ENG', 'OPS'], includeAttachments: true });
    expect(built.sourceType).toBe('confluence');
    expect(built.config).toEqual({
      cloud_id: 'cid',
      username: 'u',
      api_token: 't',
      spaces: ['ENG', 'OPS'],
      include_attachments: true,
    });
  });

  it('confluence requires cloudId or baseUrl', () => {
    expect(() => confluenceSource({})).toThrow(/cloudId|baseUrl/);
    expect(confluenceSource({ baseUrl: 'https://x.atlassian.net' }).config).toMatchObject({ base_url: 'https://x.atlassian.net' });
  });

  it('does not force sync_mode so the server applies its incremental default', () => {
    expect(confluenceSource({ cloudId: 'c' }).config.sync_mode).toBeUndefined();
    expect(s3Source({ bucket: 'b' }).config.sync_mode).toBeUndefined();
    // ...but honors an explicit override.
    expect(confluenceSource({ cloudId: 'c', syncMode: 'full' }).config.sync_mode).toBe('full');
  });

  it('file_upload and generic escape hatch', () => {
    expect(fileUploadSource({ name: 'up' })).toMatchObject({ sourceType: 'file_upload', name: 'up' });
    expect(source({ sourceType: 'notion', config: { token: 'x' } })).toMatchObject({ sourceType: 'notion', config: { token: 'x' } });
    expect(() => source({ sourceType: '' })).toThrow(/sourceType/);
  });

  it('toSourceBody normalizes strings into web sources', () => {
    expect(toSourceBody('https://x.com').sourceType).toBe('web');
    expect(toSourceBody(confluenceSource({ cloudId: 'c' })).sourceType).toBe('confluence');
  });
});
