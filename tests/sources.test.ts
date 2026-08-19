import { describe, expect, it } from 'vitest';
import {
  SOURCE_TYPES, confluenceSource, fileUploadSource, gcsSource, githubSource,
  gitlabSource, googleDriveSource, jiraSource, s3Source, source, toSourceBody,
  webSource,
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

  it('builds a github source from an installation id and repositories', () => {
    const built = githubSource({ installationId: 12345678, repositories: ['VectorAmp/Docs', 'VectorAmp/Web'] });
    expect(built.sourceType).toBe('github');
    expect(built.config).toEqual({
      installation_id: 12345678,
      repositories: ['VectorAmp/Docs', 'VectorAmp/Web'],
    });
    // GitHub authenticates via the App installation, never a token.
    expect(built.config.access_token).toBeUndefined();
    expect(built.config.connection_id).toBeUndefined();
  });

  it('github carries ref selection and content toggles through', () => {
    const built = githubSource({
      installationId: 7,
      repositories: ['o/r'],
      refMode: 'explicit',
      refs: ['main'],
      excludedRefs: ['wip'],
      activeBranchDays: 30,
      includePullRequests: false,
      includeReviewThreads: false,
      includeDirectCommits: false,
      includeGlobs: ['**/*.ts'],
      excludeGlobs: ['dist/**'],
      maxFileSizeBytes: 2_000_000,
    });
    expect(built.config).toMatchObject({
      ref_mode: 'explicit',
      refs: ['main'],
      excluded_refs: ['wip'],
      active_branch_days: 30,
      include_pull_requests: false,
      include_review_threads: false,
      include_direct_commits: false,
      include_globs: ['**/*.ts'],
      exclude_globs: ['dist/**'],
      max_file_size_bytes: 2_000_000,
    });
  });

  it('github requires an installation id and at least one repository', () => {
    expect(() => githubSource({ installationId: 0, repositories: ['o/r'] })).toThrow(/installationId/);
    expect(() => githubSource({ installationId: 1, repositories: [] })).toThrow(/repository/);
  });

  it('builds a gitlab source scoped by groups or projects', () => {
    expect(gitlabSource({ projects: ['platform/ingestion'], connectionId: 'conn-gl' }).config).toEqual({
      connection_id: 'conn-gl',
      projects: ['platform/ingestion'],
    });
    expect(gitlabSource({ groups: ['platform'] }).sourceType).toBe('gitlab');
  });

  it('gitlab supports token auth against a self-managed instance', () => {
    const built = gitlabSource({
      authMode: 'token',
      gitlabUrl: 'https://gitlab.example.com',
      accessToken: 'glpat-secret',
      groups: ['infra'],
      includeMergeRequests: true,
    });
    expect(built.config).toMatchObject({
      auth_mode: 'token',
      gitlab_url: 'https://gitlab.example.com',
      access_token: 'glpat-secret',
      include_merge_requests: true,
    });
    // GitLab models merge requests, not pull requests.
    expect(built.config.include_pull_requests).toBeUndefined();
  });

  it('gitlab requires at least one group or project', () => {
    expect(() => gitlabSource({})).toThrow(/group or project/);
    expect(() => gitlabSource({ groups: [], projects: [] })).toThrow(/group or project/);
  });

  it('github and gitlab omit optional fields so server defaults apply', () => {
    const gh = githubSource({ installationId: 1, repositories: ['o/r'] }).config;
    const gl = gitlabSource({ groups: ['g'] }).config;
    for (const key of ['ref_mode', 'sync_mode', 'active_branch_days', 'max_file_size_bytes']) {
      expect(gh[key]).toBeUndefined();
      expect(gl[key]).toBeUndefined();
    }
    // auth_mode defaults to oauth server-side, so it is not sent unless set.
    expect(gl.auth_mode).toBeUndefined();
  });

  it('exposes github and gitlab as public source types', () => {
    expect(SOURCE_TYPES).toContain('github');
    expect(SOURCE_TYPES).toContain('gitlab');
  });
});
