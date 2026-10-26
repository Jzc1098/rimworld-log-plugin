// Self-test for lib/modwatch.js（mod 变动探测）。
//
// 基线落盘用 RIMLOG_STATE_DIR 指向临时目录，跑完即删，绝不碰真实的 ~/.dsh/rimworld-log/。
// 覆盖：parseSince 的四种形态、首次运行建基线、版本变化、mtime 窗口、新增/移除。
//
// Usage: node tools/selftest-modwatch.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseSince, modChanges, baselinePath, readBaseline } from '../lib/modwatch.js';

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

// 临时状态目录：跑完即删。modwatch 的所有读写都该被 RIMLOG_STATE_DIR 接住。
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rimlog-modwatch-'));
process.env.RIMLOG_STATE_DIR = tempDir;

/** 造一个 mod 目录（带 About.xml），返回 modRoots 形状的一条。 */
function makeMod(name, packageId, version) {
  const dir = path.join(tempDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'About'), { recursive: true });
  const versionTag = version ? `\n  <modVersion>${version}</modVersion>` : '';
  fs.writeFileSync(path.join(dir, 'About', 'About.xml'),
    `<?xml version="1.0" encoding="utf-8"?>\n<ModMetaData>\n  <name>${name}</name>\n  <packageId>${packageId}</packageId>${versionTag}\n</ModMetaData>\n`, 'utf8');
  return { root: dir, packageId, name, folderName: name, version };
}

/** 把目录 mtime 设到过去/现在：modwatch 只看 statSync 的 mtimeMs。 */
function setMtime(dir, daysAgo) {
  const t = new Date(Date.now() - daysAgo * 86400_000);
  fs.utimesSync(dir, t, t);
}

console.log('modwatch self-test');
console.log('');
console.log('parseSince：');

const now = Date.parse('2026-10-26T12:00:00Z');
check('"3d" → 3 天', parseSince('3d', now).ms, 3 * 86400_000);
check('"12h" → 12 小时', parseSince('12h', now).ms, 12 * 3600_000);
check('"30m" → 30 分', parseSince('30m', now).ms, 30 * 60_000);
check('纯数字按小时', parseSince('6', now).ms, 6 * 3600_000);
check('ISO 时间', parseSince('2026-10-25T12:00:00Z', now).ms, 86400_000);
check('空串 → 24h 默认', parseSince('', now).fallback, true);
check('乱串 → 24h 默认', parseSince('last tuesday', now).fallback, true);
checkTrue('cutoff = now - ms', parseSince('1h', now).cutoff === now - 3600_000);

console.log('');
console.log('首次运行（建基线）：');

const modOld = makeMod('ModOld', 'test.old', '1.0');
const modFresh = makeMod('ModFresh', 'test.fresh', '2.0');
setMtime(modOld.root, 10);   // 10 天前
setMtime(modFresh.root, 0.01); // 今天

const first = modChanges([modOld, modFresh], { since: '3d' });
check('firstRun 标记', first.firstRun, true);
check('scanned 数', first.scanned, 2);
check('窗口内 added（按 mtime）', first.addedCount, 1);
check('added 的名字', first.added[0].name, 'ModFresh');
checkTrue('无 updated 字段（无基线可比）', first.updated === undefined);
checkTrue('基线已落盘', readBaseline()?.mods?.[modOld.root]?.version === '1.0');
checkTrue('note 提示首次', String(first.note).includes('首次'));

console.log('');
console.log('第二次运行（版本变化 + mtime）：');

// ModOld 改版本。注意：重写 About/About.xml **不会**更新 mod 根目录的 mtime
// （目录时间只在增删条目时变）——这正是版本比对必须存在的原因：Steam 就地重写文件
// 常常不动目录时间。modOld 的根目录 mtime 仍是 10 天前，但版本 1.0 → 1.1。
fs.writeFileSync(path.join(modOld.root, 'About', 'About.xml'),
  `<?xml version="1.0" encoding="utf-8"?>\n<ModMetaData>\n  <name>ModOld</name>\n  <packageId>test.old</packageId>\n  <modVersion>1.1</modVersion>\n</ModMetaData>\n`, 'utf8');
// ModFresh 不动版本；把它的目录 mtime 拉回 10 天前（首次运行时的 0.01 天只是为了
// 测 first-run 的 added，现在要让它退出窗口）。
setMtime(modFresh.root, 10);
// 新增 ModNew。条目列表要反映**当前磁盘状态**（真实场景里 detect 每次都重扫 About.xml，
// 所以 ModOld 的条目此刻就该带着 1.1）——传旧条目等于让探测看一份过期清单。
const modNew = makeMod('ModNew', 'test.new', '0.1');

const second = modChanges([{ ...modOld, version: '1.1' }, modFresh, modNew], { since: '3d' });
check('second 不是 firstRun', second.firstRun, undefined);
check('updated 数（只有 ModOld 版本变了）', second.updatedCount, 1);
check('updated 的名字', second.updated[0].name, 'ModOld');
check('updated 旧版本', second.updated[0].oldVersion, '1.0');
check('updated 新版本', second.updated[0].newVersion, '1.1');
check('added 数（ModNew）', second.addedCount, 1);
check('added 的名字', second.added[0].name, 'ModNew');
check('removed 数', second.removedCount, 0);

console.log('');
console.log('第三次运行（移除 + 全部无变化）：');

// 条目仍须反映当前磁盘（modOld 此刻是 1.1；modNew 已不在列表里）。
const modOldNow = { ...modOld, version: '1.1' };
const third = modChanges([modOldNow, modFresh], { since: '3d' });
check('removed 数（ModNew 消失）', third.removedCount, 1);
check('removed 的名字', third.removed[0].name, 'ModNew');
check('updated 数（版本与 mtime 都没再动）', third.updatedCount, 0);

console.log('');
console.log('窗口边界：');

// 两者的目录 mtime 都是 10 天前：用 5 天窗口把它们都排除在外，
// 验证「版本没变 + mtime 不在窗口内 → 不报」。
const fourth = modChanges([modOldNow, modFresh], { since: '5d' });
check('5 天窗口下 updated 数为 0', fourth.updatedCount, 0);
checkTrue('ModFresh 版本与 mtime 均无变化 → 不在 updated',
  !fourth.updated?.some((u) => u.name === 'ModFresh'));

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
