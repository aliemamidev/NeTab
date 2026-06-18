import { readFile } from 'node:fs/promises';

const requiredFiles = [
  'manifest.json',
  'newtab.html',
  'newtab.css',
  'newtab.js',
  'data/links.json',
  'data/media.json',
  'data/links.example.json',
  'data/media.example.json',
  '.gitignore',
  '.env.example',
];

async function json(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertUrl(value, context) {
  try {
    const url = new URL(value);
    assert(['http:', 'https:'].includes(url.protocol), `${context} must be http(s)`);
  } catch {
    throw new Error(`${context} is not a valid URL: ${value}`);
  }
}

for (const file of requiredFiles) {
  await readFile(file, 'utf8');
}

const manifest = await json('manifest.json');
assert(manifest.manifest_version === 3, 'manifest_version must be 3');
assert(manifest.chrome_url_overrides?.newtab === 'newtab.html', 'newtab override missing');
assert(Array.isArray(manifest.permissions), 'permissions must be an array');

const links = await json('data/links.json');
assert(typeof links.title === 'string' && links.title.trim(), 'links.title is required');
assert(Array.isArray(links.groups), 'links.groups must be an array');
for (const [groupIndex, group] of links.groups.entries()) {
  assert(typeof group.name === 'string' && group.name.trim(), `groups[${groupIndex}].name is required`);
  assert(Array.isArray(group.links), `groups[${groupIndex}].links must be an array`);
  for (const [linkIndex, link] of group.links.entries()) {
    assert(typeof link.label === 'string' && link.label.trim(), `groups[${groupIndex}].links[${linkIndex}].label is required`);
    assertUrl(link.url, `groups[${groupIndex}].links[${linkIndex}].url`);
  }
}

const media = await json('data/media.json');
assert(Array.isArray(media.photos), 'media.photos must be an array');
assert(Array.isArray(media.videos), 'media.videos must be an array');
for (const [key, items] of Object.entries({ photos: media.photos, videos: media.videos })) {
  for (const [index, item] of items.entries()) {
    assert(typeof item.path === 'string' && item.path.trim(), `${key}[${index}].path is required`);
    assert(item.path.startsWith('media/'), `${key}[${index}].path must start with media/`);
  }
}

console.log('NeTab validation passed.');
