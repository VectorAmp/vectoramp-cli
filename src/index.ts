import { buildProgram } from './commands.js';

export { buildProgram } from './commands.js';
export { VectorAmpClient } from './client.js';

if (import.meta.url === `file://${process.argv[1]}`) {
  buildProgram().parseAsync(process.argv).catch((error) => {
    console.error(error.message ?? error);
    process.exitCode = 1;
  });
}
