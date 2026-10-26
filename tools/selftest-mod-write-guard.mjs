/**
 * Check the rule: this plugin does not change the user's mod list, not even when asked to.
 *
 * Why a test rather than reading the code. The rule was added after the plugin had already written
 * ModsConfig.xml twice on its own initiative - once enabling a fix mod it had built, once enabling it
 * again while a stale check was being exercised. The user's instruction was to stop doing that
 * permanently, and a rule that only exists in a prompt is not a rule. So the refusal sits in the
 * function that performs the write, and this test calls the real tool to prove the refusal fires.
 *
 * It also proves the draft path still works, because a refusal that also broke drafting would push a
 * future agent straight back to editing the file by hand.
 *
 * Usage: node tools/selftest-mod-write-guard.mjs
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const notes = [];
const problems = [];
async function check(label, fn) {
  try {
    const value = await fn();
    notes.push(`  ok   ${label}${value === undefined ? '' : ` -> ${value}`}`);
  } catch (error) {
    problems.push(`  FAIL ${label}: ${error?.message ?? error}`);
  }
}

/** Minimal Cordis-shaped context: only what apply() touches. */
function mockContext() {
  const registered = { tools: [], commands: [], contexts: [] };
  return {
    registered,
    effect(fn) { try { fn(); } catch { /* a failing effect is another test's business */ } return () => {}; },
    on() { return () => {}; },
    get() { return undefined; },
    provide() {},
    logger: { warn: () => {}, info: () => {}, error: () => {} },
    tools: { register(d) { registered.tools.push(d); return () => {}; } },
    commands: { register(d) { registered.commands.push(d); return () => {}; } },
    systemPrompt: { context(c) { registered.contexts.push(c); return () => {}; } },
  };
}

console.log('== mod-list write guard ==');

const mod = await import(pathToFileURL(path.join(PLUGIN_ROOT, 'index.js')).href);
const ctx = mockContext();
mod.apply(ctx, {});

const scanTool = ctx.registered.tools.find((t) => t.name === 'rimworld_log_scan');
await check('rimworld_log_scan is registered with execute()', () => {
  assert.ok(scanTool, 'tool not registered');
  assert.equal(typeof scanTool.execute, 'function', 'execute must be a function');
});

// The guard must not depend on the host asking for approval: approval settings change, this does not.
await check('RIMLOG_ALLOW_MOD_WRITES is unset in a normal environment', () => {
  assert.notEqual(process.env.RIMLOG_ALLOW_MOD_WRITES, '1',
    'this test is meaningless if the opt-in is already set');
});

// A real apply request, aimed at the real profile. It must come back refused, not written.
const result = await scanTool.execute({
  action: 'mods',
  enable: ['rimcrow.selftest.never-enabled'],
  apply: true,
});

await check('apply:true is refused', () => {
  assert.equal(result.applied, false, 'the tool must not report a write');
  assert.equal(result.draftOnly, true, 'the refusal must be flagged as a draft-only outcome');
  assert.match(result.error ?? '', /不代你写入/, 'the refusal must say why');
});

await check('the refusal still carries a usable draft', () => {
  assert.ok(Array.isArray(result.changes), 'a draft must list the changes');
  assert.match(result.diff ?? '', /rimcrow\.selftest\.never-enabled/,
    'the draft must name what would have changed, so the user can do it by hand');
});

await check('the draft path still works without apply', async () => {
  const draft = await scanTool.execute({ action: 'mods', enable: ['rimcrow.selftest.never-enabled'] });
  assert.equal(draft.applied, false);
  assert.notEqual(draft.draftOnly, true, 'a plain draft is not a refusal');
  assert.ok(Array.isArray(draft.changes));
});

await check('the tool description states the rule', () => {
  assert.match(scanTool.description, /不代用户改 mod 列表|不写入/,
    'the description the model reads must carry the rule');
});

await check('the system prompt states the rule', () => {
  const text = ctx.registered.contexts.map((c) => (typeof c.text === 'function' ? c.text() : c.text)).join('\n');
  assert.match(text, /插件不代你改 mod 列表/, 'the environment block must carry the rule');
});

await check('the /rimmods command no longer advertises --apply', () => {
  const cmd = ctx.registered.commands.find((c) => c.name === 'rimmods');
  assert.ok(cmd, 'command not registered');
  assert.doesNotMatch(cmd.description ?? '', /--apply/, 'the help text must not offer a write');
});

console.log(notes.join('\n'));
if (problems.length) {
  console.log(problems.join('\n'));
  console.log(`\n${problems.length} check(s) FAILED`);
  process.exitCode = 1;
} else {
  console.log('\nall checks passed');
}
