#!/usr/bin/env node
/**
 * 一次跑完所有「应该没有变化」的检查，按固定顺序，给一个结论。
 *
 * 为什么需要它：这几项互相牵制 —— blocks.json 影响块文档的块数，块文档与清单又各自记录文件大小，
 * 而清单还会记录自己的大小。顺序错了会看到「刚生成完又说要重新生成」，很容易误判成脚本坏了。
 * 顺序是有依据的，写在这里而不是靠记忆：
 *
 *   1. 块文档（读 blocks.json）      —— 必须在盖章之后
 *   2. 清单（记录各文件大小）          —— 必须在块文档写完、盖章之后
 *   3. 清单条目（sync-manifest）      —— 只重写第五节，必须与 2 的格式一致
 *   4. 块登记表（stamp --dry-run）    —— 放在最后；它不改文件，只报告有没有未登记的改动
 *   5. package.json 引用              —— 与上面无关，随时可查
 *   6. 自测（run-selftests）          —— 跑全部 selftest-*.mjs；不依赖前五项，但放最后能一次看全
 *
 * 用法:
 *   node tools/check-all.mjs
 *   node tools/check-all.mjs --python "C:\path\to\python.exe"   # PATH 里没有 python 时
 *   RIMLOG_PYTHON=/path/to/python node tools/check-all.mjs
 */

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);

function argValue(flag) {
  const i = process.argv.indexOf(flag);
  if (i < 0) return null;
  const v = process.argv[i + 1];
  return v && !v.startsWith('--') ? v : null;
}

const python = argValue('--python') || process.env.RIMLOG_PYTHON || 'python';
const node = process.execPath;

const steps = [
  {
    name: '块文档（block guide）',
    cmd: python,
    args: [path.join('tools', 'gen-blocks-doc.py'), '--check'],
    expect: /up to date/i,
    hint: '块数或孤儿块变了：跑 python tools/gen-blocks-doc.py',
  },
  {
    name: '清单（manifest）',
    cmd: python,
    args: [path.join('tools', 'write-plugin-manifest.py'), '--check'],
    expect: /up to date/i,
    hint: '文件增删或大小变了：跑 python tools/write-plugin-manifest.py',
  },
  {
    name: '清单条目（sync）',
    cmd: node,
    args: [path.join('tools', 'sync-manifest.mjs'), '--dry-run'],
    expect: /文件无变化/,
    hint: '第五节与磁盘不一致：跑 node tools/sync-manifest.mjs',
  },
  {
    name: '块登记（stamp）',
    cmd: node,
    args: [path.join('tools', 'stamp-blocks.mjs'), '--dry-run'],
    expect: /created\s*:\s*0[\s\S]*modified\s*:\s*0[\s\S]*missing\s*:\s*0/,
    hint: '有未登记的改动：跑 node tools/stamp-blocks.mjs',
  },
  {
    name: 'package.json 引用',
    cmd: python,
    args: [path.join('tools', 'check-package-json.py')],
    expect: /\bOK\b/,
    hint: 'files 里有指向不存在文件的条目，或 exports 坏了',
  },
  {
    name: '自测（selftests）',
    cmd: node,
    args: [path.join('tools', 'run-selftests.mjs')],
    expect: /个自测通过/,
    hint: '有自测失败：node tools/run-selftests.mjs 看是哪一个，修到绿为止',
  },
];

function shorten(text, limit = 96) {
  const one = String(text || '').replace(/\s+/g, ' ').trim();
  return one.length > limit ? one.slice(0, limit) + '…' : one;
}

console.log('检查顺序（有依赖，别打乱）：');
console.log('  块文档 → 清单 → 清单条目 → 块登记 → package.json → 自测');
console.log('');

let failed = 0;
let skipped = 0;

for (const step of steps) {
  let output = '';
  let ok = false;
  let err = null;
  try {
    output = execFileSync(step.cmd, step.args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024,
    });
    ok = step.expect.test(output);
  } catch (e) {
    output = (e && (e.stdout || '')) + '' || '';
    const stderr = (e && (e.stderr || '')) + '' || '';
    const text = String((e && e.message) || '');

    // 三种「解释器根本没用起来」的形态，一律算跳过而不是失败：
    //   ENOENT / Windows 的「不是内部或外部命令」/ Microsoft Store 的 python 占位符（退出码 9009，stderr 为空）
    const missingInterpreter =
      (e && e.code === 'ENOENT') ||
      /ENOENT|not recognized|不是内部或外部命令/i.test(text) ||
      (e && e.status === 9009 && !stderr.trim());

    if (missingInterpreter) {
      err = `找不到可用的「${step.cmd}」（用 --python 指定解释器，或设置 RIMLOG_PYTHON）`;
    } else if (e && e.status === 1 && step.expect.test(stderr)) {
      // 检查脚本用退出码 1 表示「需要重新生成」，这时 output 里没有匹配是正常的
      err = shorten(stderr);
    } else {
      err = shorten(stderr || output || text);
      ok = step.expect.test(output) || step.expect.test(stderr);
    }
  }

  if (err && /找不到(可用的)?命令|找不到可用/.test(err)) {
    skipped += 1;
    console.log(`  –  ${step.name.padEnd(22)} 跳过：${err}`);
    continue;
  }
  if (ok) {
    console.log(`  ✓  ${step.name.padEnd(22)} ${shorten(output)}`);
  } else {
    failed += 1;
    console.log(`  ✗  ${step.name.padEnd(22)} ${shorten(err || output)}`);
    console.log(`      ${step.hint}`);
  }
}

console.log('');
if (failed === 0 && skipped === 0) {
  console.log('全部干净：没有需要重新生成的东西。');
  process.exit(0);
}
if (failed === 0 && skipped > 0) {
  console.log(`其它项全干净，但有 ${skipped} 项因缺少 Python 未检查。`);
  process.exit(0);
}
console.log(`${failed} 项需要处理。先按上面的顺序修：越靠前的先做，后面的结果才有意义。`);
process.exit(1);
