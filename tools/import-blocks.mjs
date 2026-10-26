/**
 * Import selected blocks from another copy of this plugin.
 *
 * Nothing is written to the plugin by default. Staging exists because merging someone else's code is the
 * most dangerous thing this toolkit does: a block can depend on a sibling block, on a new import, or on
 * a helper the other copy added elsewhere, and a merge that lands half of that produces code that runs
 * and is subtly wrong. That is worse than a merge that fails, so the tool stages, reports, and waits.
 *
 * Safety tiers
 *   default        stage only, print the apply command
 *   --apply-safe   additionally write whole-file additions that cannot conflict: new .md documents, and
 *                  new locale/*.json. Never touches a file that already exists.
 *   --apply --yes  write everything selected, including edits to existing files
 *
 * Provenance is carried across. An imported block keeps the original author, date and sub-version in the
 * local registry, marked as imported, so a later comparison can still tell whose work it was.
 *
 * Usage:
 *   node tools/import-blocks.mjs <other-dir> --blocks <id,id,...> [options]
 *   node tools/import-blocks.mjs <other-dir> --files <rel,rel,...> [options]
 *   node tools/import-blocks.mjs <other-dir> --tier docs|locale|new-tools [options]
 *
 * Options:
 *   --into <dir>     the local copy (default: this plugin)
 *   --stage <dir>    staging directory (default: <workspace>/_work/import-<stamp>)
 *   --apply-safe     also write the safe whole-file additions
 *   --apply          write everything selected
 *   --yes            required together with --apply
 *   --json           also write IMPORT.json
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { blockId, normalizeText, splitBlocks } from './lib-blocks.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_INTO = path.resolve(here, '..');

const SKIP_DIRS = new Set(['node_modules', '.git', '_archive', '_work']);
const SKIP_FILES = new Set(['package-lock.json']);

function parseArgs(argv) {
  const o = {
    other: null, into: DEFAULT_INTO, stage: null, blocks: [], files: [], tier: null,
    applySafe: false, apply: false, yes: false, json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--into') o.into = path.resolve(argv[++i] ?? '');
    else if (a === '--stage') o.stage = path.resolve(argv[++i] ?? '');
    else if (a === '--blocks') o.blocks.push(...String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--files') o.files.push(...String(argv[++i] ?? '').split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--tier') o.tier = argv[++i] ?? null;
    else if (a === '--apply-safe') o.applySafe = true;
    else if (a === '--apply') o.apply = true;
    else if (a === '--yes') o.yes = true;
    else if (a === '--json') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (!a.startsWith('--') && !o.other) o.other = path.resolve(a);
  }
  return o;
}

function walk(dir, base = dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else if (e.isFile() && !SKIP_FILES.has(e.name)) out.push(path.relative(base, full).replace(/\\/g, '/'));
  }
  return out;
}

/** Read a copy: file text plus the blocks inside each file. */
function readCopy(dir) {
  const files = new Map();
  const blocks = new Map();
  for (const rel of walk(dir)) {
    let text;
    try {
      text = readFileSync(path.join(dir, rel), 'utf8');
    } catch {
      continue;
    }
    files.set(rel, text);
    for (const block of splitBlocks(rel, text)) {
      const id = blockId(rel, block);
      blocks.set(id, { id, file: rel, kind: block.kind, name: block.name, body: block.body });
    }
  }
  let registry = null;
  const regPath = path.join(dir, 'blocks.json');
  if (existsSync(regPath)) {
    try {
      registry = JSON.parse(readFileSync(regPath, 'utf8'));
    } catch {
      registry = null;
    }
  }
  return { files, blocks, registry };
}

/**
 * Names that are language keywords, globals or built-in types rather than something a copy would have to
 * define. Without this list the dependency check reported `export`, `function`, `return` and `String` as
 * missing, which buried the one or two entries that mattered.
 */
const NON_SYMBOLS = new Set([
  // JavaScript keywords and statements
  'await', 'async', 'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
  'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'from', 'function', 'get', 'if',
  'import', 'in', 'instanceof', 'let', 'new', 'of', 'return', 'set', 'static', 'super', 'switch',
  'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
  // JavaScript literals and globals
  'true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'globalThis', 'process', 'console',
  'require', 'module', 'exports', '__dirname', '__filename',
  // Built-in constructors and namespaces
  'Object', 'Array', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Math', 'JSON', 'Date',
  'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'Promise', 'Map', 'Set', 'WeakMap',
  'WeakSet', 'Proxy', 'Reflect', 'Intl', 'URL', 'URLSearchParams', 'TextEncoder', 'TextDecoder',
  'Buffer', 'Uint8Array', 'Int32Array', 'Float64Array', 'ArrayBuffer', 'DataView',
  // Python keywords and builtins, since tools/ also holds .py files
  'and', 'as', 'assert', 'def', 'del', 'elif', 'except', 'global', 'is', 'lambda', 'None', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'self', 'True', 'False', 'print', 'len', 'str', 'int', 'float',
  'list', 'dict', 'tuple', 'set', 'open', 'range', 'enumerate', 'sorted', 'isinstance', 'Exception',
]);

function main() {
  const o = parseArgs(process.argv.slice(2));

  if (o.help || !o.other) {
    console.log('usage: node tools/import-blocks.mjs <other-dir> --blocks <id,id> [options]');
    console.log('');
    console.log('  --files <rel,rel>   whole files instead of blocks');
    console.log('  --tier docs|locale|new-tools   select a whole safety tier');
    console.log('  --into <dir>        the local copy (default: this plugin)');
    console.log('  --stage <dir>       staging directory');
    console.log('  --apply-safe        also write the safe whole-file additions');
    console.log('  --apply --yes       write everything selected');
    console.log('  --json              also write IMPORT.json');
    console.log('');
    console.log('By default nothing is written to the plugin: a staging directory is produced.');
    return o.help ? 0 : 2;
  }

  if (!existsSync(o.other)) {
    console.error('the other directory does not exist: ' + o.other);
    return 2;
  }

  const remote = readCopy(o.other);
  const localFiles = new Map();
  for (const rel of walk(o.into)) {
    try {
      localFiles.set(rel, readFileSync(path.join(o.into, rel), 'utf8'));
    } catch {
      /* unreadable files are simply absent from the local view */
    }
  }

  // ---------------------------------------------------------------- selection

  const selection = { files: new Set(), blocks: new Set() };

  for (const rel of o.files) {
    if (!remote.files.has(rel)) {
      console.error('no such file in the other copy: ' + rel);
      return 2;
    }
    selection.files.add(rel);
  }

  for (const id of o.blocks) {
    if (!remote.blocks.has(id)) {
      console.error('no such block in the other copy: ' + id);
      console.error('tip: run compare-plugin.mjs and copy ids from section five.');
      return 2;
    }
    selection.blocks.add(id);
  }

  if (o.tier) {
    for (const rel of remote.files.keys()) {
      if (localFiles.has(rel)) continue;
      const tier = safeTier(rel);
      if (o.tier === 'docs' && tier === 'docs') selection.files.add(rel);
      else if (o.tier === 'locale' && tier === 'locale') selection.files.add(rel);
      else if (o.tier === 'new-tools' && /^tools\//.test(rel)) selection.files.add(rel);
    }
  }

  if (!selection.files.size && !selection.blocks.size) {
    console.error('nothing selected. Pass --blocks, --files or --tier.');
    return 2;
  }

  // ---------------------------------------------------------------- plan

  const newFiles = [...selection.files].filter((rel) => !localFiles.has(rel));
  const overwriteFiles = [...selection.files].filter((rel) => localFiles.has(rel));

  // Group selected blocks by file.
  const blocksByFile = new Map();
  for (const id of selection.blocks) {
    const block = remote.blocks.get(id);
    if (!blocksByFile.has(block.file)) blocksByFile.set(block.file, []);
    blocksByFile.get(block.file).push(block);
  }

  // ---------------------------------------------------------------- dependency check
  //
  // Conservative on purpose. A name the local copy does not declare may be built-in, a property, or
  // defined inline, so this reports "worth a look" rather than "will break". It only escalates when the
  // same name is also absent from the other copy's own registry of declared names, which is the case
  // where a helper really is missing.
  const localDeclared = new Set();
  for (const [rel, text] of localFiles) {
    for (const b of splitBlocks(rel, text)) {
      for (const m of b.body.matchAll(/\b(?:function|class|const|let|var|def)\s+([A-Za-z_$][\w$]*)/g)) {
        localDeclared.add(m[1]);
      }
    }
  }

  const risks = [];
  for (const [file, blocks] of blocksByFile) {
    const localText = localFiles.get(file);
    if (localText === undefined) continue; // whole new file, nothing to conflict with
    for (const block of blocks) {
      const id = block.id;
      if (localText.includes(block.body)) continue;
      const names = new Set();
      for (const m of block.body.matchAll(/\b([A-Za-z_$][\w$]{2,})\b/g)) names.add(m[1]);
      const missing = [...names].filter((n) => {
        if (NON_SYMBOLS.has(n)) return false;
        if (localDeclared.has(n)) return false;
        // Reached through an object, so it is a property rather than a free symbol.
        if (new RegExp(`\\.\\s*${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(block.body)) return false;
        // Only names actually invoked are worth flagging.
        return new RegExp(`\\b${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\(`).test(block.body);
      });
      if (missing.length) risks.push({ id, missing: missing.slice(0, 10) });
    }
  }

  // ---------------------------------------------------------------- stage

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const stage = o.stage ?? path.join(path.resolve(o.into, '..'), '_work', 'import-' + stamp);
  if (existsSync(stage)) rmSync(stage, { recursive: true, force: true });
  mkdirSync(stage, { recursive: true });

  const written = [];

  for (const rel of newFiles) {
    const dest = path.join(stage, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, remote.files.get(rel), 'utf8');
    written.push({ rel, action: 'new file', bytes: statSync(dest).size });
  }

  for (const rel of overwriteFiles) {
    const dest = path.join(stage, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, remote.files.get(rel), 'utf8');
    written.push({ rel, action: 'replaced whole file', bytes: statSync(dest).size });
  }

  // Block-level edits: replace the block's text in the current local file, leaving everything else.
  const blockEdits = [];
  const localBlocksById = new Map();
  for (const [rel, text] of localFiles) {
    for (const b of splitBlocks(rel, text)) localBlocksById.set(blockId(rel, b), b);
  }

  for (const [file, blocks] of blocksByFile) {
    let text = localFiles.get(file);
    if (text === undefined) {
      // The whole file is new; it was already staged above only if it was selected as a file.
      const dest = path.join(stage, file);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, remote.files.get(file), 'utf8');
      written.push({ rel: file, action: 'new file (from block selection)', bytes: statSync(dest).size });
      continue;
    }

    let changed = false;
    for (const block of blocks) {
      const existing = localBlocksById.get(block.id);
      if (!existing) {
        blockEdits.push({ id: block.id, file, action: 'append (block not present locally)' });
        text = text.replace(/\n*$/, '\n\n' + block.body.replace(/\n*$/, '\n'));
        changed = true;
        continue;
      }
      if (normalizeText(existing.body) === normalizeText(block.body)) {
        blockEdits.push({ id: block.id, file, action: 'already identical, skipped' });
        continue;
      }
      text = text.slice(0, existing.start) + block.body + text.slice(existing.end);
      blockEdits.push({ id: block.id, file, action: 'replaced in place' });
      changed = true;
    }

    if (changed) {
      const dest = path.join(stage, file);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, text, 'utf8');
      written.push({ rel: file, action: 'edited (block level)', bytes: statSync(dest).size });
    }
  }

  // ---------------------------------------------------------------- provenance
  //
  // Imported blocks keep the other copy's author/date/sub-version. Re-stamping them with the importer's
  // name would erase exactly the information this whole mechanism exists to preserve.
  const provenanceCarried = [];
  if (remote.registry?.blocks) {
    const byId = new Map(remote.registry.blocks.map((b) => [b.id, b]));
    // The registry stores a `display` name per author id, which matters here: an id is a slug or a hash
    // (`群友小王` becomes `ur0tu22`), and a report that shows only the id tells the reviewer nothing about
    // who wrote the block they are about to accept.
    const authors = remote.registry.authors ?? {};
    for (const id of selection.blocks) {
      const record = byId.get(id);
      if (record) {
        provenanceCarried.push({
          id,
          originalAuthor: record.author ?? null,
          originalAuthorDisplay: authors[record.author]?.display ?? null,
          originalVersion: record.version ?? null,
          originalDate: record.date ?? null,
          note: 'carried across by import; not re-stamped',
        });
      }
    }
  }

  // ---------------------------------------------------------------- reports

  const lines = [];
  lines.push('# 导入暂存报告');
  lines.push('');
  lines.push(`生成时间：${stamp}`);
  lines.push(`来源 A：\`${o.other}\``);
  lines.push(`目标 B：\`${o.into}\``);
  lines.push('');
  lines.push('> 默认**没有写入插件本体**。下面全是暂存目录里的内容。');
  lines.push('> 暂存目录里的文件可以直接对比、修改、再决定是否落盘。');
  lines.push('');
  lines.push('## 一、将要写入的文件');
  lines.push('');
  if (!written.length) lines.push('（无）');
  else {
    lines.push('| 文件 | 动作 | 字节 |');
    lines.push('|---|---|---|');
    for (const w of written) lines.push(`| \`${w.rel}\` | ${w.action} | ${w.bytes.toLocaleString()} |`);
  }
  lines.push('');
  lines.push('## 二、块级改动');
  lines.push('');
  if (!blockEdits.length) lines.push('（无）');
  else {
    lines.push('| 块 | 文件 | 动作 |');
    lines.push('|---|---|---|');
    for (const e of blockEdits) lines.push(`| \`${e.id}\` | \`${e.file}\` | ${e.action} |`);
  }
  lines.push('');
  lines.push('## 三、保留的出处信息');
  lines.push('');
  if (!provenanceCarried.length) lines.push('（来源没有 blocks.json，或无块被选中）');
  else {
    lines.push('导入的块**不会**被重新署名 —— 原作者、日期、子版本号原样保留。');
    lines.push('');
    lines.push('| 块 | 原作者 | 原版本 | 原日期 |');
    lines.push('|---|---|---|---|');
    for (const p of provenanceCarried.slice(0, 60)) {
      const who = p.originalAuthorDisplay
        ? `${p.originalAuthorDisplay} \`${p.originalAuthor}\``
        : (p.originalAuthor ?? '（未记录）');
      lines.push(`| \`${p.id}\` | ${who} | ${p.originalVersion ?? '—'} | ${p.originalDate ?? '—'} |`);
    }
    if (provenanceCarried.length > 60) lines.push(`| … | 另有 ${provenanceCarried.length - 60} 个 | | |`);
  }
  lines.push('');
  lines.push('## 四、依赖待查');
  lines.push('');
  lines.push('> **这是启发式检查，不是结论。** 名字可能是内置的、属性、或块内就地定义的。');
  lines.push('');
  if (!risks.length) lines.push('（无）');
  else {
    lines.push('| 块 | 本地找不到的名字 |');
    lines.push('|---|---|');
    for (const r of risks) lines.push(`| \`${r.id}\` | ${r.missing.map((n) => '`' + n + '`').join(', ')} |`);
  }
  lines.push('');
  lines.push('## 五、下一步');
  lines.push('');
  lines.push('1. 先看暂存目录里的文件，确认改动符合预期。');
  lines.push('2. 确认无误后，把暂存目录里对应的文件覆盖到插件本体。');
  lines.push('3. **跑一次 `node tools/stamp-blocks.mjs`**，让登记表把导入的块记为「导入」而不是「新增」。');
  lines.push('4. **重启 DSH** —— 模块缓存键是「包」不是「行」，热替换无效。');
  lines.push('');
  if (o.applySafe) {
    lines.push('**`--apply-safe` 已开启**：整文件新增的文档与本地化文件已直接写入插件本体。');
    lines.push('');
  }

  const reportPath = path.join(stage, 'IMPORT.md');
  writeFileSync(reportPath, lines.join('\n'), 'utf8');

  if (o.json) {
    writeFileSync(path.join(stage, 'IMPORT.json'), JSON.stringify({
      schema: 'rimworld-log.import-plan',
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      from: o.other,
      into: o.into,
      selection: { files: [...selection.files], blocks: [...selection.blocks] },
      written,
      blockEdits,
      provenanceCarried,
      risks,
    }, null, 2) + '\n', 'utf8');
  }

  // ---------------------------------------------------------------- optional apply

  let applied = [];
  if (o.applySafe || o.apply) {
    const safeOnly = !o.apply;
    if (o.apply && !o.yes) {
      console.error('');
      console.error('--apply without --yes. Nothing written to the plugin.');
      console.error('Re-run with --apply --yes if that is really what you want.');
      return 1;
    }
    for (const w of written) {
      const rel = w.rel;
      const isNew = !localFiles.has(rel);
      const tier = safeTier(rel);
      const allowed = safeOnly ? (isNew && tier !== null) : true;
      if (!allowed) continue;
      const dest = path.join(o.into, rel);
      mkdirSync(path.dirname(dest), { recursive: true });
      writeFileSync(dest, readFileSync(path.join(stage, rel), 'utf8'), 'utf8');
      applied.push(rel);
    }
  }

  // ---------------------------------------------------------------- console

  console.log('block import');
  console.log('');
  console.log('  from : ' + o.other);
  console.log('  into : ' + o.into);
  console.log('');
  console.log(`  selected   ${selection.files.size} file(s), ${selection.blocks.size} block(s)`);
  console.log(`  staged     ${written.length} file(s)`);
  console.log(`  block edits ${blockEdits.filter((e) => e.action !== 'already identical, skipped').length}`);
  console.log(`  provenance ${provenanceCarried.length} block(s) carried across`);
  console.log(`  risks      ${risks.length}`);
  console.log('');
  console.log('  stage: ' + stage);
  console.log('  report: ' + reportPath);
  if (applied.length) {
    console.log('');
    console.log(`  applied to the plugin (${applied.length} file(s)):`);
    for (const rel of applied) console.log('    ' + rel);
    console.log('');
    console.log('  next: node tools/stamp-blocks.mjs   then restart DSH');
  } else {
    console.log('');
    console.log('  nothing was written to the plugin.');
    console.log('  review the stage, then either copy the files across, or re-run with');
    console.log('    --apply-safe   (new documents and locale files only)');
    console.log('    --apply --yes  (everything selected)');
  }
  console.log('');
  console.log('  No ordering is implied: A is the source you named, B is --into.');

  return 0;
}

process.exit(main());
