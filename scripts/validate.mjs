import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

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
  'PRIVACY.md',
  'STORE_LISTING.md',
];

const privateFiles = [
  '.env',
  'data/links.local.json',
  'data/media.local.json',
];

const forbiddenSourcePatterns = [
  { pattern: /<script[^>]+src=["']https?:\/\//i, message: 'Remote script tags are not allowed in extension pages.' },
  { pattern: /<iframe[^>]+src=["']https?:\/\//i, message: 'Remote iframe widgets increase Chrome Web Store review risk and are disabled in the public build.' },
  { pattern: /\beval\s*\(/, message: 'eval() is not allowed.' },
  { pattern: /new\s+Function\s*\(/, message: 'new Function() is not allowed.' },
  { pattern: /import\s*\(\s*[`'"]https?:\/\//, message: 'Remote dynamic imports are not allowed.' },
  { pattern: /https:\/\/widgets\.dastyar\.io/i, message: 'External Dastyar widget iframe must not be in the Chrome Store build.' },
  { pattern: /https:\/\/www\.google\.com\/s2\/favicons/i, message: 'External favicon service must not be used in the Chrome Store build.' },
  { pattern: /https:\/\/icons\.duckduckgo\.com/i, message: 'External favicon service must not be used in the Chrome Store build.' },
];

async function json(filePath) {
  return JSON.parse(await readFile(filePath, 'utf8'));
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

async function readRequiredFiles() {
  for (const file of requiredFiles) {
    await readFile(file, 'utf8');
  }
}

async function validateManifest() {
  const manifest = await json('manifest.json');
  assert(manifest.manifest_version === 3, 'manifest_version must be 3');
  assert(manifest.chrome_url_overrides?.newtab === 'newtab.html', 'newtab override missing');
  assert(typeof manifest.name === 'string' && manifest.name.trim(), 'manifest.name is required');
  assert(/^\d+\.\d+\.\d+(\.\d+)?$/.test(manifest.version), 'manifest.version must be a Chrome-compatible version string');
  assert(typeof manifest.description === 'string' && manifest.description.length <= 132, 'manifest.description must be <= 132 characters');

  const permissions = manifest.permissions || [];
  assert(Array.isArray(permissions), 'permissions must be an array');
  const allowedPermissions = new Set(['storage', 'favicon']);
  for (const permission of permissions) {
    assert(allowedPermissions.has(permission), `Unexpected permission: ${permission}`);
  }
  assert(!('host_permissions' in manifest), 'host_permissions must not be present in the public build');
  assert(!('web_accessible_resources' in manifest), 'web_accessible_resources must not expose packaged data/media');
  assert(!permissions.includes('unlimitedStorage'), 'unlimitedStorage is intentionally not used in the public Chrome Store build');

  const csp = manifest.content_security_policy?.extension_pages || '';
  assert(csp.includes("script-src 'self'"), "CSP must restrict scripts to 'self'");
  assert(!/script-src[^;]*https?:/i.test(csp), 'CSP must not allow remote scripts');
  assert(!/connect-src[^;]*https?:/i.test(csp), 'CSP must not allow arbitrary remote fetches');
  assert(!/frame-src[^;]*https?:/i.test(csp), 'CSP must not allow remote frames in the public build');
}

async function validateLinks() {
  const links = await json('data/links.json');
  assert(typeof links.title === 'string' && links.title.trim(), 'links.title is required');
  assert(Array.isArray(links.groups), 'links.groups must be an array');
  for (const [groupIndex, group] of links.groups.entries()) {
    assert(typeof group.id === 'string' && group.id.trim(), `groups[${groupIndex}].id is required`);
    assert(typeof group.name === 'string' && group.name.trim(), `groups[${groupIndex}].name is required`);
    assert(Array.isArray(group.links), `groups[${groupIndex}].links must be an array`);
    for (const [linkIndex, link] of group.links.entries()) {
      assert(typeof link.id === 'string' && link.id.trim(), `groups[${groupIndex}].links[${linkIndex}].id is required`);
      assert(typeof link.label === 'string' && link.label.trim(), `groups[${groupIndex}].links[${linkIndex}].label is required`);
      assertUrl(link.url, `groups[${groupIndex}].links[${linkIndex}].url`);
    }
  }
}

async function validateMedia() {
  const media = await json('data/media.json');
  assert(Array.isArray(media.photos), 'media.photos must be an array');
  assert(Array.isArray(media.videos), 'media.videos must be an array');
  for (const [key, items] of Object.entries({ photos: media.photos, videos: media.videos })) {
    for (const [index, item] of items.entries()) {
      assert(typeof item.path === 'string' && item.path.trim(), `${key}[${index}].path is required`);
      assert(item.path.startsWith('media/samples/'), `${key}[${index}].path must stay inside media/samples/ in the public build`);
      assert(existsSync(item.path), `${key}[${index}].path does not exist: ${item.path}`);
    }
  }
}

async function validateNoPrivateFiles() {
  for (const file of privateFiles) {
    assert(!existsSync(file), `Private file must not be committed: ${file}`);
  }

  for (const dir of ['media/photos', 'media/videos']) {
    if (!existsSync(dir)) continue;
    const entries = await readdir(dir);
    assert(entries.length === 0, `${dir} must not contain personal media in the public build`);
  }
}

async function validateSourceSafety() {
  const sourceFiles = ['newtab.html', 'newtab.js', 'newtab.css', 'manifest.json'];
  for (const file of sourceFiles) {
    const text = await readFile(file, 'utf8');
    for (const { pattern, message } of forbiddenSourcePatterns) {
      assert(!pattern.test(text), `${file}: ${message}`);
    }
  }
}

async function main() {
  await readRequiredFiles();
  await validateManifest();
  await validateLinks();
  await validateMedia();
  await validateNoPrivateFiles();
  await validateSourceSafety();
  console.log('NeTab validation passed.');
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
