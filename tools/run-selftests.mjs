#!/usr/bin/env node
/**
 * 跑 tools/ 下全部 selftest-*.mjs，任何一个失败就非零退出。
 *
 * check-all 的第六项调用本脚本；也可以单独 `node tools/run-selftests.mjs`。
 *
 * 约定：selftest 自己负责隔离（modwatch 的临时目录、mock host 等），
 * 这里只负责逐个执行与汇总，不做任何环境准备。
 */

import { readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const names = readdirSync(HERE)
  .filter((n) => /^selftest-.*\.mjs$/.test(n))
  .sort();

if (names.length === 0) {
  console.log('没有找到任何 selftest-*.mjs。');
  process.exit(1);
}

let failed = 0;
for (const name of names) {
  try {
    execFileSync(process.execPath, [path.join(HERE, name)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 16 * 1024 * 1024,
    });
    console.log(`  ✓  ${name}`);
  } catch (e) {
    failed += 1;
    const out = `${e?.stdout ?? ''}${e?.stderr ?? ''}`.trim().split('\n').filter(Boolean);
    const tail = out.slice(-3).join(' | ');
    console.log(`  ✗  ${name}`);
    if (tail) console.log(`      ${tail.slice(0, 200)}`);
  }
}

console.log('');
if (failed === 0) {
  console.log(`全部 ${names.length} 个自测通过。`);
  process.exit(0);
}
console.log(`${failed}/${names.length} 个自测失败。`);
process.exit(1);
