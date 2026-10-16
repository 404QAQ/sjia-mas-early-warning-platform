import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const tsc = path.join(scriptDir, '..', 'node_modules', '.pnpm', 'typescript@5.6.3', 'node_modules', 'typescript', 'lib', 'tsc.js');
const result = spawnSync(process.execPath, [tsc, ...process.argv.slice(2)], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
