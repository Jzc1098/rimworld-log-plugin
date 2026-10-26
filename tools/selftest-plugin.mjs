/**
 * Integration self-test for the plugin.
 *
 * Loads index.js, runs apply() against a stub context, and checks what registers and how.
 *
 * This exists because a change to index.js cannot be verified by loading DSH: a typo in a registration, a
 * missing import, or a helper that does not exist would only show up as a plugin that silently fails to
 * start. Running apply() against a stub catches that whole class of mistake without touching the live
 * plugin.
 *
 * It also checks the ToolDefinition contract by name. That is not ceremony: an earlier version of the
 * comparison tool registered its executor as `handler` when the contract requires `execute`, which produces
 * a tool that appears in the list and can never be invoked. Nothing else would have caught it.
 *
 * Usage: node tools/selftest-plugin.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, '..');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? '   ' + detail : ''}`);
};

console.log('plugin self-test');
console.log('');

// A stub context, providing only what apply() uses.
const registeredTools = [];
const registeredCommands = [];
const promptContexts = [];
const logged = [];

const ctx = {
  logger: { warn: (message) => logged.push(String(message)) },
  effect: (fn) => {
    try {
      fn();
    } catch (error) {
      failures++;
      console.log(`  FAIL effect threw: ${error?.message ?? error}`);
    }
  },
  tools: { register: (tool) => registeredTools.push(tool) },
  commands: { register: (command) => registeredCommands.push(command) },
  systemPrompt: { context: (entry) => promptContexts.push(entry) },
};

let mod;
try {
  mod = await import(new URL('../index.js', import.meta.url).href);
} catch (error) {
  console.log(`  FAIL import threw: ${error?.message ?? error}`);
  process.exit(1);
}

check('module imports', true, `exports: ${Object.keys(mod).join(', ')}`);
check('apply is exported', typeof mod.apply === 'function');

try {
  mod.apply(ctx, {});
  check('apply() completed without throwing', true);
} catch (error) {
  check('apply() completed without throwing', false, String(error?.message ?? error));
  console.log('');
  console.log(`${failures} CHECK(S) FAILED`);
  process.exit(1);
}

console.log('');
console.log('  registered tools   : ' + registeredTools.map((t) => t.name).join(', '));
console.log('  registered commands: ' + registeredCommands.map((c) => c.name).join(', '));
console.log('  prompt contexts    : ' + promptContexts.map((p) => p.name).join(', '));
console.log('');

const expectTools = ['rimworld_log_scan', 'rimworld_plugin_guide', 'rimworld_plugin_compare'];
for (const name of expectTools) {
  const tool = registeredTools.find((t) => t.name === name);
  check(`tool ${name}`, Boolean(tool));
  if (!tool) continue;
  check(`  ${name} has a useful description`,
    typeof tool.description === 'string' && tool.description.length > 40);
  // The contract, asserted by name. `execute` runs the tool; `output.schema` and `output.render` describe
  // and render its result. A tool registered without them looks fine and cannot be called.
  check(`  ${name} has execute`, typeof tool.execute === 'function');
  check(`  ${name} has output.schema`, Boolean(tool.output?.schema));
  check(`  ${name} has output.render`, typeof tool.output?.render === 'function');
  check(`  ${name} declares at least one parameter`,
    Object.keys(tool.parameters?.properties ?? {}).length > 0);
}

for (const name of ['rimlog', 'rimmods']) {
  check(`command /${name}`, registeredCommands.some((c) => c.name === name));
}

check('no duplicate tool names',
  new Set(registeredTools.map((t) => t.name)).size === registeredTools.length);
check('no duplicate command names',
  new Set(registeredCommands.map((c) => c.name)).size === registeredCommands.length);
check('system prompt context registered', promptContexts.length > 0);
check('nothing was logged as a warning', logged.length === 0, logged.join(' | '));

// The self-report guide must describe exactly what the registry holds, since generating it instead of
// writing it is the whole point.
console.log('');
console.log('self-report consistency:');
{
  const registry = await import(new URL('../plugins/registry.js', import.meta.url).href);
  const guideTools = registry.listTools().map((t) => t.name).sort();
  const guideCommands = registry.listCommands().map((c) => c.name).sort();
  const actualTools = registeredTools.map((t) => t.name).sort();
  const actualCommands = registeredCommands.map((c) => c.name).sort();

  check('registry tool list matches what registered',
    JSON.stringify(guideTools) === JSON.stringify(actualTools), guideTools.join(', '));
  check('registry command list matches what registered',
    JSON.stringify(guideCommands) === JSON.stringify(actualCommands), guideCommands.join(', '));

  const report = await import(new URL('../plugins/feature-report.js', import.meta.url).href);
  const usage = report.usageText();
  check('usageText mentions every tool', guideTools.every((n) => usage.includes(n)));
  check('usageText mentions every command', guideCommands.every((n) => usage.includes('/' + n)));

  const firstParam = Object.keys(registeredTools[0]?.parameters?.properties ?? {})[0];
  check('usageText carries a parameter description', Boolean(firstParam) && usage.includes(firstParam));

  const text = report.reportText();
  check('reportText states that it does not judge versions', text.includes('不判断版本新旧'));
  check('reportText describes the block registry', text.includes('块'));
}

console.log('');
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
