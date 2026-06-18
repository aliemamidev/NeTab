import { readFile, writeFile } from 'node:fs/promises';

function parseEnv(text) {
  const out = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

async function main() {
  let envText = '';
  try {
    envText = await readFile('.env', 'utf8');
  } catch {
    console.log('No .env file found. Copy .env.example to .env first.');
    return;
  }
  const env = parseEnv(envText);
  const writes = [];
  if (env.NETAB_LINKS_JSON) {
    const parsed = JSON.parse(env.NETAB_LINKS_JSON);
    writes.push(writeFile('data/links.local.json', `${JSON.stringify(parsed, null, 2)}\n`));
  }
  if (env.NETAB_MEDIA_JSON) {
    const parsed = JSON.parse(env.NETAB_MEDIA_JSON);
    writes.push(writeFile('data/media.local.json', `${JSON.stringify(parsed, null, 2)}\n`));
  }
  await Promise.all(writes);
  console.log(writes.length ? 'Local JSON files updated from .env.' : 'No NETAB_* JSON values found in .env.');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
