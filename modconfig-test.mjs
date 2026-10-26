/**
 * Tests for the only writing module in the plugin. Every test runs against a throwaway copy of
 * the real `ModsConfig.xml`, so the user's configuration is never touched.
 *
 * Usage: node modconfig-test.mjs
 */

// 测试会调用真实的 tool.execute（含 action=analyze），那会触发自动归档并往工作区里写记录。
// 测试会调用真实的 tool.execute（含 action=analyze），那会触发自动归档并往工作区写记录。
// 测试不该产生副作用，这里直接关掉。
process.env.RIMLOG_AUTO_ARCHIVE = '0';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  applyModChange,
  describeChange,
  parseModsConfig,
  planModChange,
  readModsConfig,
  renderDiff,
  renderModsConfig,
} from './lib/modconfig.js';
import { detectEnvironment, activeModList } from './lib/detect.js';

const problems = [];
const notes = [];
function check(label, fn) {
  try {
    const value = fn();
    notes.push(`  ok   ${label}${value === undefined ? '' : ` -> ${value}`}`);
    return value;
  } catch (error) {
    problems.push(`  FAIL ${label}: ${error?.message ?? error}`);
    return undefined;
  }
}

console.log('== modconfig writer tests (sandboxed copies only) ==');

const env = detectEnvironment();
assert.ok(env.profile, 'a RimCrow profile is required for this test');
const realConfig = env.profile.modsConfig;
assert.ok(fs.existsSync(realConfig), `missing ${realConfig}`);
const realText = fs.readFileSync(realConfig, 'utf8');
const realMtime = fs.statSync(realConfig).mtimeMs;

const mods = activeModList(env.profile, env.config, { toolModRoots: [`${env.home}\\toolmods`] });
/**
 * The `knownMods` view the plugin actually uses: every enabled mod plus every mod directory on
 * disk, deduplicated by package id. Judging an "enable" request against the active list alone
 * would report a perfectly installed mod as missing.
 */
const knownMods = (() => {
  const byId = new Map();
  for (const mod of mods.active) {
    if (mod.packageId) byId.set(mod.packageId.toLowerCase(), mod);
  }
  for (const root of mods.modRoots) {
    const key = String(root.packageId ?? '').toLowerCase();
    if (key && !byId.has(key)) byId.set(key, { packageId: root.packageId, name: root.name, installed: true, dir: root.root });
  }
  return [...byId.values()];
})();
notes.push(`  info knownMods table: ${knownMods.length} ids (${mods.activeCount} enabled, ${mods.modRoots.length} on disk)`);

// --- parser / renderer --------------------------------------------------
check('parseModsConfig reads version, active mods and expansions', () => {
  const parsed = parseModsConfig(realText);
  assert.ok(parsed.version, 'no version');
  assert.ok(parsed.activeMods.length > 400, `only ${parsed.activeMods.length} active mods`);
  assert.equal(parsed.knownExpansions.length, 5);
  return `version=${parsed.version}, active=${parsed.activeMods.length}, expansions=${parsed.knownExpansions.length}`;
});

check('render(parse(x)) preserves the mod list exactly', () => {
  const parsed = parseModsConfig(realText);
  const round = parseModsConfig(renderModsConfig(parsed));
  assert.deepEqual(round.activeMods, parsed.activeMods);
  assert.deepEqual(round.knownExpansions, parsed.knownExpansions);
  assert.equal(round.version, parsed.version);
  return `${round.activeMods.length} ids identical`;
});

check('parser tolerates XML entities and odd whitespace', () => {
  const parsed = parseModsConfig(
    "<?xml version='1.0' encoding='UTF-8'?>\n<ModsConfigData>\n <version>1.6</version>\n"
    + ' <activeMods>\n  <li> a.b&amp;c </li>\n\t<li>d.e</li>\n </activeMods>\n</ModsConfigData>\n',
  );
  assert.deepEqual(parsed.activeMods, ['a.b&c', 'd.e']);
  const rendered = renderModsConfig(parsed);
  assert.deepEqual(parseModsConfig(rendered).activeMods, ['a.b&c', 'd.e']);
  return 'entities round-trip';
});

check('renderer output keeps the shape RimWorld writes', () => {
  const rendered = renderModsConfig({ version: '1.6.4850 rev646', activeMods: ['a.b'], knownExpansions: ['ludeon.rimworld.royalty'] });
  assert.ok(rendered.startsWith("<?xml version='1.0' encoding='UTF-8'?>\n"), 'declaration changed');
  assert.ok(rendered.includes('\n  <activeMods>\n    <li>a.b</li>\n  </activeMods>\n'), 'indentation changed');
  assert.ok(rendered.endsWith('</ModsConfigData>\n'), 'trailing newline missing');
  return 'declaration + 2-space indent preserved';
});

// --- sandbox ------------------------------------------------------------
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'rimlog-modconfig-'));
const workFile = path.join(sandbox, 'ModsConfig.xml');
fs.copyFileSync(realConfig, workFile);
notes.push(`  info sandbox: ${workFile}`);

const base = readModsConfig(workFile);
assert.ok(base.ok, base.error);
// A mod that exists on disk but is not in the active list — the real "enable a mod to dig
// further" case. It has to come from the scanned mod table, because `mods.active` only ever
// contains ids that are already enabled.
// Prefer an installed-but-disabled mod that actually declares a packageId; some mods ship an
// `About.xml` without one, and enabling those legitimately produces a "cannot find" warning.
const activeSet = new Set(base.config.activeMods.map((id) => id.toLowerCase()));
const declared = mods.modRoots.filter((root) => root.packageId && !activeSet.has(root.packageId.toLowerCase()));
const disabledCandidate = declared[0];
const someDisabled = disabledCandidate
  ? { packageId: disabledCandidate.packageId, name: disabledCandidate.name, installed: true, dir: disabledCandidate.root }
  : undefined;
const noPackageIdCount = mods.modRoots.filter((root) => !root.packageId).length;
const firstId = base.config.activeMods[0];
notes.push(`  info ${declared.length} installed-but-disabled mods with a packageId; ${noPackageIdCount} mods declare none`);

// --- planning -----------------------------------------------------------
check('plan: disabling an id removes it and reports the position', () => {
  const plan = planModChange(base.config, { disable: [firstId] }, knownMods);
  assert.equal(plan.changes.length, 1);
  assert.equal(plan.changes[0].action, 'disable');
  assert.equal(plan.after.includes(firstId), false);
  assert.equal(plan.afterCount, plan.beforeCount - 1);
  return `removed ${firstId}`;
});

check('plan: enabling an already-enabled id is reported, not duplicated', () => {
  const plan = planModChange(base.config, { enable: [firstId] }, knownMods);
  assert.equal(plan.changes.length, 0);
  assert.deepEqual(plan.alreadyEnabled, [firstId]);
  assert.equal(plan.afterCount, plan.beforeCount);
  return 'no duplicate';
});

check('plan: enabling an already-disabled installed mod appends it', () => {
  assert.ok(someDisabled, 'no disabled-but-installed mod available for this test');
  const plan = planModChange(base.config, { enable: [someDisabled.packageId] }, knownMods);
  assert.equal(plan.changes.length, 1);
  assert.equal(plan.after[plan.after.length - 1], someDisabled.packageId);
  assert.equal(plan.warnings.length, 0, `unexpected warning: ${plan.warnings[0] ?? ''}`);
  return `appended ${someDisabled.packageId}`;
});

check('plan: an unknown id is added but warned about', () => {
  const plan = planModChange(base.config, { enable: ['totally.unknown.mod.id'] }, knownMods);
  assert.equal(plan.changes.length, 1);
  assert.ok(plan.warnings.some((w) => w.includes('找不到')), 'no warning for unknown id');
  return plan.warnings[0].slice(0, 48);
});

check('plan: disabling an id that is not active is reported, not applied', () => {
  assert.ok(someDisabled, 'no disabled mod available for this test');
  const plan = planModChange(base.config, { disable: [someDisabled.packageId] }, knownMods);
  assert.equal(plan.changes.length, 0);
  assert.deepEqual(plan.alreadyDisabled, [someDisabled.packageId]);
  return 'no-op';
});

check('plan: the relative order of untouched mods is preserved', () => {
  const plan = planModChange(base.config, { disable: [base.config.activeMods[5]] }, knownMods);
  const expected = base.config.activeMods.filter((id) => id !== base.config.activeMods[5]);
  assert.deepEqual(plan.after, expected);
  return `${expected.length} ids in original order`;
});

check('describeChange and renderDiff summarise the plan', () => {
  const plan = planModChange(base.config, { enable: [someDisabled.packageId], disable: [firstId] }, knownMods);
  const described = describeChange(plan);
  const diff = renderDiff(plan);
  assert.ok(described.includes(someDisabled.packageId), 'describe lost the enabled id');
  assert.ok(diff.includes(`+ ${someDisabled.packageId}`), 'diff lost the addition');
  assert.ok(diff.includes(`- ${firstId}`), 'diff lost the removal');
  return `${described.split('\n').length} describe lines, ${diff.split('\n').length} diff lines`;
});

// --- dry run ------------------------------------------------------------
check('dry run writes nothing at all', () => {
  const before = fs.readFileSync(workFile, 'utf8');
  const beforeList = fs.readdirSync(sandbox).length;
  const plan = planModChange(base.config, { enable: [someDisabled.packageId] }, knownMods);
  const result = applyModChange(workFile, plan, { dryRun: true });
  assert.equal(result.ok, true);
  assert.equal(result.dryRun, true);
  assert.equal(fs.readFileSync(workFile, 'utf8'), before, 'dry run modified the file');
  assert.equal(fs.readdirSync(sandbox).length, beforeList, 'dry run created a file');
  assert.ok(result.preview.includes(someDisabled.packageId), 'no preview returned');
  return 'file and directory unchanged, preview returned';
});

// --- real write into the sandbox ----------------------------------------
check('real write changes the list, makes a backup, and verifies itself', () => {
  const parsed = readModsConfig(workFile).config;
  const plan = planModChange(parsed, { enable: [someDisabled.packageId], disable: [firstId] }, knownMods);
  const result = applyModChange(workFile, plan, { dryRun: false });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.verified, true, 'post-write verification failed');
  assert.ok(fs.existsSync(result.backupPath), 'no backup written');

  const after = readModsConfig(workFile);
  assert.ok(after.ok, after.error);
  assert.equal(after.config.activeMods.includes(firstId), false, 'disable did not apply');
  assert.equal(after.config.activeMods.includes(someDisabled.packageId), true, 'enable did not apply');
  assert.equal(after.config.activeMods.length, parsed.activeMods.length, 'count drifted');
  assert.equal(after.config.version, parsed.version, 'version lost');
  assert.deepEqual(after.config.knownExpansions, parsed.knownExpansions, 'expansions lost');

  // The backup must be byte-identical to what was there before.
  assert.equal(fs.readFileSync(result.backupPath, 'utf8'), realText, 'backup is not the original content');
  return `${result.beforeCount} -> ${result.afterCount} ids, backup ${path.basename(result.backupPath)}`;
});

check('a stale mtime is refused instead of clobbering', () => {
  const parsed = readModsConfig(workFile).config;
  const plan = planModChange(parsed, { disable: [parsed.activeMods[0]] }, knownMods);
  const before = fs.readFileSync(workFile, 'utf8');
  // An explicitly wrong expectation, so the guard is exercised regardless of this file's history.
  const result = applyModChange(workFile, plan, { dryRun: false, expectedMtimeMs: realMtime - 60_000 });
  assert.equal(result.ok, false);
  assert.ok(result.error.includes('改动过'), `unexpected error: ${result.error}`);
  assert.equal(fs.readFileSync(workFile, 'utf8'), before, 'file was modified despite the refusal');
  return 'refused, file untouched';
});

check('re-applying the same plan is idempotent', () => {
  const parsed = readModsConfig(workFile).config;
  const plan = planModChange(parsed, { enable: [someDisabled.packageId], disable: [firstId] }, knownMods);
  assert.equal(plan.changes.length, 0, 'second application planned changes');
  return 'no changes planned on repeat';
});

check('the real ModsConfig.xml is untouched by this test run', () => {
  const now = fs.statSync(realConfig);
  assert.equal(now.mtimeMs, realMtime, 'the real configuration was modified');
  assert.equal(fs.readFileSync(realConfig, 'utf8'), realText);
  return `mtime unchanged (${new Date(now.mtimeMs).toISOString()})`;
});

// --- cleanup ------------------------------------------------------------
fs.rmSync(sandbox, { recursive: true, force: true });

console.log('\n== results ==');
for (const line of notes) console.log(line);
if (problems.length > 0) {
  console.log('\n== problems ==');
  for (const line of problems) console.log(line);
  process.exit(1);
}
console.log('\nMod config writer is safe: drafted, diffable, backed up, verified, sandboxed in tests.');
