/**
 * Print the timeline of a session: when each of our patch guards applied, when the first texture
 * compression error appeared, and when the log ends.
 *
 * The ordering answers the question that decides whether a remaining error is fixable by the patch:
 * a "Compress will not work" entry after the compression guard applied is one the guard could not
 * have prevented, which means the guard's timing - not its logic - is what limits it.
 *
 * Usage: node session-timeline.mjs <RimCrow_Realtime.log>
 */

import { readLogEntriesFrom } from '../lib/report.js';

const file = process.argv[2];
if (!file) {
  console.error('usage: node session-timeline.mjs <RimCrow_Realtime.log>');
  process.exit(2);
}

const read = readLogEntriesFrom(file, 0);
const entries = read.entries;
console.log(`file    : ${file}`);
console.log(`entries : ${entries.length}`);
if (entries.length === 0) process.exit(0);
console.log(`span    : ${entries[0].time}  →  ${entries[entries.length - 1].time}`);

const marks = [
  ['压缩补丁生效 (compression guard)', /RimCrow compression fix/],
  ['口径守卫生效 (caliber guard)', /RimCrow log fix/],
  ['首次贴图压缩错误', /Compress will not work/],
  ['末次贴图压缩错误', /Compress will not work/],
];

console.log('\n=== 时间线 ===');
for (const [label, re] of marks) {
  const hits = entries.filter((e) => re.test(String(e.message ?? '')));
  if (hits.length === 0) {
    console.log(`  ${label.padEnd(36)} (无)`);
    continue;
  }
  console.log(`  ${label.padEnd(36)} ${hits[0].time}   (${hits.length} 条)`);
}

// The decisive comparison.
const guard = entries.find((e) => /RimCrow compression fix.*guard applied/.test(String(e.message ?? '')));
const compressErrors = entries.filter((e) => /Compress will not work/.test(String(e.message ?? '')));
if (guard && compressErrors.length > 0) {
  const after = compressErrors.filter((e) => e.time > guard.time);
  console.log('\n=== 判定 ===');
  console.log(`  补丁生效: ${guard.time}`);
  console.log(`  压缩错误共 ${compressErrors.length} 条；其中补丁生效之后 ${after.length} 条`);
  if (after.length === compressErrors.length) {
    console.log('  → 全部发生在补丁生效之后，说明时序不是限制因素，需要查别的原因。');
  } else if (after.length === 0) {
    console.log('  → 全部发生在补丁生效之前，属于时序限制（补丁装得太晚）。');
  } else {
    console.log(`  → 混合：${compressErrors.length - after.length} 条在生效前，${after.length} 条在生效后。`);
    console.log('     生效后仍有错误说明不只是时序问题，需单独查。');
  }
  const sizes = new Map();
  for (const e of compressErrors) {
    const m = /dimensions \(([^)]+)\)/.exec(String(e.message));
    if (m) sizes.set(m[1], (sizes.get(m[1]) ?? 0) + (e.count ?? 1));
  }
  console.log('  涉及的贴图尺寸:');
  for (const [size, n] of [...sizes.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${size.padEnd(14)} ×${n}`);
  }
}
