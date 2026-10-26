/**
 * Offline harness for the plugin's Host half.
 *
 * The Host loader imports a plugin once and does not retry a failed entry, so a mistake here
 * cannot be discovered by re-installing. This runs `apply()` against a mock Cordis context and
 * checks the three registrations, then executes the tool and the command end to end against the
 * real logs. It proves the module works before any restart is requested.
 *
 * Usage: node mock-host.mjs
 */

// 测试会调用真实的 tool.execute（含 action=analyze），那会触发自动归档并往工作区里写记录。
// 测试会调用真实的 tool.execute（含 action=analyze），那会触发自动归档并往工作区写记录。
// 测试不该产生副作用，这里直接关掉。
process.env.RIMLOG_AUTO_ARCHIVE = '0';

import assert from 'node:assert/strict';

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

async function checkAsync(label, fn) {
  try {
    const value = await fn();
    notes.push(`  ok   ${label}${value === undefined ? '' : ` -> ${value}`}`);
    return value;
  } catch (error) {
    problems.push(`  FAIL ${label}: ${error?.message ?? error}`);
    return undefined;
  }
}

/** A minimal stand-in for the Cordis context shape `apply()` uses. */
function mockContext() {
  const registered = { tools: [], commands: [], contexts: [] };
  const effects = [];
  const warns = [];
  const services = new Map();
  return {
    registered,
    effects,
    warns,
    effect(fn, label) {
      effects.push({ label, disposer: fn() });
      return () => {};
    },
    on() {
      return () => {};
    },
    get(name) {
      return services.get(name);
    },
    provide(name, value) {
      services.set(name, value);
    },
    logger: {
      warn: (m) => warns.push(m),
      info: () => {},
      error: (m) => warns.push(m),
    },
    tools: {
      register(definition) {
        registered.tools.push(definition);
        return () => {};
      },
    },
    commands: {
      register(definition) {
        registered.commands.push(definition);
        return () => {};
      },
    },
    systemPrompt: {
      context(contribution) {
        registered.contexts.push(contribution);
        return () => {};
      },
    },
    // `sessionController` is intentionally absent: the command must degrade, not throw.
  };
}

console.log('== rimworld-log host-half offline harness ==');

const mod = await import('./index.js');
check('module exports apply/inject/name', () => {
  assert.equal(typeof mod.apply, 'function', 'apply must be a function');
  assert.ok(Array.isArray(mod.inject), 'inject must be an array');
  assert.equal(typeof mod.name, 'string');
  return `inject=${JSON.stringify(mod.inject)}`;
});

await checkAsync('no @deepseek-ai/* import remains in index.js', async () => {
  const source = await import('node:fs').then((fs) => fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8'));
  const staticImports = [...source.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  const dynamicImports = [...source.matchAll(/import\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  const external = [...staticImports, ...dynamicImports].filter((spec) => !spec.startsWith('.') && !spec.startsWith('node:'));
  assert.deepEqual(external, [], `unexpected external imports: ${external.join(', ')}`);
  return `imports: ${[...staticImports, ...dynamicImports].join(', ')}`;
});

const ctx = mockContext();
let applyError;
try {
  mod.apply(ctx, {});
} catch (error) {
  applyError = error;
}
check('apply() runs without throwing', () => {
  assert.equal(applyError, undefined, applyError?.stack ?? String(applyError));
  return `${ctx.effects.length} effects registered`;
});

/**
 * Mirror the registry's own validation: every `type` in a schema tree must be a JSON Schema type.
 *
 * This was a real failure — the tool originally declared `output.schema = { type: 'json' }` by
 * copying a shipped package, and registration rejected it with `JsonSchemaError: unsupported JSON
 * schema`. Checking it here turns a live install failure into an offline one.
 */
const JSON_SCHEMA_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null']);

function assertSupportedSchema(node, path = 'schema') {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((child, i) => assertSupportedSchema(child, `${path}[${i}]`));
    return;
  }
  if (node.type !== undefined) {
    assert.ok(
      JSON_SCHEMA_TYPES.has(node.type),
      `${path}.type = ${JSON.stringify(node.type)} is not a JSON Schema type `
        + `(allowed: ${[...JSON_SCHEMA_TYPES].join('/')})`,
    );
  }
  for (const key of ['properties', 'items', 'additionalProperties', 'definitions', '$defs']) {
    if (node[key] && typeof node[key] === 'object') {
      if (key === 'properties' || key === 'definitions' || key === '$defs') {
        for (const [name, child] of Object.entries(node[key])) assertSupportedSchema(child, `${path}.${key}.${name}`);
      } else {
        assertSupportedSchema(node[key], `${path}.${key}`);
      }
    }
  }
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (Array.isArray(node[key])) node[key].forEach((child, i) => assertSupportedSchema(child, `${path}.${key}[${i}]`));
  }
}

const tool = ctx.registered.tools.find((t) => t.name === 'rimworld_log_scan');
check('registers the log tool with a valid ToolDefinition', () => {
  // 这条断言原本写死「只注册一个工具」。插件后来增加到四个（log / guide / compare / archive），
  // 于是一直失败。改成「必须包含日志工具，且每个工具都符合契约」——数量不是契约的一部分。
  assert.ok(ctx.registered.tools.length >= 1, '至少应注册一个工具');
  for (const t of ctx.registered.tools) {
    assert.equal(typeof t.name, 'string', 'tool.name 必须是字符串');
    assert.ok(t.name.length > 0, 'tool.name 不能为空');
    assert.equal(typeof t.execute, 'function', `${t.name}: execute 必须是函数`);
  }
  assert.ok(tool, '缺少 rimworld_log_scan 工具');
  assert.equal(tool.name, 'rimworld_log_scan');
  assert.equal(typeof tool.description, 'string');
  assert.ok(tool.description.length > 40, 'description too short');
  assert.equal(tool.parameters.type, 'object');
  assert.ok(tool.parameters.properties.action, 'action parameter missing');
  assert.equal(typeof tool.execute, 'function', 'execute must be a function');
  // The contract requires `output: { schema, render }`.
  assert.ok(tool.output, 'output definition is required');
  assert.ok(tool.output.schema, 'output.schema is required');
  assert.equal(typeof tool.output.render, 'function', 'output.render is required');
  return `tools=${ctx.registered.tools.map((t) => t.name).join(',')}, params=${Object.keys(tool.parameters.properties).length}`;
});

check('every declared schema type is a supported JSON Schema type', () => {
  assertSupportedSchema(tool.parameters, 'parameters');
  assertSupportedSchema(tool.output.schema, 'output.schema');
  return 'parameters and output schema validated';
});

check('output.render returns model-facing content blocks', () => {
  const blocks = tool.output.render({ action: 'analyze' }, { brief: '# hello' });
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.equal(blocks[0].text, '# hello');
  const fallback = tool.output.render({}, { ok: true });
  assert.equal(fallback[0].type, 'text');
  return 'text block for brief, JSON fallback for anything else';
});

const command = ctx.registered.commands.find((c) => c.name === 'rimlog');
const modsCommand = ctx.registered.commands.find((c) => c.name === 'rimmods');
check('registers the /rimlog and /rimmods commands', () => {
  assert.equal(ctx.registered.commands.length, 2, `expected 2 commands, got ${ctx.registered.commands.map((c) => c.name).join(', ')}`);
  assert.ok(command, '/rimlog missing');
  assert.equal(typeof command.handler, 'function');
  assert.ok(command.input?.hint, 'input.hint is expected');
  assert.ok(modsCommand, '/rimmods missing');
  assert.equal(typeof modsCommand.handler, 'function');
  assert.ok(!command.name.includes('/'), 'command names must not include the slash');
  return `${ctx.registered.commands.map((c) => `/${c.name}`).join(', ')}`;
});

check('system-prompt context is declared with name/order/text', () => {
  const contribution = ctx.registered.contexts[0];
  assert.ok(contribution, 'no context registered');
  assert.equal(typeof contribution.name, 'string');
  assert.equal(typeof contribution.order, 'number');
  assert.equal(typeof contribution.text, 'function');
  return `${contribution.name} order=${contribution.order}`;
});

await checkAsync('tool execute action=detect finds RimCrow', async () => {
  const result = await tool.execute({ action: 'detect' });
  assert.equal(result.ok, true, `detect failed: ${result.error}`);
  assert.ok(result.home, 'no RimCrow home detected');
  const available = result.sources.filter((s) => s.exists).map((s) => s.kind);
  assert.ok(available.length > 0, 'no readable log source');
  assert.ok(result.patchDir && result.patchDir.length > 0, 'patch directory not reported');
  return `home=${result.home}, sources=${available.join(',')}, profiles=${result.profiles.length}, mods=${result.mods?.activeCount}, patchDir=${result.patchDir}`;
});

await checkAsync('tool execute action=analyze returns a brief', async () => {
  const result = await tool.execute({ action: 'analyze', sources: ['realtime'], full: true, maxClusters: 5 });
  assert.equal(result.ok, true);
  assert.ok(typeof result.brief === 'string' && result.brief.length > 500, 'brief too small');
  assert.ok(Array.isArray(result.clusters));
  const blocks = tool.output.render({}, result);
  assert.ok(blocks[0].text.length > 500);
  return `${result.clusters.length} clusters, brief ${result.brief.length} chars, errors=${result.totals.errors}`;
});

await checkAsync('tool execute action=grep returns raw lines', async () => {
  const result = await tool.execute({ action: 'grep', pattern: 'Exception', limit: 3 });
  assert.ok(!result.error, result.error);
  return `${result.returned} hits of ${result.totalLines} lines`;
});

await checkAsync('tool execute rejects a bad source without throwing', async () => {
  const result = await tool.execute({ action: 'analyze', sources: ['nope'], full: true });
  assert.equal(result.ok, true, 'unknown sources should fall back to the default');
  return `fell back, brief ${result.brief.length} chars`;
});

await checkAsync('tool execute action=mods defaults to an unapplied draft', async () => {
  const result = await tool.execute({ action: 'mods', enable: ['VanillaExpanded.VFECore'] });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.applied, false, 'a bare mods call must not write');
  assert.ok(result.diff.includes('+ VanillaExpanded.VFECore'), 'diff missing the addition');
  assert.ok(result.describe.length > 0, 'no human-readable summary');
  assert.ok(result.filePath.endsWith('ModsConfig.xml'), `unexpected target: ${result.filePath}`);
  return `draft only, ${result.changes.length} planned change(s), ${result.beforeCount} -> ${result.afterCount}`;
});

await checkAsync('tool execute action=mods reports a no-op without writing', async () => {
  const result = await tool.execute({ action: 'mods', disable: ['definitely.not.enabled'] });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.applied, false);
  assert.equal(result.changes.length, 0);
  return result.reason;
});

await checkAsync('/rimmods without arguments explains itself', async () => {
  const result = await modsCommand.handler({ rawInput: '', agent: { id: 'mock-session' }, attachments: [], signal: new AbortController().signal });
  assert.equal(result.kind, 'error');
  assert.ok(result.text.includes('/rimmods enable'), 'usage text missing');
  return 'usage returned';
});

await checkAsync('/rimmods drafts a change and says it did not write', async () => {
  const result = await modsCommand.handler({
    rawInput: 'enable VanillaExpanded.VFECore',
    agent: { id: 'mock-session' },
    attachments: [],
    signal: new AbortController().signal,
  });
  assert.equal(result.kind, 'success', result.text?.slice(0, 200));
  assert.ok(result.text.includes('草稿（未写入）'), 'draft notice missing');
  assert.ok(result.text.includes('+ VanillaExpanded.VFECore'), 'diff missing');
  assert.ok(result.text.includes('插件不会代你写入'), 'next-step hint missing');
  return 'draft + apply hint returned';
});

await checkAsync('command handler delivers the brief even with no prompt channel', async () => {
  const result = await command.handler({
    rawInput: '--full',
    agent: { id: 'mock-session' }, // no followup, and no sessionController service
    attachments: [],
    signal: new AbortController().signal,
  });
  assert.equal(result.kind, 'success', `expected success, got ${JSON.stringify(result).slice(0, 200)}`);
  assert.ok(result.text.includes('RimWorld 游戏日志分析载荷'), 'the brief was dropped on the floor');
  return `${result.text.length} chars returned to the user`;
});

check('environment context renders the detected facts', () => {
  const text = ctx.registered.contexts[0].text();
  assert.ok(typeof text === 'string' && text.length > 20, 'context text empty');
  assert.ok(text.includes('RimCrow'), 'context does not mention RimCrow');
  assert.ok(text.includes('补丁文件放在'), 'context does not state where patches go');
  assert.ok(text.includes('/rimmods'), 'context does not name the mod command');
  return `${text.length} chars`;
});

console.log('\n== results ==');
for (const line of notes) console.log(line);
if (problems.length > 0) {
  console.log('\n== problems ==');
  for (const line of problems) console.log(line);
  process.exit(1);
}
console.log('\nHost half is internally consistent and works against the real logs.');
