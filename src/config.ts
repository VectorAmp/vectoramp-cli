import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

export interface VectorAmpConfig {
  apiKey?: string;
  baseUrl?: string;
  apiPrefix?: string;
  datasetId?: string;
}

export const DEFAULT_BASE_URL = 'https://api.vectoramp.com';
export const DEFAULT_API_PREFIX = '/api/v1';

export function configPath(): string {
  return process.env.VECTORAMP_CONFIG ?? join(homedir(), '.config', 'vectoramp', 'config.json');
}

export async function readConfig(): Promise<VectorAmpConfig> {
  try {
    return JSON.parse(await readFile(configPath(), 'utf8')) as VectorAmpConfig;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export async function writeConfig(config: VectorAmpConfig): Promise<void> {
  const path = configPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

export async function resolveConfig(overrides: VectorAmpConfig = {}): Promise<Required<Pick<VectorAmpConfig, 'baseUrl' | 'apiPrefix'>> & VectorAmpConfig> {
  const local = await readConfig();
  return {
    ...local,
    ...overrides,
    apiKey: overrides.apiKey ?? process.env.VECTORAMP_API_KEY ?? local.apiKey,
    baseUrl: overrides.baseUrl ?? process.env.VECTORAMP_BASE_URL ?? local.baseUrl ?? DEFAULT_BASE_URL,
    apiPrefix: overrides.apiPrefix ?? process.env.VECTORAMP_API_PREFIX ?? local.apiPrefix ?? DEFAULT_API_PREFIX
  };
}
