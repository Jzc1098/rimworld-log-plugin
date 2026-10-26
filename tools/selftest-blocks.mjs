// Self-test for the block splitter.
//
// The case that matters is the last one: this project builds its documents from template literals
// containing braces, so a naive brace counter would invent blocks that do not exist and the whole
// block-comparison feature would be built on sand.
//
// Usage: node tools/selftest-blocks.mjs

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { splitBlocks, blockId, normalizeText, skeleton, exportedNames } from './lib-blocks.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const plugin = path.resolve(here, '..');

let failures = 0;
const check = (label, actual, expected) => {
  // Two call styles: check(label, actual, expected) compares, while check(label, ok, detail) with a
  // boolean first argument and a string second reports the detail. The earlier version passed the detail
  // string through as `expected` and printed "got true, want 16 blocks ..." for every pass.
  let ok;
  let shown;
  if (typeof actual === 'boolean' && typeof expected === 'string') {
    ok = actual;
    shown = expected;
  } else {
    ok = actual === expected;
    shown = ok ? String(actual) : `got ${actual}, want ${expected}`;
  }
  if (!ok) failures++;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label.padEnd(42)} ${shown}`);
};

console.log('block splitter self-test');
console.log('');

console.log('real files:');
for (const rel of ['index.js', 'lib/report.js', 'tools/check-packagerefs.mjs',
                   'OPERATIONS.md', 'package.json', 'tools/probe-pe.py']) {
  let text;
  try {
    text = readFileSync(path.join(plugin, rel), 'utf8');
  } catch {
    console.log(`  skip ${rel} (not present)`);
    continue;
  }
  const blocks = splitBlocks(rel, text);
  const named = blocks.filter((b) => !b.name.startsWith('__') && b.name !== '(file)');
  const sample = named.slice(0, 3).map((b) => `${b.kind}:${b.name}`).join(', ');
  console.log(`  ${rel.padEnd(32)} blocks=${String(blocks.length).padStart(4)}`
    + ` named=${String(named.length).padStart(4)}  e.g. ${sample}`);
}
console.log('');

console.log('normalisation:');
check('BOM stripped', normalizeText('\uFEFFa').startsWith('a'), true);
check('CRLF collapsed', normalizeText('a\r\nb').includes('\r'), false);
check('trailing space stripped', normalizeText('a   \nb'), 'a\nb');
// skeleton replaces string and regex bodies with `*` of the same length. Their text should not decide
// similarity - rewording a message must not make two otherwise identical blocks look different - but the
// length must survive, or `const a = "x"` and `const a = "yyyy"` would compare as the same.
check('skeleton keeps code', skeleton('const a = 1;'), 'const a = 1;');
check('skeleton drops the comment body', skeleton('// hi\nconst a = 1;').includes('hi'), false);
check('skeleton does not glue identifiers', skeleton('// hi\nconst a = 1;'), 'const a = 1;');
check('skeleton keeps the string delimiter and its length',
  skeleton('const a = "x";'), 'const a = "*";');
check('skeleton distinguishes different string lengths',
  skeleton('const a = "x";') === skeleton('const a = "yyyy";'), false);
check('skeleton ignores string wording',
  skeleton('f("hello")') === skeleton('f("world")'), true);
check('skeleton collapses whitespace runs', skeleton('const   a\t=\n1;'), 'const a = 1;');
console.log('');

console.log('regression: braces inside template literals');
{
  const src = [
    'const a = 1;',
    'function f() {',
    '  return `x ${ {k: 1} } y`;',
    '}',
    'function g() { return 2; }',
  ].join('\n');
  const fns = splitBlocks('t.mjs', src).filter((b) => b.kind === 'function');
  check('both functions found', fns.map((b) => b.name).join(','), 'f,g');
}

console.log('regression: brace inside a string and inside a comment');
{
  const src = [
    'function f() {',
    '  const s = "} not a close";',
    '  // } neither is this',
    '  return s;',
    '}',
    'function g() { return 1; }',
  ].join('\n');
  const fns = splitBlocks('t.mjs', src).filter((b) => b.kind === 'function');
  check('both functions found', fns.map((b) => b.name).join(','), 'f,g');
}

console.log('regression: markdown sections align by title');
{
  const md = '# Top\n\n## A\n\ntext a\n\n## B\n\ntext b\n';
  const names = splitBlocks('d.md', md).map((b) => b.name).join('|');
  check('headings collected', names, 'Top|A|B');
}

console.log('regression: a shell comment inside a fence is not a heading');
{
  const md = [
    '# Real',
    '',
    '```bash',
    '# not a heading',
    'node x.mjs',
    '```',
    '',
    '## Also real',
    '',
    '~~~',
    '# still not a heading',
    '~~~',
  ].join('\n');
  const names = splitBlocks('d.md', md).map((b) => b.name).join('|');
  check('fences skipped', names, 'Real|Also real');
}

console.log('regression: a doc comment after a closing brace is still a comment');
{
  // The failure this pins down: `}` sets afterValue, so a `/*` right after a function was read as
  // division, the comment text was parsed as code, and every later declaration vanished into one block.
  const src = [
    'function first() {',
    '  return 1;',
    '}',
    '',
    '/**',
    ' * A doc comment containing an unbalanced brace: { and a backtick: `x`.',
    ' */',
    'function second() {',
    '  return 2;',
    '}',
    '',
    'const third = () => {};',
    '',
    '/** another comment with a brace { */',
    'function fourth() {',
    '  return 4;',
    '}',
  ].join('\n');
  const fns = splitBlocks('t.mjs', src).filter((b) => b.kind === 'function');
  check('all four declarations found', fns.map((b) => b.name).join(','), 'first,second,fourth');
}

console.log('regression: an unterminated string must not hang or throw');
{
  const src = 'function f() {\n  const s = "never closed\n';
  let ok = true;
  try {
    splitBlocks('t.mjs', src);
  } catch {
    ok = false;
  }
  check('no throw', ok, true);
}

console.log('sanity: block count must be plausible for each real file');
{
  // The check that was missing. Eight passing regressions did not notice that a whole file had collapsed
  // into one block, because every test asked "are these specific declarations found" and none asked "is
  // the total believable". A file whose top-level declaration count is far above the number of blocks the
  // splitter returns has been swallowed somewhere.
  for (const rel of ['index.js', 'lib/report.js', 'lib/detect.js', 'lib/parse.js',
                     'tools/compare-plugin.mjs', 'tools/stamp-blocks.mjs', 'tools/lib-blocks.mjs']) {
    let text;
    try {
      text = readFileSync(path.join(plugin, rel), 'utf8');
    } catch {
      continue;
    }
    const blocks = splitBlocks(rel, text);
    const named = blocks.filter((b) => !b.name.startsWith('__') && b.name !== '(file)');
    const declared = [...text.matchAll(/^(?:export\s+)?(?:async\s+)?(function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)];
    const ratio = declared.length === 0 ? 1 : named.length / declared.length;
    check(`${rel} split plausibly`, ratio >= 0.8,
      `${named.length} blocks for ${declared.length} declarations`);
  }
}

console.log('block ids and exports:');
{
  const src = 'export function alpha() {}\nexport const beta = 1;\n';
  const blocks = splitBlocks('t.mjs', src);
  check('ids are path:kind:name', blockId('t.mjs', blocks[0]), 't.mjs:function:alpha');
  check('exported names', [...exportedNames(src)].join(','), 'alpha,beta');
}

console.log('');
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
