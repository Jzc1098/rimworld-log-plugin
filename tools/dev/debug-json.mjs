/**
 * Reproduce and then verify the fix for the "value is not lossless JSON" tool failure.
 *
 * The failure happened on the success path of a mod-list write: `error: result.error` evaluates
 * to `undefined` when the write worked, and the harness rejects undefined members. This builds
 * both shapes and asserts the serialized result contains no undefined and no non-finite numbers,
 * with and without the sanitizer.
 *
 * Usage: node debug-json.mjs
 */

import assert from 'node:assert/strict';

import { detectEnvironment, activeModList } from './lib/detect.js';
import { readModsConfig, planModChange } from './lib/modconfig.js';

const env = detectEnvironment();
const mods = activeModList(env.profile, env.config, { toolModRoots: [`${env.home}\\toolmods`] });
const knownMods = (() => {
  const byId = new Map();
  for (const mod of mods.active) if (mod.packageId) byId.set(mod.packageId.toLowerCase(), mod);
  for (const root of mods.modRoots) {
    const key = String(root.packageId ?? '').toLowerCase();
    if (key && !byId.has(key)) byId.set(key, { packageId: root.packageId, name: root.name, installed: true, dir: root.root });
  }
  return [...byId.values()];
})();

/** The sanitizer from index.js, duplicated here so the test does not import plugin wiring. */
function jsonSafe(value) {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item)).filter((item) => item !== undefined);
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const clean = jsonSafe(item);
      if (clean !== undefined) out[key] = clean;
    }
    return out;
  }
  return value;
}

/** Walk a value and collect anything a strict serializer would reject. */
function offendersIn(value, path = 'root') {
  const bad = [];
  const t = typeof value;
  if (t === 'undefined') bad.push(`${path} = undefined`);
  else if (t === 'number' && !Number.isFinite(value)) bad.push(`${path} = ${value}`);
  else if (t === 'bigint') bad.push(`${path} = bigint`);
  else if (t === 'function') bad.push(`${path} = function`);
  else if (value && t === 'object') {
    if (Array.isArray(value)) value.forEach((v, i) => bad.push(...offendersIn(v, `${path}[${i}]`)));
    else for (const [k, v] of Object.entries(value)) bad.push(...offendersIn(v, `${path}.${k}`));
  }
  return bad;
}

const read = readModsConfig(env.profile.modsConfig);
assert.ok(read.ok, read.error);
const plan = planModChange(read.config, { enable: [], disable: [] }, knownMods);
const summary = {
  filePath: env.profile.modsConfig,
  changes: plan.changes,
  alreadyEnabled: plan.alreadyEnabled,
  alreadyDisabled: plan.alreadyDisabled,
  warnings: plan.warnings,
  beforeCount: plan.beforeCount,
  afterCount: plan.afterCount,
  describe: 'stub',
  diff: 'stub',
};

// This is the shape index.js returned on the failing call, before the fix.
const unfixed = {
  ok: true,
  applied: true,
  backupPath: 'ModsConfig.xml.bak-EXAMPLE',
  verified: true,
  error: undefined, // <-- what a successful write produces
  note: 'stub',
  ...summary,
};
const before = offendersIn(unfixed);
console.log('=== the failing shape, before the fix ===');
console.log(`  offenders: ${before.length}`);
for (const o of before) console.log(`    ${o}`);

const fixed = jsonSafe(unfixed);
const after = offendersIn(fixed);
console.log('\n=== the same shape, after jsonSafe ===');
console.log(`  offenders: ${after.length}`);
for (const o of after) console.log(`    ${o}`);

// Also confirm the sanitizer drops non-finite numbers, which JSON turns into null.
const withNumbers = jsonSafe({ a: Infinity, b: NaN, c: -Infinity, d: 1.5, e: undefined, f: [1, undefined, 2] });
console.log('\n=== non-finite handling ===');
console.log('  ', JSON.stringify(withNumbers));

const ok = before.length > 0 && after.length === 0
  && withNumbers.a === 'Infinity' && withNumbers.b === 'NaN'
  && withNumbers.e === undefined && withNumbers.f.length === 2;
console.log(ok
  ? '\nReproduced the failure and confirmed the fix removes it.'
  : '\nCould not reproduce the failure with this shape.');
process.exit(ok ? 0 : 1);
