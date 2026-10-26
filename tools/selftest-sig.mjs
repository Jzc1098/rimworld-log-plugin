// Self-test for lib/sig.js（紧凑视图与会话对比）。
//
// 全部用构造的 analysis 对象离线跑：sig.js 不读文件、不解析日志，输入就是 analyze() 的
// 返回形状。所以这里不需要真实日志——需要覆盖的是三种归属折叠、忽略清单、以及 diff 的
// 三向分类（新增/消失/计数变化）与阈值。
//
// Usage: node tools/selftest-sig.mjs

import { attributionBucket, buildCompact, diffAnalyses, isIgnoredSignature, signatureLine, ENGINE_BUCKET } from '../lib/sig.js';

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

/** 造一个 analyze() 返回形状的簇。 */
const cluster = (over = {}) => ({
  level: 'ERROR',
  occurrences: 1,
  normalized: 'Parsed <n> as int.',
  firstTime: '2026-10-26 12:00:00',
  lastTime: '2026-10-26 12:00:00',
  relatedModIds: [],
  strayMods: [],
  inferredTypes: [],
  files: [],
  frames: [],
  samples: ['Parsed 6.545 as int.'],
  key: 'k',
  ...over,
});
const analysisOf = (clusters, over = {}) => ({
  generatedAt: '2026-10-26T12:00:00.000Z',
  profile: { id: 'p1', name: 'test', gameVersion: '1.7' },
  sources: [{ label: '实时', available: true, incremental: false, entries: 10, summary: { errors: 3, warnings: 5 } }],
  totals: { entries: 10, errors: 3, warnings: 5 },
  clusters,
  ...over,
});

console.log('sig.js self-test');
console.log('');
console.log('归属折叠：');

checkTrue('无 attributedMod → 引擎桶', attributionBucket(cluster()).engine === true);
check('无 attributedMod 的标签', attributionBucket(cluster()).label, ENGINE_BUCKET);
checkTrue('confidence=low → 引擎桶', attributionBucket(cluster({ attributedMod: { name: 'X', packageId: 'x.y', confidence: 'low', enabled: true } })).engine === true);
checkTrue('enabled=false → 引擎桶', attributionBucket(cluster({ attributedMod: { name: 'X', packageId: 'x.y', confidence: 'high', enabled: false } })).engine === true);
check('正常归属 → mod 标签', attributionBucket(cluster({ attributedMod: { name: 'VF', packageId: 'smash.vf', confidence: 'high', enabled: true } })).label, 'VF [smash.vf]');
check('无 packageId 时只显示名', attributionBucket(cluster({ attributedMod: { name: 'VF', confidence: 'medium', enabled: true } })).label, 'VF');

console.log('');
console.log('signatureLine：');

const line = signatureLine(cluster({ occurrences: 47, attributedMod: { name: 'VF', packageId: 'smash.vf', confidence: 'high', enabled: true } }));
check('count 透传', line.count, 47);
check('engine=false', line.engine, false);
checkTrue('长签名截到 90', signatureLine(cluster({ normalized: 'x'.repeat(200), occurrences: 1 })).sig.length === 90);

console.log('');
console.log('忽略清单：');

checkTrue('normalized 命中', isIgnoredSignature(cluster({ normalized: "PA's God Hands 我修复了" }), ["pa's god hands"]));
checkTrue('样本命中（normalized 不含）', isIgnoredSignature(cluster({ normalized: 'ZZZ', samples: ['PA God Hands flavor'] }), ['god hands']));
checkTrue('不命中 → false', isIgnoredSignature(cluster({ normalized: 'Texture has dimensions' }), ['god hands']) === false);
checkTrue('空清单 → false', isIgnoredSignature(cluster(), []) === false);

console.log('');
console.log('buildCompact：');

const analysis = analysisOf([
  cluster({ occurrences: 47 }),
  cluster({ level: 'WARNING', occurrences: 78, normalized: 'Texture <d> mask mismatch' }),
  cluster({ occurrences: 3, normalized: "PA's God Hands flavor error", attributedMod: { name: 'GH', confidence: 'high', enabled: true } }),
]);
const compact = buildCompact(analysis, { ignore: ['god hands'] });
check('错误签名数（1 条被忽略）', compact.errorSignatures.length, 1);
check('忽略统计-签名数', compact.ignored.signatures, 1);
check('忽略统计-事件数', compact.ignored.events, 3);
check('警告签名数', compact.warningSignatures.length, 1);
check('概览带 errors', compact.overview[0].errors, 3);
checkTrue('无忽略时不输出 ignored 字段', buildCompact(analysis).ignored === undefined);
checkTrue('警告截断到 maxWarnings', buildCompact(analysisOf(
  Array.from({ length: 20 }, (_, i) => cluster({ level: 'WARNING', occurrences: i + 1, normalized: `w${i}` })),
), { maxWarnings: 5 }).warningSignatures.length === 5);

console.log('');
console.log('diffAnalyses：');

const current = analysisOf([
  cluster({ occurrences: 5, normalized: 'A' }),
  cluster({ occurrences: 9, normalized: 'B' }),           // 上次 3 → +6，进 changed
  cluster({ occurrences: 2, normalized: 'NEW' }),         // 新增
  cluster({ level: 'WARNING', occurrences: 4, normalized: 'W' }),
]);
const previous = analysisOf([
  cluster({ occurrences: 5, normalized: 'A' }),           // 不变
  cluster({ occurrences: 3, normalized: 'B' }),
  cluster({ occurrences: 7, normalized: 'GONE' }),        // 消失
  cluster({ level: 'WARNING', occurrences: 1, normalized: 'W' }),
]);
const diff = diffAnalyses(current, previous);
check('新增 1 条', diff.added.length, 1);
check('新增签名', diff.added[0].sig, 'NEW');
check('消失 1 条', diff.removed.length, 1);
check('消失签名', diff.removed[0].sig, 'GONE');
check('计数变化 1 条', diff.changed.length, 1);
check('变化 delta', diff.changed[0].delta, 6);

const diffBoth = diffAnalyses(current, previous, { includeWarnings: true });
checkTrue('includeWarnings 后 W 计入 changed', diffBoth.changed.some((c) => c.sig === 'W'));

const diffLoose = diffAnalyses(current, previous, { threshold: 100 });
check('阈值以下不进 changed', diffLoose.changed.length, 0);

console.log('');
if (failures === 0) {
  console.log('全部通过。');
  process.exit(0);
}
console.log(`${failures} 项失败。`);
process.exit(1);
