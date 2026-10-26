/**
 * Prototype the condensed log report, so the output size can be judged before anything is built.
 *
 * Reuses the plugin's existing parsers, then adds the part RimCrow does not provide: grouping by
 * error identity across the whole session and emitting one entry per distinct problem, with a count
 * and a short stack instead of the full one.
 *
 * Usage: node compact-report-prototype.mjs [path-to-any-RimCrow-log]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { detectEnvironment } from '../lib/detect.js';
import { readLogEntries } from '../lib/parse.js';

const env = detectEnvironment();
// Optional argument so any session's log can be measured, not just the current one.
const source = process.argv[2] ?? env.sources.realtime.path;
const raw = fs.readFileSync(source, 'utf8');
const entries = readLogEntries(source).entries;

const rawBytes = Buffer.byteLength(raw, 'utf8');

/** Normalise a message so the same problem with different numbers collapses to one key. */
function normalize(message) {
  return String(message ?? '')
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}

/** Keep the frames that identify the problem, drop the engine plumbing. */
function shortStack(details, max = 4) {
  if (!details) return [];
  const frames = [];
  for (const line of String(details).split('\n')) {
    const m = /^\s*at\s+([^\s(]+)\s*(?:\(([^)]*)\))?/.exec(line);
    if (!m) continue;
    const frame = m[1];
    // Skip pure engine noise; keep anything that names a mod or a game system.
    if (/^(MonoMod\.Utils\.DynamicMethodDefinition|System\.Threading|System\.RuntimeMethodHandle)/.test(frame)) continue;
    frames.push(frame.replace(/^MonoMod\.Utils\.DynamicMethodDefinition\./, ''));
    if (frames.length >= max) break;
  }
  return frames;
}

const groups = new Map();
for (const e of entries) {
  if (e.level !== 'ERROR' && e.level !== 'WARNING') continue;
  const key = `${e.level}|${normalize(e.message)}`;
  if (!groups.has(key)) {
    groups.set(key, {
      level: e.level,
      message: String(e.message ?? '').slice(0, 200),
      count: 0,
      first: e.time,
      last: e.time,
      sample: e.details ? String(e.details).slice(0, 300) : null,
    });
  }
  const g = groups.get(key);
  g.count += e.count ?? 1;
  g.last = e.time;
  if (!g.frames) g.frames = shortStack(e.details);
}

const ordered = [...groups.values()].sort((a, b) => b.count - a.count);
const errors = ordered.filter((g) => g.level === 'ERROR');
const warnings = ordered.filter((g) => g.level === 'WARNING');

const report = {
  v: 1,
  generatedAt: new Date().toISOString(),
  source: path.basename(source),
  sourceBytes: rawBytes,
  session: { first: entries[0]?.time ?? null, last: entries[entries.length - 1]?.time ?? null },
  totals: {
    entries: entries.length,
    errorEvents: errors.reduce((s, g) => s + g.count, 0),
    warningEvents: warnings.reduce((s, g) => s + g.count, 0),
    distinctErrors: errors.length,
    distinctWarnings: warnings.length,
  },
  errors: errors.map((g) => ({
    count: g.count,
    msg: g.message,
    mods: g.mods ?? undefined,
    frames: g.frames,
    first: g.first,
    last: g.last,
  })),
  warnings: warnings.slice(0, 12).map((g) => ({ count: g.count, msg: g.message })),
};

const json = JSON.stringify(report, null, 0);
const jsonPretty = JSON.stringify(report, null, 1);

// fileURLToPath decodes the percent-encoding import.meta.url carries, which matters here because
// the workspace path contains spaces and non-ASCII characters.
const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, '..', '..', '_work');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'compact-sample.json'), jsonPretty, 'utf8');

console.log('=== token / size comparison ===');
console.log(`  raw RimCrow_Realtime.log   ${rawBytes.toLocaleString()} bytes`);
console.log(`  condensed report (compact) ${json.length.toLocaleString()} bytes`);
console.log(`  condensed report (pretty)  ${jsonPretty.length.toLocaleString()} bytes`);
console.log(`  reduction                  ${(100 - (json.length / rawBytes) * 100).toFixed(1)}%`);
console.log('');
console.log(`  rough token estimate:  raw ~${Math.round(rawBytes / 4).toLocaleString()}   condensed ~${Math.round(json.length / 4).toLocaleString()}`);
console.log('');
console.log('=== distinct problems found ===');
console.log(`  ERROR   ${errors.length} distinct, ${report.totals.errorEvents} events`);
console.log(`  WARNING ${warnings.length} distinct, ${report.totals.warningEvents} events`);
console.log('');
console.log('=== top errors as they would appear ===');
for (const g of errors.slice(0, 6)) {
  console.log(`  x${g.count}  ${g.message.slice(0, 96)}`);
  if (g.frames?.length) console.log(`        ${g.frames.slice(0, 2).join('  <-  ')}`);
}
console.log('');
console.log(`wrote ${path.join(outDir, 'compact-sample.json')}`);
