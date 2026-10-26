/**
 * Compare two copies of this plugin, block by block, and report the differences.
 *
 * Deliberately does NOT decide which side is newer. Version numbers, file counts, byte sizes and dates
 * are all statements made by a copy about itself; none of them establishes that one copy descends from
 * the other, and a wrong "theirs is newer" sends someone merging in the wrong direction. Every section
 * of the report is symmetric: A has this, B has that.
 *
 * The unit of comparison is a block, not a line. Two copies drift in whitespace, ordering and
 * formatting, so a line diff buries real change under churn; blocks are matched by path, kind and name,
 * so a function that moved is the same function and one that was edited is one entry.
 *
 * Usage:
 *   node tools/compare-plugin.mjs <other-dir> [--mine <dir>] [options]
 *
 * Options:
 *   --mine <dir>          the local copy (default: this plugin)
 *   --out <file>          report path (default: _work/compare-<stamp>/REPORT.md)
 *   --only changed        limit the listing to changed blocks
 *   --show-weak-signals   also report same-function guesses from name similarity and content
 *                         similarity, not only from an identical exported surface
 *   --json                also write REPORT.json next to the report
 *   --quiet               print only the summary
 *
 * Exit code is 0 whenever a report was produced; differences are not an error.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  blockId, declaredNames, exportedNames, normalizeText, referencedNames, skeleton, splitBlocks,
} from './lib-blocks.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_MINE = path.resolve(here, '..');

const SKIP_FILES = new Set(['package-lock.json']);
const SKIP_DIRS = new Set(['node_modules', '.git']);

// ---------------------------------------------------------------- option parsing

function parseArgs(argv) {
  const options = {
    other: null, mine: DEFAULT_MINE, out: null, only: 'all',
    weak: false, json: false, quiet: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mine') options.mine = path.resolve(argv[++i] ?? '');
    else if (a === '--out') options.out = path.resolve(argv[++i] ?? '');
    else if (a === '--only') options.only = argv[++i] ?? 'all';
    else if (a === '--show-weak-signals') options.weak = true;
    else if (a === '--json') options.json = true;
    else if (a === '--quiet') options.quiet = true;
    else if (a === '--help' || a === '-h') options.help = true;
    else if (!a.startsWith('--') && !options.other) options.other = path.resolve(a);
  }
  return options;
}

// ---------------------------------------------------------------- reading a copy

function walk(dir, base = dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, base, out);
    else if (entry.isFile() && !SKIP_FILES.has(entry.name)) {
      out.push(path.relative(base, full).replace(/\\/g, '/'));
    }
  }
  return out;
}

const sha = (text) => createHash('sha256').update(text).digest('hex').slice(0, 16);

/**
 * Read one copy of the plugin into a comparable shape.
 *
 * A copy without blocks.json is not an error: it just means block alignment is impossible, so the
 * caller is told and the report degrades to file level. Guessing block identity across copies that use
 * different splitting rules would be worse than saying so.
 */
function readCopy(dir, label) {
  const copy = {
    label, dir, exists: existsSync(dir), files: new Map(), blocks: new Map(),
    version: null, hasRegistry: false, registry: null, errors: [],
  };
  if (!copy.exists) {
    copy.errors.push('directory does not exist');
    return copy;
  }

  const pkgPath = path.join(dir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
      copy.version = pkg.version ?? null;
      copy.packageName = pkg.name ?? null;
    } catch (error) {
      copy.errors.push('package.json is not valid JSON: ' + error.message);
    }
  } else {
    copy.errors.push('no package.json');
  }

  const regPath = path.join(dir, 'blocks.json');
  if (existsSync(regPath)) {
    try {
      const reg = JSON.parse(readFileSync(regPath, 'utf8'));
      if (reg.schema === 'rimworld-log.blocks') {
        copy.hasRegistry = true;
        copy.registry = reg;
      } else {
        copy.errors.push('blocks.json has an unrecognised schema: ' + String(reg.schema));
      }
    } catch (error) {
      copy.errors.push('blocks.json is not valid JSON: ' + error.message);
    }
  }

  // Registry records, keyed by block id, for provenance.
  const provenance = new Map();
  if (copy.hasRegistry) {
    for (const b of copy.registry.blocks ?? []) provenance.set(b.id, b);
  }

  for (const rel of walk(dir)) {
    let text;
    try {
      text = readFileSync(path.join(dir, rel), 'utf8');
    } catch {
      continue;
    }
    copy.files.set(rel, { hash: sha(normalizeText(text)), size: statSync(path.join(dir, rel)).size });

    for (const block of splitBlocks(rel, text)) {
      const id = blockId(rel, block);
      const record = provenance.get(id);
      copy.blocks.set(id, {
        id,
        file: rel,
        kind: block.kind,
        name: block.name,
        hash: sha(normalizeText(block.body)),
        body: block.body,
        lineCount: block.body.split('\n').length,
        exports: [...exportedNames(block.body)],
        declares: [...declaredNames(block.body)],
        refs: [...referencedNames(block.body)],
        record: record ?? null,
        provenance: describeProvenance(record),
      });
    }
  }

  return copy;
}

/** One-line provenance string, honest about not knowing. */
function describeProvenance(record) {
  if (!record) return 'not in registry';
  const parts = [];
  if (record.author) {
    parts.push(`${record.version} by ${record.author} on ${record.date}`);
  } else if (record.baseline) {
    parts.push('author unknown (pre-dates the registry)');
  } else {
    parts.push('author not recorded');
  }
  if (record.modifiedBy) {
    parts.push(`last changed ${record.modifiedVersion} by ${record.modifiedBy} on ${record.modifiedDate}`
      + (record.modifiedCount > 1 ? ` (${record.modifiedCount} changes)` : ''));
  }
  if (record.removedAt) parts.push(`recorded removed ${record.removedAt}`);
  return parts.join('; ');
}

// ---------------------------------------------------------------- comparison

/**
 * Language keywords, globals and built-in types, which no copy has to define.
 *
 * The dependency check walks every identifier a block mentions, so without this list it reported
 * `export`, `function`, `return` and `String` as missing and buried the entries that mattered.
 */
const NON_SYMBOLS = new Set([
  'await', 'async', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'from', 'function', 'get', 'if',
  'import', 'in', 'instanceof', 'let', 'new', 'of', 'return', 'set', 'static', 'super', 'switch',
  'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
  'true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'globalThis', 'process', 'console',
  'require', 'module', 'exports', '__dirname', '__filename',
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Math', 'JSON', 'Date',
  'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'Promise', 'Map', 'Set', 'WeakMap',
  'WeakSet', 'Proxy', 'Reflect', 'Intl', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'Buffer', 'Uint8Array', 'Int32Array', 'Float64Array', 'ArrayBuffer', 'DataView',
  'and', 'as', 'assert', 'def', 'del', 'elif', 'except', 'global', 'is', 'lambda', 'None', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'self', 'True', 'False', 'print', 'len', 'str', 'int', 'float',
  'list', 'dict', 'tuple', 'set', 'open', 'range', 'enumerate', 'sorted', 'isinstance', 'Exception',
]);

function compare(a, b, options) {
  const result = {
    filesOnlyA: [], filesOnlyB: [], filesDiffer: [], filesSame: [],
    blocksOnlyA: [], blocksOnlyB: [], blocksDiffer: [], blocksSame: [],
    suspected: [], unresolved: [], undecided: [],
  };

  for (const [rel, meta] of a.files) {
    const other = b.files.get(rel);
    if (!other) result.filesOnlyA.push(rel);
    else if (other.hash !== meta.hash) result.filesDiffer.push(rel);
    else result.filesSame.push(rel);
  }
  for (const rel of b.files.keys()) {
    if (!a.files.has(rel)) result.filesOnlyB.push(rel);
  }

  for (const [id, block] of a.blocks) {
    const other = b.blocks.get(id);
    if (!other) result.blocksOnlyA.push(block);
    else if (other.hash !== block.hash) result.blocksDiffer.push({ a: block, b: other });
    else result.blocksSame.push(block);
  }
  for (const [id, block] of b.blocks) {
    if (!a.blocks.has(id)) result.blocksOnlyB.push(block);
  }

  result.blocksOnlyA.sort((x, y) => (x.id < y.id ? -1 : 1));
  result.blocksOnlyB.sort((x, y) => (x.id < y.id ? -1 : 1));
  result.blocksDiffer.sort((x, y) => (x.a.id < y.a.id ? -1 : 1));

  // ---- suspected same-function blocks -----------------------------------
  //
  // By default only the strong signal is reported: two blocks whose exported surface is identical.
  // Same-named exports cannot coexist in one module, so that pair really is a choice. Name similarity
  // and content similarity are guesses that misfire often - `parseEntry` and `parseEntries` may be
  // unrelated - so they are opt-in.
  //
  // Structural filler is excluded from every match below. The splitter names the text before a file's
  // first declaration `__leading__`, and a Markdown file's text before its first heading `__preamble__`,
  // so dozens of unrelated files share those names. Comparing them against each other produced 4530
  // pairs of pure noise on the first run.
  const FILLER_NAMES = new Set([
    '__leading__', '__preamble__', '(file)', '',
  ]);
  const isFiller = (block) => FILLER_NAMES.has(block.name);

  const aByName = new Map();
  for (const block of a.blocks.values()) {
    if (!aByName.has(block.name)) aByName.set(block.name, []);
    aByName.get(block.name).push(block);
  }
  const bByName = new Map();
  for (const block of b.blocks.values()) {
    if (!bByName.has(block.name)) bByName.set(block.name, []);
    bByName.get(block.name).push(block);
  }

  // Same name, different file/kind: a rename or a genuine duplicate.
  //
  // The name alone is not evidence. Two earlier versions of this rule keyed on the name and produced
  // 4537 then 62 pairs that were almost entirely noise - `const env` declared locally in 33 scripts, then
  // a five-line `check` helper implemented separately in a dozen test files. Neither is a duplicate
  // implementation; both are ordinary local plumbing that happens to share a spelling.
  //
  // A duplicate implementation has to look like one, so a shared name now also requires the bodies to be
  // at least 70% similar once comments and whitespace are removed. That check is always on, including
  // when weak signals are off, because without it the rule reports nothing worth reading.
  const BEHAVIOURAL_KINDS = new Set(['function', 'class', 'def']);
  const worthComparing = (block) => BEHAVIOURAL_KINDS.has(block.kind);
  const DUPLICATE_SIMILARITY = 0.7;

  for (const [name, listA] of aByName) {
    const listB = bByName.get(name);
    if (!listB) continue;
    for (const blockA of listA) {
      if (isFiller(blockA) || !worthComparing(blockA)) continue;
      for (const blockB of listB) {
        if (blockA.id === blockB.id) continue;
        if (isFiller(blockB) || !worthComparing(blockB)) continue;

        const ratio = similarity(skeleton(blockA.body), skeleton(blockB.body));

        if (blockA.file === blockB.file) {
          // Same file, same name, different kind: a rename such as `const f` becoming `function f`.
          result.suspected.push({ kind: 'rename-candidate', name, a: blockA, b: blockB,
            signal: 'same name in the same file but a different kind' });
          continue;
        }
        if (ratio >= 0.999) {
          result.suspected.push({ kind: 'identical-content', name, a: blockA, b: blockB,
            signal: 'same name and identical content after normalisation' });
          continue;
        }
        if (ratio >= DUPLICATE_SIMILARITY) {
          result.suspected.push({ kind: 'duplicate-name', name, a: blockA, b: blockB,
            signal: `same name and ${(ratio * 100).toFixed(0)}% similar content` });
        }
        // Below the threshold, a shared name means nothing and is deliberately not reported.
      }
    }
  }

  // Exported-surface collisions across files: the strong signal.
  //
  // Tightened after a first run reported 4537 pairs. The cause was that nearly every script in tools/
  // opens with an `export function main()`, so `main` matched everything against everything. That is not
  // what "same exported surface" is supposed to catch: each of those files is a separate entry point and
  // two `main` functions do not compete.
  //
  // The signal is only meaningful when the two exports would occupy the same module namespace, so:
  //   - both blocks must be functions (a `const` is a value, not a behaviour)
  //   - `main` is excluded by name, since it is an entry-point convention rather than an interface
  //   - each block must export only one name, so the surface really is that name
  const ENTRY_POINT_NAMES = new Set(['main', 'run', 'start', 'cli', 'default']);

  const aByExport = new Map();
  for (const block of a.blocks.values()) {
    if (block.kind !== 'function') continue;
    if (block.exports.length !== 1) continue;
    if (isFiller(block)) continue;
    const name = block.exports[0];
    if (ENTRY_POINT_NAMES.has(name.toLowerCase())) continue;
    if (!aByExport.has(name)) aByExport.set(name, []);
    aByExport.get(name).push(block);
  }
  for (const blockB of b.blocks.values()) {
    if (blockB.kind !== 'function') continue;
    if (blockB.exports.length !== 1) continue;
    if (isFiller(blockB)) continue;
    const name = blockB.exports[0];
    if (ENTRY_POINT_NAMES.has(name.toLowerCase())) continue;
    for (const blockA of aByExport.get(name) ?? []) {
      if (blockA.id === blockB.id) continue;
      if (blockA.hash === blockB.hash) continue;
      if (result.suspected.some((s) => s.a.id === blockA.id && s.b.id === blockB.id)) continue;
      result.suspected.push({
        kind: 'same-export',
        name,
        a: blockA,
        b: blockB,
        signal: `both are functions exporting only \`${name}\``,
      });
    }
  }

  // Weak signals, only when asked for.
  if (options.weak) {
    const flatten = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    for (const blockA of a.blocks.values()) {
      for (const blockB of b.blocks.values()) {
        if (blockA.id === blockB.id) continue;
        if (blockA.hash === blockB.hash) continue;
        if (blockA.kind !== blockB.kind) continue;
        if (result.suspected.some((s) => s.a.id === blockA.id && s.b.id === blockB.id)) continue;

        const fa = flatten(blockA.name);
        const fb = flatten(blockB.name);
        if (fa.length >= 4 && fb.length >= 4 && (fa.includes(fb) || fb.includes(fa))) {
          result.suspected.push({ kind: 'name-similar', name: blockA.name, a: blockA, b: blockB,
            signal: `names overlap: \`${blockA.name}\` vs \`${blockB.name}\`` });
          continue;
        }

        const sa = skeleton(blockA.body);
        const sb = skeleton(blockB.body);
        if (sa.length < 80 || sb.length < 80) continue;
        const ratio = similarity(sa, sb);
        if (ratio >= 0.86) {
          result.suspected.push({ kind: 'content-similar', name: blockA.name, a: blockA, b: blockB,
            signal: `content ${(ratio * 100).toFixed(0)}% similar after normalisation` });
        }
      }
    }
  }

  // ---- unresolved symbols ----------------------------------------------
  //
  // For blocks that exist only in A and look importable, check whether the names they mention are
  // resolvable in B. This is a heuristic and is labelled as one: a name can be built-in, a property, or
  // defined inline, so anything reported here is "worth a look", not "broken".
  const bKnown = new Set();
  for (const block of b.blocks.values()) for (const name of block.declares) bKnown.add(name);

  for (const block of [...result.blocksOnlyA, ...result.blocksDiffer.map((p) => p.a)]) {
    if (!/\.(mjs|js|cjs|py)$/.test(block.file)) continue;
    const own = new Set(block.declares);
    const missing = [];
    for (const name of block.refs) {
      if (own.has(name)) continue;
      if (bKnown.has(name)) continue;
      if (NON_SYMBOLS.has(name)) continue;
      if (new RegExp(`\\.\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(block.body)) continue;
      missing.push(name);
    }
    // Keep only names that are actually invoked, to cut the remaining noise.
    const interesting = missing.filter((n) =>
      new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`).test(block.body));
    if (interesting.length) {
      result.unresolved.push({ block, names: interesting.slice(0, 12) });
    }
  }

  // ---- things a human has to answer -------------------------------------
  if (!a.hasRegistry && !b.hasRegistry) {
    result.undecided.push('Neither copy has blocks.json, so no block-level alignment was possible.');
  } else if (!a.hasRegistry) {
    result.undecided.push('A has no blocks.json, so its blocks could not be aligned; '
      + 'its side is reported at file level only.');
  } else if (!b.hasRegistry) {
    result.undecided.push('B has no blocks.json, so its blocks could not be aligned; '
      + 'its side is reported at file level only.');
  }

  return result;
}

/** Cheap bigram similarity, good enough to rank candidates. */
function similarity(x, y) {
  if (x === y) return 1;
  const bigrams = (s) => {
    const set = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const gram = s.slice(i, i + 2);
      set.set(gram, (set.get(gram) ?? 0) + 1);
    }
    return set;
  };
  const bx = bigrams(x);
  const by = bigrams(y);
  let overlap = 0;
  for (const [gram, count] of bx) overlap += Math.min(count, by.get(gram) ?? 0);
  return (2 * overlap) / (x.length + y.length - 2 || 1);
}

// ---------------------------------------------------------------- report

function renderReport(a, b, diff, options, stamp) {
  const L = [];
  const versionLine = (copy) => {
    const bits = [];
    bits.push(`${copy.files.size} files`);
    bits.push(`${copy.blocks.size} blocks`);
    let bytes = 0;
    for (const meta of copy.files.values()) bytes += meta.size;
    bits.push(`${bytes.toLocaleString()} B`);
    if (copy.version) bits.push(`declared version ${copy.version} (recorded only, never used to decide anything)`);
    else bits.push('no declared version');
    if (!copy.hasRegistry) bits.push('no blocks.json - block alignment unavailable');
    return bits.join(' · ');
  };

  L.push('# 插件比对报告');
  L.push('');
  L.push(`生成时间：${stamp}`);
  L.push('');
  L.push('> **本报告不判断谁新谁旧。** 版本号、文件数、字节数、日期都是各方对自己做的声明，');
  L.push('> 都不足以证明一方源自另一方。所有章节都是对称的：A 有什么、B 有什么。');
  L.push('');
  L.push('| | A（对方） | B（本地） |');
  L.push('|---|---|---|');
  L.push(`| 目录 | \`${a.dir}\` | \`${b.dir}\` |`);
  L.push(`| 清单 | ${versionLine(a)} | ${versionLine(b)} |`);
  if (a.errors.length || b.errors.length) {
    L.push(`| 读取问题 | ${a.errors.join('; ') || '—'} | ${b.errors.join('; ') || '—'} |`);
  }
  L.push('');

  // ---- summary
  L.push('## 一、汇总');
  L.push('');
  L.push('| 项 | 数量 |');
  L.push('|---|---|');
  L.push(`| 文件完全相同 | ${diff.filesSame.length} |`);
  L.push(`| 文件仅 A 有 | ${diff.filesOnlyA.length} |`);
  L.push(`| 文件仅 B 有 | ${diff.filesOnlyB.length} |`);
  L.push(`| 文件两边都有但内容不同 | ${diff.filesDiffer.length} |`);
  L.push(`| 块完全相同 | ${diff.blocksSame.length} |`);
  L.push(`| 块仅 A 有 | ${diff.blocksOnlyA.length} |`);
  L.push(`| 块仅 B 有 | ${diff.blocksOnlyB.length} |`);
  L.push(`| 块两边都有但内容不同 | ${diff.blocksDiffer.length} |`);
  L.push(`| 疑似同功能的块对 | ${diff.suspected.length}${options.weak ? '（含弱信号）' : '（仅强信号）'} |`);
  L.push(`| 依赖待查的块 | ${diff.unresolved.length} |`);
  L.push(`| 未决问题 | ${diff.undecided.length} |`);
  L.push('');

  // ---- only A
  L.push(`## 二、A 有 B 没有（${diff.filesOnlyA.length} 个文件）`);
  L.push('');
  if (!diff.filesOnlyA.length) L.push('（无）');
  else {
    const groups = groupByPurpose(diff.filesOnlyA);
    for (const [label, rows] of groups) {
      L.push(`### ${label}（${rows.length}）`);
      L.push('');
      L.push('| 文件 | 字节 |');
      L.push('|---|---|');
      for (const rel of rows) L.push(`| \`${rel}\` | ${a.files.get(rel).size.toLocaleString()} |`);
      L.push('');
    }
  }
  L.push('');

  // ---- only B
  L.push(`## 三、B 有 A 没有（${diff.filesOnlyB.length} 个文件）`);
  L.push('');
  L.push('> 这一节只陈述事实。是 A 删掉了它们、还是 B 后加的，本报告不做判断。');
  L.push('');
  if (!diff.filesOnlyB.length) L.push('（无）');
  else {
    L.push('| 文件 | 字节 |');
    L.push('|---|---|');
    for (const rel of diff.filesOnlyB) L.push(`| \`${rel}\` | ${b.files.get(rel).size.toLocaleString()} |`);
  }
  L.push('');

  // ---- differing blocks
  L.push(`## 四、两边都有但内容不同的块（${diff.blocksDiffer.length}）`);
  L.push('');
  if (!diff.blocksDiffer.length) L.push('（无）');
  else {
    L.push('| 块 | A 出处 | B 出处 | 行数 A→B |');
    L.push('|---|---|---|---|');
    for (const pair of diff.blocksDiffer) {
      L.push(`| \`${pair.a.id}\` | ${pair.a.provenance} | ${pair.b.provenance}`
        + ` | ${pair.a.lineCount}→${pair.b.lineCount} |`);
    }
    if (options.only !== 'changed') {
      L.push('');
      L.push('<details><summary>逐块内容</summary>');
      L.push('');
      for (const pair of diff.blocksDiffer.slice(0, 40)) {
        L.push(`### \`${pair.a.id}\``);
        L.push('');
        L.push('A：');
        L.push('');
        L.push('```');
        L.push(clip(pair.a.body, 24));
        L.push('```');
        L.push('');
        L.push('B：');
        L.push('');
        L.push('```');
        L.push(clip(pair.b.body, 24));
        L.push('```');
        L.push('');
      }
      if (diff.blocksDiffer.length > 40) {
        L.push(`（另有 ${diff.blocksDiffer.length - 40} 个未展开）`);
      }
      L.push('</details>');
    }
  }
  L.push('');

  // ---- block-level additions and removals
  L.push(`## 五、仅 A 有的块（${diff.blocksOnlyA.length}）`);
  L.push('');
  if (!diff.blocksOnlyA.length) L.push('（无）');
  else {
    L.push('| 块 | 出处 | 行 | 导出 |');
    L.push('|---|---|---|---|');
    for (const block of diff.blocksOnlyA) {
      L.push(`| \`${block.id}\` | ${block.provenance} | ${block.lineCount}`
        + ` | ${block.exports.length ? block.exports.join(', ') : '—'} |`);
    }
  }
  L.push('');
  L.push(`## 六、仅 B 有的块（${diff.blocksOnlyB.length}）`);
  L.push('');
  if (!diff.blocksOnlyB.length) L.push('（无）');
  else {
    L.push('| 块 | 出处 | 行 |');
    L.push('|---|---|---|');
    for (const block of diff.blocksOnlyB) {
      L.push(`| \`${block.id}\` | ${block.provenance} | ${block.lineCount} |`);
    }
  }
  L.push('');

  // ---- suspected duplicates
  L.push(`## 七、疑似同功能的块（${diff.suspected.length}）`);
  L.push('');
  if (!options.weak) {
    L.push('**默认只报强信号：两块的导出面完全相同。** 同名的导出无法在同一模块里共存，');
    L.push('所以那一对确实是替代关系。名字相似与内容相近属于猜测、误报率高，');
    L.push('需要时加 `--show-weak-signals` 才列出。');
  } else {
    L.push('**已启用 `--show-weak-signals`**：除导出面相同外，还列出名字相似与内容相近的猜测。');
    L.push('**带「弱信号」标记的条目误报率高，请自行筛选。**');
  }
  L.push('');
  if (!diff.suspected.length) L.push('（无）');
  else {
    const weakKinds = new Set(['name-similar', 'content-similar']);
    for (const item of diff.suspected.slice(0, 60)) {
      const weak = weakKinds.has(item.kind) ? ' **（弱信号）**' : '';
      L.push(`### ${item.kind}${weak} — \`${item.name}\``);
      L.push('');
      L.push(`- **触发信号**：${item.signal}`);
      L.push(`- A：\`${item.a.id}\` · ${item.a.provenance} · ${item.a.lineCount} 行`
        + `${item.a.exports.length ? ' · 导出 ' + item.a.exports.join(', ') : ''}`);
      L.push(`- B：\`${item.b.id}\` · ${item.b.provenance} · ${item.b.lineCount} 行`
        + `${item.b.exports.length ? ' · 导出 ' + item.b.exports.join(', ') : ''}`);
      L.push('');
      const disposal = disposalAdvice(item);
      L.push(`- **性质**：${disposal.nature}`);
      L.push(`- **建议**：${disposal.advice}`);
      L.push('');
    }
    if (diff.suspected.length > 60) L.push(`（另有 ${diff.suspected.length - 60} 对未展开）`);
  }
  L.push('');

  // ---- import order
  L.push('## 八、可学清单与导入顺序');
  L.push('');
  L.push('按**导入的安全性**排序，与时间、版本无关。');
  L.push('');
  const tiers = [
    ['第一档 · 整文件新增的文档（零风险）', diff.filesOnlyA.filter((r) => /\.md$/i.test(r))],
    ['第二档 · 整文件新增的本地化与静态资源', diff.filesOnlyA.filter((r) => !/\.md$/i.test(r)
      && /\.(json|svg|txt)$/i.test(r))],
    ['第三档 · 整文件新增的工具脚本（需看依赖）', diff.filesOnlyA.filter((r) => !/\.md$/i.test(r)
      && !/\.(json|svg|txt)$/i.test(r))],
  ];
  for (const [label, rows] of tiers) {
    L.push(`### ${label}（${rows.length}）`);
    L.push('');
    if (!rows.length) L.push('（无）');
    else for (const rel of rows) L.push(`- \`${rel}\``);
    L.push('');
  }
  L.push(`### 第四档 · 共有文件里的块改动（${diff.blocksDiffer.length}，必须人工看依赖）`);
  L.push('');
  if (!diff.blocksDiffer.length) L.push('（无）');
  else for (const pair of diff.blocksDiffer.slice(0, 40)) L.push(`- \`${pair.a.id}\``);
  L.push('');

  // ---- undecided
  L.push(`## 九、未决问题（${diff.undecided.length}）`);
  L.push('');
  if (!diff.undecided.length) L.push('（无）');
  else for (const item of diff.undecided) L.push(`- ${item}`);
  L.push('');

  // ---- unresolved
  L.push(`## 十、依赖待查`);
  L.push('');
  L.push('> **这是启发式检查，不是结论。** 一个名字可能是内置的、某个对象的属性、或块内就地定义的，');
  L.push('> 所以这里列出的只是「值得看一眼」，不代表导入就会坏。');
  L.push('');
  if (!diff.unresolved.length) L.push('（无）');
  else {
    L.push('| 块 | B 里找不到的名字 |');
    L.push('|---|---|');
    for (const item of diff.unresolved.slice(0, 40)) {
      L.push(`| \`${item.block.id}\` | ${item.names.map((n) => '`' + n + '`').join(', ')} |`);
    }
  }
  L.push('');

  // ---- fully identical
  L.push(`## 附：完全相同的文件（${diff.filesSame.length}）`);
  L.push('');
  L.push('列出是为了让你知道没有遗漏。');
  L.push('');
  L.push('<details><summary>展开</summary>');
  L.push('');
  for (const rel of diff.filesSame) L.push(`- \`${rel}\``);
  L.push('');
  L.push('</details>');
  L.push('');

  return L.join('\n');
}

function disposalAdvice(item) {
  switch (item.kind) {
    case 'same-export':
      return {
        nature: '**替代关系** —— 两块导出同一个名字，无法在同一模块共存。',
        advice: '二选一。不要两个都要：那会留下一份永不执行的死代码。'
          + '若确实需要两者的能力，应把差异部分合成一个块，而不是并排放两个。',
      };
    case 'identical-content':
      return {
        nature: '**内容相同** —— 同一个块换了位置或名字。',
        advice: '不需要导入；这是同一次改动在两边的不同表现。',
      };
    case 'rename-candidate':
      return {
        nature: '**疑似改名** —— 同文件内同名但块类型不同（例如 `const f` 变成 `function f`）。',
        advice: '若确为改名，在 `blocks.json` 里给该块加 `aliases`，下次比对就不会再报为「新增+删除」。',
      };
    case 'duplicate-name':
      return {
        nature: '**同名不同文件** —— 可能是重复实现，也可能是两个不同用途的同名工具。',
        advice: '看两块的导出与调用点再决定。若无调用冲突，可以都保留。',
      };
    case 'name-similar':
      return {
        nature: '**弱信号：名字相似** —— 可能是同一功能，也可能毫无关系（`parseEntry` 与 `parseEntries`）。',
        advice: '对比两块的输出形状。形状不同就不是同一功能，可共存。',
      };
    default:
      return {
        nature: '**弱信号：内容相近** —— 归一化后高度相似，但不足以断定等价。',
        advice: '看差异的那几行。若差异只是写法，保留本地那份即可。',
      };
  }
}

function groupByPurpose(files) {
  const groups = new Map();
  const put = (label, rel) => {
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(rel);
  };
  for (const rel of files) {
    if (/\.md$/i.test(rel)) put('文档', rel);
    else if (/^locale\//.test(rel) || /\.(json|svg)$/i.test(rel)) put('本地化与静态资源', rel);
    else if (/^tools\//.test(rel)) put('工具脚本', rel);
    else if (/^plugins\//.test(rel)) put('插件模块', rel);
    else put('其它', rel);
  }
  return [...groups.entries()].sort((x, y) => y[1].length - x[1].length);
}

function clip(text, maxLines) {
  const lines = String(text).split('\n');
  if (lines.length <= maxLines) return text;
  return lines.slice(0, maxLines).join('\n') + `\n… (${lines.length - maxLines} more lines)`;
}

// ---------------------------------------------------------------- main

function main() {
  const options = parseArgs(process.argv.slice(2));

  if (options.help || !options.other) {
    console.log('usage: node tools/compare-plugin.mjs <other-dir> [options]');
    console.log('');
    console.log('  --mine <dir>          the local copy (default: this plugin)');
    console.log('  --out <file>          report path');
    console.log('  --only changed        limit the listing to changed blocks');
    console.log('  --show-weak-signals   also report name/content similarity guesses');
    console.log('  --json                also write REPORT.json');
    console.log('  --quiet               print only the summary');
    console.log('');
    console.log('The report never decides which copy is newer. All sections are symmetric.');
    return options.help ? 0 : 2;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const a = readCopy(options.other, 'A (other)');
  const b = readCopy(options.mine, 'B (mine)');

  if (!a.exists) {
    console.error('the other directory does not exist: ' + a.dir);
    return 2;
  }
  if (!b.exists) {
    console.error('the local directory does not exist: ' + b.dir);
    return 2;
  }

  const diff = compare(a, b, options);
  const report = renderReport(a, b, diff, options, stamp);

  const outDir = options.out ? path.dirname(options.out)
    : path.join(path.resolve(b.dir, '..'), '_work', 'compare-' + stamp);
  const outFile = options.out ?? path.join(outDir, 'REPORT.md');

  try {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(outFile, report, 'utf8');
    if (options.json) {
      writeFileSync(path.join(outDir, 'REPORT.json'), JSON.stringify({
        schema: 'rimworld-log.compare-report',
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        note: 'No ordering is implied. A is the side passed on the command line, B is --mine.',
        a: { dir: a.dir, version: a.version, files: a.files.size, blocks: a.blocks.size,
             hasRegistry: a.hasRegistry, errors: a.errors },
        b: { dir: b.dir, version: b.version, files: b.files.size, blocks: b.blocks.size,
             hasRegistry: b.hasRegistry, errors: b.errors },
        summary: {
          filesSame: diff.filesSame.length,
          filesOnlyA: diff.filesOnlyA.length,
          filesOnlyB: diff.filesOnlyB.length,
          filesDiffer: diff.filesDiffer.length,
          blocksSame: diff.blocksSame.length,
          blocksOnlyA: diff.blocksOnlyA.length,
          blocksOnlyB: diff.blocksOnlyB.length,
          blocksDiffer: diff.blocksDiffer.length,
          suspected: diff.suspected.length,
          unresolved: diff.unresolved.length,
        },
        filesOnlyA: diff.filesOnlyA,
        filesOnlyB: diff.filesOnlyB,
        filesDiffer: diff.filesDiffer,
        blocksOnlyA: diff.blocksOnlyA.map((x) => ({ id: x.id, provenance: x.provenance })),
        blocksOnlyB: diff.blocksOnlyB.map((x) => ({ id: x.id, provenance: x.provenance })),
        blocksDiffer: diff.blocksDiffer.map((p) => ({ id: p.a.id, a: p.a.provenance, b: p.b.provenance })),
        suspected: diff.suspected.map((s) => ({ kind: s.kind, name: s.name, signal: s.signal,
          a: s.a.id, b: s.b.id })),
        undecided: diff.undecided,
      }, null, 2) + '\n', 'utf8');
    }
  } catch (error) {
    console.error('could not write the report: ' + error.message);
    console.log('');
    console.log(report);
    return 1;
  }

  const summary = [
    ['A (other)', a], ['B (mine)', b],
  ].map(([label, copy]) => `  ${label.padEnd(10)} ${String(copy.files.size).padStart(3)} files`
    + `  ${String(copy.blocks.size).padStart(4)} blocks`
    + (copy.hasRegistry ? '' : '   (no blocks.json)')).join('\n');

  console.log('plugin comparison');
  console.log('');
  console.log(summary);
  console.log('');
  console.log('  no ordering is implied by this report');
  console.log('');
  console.log(`  files      same ${diff.filesSame.length}`
    + `   only A ${diff.filesOnlyA.length}`
    + `   only B ${diff.filesOnlyB.length}`
    + `   differ ${diff.filesDiffer.length}`);
  console.log(`  blocks     same ${diff.blocksSame.length}`
    + `   only A ${diff.blocksOnlyA.length}`
    + `   only B ${diff.blocksOnlyB.length}`
    + `   differ ${diff.blocksDiffer.length}`);
  console.log(`  suspected  ${diff.suspected.length}${options.weak ? ' (weak signals on)' : ' (strong signal only)'}`);
  console.log(`  unresolved ${diff.unresolved.length}   undecided ${diff.undecided.length}`);
  console.log('');
  console.log('report: ' + outFile);
  if (options.json) console.log('json  : ' + path.join(outDir, 'REPORT.json'));

  if (!options.quiet) {
    console.log('');
    if (diff.filesOnlyA.length) {
      console.log('only in A:');
      for (const rel of diff.filesOnlyA.slice(0, 20)) console.log('  ' + rel);
      if (diff.filesOnlyA.length > 20) console.log(`  … ${diff.filesOnlyA.length - 20} more`);
      console.log('');
    }
    if (diff.filesOnlyB.length) {
      console.log('only in B:');
      for (const rel of diff.filesOnlyB.slice(0, 20)) console.log('  ' + rel);
      if (diff.filesOnlyB.length > 20) console.log(`  … ${diff.filesOnlyB.length - 20} more`);
      console.log('');
    }
    if (diff.suspected.length) {
      console.log('suspected same-function blocks:');
      for (const item of diff.suspected.slice(0, 12)) {
        console.log(`  [${item.kind}] ${item.name}`);
        console.log(`      ${item.signal}`);
      }
      if (diff.suspected.length > 12) console.log(`  … ${diff.suspected.length - 12} more`);
      console.log('');
    }
  }

  return 0;
}

process.exit(main());
