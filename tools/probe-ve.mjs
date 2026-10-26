/**
 * Lightweight feasibility probe for reading Visual Exceptions' data from a patch.
 *
 * Instead of walking the full ECMA-335 table set (which is slow and was what stalled earlier), this
 * only needs to answer three questions:
 *
 *   1. which member names the mod exposes that could yield a report
 *   2. do the assembly's own strings hint at how the report is produced
 *   3. is there a settings surface that might already offer a file path
 *
 * Usage: node probe-ve.mjs
 */

import fs from 'node:fs';
import path from 'node:path';

// 目标 DLL（公开版不写死本机路径）：VISUAL_EXCEPTIONS_DLL 直接给路径，
// 或设 RIMWORLD_DIR 走默认布局 <RIMWORLD_DIR>/Mods/2538411704/1.6/Assemblies/VisualExceptions.dll
const dll = process.env.VISUAL_EXCEPTIONS_DLL
  ?? (process.env.RIMWORLD_DIR
    ? path.join(process.env.RIMWORLD_DIR, 'Mods', '2538411704', '1.6', 'Assemblies', 'VisualExceptions.dll')
    : undefined);
if (!dll) {
  console.error('请设置 VISUAL_EXCEPTIONS_DLL，或设置 RIMWORLD_DIR 使用默认布局');
  process.exit(2);
}
const buf = fs.readFileSync(dll);
console.log(`file: ${dll}`);
console.log(`size: ${buf.length} bytes\n`);

/** UTF-8 runs: .NET metadata names (#Strings heap). */
function utf8Names(bytes) {
  const out = new Set();
  const re = /[\x20-\x7e]{3,}/g;
  let m;
  while ((m = re.exec(bytes.toString('latin1')))) {
    const s = m[0];
    if (/^[A-Za-z_][A-Za-z0-9_.<>+`]*$/.test(s)) out.add(s);
  }
  return out;
}

/** UTF-16LE runs: .NET string literals (#US heap). */
function utf16Strings(bytes) {
  const out = new Set();
  const re = /(?:[\x20-\x7e]\x00){4,}/g;
  let m;
  while ((m = re.exec(bytes.toString('latin1')))) {
    out.add(Buffer.from(m[0], 'latin1').toString('utf16le'));
  }
  return out;
}

const names = utf8Names(buf);
const literals = utf16Strings(buf);
console.log(`metadata names: ${names.size}   string literals: ${literals.size}\n`);

console.log('=== member names that could produce a report ===');
for (const n of [...names].filter((s) => /Report|Exceptions|ExceptionInfo|Details|Inspector|ToString/i.test(s)).sort()) {
  console.log(`  ${n}`);
}

console.log('\n=== settable / readable properties on the mod types ===');
for (const n of [...names].filter((s) => /^get_|^set_/.test(s)).sort()) {
  console.log(`  ${n}`);
}

console.log('\n=== string literals: anything about files, paths or output ===');
for (const s of [...literals].filter((s) => /\.json|\.txt|\.log|path|folder|copy|clipboard/i.test(s)).sort()) {
  console.log(`  ${JSON.stringify(s)}`);
}

console.log('\n=== string literals that look like UI labels or report headers ===');
for (const s of [...literals].filter((s) => s.includes(' ') && s.length > 12 && s.length < 90).sort()) {
  console.log(`  ${JSON.stringify(s)}`);
}

console.log('\n=== does the assembly reference Harmony? ===');
for (const n of ['0Harmony', 'HarmonyLib', 'HarmonyPatch', 'Patcher']) {
  const present = names.has(n) || buf.includes(Buffer.from(n, 'utf8'));
  console.log(`  ${n.padEnd(16)} ${present}`);
}
