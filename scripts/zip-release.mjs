import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';

const execFileAsync = promisify(execFile);
await mkdir('release', { recursive: true });
await execFileAsync('zip', [
  '-r',
  'release/netab-extension.zip',
  '.',
  '-x',
  '.git/*',
  'release/*',
  'node_modules/*',
  '.env',
  '.env.*',
  'data/*.local.json',
  'media/photos/*',
  'media/videos/*',
]);
console.log('Created release/netab-extension.zip');
