// Canonical ingestion source helpers/builders (§4 of the DX contract).
// Each helper returns a normalized source descriptor — `{ source_type, name?,
// description?, config, metadata? }` — that is passed straight into
// `client.createSource(...)` or `dataset.ingestSource(...)`. Required fields are
// enforced; optional fields are only sent when provided so the server applies
// its own documented defaults (e.g. sync_mode "incremental").

export interface SourceDescriptor {
  sourceType: string;
  name?: string;
  description?: string;
  config: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export type SourceInput = SourceDescriptor | string;

function clean(config: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined));
}

function asArray(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

export interface WebSourceOptions {
  startUrls?: string | string[];
  name?: string;
  description?: string;
  maxDepth?: number;
  maxPages?: number;
  allowedDomains?: string[];
  includeAssets?: boolean;
  maxAssetsPerPage?: number;
  selectors?: Record<string, unknown>;
  headers?: Record<string, string>;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/** Web crawler source. Accepts a single URL string or an options object. */
export function webSource(input: string | WebSourceOptions): SourceDescriptor {
  const options = typeof input === 'string' ? { startUrls: input } : input;
  const startUrls = asArray(options.startUrls);
  if (!startUrls || !startUrls.length) throw new Error('webSource requires at least one start URL.');
  return {
    sourceType: 'web',
    name: options.name,
    description: options.description,
    config: clean({
      start_urls: startUrls,
      max_depth: options.maxDepth,
      max_pages: options.maxPages,
      allowed_domains: options.allowedDomains,
      include_assets: options.includeAssets,
      max_assets_per_page: options.maxAssetsPerPage,
      selectors: options.selectors,
      headers: options.headers,
      ...options.config,
    }),
    metadata: options.metadata,
  };
}

export interface S3SourceOptions {
  bucket: string;
  prefix?: string;
  region?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  filePatterns?: string[];
  maxFileSizeMb?: number;
  syncMode?: 'full' | 'incremental';
  name?: string;
  description?: string;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export function s3Source(options: S3SourceOptions): SourceDescriptor {
  if (!options.bucket) throw new Error('s3Source requires a bucket.');
  return {
    sourceType: 's3',
    name: options.name,
    description: options.description,
    config: clean({
      bucket: options.bucket,
      prefix: options.prefix,
      region: options.region,
      access_key_id: options.accessKeyId,
      secret_access_key: options.secretAccessKey,
      file_patterns: options.filePatterns,
      max_file_size_mb: options.maxFileSizeMb,
      sync_mode: options.syncMode,
      ...options.config,
    }),
    metadata: options.metadata,
  };
}

export interface GcsSourceOptions {
  bucket: string;
  prefix?: string;
  projectId?: string;
  authMode?: 'service_account' | 'oauth' | 'adc';
  serviceAccountJson?: string;
  credentialsJson?: string;
  filePatterns?: string[];
  syncMode?: 'full' | 'incremental';
  name?: string;
  description?: string;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export function gcsSource(options: GcsSourceOptions): SourceDescriptor {
  if (!options.bucket) throw new Error('gcsSource requires a bucket.');
  return {
    sourceType: 'gcs',
    name: options.name,
    description: options.description,
    config: clean({
      bucket: options.bucket,
      prefix: options.prefix,
      project_id: options.projectId,
      auth_mode: options.authMode,
      service_account_json: options.serviceAccountJson,
      credentials_json: options.credentialsJson,
      file_patterns: options.filePatterns,
      sync_mode: options.syncMode,
      ...options.config,
    }),
    metadata: options.metadata,
  };
}

export interface GoogleDriveSourceOptions {
  folderIds?: string[];
  fileIds?: string[];
  authMode?: 'service_account' | 'oauth';
  serviceAccountJson?: string;
  oauthCredentials?: Record<string, unknown>;
  driveId?: string;
  mimeTypes?: string[];
  syncMode?: 'full' | 'incremental';
  name?: string;
  description?: string;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export function googleDriveSource(options: GoogleDriveSourceOptions): SourceDescriptor {
  if (!options.folderIds?.length && !options.fileIds?.length) {
    throw new Error('googleDriveSource requires folderIds or fileIds.');
  }
  return {
    sourceType: 'gdrive',
    name: options.name,
    description: options.description,
    config: clean({
      auth_mode: options.authMode,
      service_account_json: options.serviceAccountJson,
      oauth_credentials: options.oauthCredentials,
      drive_id: options.driveId,
      folder_ids: options.folderIds,
      file_ids: options.fileIds,
      mime_types: options.mimeTypes,
      sync_mode: options.syncMode,
      ...options.config,
    }),
    metadata: options.metadata,
  };
}

export interface JiraSourceOptions {
  cloudId?: string;
  baseUrl?: string;
  accessToken?: string;
  username?: string;
  apiToken?: string;
  projectKeys?: string[];
  jql?: string;
  includeComments?: boolean;
  syncMode?: 'full' | 'incremental';
  name?: string;
  description?: string;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export function jiraSource(options: JiraSourceOptions = {}): SourceDescriptor {
  return {
    sourceType: 'jira',
    name: options.name,
    description: options.description,
    config: clean({
      cloud_id: options.cloudId,
      base_url: options.baseUrl,
      access_token: options.accessToken,
      username: options.username,
      api_token: options.apiToken,
      projects: options.projectKeys,
      jql: options.jql,
      include_comments: options.includeComments,
      sync_mode: options.syncMode,
      ...options.config,
    }),
    metadata: options.metadata,
  };
}

export interface ConfluenceSourceOptions {
  cloudId?: string;
  baseUrl?: string;
  authMode?: 'basic' | 'oauth';
  username?: string;
  apiToken?: string;
  oauthCredentials?: Record<string, unknown>;
  spaces?: string[];
  includeAttachments?: boolean;
  syncMode?: 'full' | 'incremental';
  name?: string;
  description?: string;
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

/** Confluence spaces/pages source (§4 — previously missing from this client). */
export function confluenceSource(options: ConfluenceSourceOptions = {}): SourceDescriptor {
  if (!options.cloudId && !options.baseUrl) {
    throw new Error('confluenceSource requires cloudId or baseUrl.');
  }
  return {
    sourceType: 'confluence',
    name: options.name,
    description: options.description,
    config: clean({
      cloud_id: options.cloudId,
      base_url: options.baseUrl,
      auth_mode: options.authMode,
      username: options.username,
      api_token: options.apiToken,
      oauth_credentials: options.oauthCredentials,
      spaces: options.spaces,
      include_attachments: options.includeAttachments,
      sync_mode: options.syncMode,
      ...options.config,
    }),
    metadata: options.metadata,
  };
}

export interface FileUploadSourceOptions {
  name?: string;
  description?: string;
  storageProvider?: string;
  syncMode?: 'full' | 'incremental';
  config?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export function fileUploadSource(options: FileUploadSourceOptions = {}): SourceDescriptor {
  return {
    sourceType: 'file_upload',
    name: options.name,
    description: options.description,
    config: clean({
      storage_provider: options.storageProvider,
      sync_mode: options.syncMode,
      ...options.config,
    }),
    metadata: options.metadata,
  };
}

export interface GenericSourceOptions {
  sourceType: string;
  config?: Record<string, unknown>;
  name?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

/** Escape hatch for source types without a dedicated helper. */
export function source(options: GenericSourceOptions): SourceDescriptor {
  if (!options.sourceType) throw new Error('source requires a sourceType.');
  return {
    sourceType: options.sourceType,
    name: options.name,
    description: options.description,
    config: clean({ ...(options.config ?? {}) }),
    metadata: options.metadata,
  };
}

export const SOURCE_TYPES = ['web', 's3', 'gcs', 'gdrive', 'jira', 'confluence', 'file_upload'] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/** Normalize a string or descriptor into the body createSource() expects. */
export function toSourceBody(input: SourceInput): SourceDescriptor {
  return typeof input === 'string' ? webSource(input) : input;
}
