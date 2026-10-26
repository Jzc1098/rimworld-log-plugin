/**
 * Stamp every block with who wrote it, when, and a sub-version.
 *
 * Why a registry instead of a comment header in each block: three of this plugin's files are JSON, and
 * several of its generators build Markdown from template literals. Injecting a comment into a JSON file
 * makes it invalid, and injecting one into a template literal can change the document the tool emits.
 * A sidecar registry cannot damage anything it describes.
 *
 * Sub-version format: `<plugin version>.<author>.<author's running number>`, e.g. `1.1.0.lin.003`.
 * The plugin version is recorded but never used to decide anything - it only says which release the
 * author was working against.
 *
 * Originals are never overwritten. A block carries `author`/`version`/`date` for the first stamping,
 * and gains `modifiedBy`/`modifiedVersion`/`modifiedDate` when its content later changes. That way
 * "who wrote this" and "who last changed it" stay distinct, which is what makes learning from someone
 * else's copy possible at all.
 *
 * Usage:
 *   node tools/stamp-blocks.mjs                 stamp everything that changed
 *   node tools/stamp-blocks.mjs --dry-run       show what would change
 *   node tools/stamp-blocks.mjs --adopt         re-stamp blocks that have no author yet
 *   node tools/stamp-blocks.mjs --author wang   override the author for this run
 *
 * Author resolution order: --author, RIMLOG_AUTHOR, git config user.name, OS user, "unknown".
 * Whichever is used is printed, so it is never a surprise.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blockId, normalizeText, splitBlocks } from './lib-blocks.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN = path.resolve(here, '..');
const REGISTRY = path.join(PLUGIN, 'blocks.json');

/** Files that never belong in the registry. */
const SKIP_FILES = new Set(['blocks.json', 'package-lock.json']);
const SKIP_DIRS = new Set(['node_modules', '.git']);

// ---------------------------------------------------------------- author

function osUser() {
  try {
    return os.userInfo().username || '';
  } catch {
    return '';
  }
}

function gitUser() {
  try {
    return execFileSync('git', ['config', 'user.name'], {
      cwd: PLUGIN, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Decide whose name to stamp with.
 *
 * Order: --author, RIMLOG_AUTHOR, the registry's existing author, git config, OS user.
 *
 * The registry sits above git on purpose. A registry that has been renamed - which happens when the
 * recorded id came from `git config user.name` and the person then chooses a different name - would
 * otherwise be silently reverted on the next stamp, because git still answers with the old value. Asking
 * the registry first makes the last deliberate choice win, and the source is printed either way so the
 * choice is never invisible.
 */
function resolveAuthor(argv, registry) {
  const flagIndex = argv.indexOf('--author');
  if (flagIndex >= 0 && argv[flagIndex + 1]) {
    return { id: argv[flagIndex + 1].trim(), source: '--author' };
  }
  if (process.env.RIMLOG_AUTHOR) {
    return { id: process.env.RIMLOG_AUTHOR.trim(), source: 'RIMLOG_AUTHOR' };
  }

  const known = Object.keys(registry?.authors ?? {});
  // Match on the display name too, not only the key. The key is an ASCII slug and the display name is not,
  // so a name with CJK characters would otherwise slugify to its digits and fork a second author entry
  // alongside the one the registry already holds.
  const findExisting = (name) => {
    const wanted = String(name ?? '').trim().toLowerCase();
    for (const key of known) {
      const entry = registry.authors[key];
      if (key.toLowerCase() === wanted) return key;
      if (String(entry?.display ?? '').trim().toLowerCase() === wanted) return key;
    }
    return null;
  };

  if (known.length === 1) {
    const key = known[0];
    return {
      id: registry.authors[key].display ?? key,
      key,
      source: 'blocks.json (already registered)',
    };
  }
  if (known.length > 1) {
    // More than one author has contributed. Git is the best remaining guess; --author or RIMLOG_AUTHOR
    // is the way to be explicit about which one is stamping now.
    const git = gitUser();
    const guess = git || osUser() || 'unknown';
    const key = findExisting(guess);
    return { id: guess, key, source: git
      ? 'git config user.name (multiple authors in blocks.json)'
      : 'OS user (multiple authors in blocks.json)' };
  }

  const git = gitUser();
  if (git) return { id: git, key: null, source: 'git config user.name' };
  const user = osUser();
  if (user) return { id: user, key: null, source: 'OS user (' + os.platform() + ')' };
  return { id: 'unknown', key: null, source: 'fallback' };
}

/**
 * Author id used in a version string: lowercase, no spaces.
 *
 * A name that is not plainly Latin gets a short hash of the full name instead of being stripped. Two
 * earlier behaviours were both wrong, and both showed up in this registry:
 *
 *   every CJK name collapsed to the empty string, so all contributors shared one key and
 *   `1.2.0.unknown.001` could belong to anyone;
 *   a name mixing CJK and digits kept only the digits, producing a key that did not match the registry's
 *   own id and forked a second author entry.
 *   (The registry id is now an explicit ASCII name, which is what makes this stable.)
 *
 * So a slug is accepted only when it still carries letters: letters are what make a key identifiable, and
 * what keep it from colliding with a key derived from a different name. Anything else is hashed.
 *
 * The hash is derived from the whole name, so the same person always gets the same id and different people
 * do not collide - which matters because the id is what a sub-version string carries.
 */
function slug(author) {
  const name = String(author);
  const ascii = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  if (ascii && /[a-z]/.test(ascii)) return ascii;

  // FNV-1a over the trimmed name, kept short and case-sensitive so `群友小王` and `群友小李` differ.
  let hash = 0x811c9dc5;
  const trimmed = name.trim();
  for (let i = 0; i < trimmed.length; i++) {
    hash ^= trimmed.codePointAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return 'u' + hash.toString(36);
}

// ---------------------------------------------------------------- helpers

const sha = (text) => 'sha256:' + createHash('sha256').update(text).digest('hex').slice(0, 16);

const today = () => {
  if (process.env.RIMLOG_DATE) return process.env.RIMLOG_DATE;
  const d = new Date();
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

function walkFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(full, base, out);
    } else if (entry.isFile() && !SKIP_FILES.has(entry.name)) {
      out.push(path.relative(base, full).replace(/\\/g, '/'));
    }
  }
  return out;
}

function pluginVersion() {
  try {
    return JSON.parse(readFileSync(path.join(PLUGIN, 'package.json'), 'utf8')).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function loadRegistry() {
  if (!existsSync(REGISTRY)) {
    return {
      schema: 'rimworld-log.blocks',
      schemaVersion: 1,
      pluginVersion: pluginVersion(),
      authors: {},
      blocks: [],
    };
  }
  try {
    const parsed = JSON.parse(readFileSync(REGISTRY, 'utf8'));
    parsed.authors ??= {};
    parsed.blocks ??= [];
    return parsed;
  } catch (error) {
    console.error('blocks.json is not valid JSON: ' + error.message);
    console.error('Refusing to overwrite it. Fix or delete it, then run again.');
    process.exit(2);
  }
}

/**
 * Next sub-version for an author, incrementing their counter.
 *
 * `authorId` is the raw name the author gave, which may be in any language; `display` is what a report
 * shows. The earlier version passed the already-slugged key as the display name too, so a contributor
 * called `群友小王` was recorded as `ur0tu22` in the authors table and their real name never appeared
 * anywhere. The key keeps the slug because it has to go inside a version string; the display keeps the
 * name because that is the only place it is legible.
 */
function nextVersion(registry, authorId, version, knownKey = null) {
  // A key already in the registry wins over a freshly computed slug. The registry's key was chosen when
  // that author was first recorded and cannot be recomputed reliably - the id was once a lowercase slug and
  // is now `Jzc1098` (renamed by the rename tool), while slugging the same name today may yield a hash.
  // Recomputing forked a second entry for one person, which is exactly the confusion this registry is
  // meant to prevent.
  const key = knownKey ?? slug(authorId);
  const display = String(authorId).trim() || key;
  const entry = registry.authors[key] ?? { display, firstSeen: today(), counter: 0 };
  entry.counter = (entry.counter ?? 0) + 1;
  // A name recorded earlier wins: renaming yourself must not silently rewrite history in a registry whose
  // whole purpose is attribution. `rename-author.py` is the deliberate way to change it.
  entry.display ??= display;
  registry.authors[key] = entry;
  return { author: key, version: `${version}.${key}.${String(entry.counter).padStart(3, '0')}` };
}

// ---------------------------------------------------------------- main

const HELP = `
stamp-blocks — register every block in the plugin, with who wrote it and when.

  node tools/stamp-blocks.mjs [options]

  --dry-run            show what would change, write nothing
  --author <name>      your name for this run (any language)
  --adopt              claim blocks that have no author yet
  --help, -h           this text

Author resolution order: --author, RIMLOG_AUTHOR, the name already in blocks.json,
\`git config user.name\`, the OS user.

Sub-version format: <plugin version>.<your id>.<running number>, for example
1.2.0.Jzc1098.151. A name with no Latin characters gets a short hash as its id,
so contributors stay distinguishable.

Originals are never overwritten: a block keeps the author, version and date of
whoever first wrote it, and separately records who last modified it.
`;

function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(HELP);
    return 0;
  }

  const dryRun = argv.includes('--dry-run');
  const adopt = argv.includes('--adopt');
  // The registry is loaded first so the author can default to whoever it already records.
  const earlyRegistry = loadRegistry();
  const author = resolveAuthor(argv, earlyRegistry);
  const authorKey = author.key ?? slug(author.id);
  const version = pluginVersion();

  console.log('plugin        : ' + PLUGIN);
  console.log('plugin version: ' + version + '   (recorded only, never used to decide anything)');
  console.log('author        : ' + author.id + '   (from ' + author.source + ')');
  console.log('author id     : ' + authorKey);
  console.log('date          : ' + today());
  console.log('mode          : ' + (dryRun ? 'dry run' : 'write')
    + (adopt ? ' + adopt unowned blocks' : ''));
  console.log('');

  const registry = loadRegistry();
  const byId = new Map(registry.blocks.map((b) => [b.id, b]));
  const seen = new Set();
  const stats = { total: 0, unchanged: 0, created: 0, modified: 0, adopted: 0, baseline: 0 };

  // A registry with no blocks has never been initialised. Everything it finds on that first pass
  // predates the registry, so attributing it to whoever happens to run the tool would be a lie that
  // later blocks could never be distinguished from. Those blocks are recorded with a null author
  // instead, and only changes from here on carry a name. `--adopt` is how someone deliberately claims
  // a block.
  const baseline = registry.blocks.length === 0;
  if (baseline) {
    console.log('First initialisation: existing blocks will be recorded as author unknown.');
    console.log('They are marked baseline=true. Use --adopt later to claim individual blocks.');
    console.log('');
  }

  for (const rel of walkFiles(PLUGIN).sort()) {
    let text;
    try {
      text = readFileSync(path.join(PLUGIN, rel), 'utf8');
    } catch {
      continue;
    }
    const blocks = splitBlocks(rel, text);

    for (const block of blocks) {
      const id = blockId(rel, block);
      const hash = sha(normalizeText(block.body));
      seen.add(id);
      stats.total++;

      const existing = byId.get(id);

      if (!existing) {
        const record = {
          id,
          file: rel,
          kind: block.kind,
          name: block.name,
          hash,
        };
        if (baseline) {
          record.author = null;
          record.version = null;
          record.date = null;
          record.baseline = true;
          record.note = 'pre-dates the block registry; authorship not recorded';
          stats.baseline++;
        } else {
          const stamp = nextVersion(registry, author.id, version, author.key);
          record.source = 'created';
          record.author = stamp.author;
          record.version = stamp.version;
          record.date = today();
          stats.created++;
          console.log('  + ' + id + '  ' + stamp.version);
        }
        byId.set(id, record);
        continue;
      }

      if (existing.hash === hash) {
        stats.unchanged++;
        // --adopt gives a first stamp to blocks that predate the registry, or to one created while the
        // registry was being initialised.
        if (adopt && !existing.author) {
          const stamp = nextVersion(registry, author.id, version, author.key);
          existing.author = stamp.author;
          existing.version = stamp.version;
          existing.date = today();
          existing.source = 'adopted';
          delete existing.baseline;
          delete existing.note;
          stats.adopted++;
          console.log('  ~ adopted ' + id + '  -> ' + stamp.version);
        }
        continue;
      }

      // Content changed. Keep the original attribution - even when there is none - and record the
      // change separately. "Who wrote this" and "who last changed it" must stay distinguishable, or
      // attributing a change to the original author becomes unavoidable.
      const stamp = nextVersion(registry, author.id, version, author.key);
      existing.hash = hash;
      existing.modifiedBy = stamp.author;
      existing.modifiedVersion = stamp.version;
      existing.modifiedDate = today();
      existing.modifiedCount = (existing.modifiedCount ?? 0) + 1;
      stats.modified++;
      console.log('  * ' + id + '  ' + stamp.version
        + (existing.version ? '  (original: ' + existing.version + ')'
                            : '  (original: unknown, pre-registry)'));
    }
  }

  // Blocks that vanished stay in the registry, marked, rather than being deleted: the compare tool needs
  // to tell "removed here" from "never existed".
  const missing = registry.blocks.filter((b) => !seen.has(b.id) && !b.removedAt);
  for (const b of missing) {
    b.removedAt = today();
    console.log('  - ' + b.id + '  (no longer present)');
  }

  const output = {
    schema: 'rimworld-log.blocks',
    schemaVersion: 1,
    pluginVersion: version,
    generatedAt: new Date().toISOString(),
    note: 'Sub-version format is <plugin version>.<author>.<running number>. The plugin version is '
      + 'recorded for context only and is never used to decide which side is newer.',
    authors: registry.authors,
    blocks: [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };

  console.log('');
  console.log(`blocks   : ${stats.total}`);
  console.log(`unchanged: ${stats.unchanged}`);
  if (baseline) console.log(`baseline : ${stats.baseline}   (author unknown, pre-dates the registry)`);
  console.log(`created  : ${stats.created}`);
  console.log(`modified : ${stats.modified}`);
  if (adopt) console.log(`adopted  : ${stats.adopted}`);
  console.log(`missing  : ${missing.length}`);
  console.log('');
  if (Object.keys(registry.authors).length === 0) {
    console.log('authors: none yet - no block has been created or adopted.');
  } else {
    console.log('authors:');
    for (const [key, entry] of Object.entries(registry.authors)) {
      console.log(`  ${key.padEnd(16)} counter=${entry.counter}  first seen ${entry.firstSeen}`);
    }
  }
  console.log('');
  if (baseline) {
    console.log('Note: baseline blocks can be claimed with --adopt, or left as unknown.');
    console.log('Every block you add or change from now on is stamped automatically.');
    console.log('');
  }

  if (dryRun) {
    console.log('dry run: ' + REGISTRY + ' not written.');
    return 0;
  }

  writeFileSync(REGISTRY, JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.log('wrote ' + REGISTRY + '  (' + statSync(REGISTRY).size.toLocaleString() + ' B)');
  return 0;
}

process.exit(main());
