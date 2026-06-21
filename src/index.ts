import { realpathSync } from 'fs';
import { fileURLToPath } from 'url';
import { buildProgram } from './commands.js';

export { buildProgram } from './commands.js';
export { VectorAmpClient, VectorAmpApiError, collectFiles } from './client.js';
export type { VectorRecord, SearchOptions, IngestFile, StreamEvent } from './client.js';
export {
  webSource, s3Source, gcsSource, googleDriveSource, jiraSource, confluenceSource,
  fileUploadSource, source, SOURCE_TYPES,
} from './sources.js';
export type { SourceDescriptor, SourceInput, SourceType } from './sources.js';
export { openai, embeddingDimensions } from './embeddings.js';

function isEntrypoint(): boolean {
  if (!process.argv[1]) return false;
  return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
}

if (isEntrypoint()) {
  buildProgram().parseAsync(process.argv).catch((error) => {
    if (error?.code === 'commander.helpDisplayed' || error?.code === 'commander.version') {
      process.exitCode = 0;
      return;
    }
    console.error(error.message ?? error);
    process.exitCode = 1;
  });
}
