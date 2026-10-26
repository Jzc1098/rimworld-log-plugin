// Self-test for lib/patchaudit.js（补丁部署审计）。
//
// 在临时目录里搭一个最小场景：工作区放两个修复 mod（一个源码比部署新、一个哈希不一致、
// 一个同步、一个纯 XML 无 DLL），部署目录放对应的假 mod，activeMods 传对应的启用列表。
// 跑完后整个临时目录删掉。
//
// Usage: node tools/selftest-patchaudit.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { patchAudit } from '../lib/patchaudit.js';

let failures = 0;
const check = (label, actual, expected) => {
  const ok = actual === expected;
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(46)} ${ok ? String(actual) : `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`}`);
};
const checkTrue = (label, ok, detail = '') => {
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(46)} ${detail}`);
};

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rimlog-patchaudit-'));

/** 在 tempDir 下造一个目录结构。 */
function makeMod(root, name, packageId, { withDll = true, dllContent = 'DLL-A', sourceMtimeDays = 0 } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'About'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'About', 'About.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<ModMetaData>\n  <name>${name}</name>\n  <packageId>${packageId}</packageId>\n</ModMetaData>\n`, 'utf8');
  if (withDll) {
    fs.mkdirSync(path.join(dir, '1.6', 'Assemblies'), { recursive: true });
    fs.writeFileSync(path.join(dir, '1.6', 'Assemblies', 'Test.dll'), dllContent, 'utf8');
  }
  fs.mkdirSync(path.join(dir, 'Source'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'Source', 'Patch.cs'), '// source', 'utf8');
  if (sourceMtimeDays > 0) {
    const t = new Date(Date.now() - sourceMtimeDays * 86400_000);
    fs.utimesSync(path.join(dir, 'Source', 'Patch.cs'), t, t);
  }
  return dir;
}

console.log('patchaudit self-test');
console.log('');

// ---- 搭场景 ----
const workspace = path.join(tempDir, 'workspace');
const deployed = path.join(tempDir, 'deployed');
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(deployed, { recursive: true });

// 同步的 mod：两边 DLL 内容相同
const wsSynced = makeMod(workspace, 'fix-synced', 'rimcrow.fix.synced', { dllContent: 'SAME' });
const depSynced = makeMod(deployed, 'Fix - synced', 'rimcrow.fix.synced', { dllContent: 'SAME', sourceMtimeDays: 30 });

// 源码比部署新：工作区 .cs 是新的（mtime = now），部署 DLL 是旧的（content 一样但时间拉旧）
const wsNewer = makeMod(workspace, 'fix-newer', 'rimcrow.fix.newer', { dllContent: 'X' });
const depNewer = makeMod(deployed, 'Fix - newer', 'rimcrow.fix.newer', { dllContent: 'X' });
// 把部署的 DLL mtime 拉到 30 天前
const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000);
fs.utimesSync(path.join(depNewer, '1.6', 'Assemblies', 'Test.dll'), thirtyDaysAgo, thirtyDaysAgo);

// 哈希不一致：两边 DLL 内容不同
makeMod(workspace, 'fix-hash', 'rimcrow.fix.hash', { dllContent: 'AAA' });
makeMod(deployed, 'Fix - hash', 'rimcrow.fix.hash', { dllContent: 'BBB' });

// 无工作区副本：只在部署侧
makeMod(deployed, 'Fix - nows', 'rimcrow.fix.nows', { dllContent: 'C' });

// 纯 XML（无 DLL）：只在部署侧，工作区也没 DLL
const wsXml = path.join(workspace, 'fix-xml');
fs.mkdirSync(path.join(wsXml, 'About'), { recursive: true });
fs.writeFileSync(path.join(wsXml, 'About', 'About.xml'),
  `<?xml version="1.0"?>\n<ModMetaData><name>fix-xml</name><packageId>rimcrow.fix.xml</packageId></ModMetaData>`, 'utf8');
const depXml = path.join(deployed, 'Fix - xml');
fs.mkdirSync(path.join(depXml, 'About'), { recursive: true });
fs.writeFileSync(path.join(depXml, 'About', 'About.xml'),
  `<?xml version="1.0"?>\n<ModMetaData><name>Fix - xml</name><packageId>rimcrow.fix.xml</packageId></ModMetaData>`, 'utf8');

// 未启用：工作区有但不在 activeMods 里
makeMod(workspace, 'fix-off', 'rimcrow.fix.off', { dllContent: 'D' });

// ---- 运行 ----
const activeMods = [
  { packageId: 'rimcrow.fix.synced', dir: depSynced, name: 'Fix - synced', installed: true },
  { packageId: 'rimcrow.fix.newer', dir: depNewer, name: 'Fix - newer', installed: true },
  { packageId: 'rimcrow.fix.hash', dir: path.join(deployed, 'Fix - hash'), name: 'Fix - hash', installed: true },
  { packageId: 'rimcrow.fix.nows', dir: path.join(deployed, 'Fix - nows'), name: 'Fix - nows', installed: true },
  { packageId: 'rimcrow.fix.xml', dir: depXml, name: 'Fix - xml', installed: true },
  { packageId: 'ludeon.rimworld', name: 'Core', installed: true },  // 不该被审计（非 rimcrow.*）
];
const result = patchAudit(activeMods, { workspaceDir: workspace });

console.log('判定：');
check('ok', result.ok, true);
check('synced 数', result.counts.synced, 1);
check('sourceNewer 数', result.counts.sourceNewer, 1);
check('hashMismatch 数', result.counts.hashMismatch, 1);
check('noWorkspace 数', result.counts.noWorkspace, 1);
check('noDll 数', result.counts.noDll, 1);
check('notEnabled 数', result.counts.notEnabled, 1);
check('deployed 数', result.counts.deployed, 5);
checkTrue('verdict 包含差异提示', String(result.verdict).includes('不一致'));

console.log('');
console.log('各分区内容：');
check('sourceNewer 的 packageId', result.sourceNewer[0]?.packageId, 'rimcrow.fix.newer');
check('hashMismatch 的 packageId', result.hashMismatch[0]?.packageId, 'rimcrow.fix.hash');
check('noWorkspace 的 reason', result.noWorkspace[0]?.reason, '无工作区副本');
check('notEnabled 的 packageId', result.notEnabled[0]?.packageId, 'rimcrow.fix.off');
check('noDll 的 packageId', result.noDll[0]?.packageId, 'rimcrow.fix.xml');
checkTrue('synced 包含 rimcrow.fix.synced', result.synced.some((m) => m.packageId === 'rimcrow.fix.synced'));
checkTrue('ludeon 不在审计结果里', !JSON.stringify(result).includes('ludeon.rimworld'));

console.log('');
console.log('错误路径：');
const bad = patchAudit(activeMods, { workspaceDir: path.join(tempDir, 'nonexistent') });
check('不存在的目录 → ok: false', bad.ok, false);
checkTrue('错误信息提到目录', String(bad.error).includes('nonexistent'));

const noWs = patchAudit([], { workspaceDir: workspace });
check('空 activeMods → deployed 0', noWs.counts.deployed, 0);
check('空 activeMods → notEnabled 5', noWs.counts.notEnabled, 5);

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
