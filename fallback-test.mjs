/**
 * Verify the degraded path: no RimCrow installation present, only a vanilla RimWorld user-data
 * root. Run with RIMCROW_HOME pointed at a non-existent directory.
 *
 * Usage (PowerShell): $env:RIMCROW_HOME='C:\__none__'; node fallback-test.mjs
 */

// 测试会调用真实的 tool.execute（含 action=analyze），那会触发自动归档并往工作区里写记录。
// 测试会调用真实的 tool.execute（含 action=analyze），那会触发自动归档并往工作区写记录。
// 测试不该产生副作用，这里直接关掉。
process.env.RIMLOG_AUTO_ARCHIVE = '0';

import { detectEnvironment, defaultUserDataRoot } from './lib/detect.js';
import { analyze } from './lib/report.js';

const env = detectEnvironment();
console.log('RIMCROW_HOME =', process.env.RIMCROW_HOME ?? '(unset)');
console.log('detected home   :', env.home ?? '(none)');
console.log('profile         :', env.profile ? `${env.profile.name} (${env.profile.id})` : '(none)');
console.log('userDataRoot    :', env.userDataRoot ?? '(none)');
console.log('default userRoot:', defaultUserDataRoot() ?? '(none)');
console.log('sources:');
for (const [kind, file] of Object.entries(env.sources ?? {})) {
  console.log(`  ${kind.padEnd(11)} ${file.exists ? `${file.bytes} bytes` : 'missing'}  ${file.path}`);
}
console.log('notes:');
for (const note of env.notes) console.log('  -', note);

const kinds = Object.entries(env.sources ?? {}).filter(([, f]) => f.exists).map(([k]) => k);
if (kinds.length === 0) {
  console.log('\nno readable log source in this configuration');
  process.exit(0);
}
const analysis = analyze(env, { sources: kinds, full: true, maxClusters: 8, persist: false });
console.log(`\nanalysis over ${kinds.join(', ')}: errors=${analysis.totals.errors} warnings=${analysis.totals.warnings}`);
console.log(`clusters shown: ${analysis.clusters.length}, brief ${analysis.brief.length} chars`);
console.log('\n--- brief head ---');
console.log(analysis.brief.split('\n').slice(0, 18).join('\n'));
