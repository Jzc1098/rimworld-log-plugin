// Self-test for lib/config.js（设置持久层）。
//
// 用 RIMLOG_STATE_DIR 指向临时目录，写入 settings.json 测试三级回退。
// 跑完即删，不碰真实的 ~/.dsh/rimworld-log/。
//
// Usage: node tools/selftest-config.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rimlog-config-'));
process.env.RIMLOG_STATE_DIR = tempDir;

// 清掉可能存在的环境变量（确保测试不受外部干扰）
delete process.env.DSH_RIMWORLD_PATCH_DIR;
delete process.env.RIMWORLD_PATCH_DIR;
delete process.env.RIMLOG_WORKSPACE_DIR;

const { get, getAll, describeAll, settingsPath, KNOWN_KEYS, SETTINGS_SCHEMA } = await import('../lib/config.js');

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(48)} ${ok ? String(actual) : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
};
const checkTrue = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(48)} ${detail}`);
};

console.log('config.js self-test');
console.log('');
console.log('默认值（无文件、无 env）：');

const defaultPatch = get('patchDir');
checkTrue('patchDir 有默认值', typeof defaultPatch.value === 'string' && defaultPatch.value.length > 0);
check('patchDir 来源 = default', defaultPatch.origin, 'default');
checkTrue('workspaceDir 默认为 null（由探测层处理）', get('workspaceDir').value === null);
check('ignoredSignatures 默认为空数组', Array.isArray(get('ignoredSignatures').value) && get('ignoredSignatures').value.length, 0);
check('clusterLimit 默认 14', get('clusterLimit').value, 14);

console.log('');
console.log('settings.json（文件层）：');

// 写一个 settings.json
fs.writeFileSync(settingsPath(), JSON.stringify({
  schema: SETTINGS_SCHEMA,
  patchDir: 'D:\\my-patches',
  ignoredSignatures: ["PA's God Hands", '另一个噪音'],
  clusterLimit: 20,
}), 'utf8');

// config.js 在模块加载时缓存了设置，所以需要重新导入
// 由于 ESM 的 import 是一次性绑定，我们直接测 get 在模块重新加载后的行为
// 但在同一个进程里无法重新导入……所以这里用 delete cache + dynamic import 的方式不行
// 实际上 config.js 的 readSettings 在模块加载时执行一次。
// 为了测试文件层，我们需要在写文件之后重新加载模块。
// 在 ESM 中可以用 import.meta.url + query param 来绕过缓存：
const config2 = await import(`../lib/config.js?test=${Date.now()}`);

check('文件层 patchDir', config2.get('patchDir').value, 'D:\\my-patches');
check('文件层 patchDir 来源 = file', config2.get('patchDir').origin, 'file');
check('文件层 ignoredSignatures 数组', config2.get('ignoredSignatures').value.length, 2);
check('文件层 clusterLimit', config2.get('clusterLimit').value, 20);
check('文件层没写的 workspaceDir 回退 default', config2.get('workspaceDir').origin, 'default');

console.log('');
console.log('环境变量（优先于文件）：');

process.env.DSH_RIMWORLD_PATCH_DIR = 'E:\\env-wins';
const config3 = await import(`../lib/config.js?env=${Date.now()}`);
check('env 覆盖文件', config3.get('patchDir').value, 'E:\\env-wins');
check('env 来源 = env', config3.get('patchDir').origin, 'env');
check('env 有 envVar 标记', config3.get('patchDir').envVar, 'DSH_RIMWORLD_PATCH_DIR');
check('没 env 的键仍走文件', config3.get('clusterLimit').value, 20);

console.log('');
console.log('配置界面（行配置层）：');

// 清掉 env 段留下的变量，让行配置层暴露出来
delete process.env.DSH_RIMWORLD_PATCH_DIR;
// 行配置通过 setRowConfig 存进模块状态；每次带 query 的动态 import 是独立实例。
const configRow = await import(`../lib/config.js?row=${Date.now()}`);
configRow.setRowConfig({ clusterLimit: 25, ignoredSignatures: ['god hands'], patchDir: '' });
check('行配置 clusterLimit', configRow.get('clusterLimit').value, 25);
check('行配置来源 = row', configRow.get('clusterLimit').origin, 'row');
check('行配置 ignoredSignatures', configRow.get('ignoredSignatures').value.length, 1);
// 空字符串 = 未设置：跳过 row 层 → 掉到文件层（settings.json 里还有 patchDir）
check('行配置空串跳过 → 掉到文件层', configRow.get('patchDir').origin, 'file');
// env 仍然赢过 row
process.env.DSH_RIMWORLD_PATCH_DIR = 'E:\\env-wins';
check('env 仍然赢过 row', configRow.get('patchDir').value, 'E:\\env-wins');
check('env 来源不变', configRow.get('patchDir').origin, 'env');
delete process.env.DSH_RIMWORLD_PATCH_DIR;
// setRowConfig(null) 清掉 row 层 → 掉到 settings.json（文件层还留着 clusterLimit: 20）
configRow.setRowConfig(null);
check('清掉 row 后掉到文件层', configRow.get('clusterLimit').value, 20);
check('清掉 row 后来源 = file', configRow.get('clusterLimit').origin, 'file');

console.log('');
console.log('describeAll（供 action=config 打印）：');

const described = config3.describeAll();
checkTrue('describeAll 返回数组', Array.isArray(described));
checkTrue('每个条目有 key/label/value/origin', described.every((e) => typeof e.key === 'string' && typeof e.label === 'string' && 'value' in e && typeof e.origin === 'string'));
checkTrue('包含 patchDir 条目', described.some((e) => e.key === 'patchDir'));

console.log('');
console.log('坏文件防御：');

// 清掉上面设的 env，否则 env 永远赢，坏文件回退测不到
delete process.env.DSH_RIMWORLD_PATCH_DIR;
fs.writeFileSync(settingsPath(), 'not json at all {{{', 'utf8');
const config4 = await import(`../lib/config.js?bad=${Date.now()}`);
check('坏文件 → patchDir 回退 default', config4.get('patchDir').origin, 'default');
check('坏文件 → clusterLimit 回退 14', config4.get('clusterLimit').value, 14);

console.log('');
console.log('KNOWN_KEYS：');
checkTrue('包含 7 个已知键', KNOWN_KEYS.length === 7, `实际 ${KNOWN_KEYS.length} 个: ${KNOWN_KEYS.join(', ')}`);

console.log('');
console.log('清理：');
fs.rmSync(tempDir, { recursive: true, force: true });
checkTrue('临时目录已删', !fs.existsSync(tempDir));

console.log('');
if (failures === 0) {
  console.log('全部通过。');
  process.exit(0);
}
console.log(`${failures} 项失败。`);
process.exit(1);
