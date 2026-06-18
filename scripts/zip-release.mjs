import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, rm } from 'node:fs/promises';

const execFileAsync = promisify(execFile);
const releaseDir = 'release';
const chromeZip = `${releaseDir}/netab-chrome-webstore.zip`;
const publicZip = `${releaseDir}/netab-public-source.zip`;

const packageFiles = [
  'manifest.json',
  'newtab.html',
  'newtab.css',
  'newtab.js',
  'data/links.json',
  'data/media.json',
  'media/samples',
];

const publicFiles = [
  ...packageFiles,
  '.github/workflows/ci.yml',
  '.gitignore',
  '.env.example',
  'LICENSE',
  'README.md',
  'PRIVACY.md',
  'STORE_LISTING.md',
  'package.json',
  'scripts',
  'data/links.example.json',
  'data/media.example.json',
  'docs/screenshots',
  'media/.gitkeep',
];

async function zip(outPath, files) {
  await rm(outPath, { force: true });
  await execFileAsync('zip', ['-r', outPath, ...files]);
}

await mkdir(releaseDir, { recursive: true });
await zip(chromeZip, packageFiles);
await zip(publicZip, publicFiles);

console.log(`Created ${chromeZip}`);
console.log(`Created ${publicZip}`);
