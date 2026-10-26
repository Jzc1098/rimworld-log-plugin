/**
 * Report About.xml files whose direct children do not match Verse.ModMetaData.
 *
 * Works on the parsed tree, not on text: a regex over the inner XML also matches nested elements and
 * produced thousands of false positives in earlier attempts.
 *
 * Usage: node check-about.mjs <root> [<root> ...]
 */

import fs from 'node:fs';
import path from 'node:path';

const roots = process.argv.slice(2);
if (roots.length === 0) {
  console.error('usage: node check-about.mjs <root> [<root> ...]');
  process.exit(2);
}

const KNOWN = new Set([
  'name', 'author', 'description', 'packageId', 'modVersion', 'url', 'steamAppId',
  'supportedVersions', 'modDependencies', 'loadAfter', 'loadBefore',
  'forceLoadAfter', 'forceLoadBefore', 'incompatibleWith',
  'descriptions', 'authors', 'modIconPath', 'targetVersion',
  'modDependenciesByVersion', 'descriptionsByVersion', 'loadAfterByVersion', 'loadBeforeByVersion',
]);
const STRING_LISTS = new Set([
  'supportedVersions', 'loadAfter', 'loadBefore', 'forceLoadAfter', 'forceLoadBefore', 'incompatibleWith',
]);
const STRUCT_LISTS = new Set(['modDependencies', 'modDependenciesByVersion']);

/**
 * Strip XML comments before scanning.
 *
 * Without this the tag scanner matches a tag that a comment merely mentions. `<!--modDependencies>`
 * is not a valid comment opener, so the scanner resumes at `modDependencies>` and counts it as a real
 * open tag, which desynchronises the depth counter and produces phantom top-level tags.
 */
function stripComments(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

// A deliberately small tag scanner: enough to read well-formed About.xml without a dependency.
function topLevelTags(inner) {
  const out = [];
  let depth = 0;
  const re = /<(\/?)([A-Za-z_][A-Za-z0-9_.-]*)((?:"[^"]*"|'[^']*'|[^>"'])*?)(\/?)>/g;
  let m;
  while ((m = re.exec(inner)) !== null) {
    const closing = m[1] === '/';
    const selfClosing = m[4] === '/';
    if (!closing && depth === 0) out.push(m[2]);
    if (!closing && !selfClosing) depth += 1;
    else if (closing) depth = Math.max(0, depth - 1);
  }
  return out;
}

/** Extract one container's inner text by tracking depth. */
function container(inner, tag) {
  const open = new RegExp(`<${tag}(?:\\s[^>]*)?>`, 'i').exec(inner);
  if (!open) return undefined;
  let depth = 1;
  const scan = new RegExp(`<${tag}(?:\\s[^>]*)?>|</${tag}>`, 'gi');
  scan.lastIndex = open.index + open[0].length;
  let s;
  while ((s = scan.exec(inner)) !== null) {
    if (s[0][1] === '/') {
      depth -= 1;
      if (depth === 0) return inner.slice(open.index + open[0].length, s.index);
    } else depth += 1;
  }
  return undefined;
}

/** Top-level <li> items of a block, respecting nesting. */
function items(block) {
  if (block === undefined) return [];
  const out = [];
  const open = /<li(?:\s[^>]*)?>/g;
  let m;
  while ((m = open.exec(block)) !== null) {
    let depth = 1;
    const scan = /<li(?:\s[^>]*)?>|<\/li>/g;
    scan.lastIndex = m.index + m[0].length;
    let s;
    let end = -1;
    while ((s = scan.exec(block)) !== null) {
      if (s[0] === '</li>') {
        depth -= 1;
        if (depth === 0) {
          end = s.index;
          break;
        }
      } else depth += 1;
    }
    if (end === -1) break;
    out.push(block.slice(m.index + m[0].length, end));
    open.lastIndex = end;
  }
  return out;
}

const unknown = [];
const malformed = [];
let scanned = 0;

function consider(dir) {
  const about = path.join(dir, 'About', 'About.xml');
  if (!fs.existsSync(about)) return;
  scanned += 1;
  const text = stripComments(fs.readFileSync(about, 'utf8'));

  const root = /<ModMetaData(?:\s[^>]*)?>([\s\S]*)<\/ModMetaData>/i.exec(text);
  if (!root) {
    malformed.push(`no <ModMetaData> root: ${about}`);
    return;
  }
  const inner = root[1];

  for (const tag of topLevelTags(inner)) {
    if (!KNOWN.has(tag)) unknown.push(`${tag}  <-  ${about}`);
  }

  for (const tag of STRING_LISTS) {
    for (const li of items(container(inner, tag))) {
      if (/<[A-Za-z_]/.test(li)) {
        malformed.push(`<${tag}> li contains an element: ${li.trim().slice(0, 60)}  <-  ${about}`);
      }
    }
  }
  for (const tag of STRUCT_LISTS) {
    for (const li of items(container(inner, tag))) {
      if (!/<packageId/i.test(li)) {
        malformed.push(`<${tag}> li has no packageId: ${li.trim().slice(0, 60)}  <-  ${about}`);
      }
    }
  }

  const pkg = /<packageId(?:\s[^>]*)?>([\s\S]*?)<\/packageId>/i.exec(inner);
  if (!pkg) malformed.push(`no <packageId>: ${about}`);
  else if (!pkg[1].trim()) malformed.push(`empty <packageId>: ${about}`);
}

function walk(dir, depth) {
  if (depth > 3) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  consider(dir);
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (/^(Textures|Sounds|Languages|Defs|Patches|Assemblies|Source|obj|bin|\.git|About|News)$/i.test(e.name)) continue;
    walk(path.join(dir, e.name), depth + 1);
  }
}

for (const root of roots) {
  if (!fs.existsSync(root)) continue;
  walk(root, 0);
}

console.log(`scanned ${scanned} About.xml files`);
console.log(`\n=== unknown top-level tags: ${unknown.length} ===`);
for (const u of [...new Set(unknown)].slice(0, 40)) console.log(`  ${u}`);
console.log(`\n=== malformed: ${malformed.length} ===`);
for (const m of malformed.slice(0, 60)) console.log(`  ${m}`);
