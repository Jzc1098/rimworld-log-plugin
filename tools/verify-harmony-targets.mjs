/**
 * Verify declared Harmony patch targets against the 1.7 API.
 *
 * This is the check that the earlier string scan should have been. A string scan has to guess which type a
 * bare member name belongs to and drowns in false positives (846 of 863 assemblies, which is no answer at
 * all). A `[HarmonyPatch]` target is declarative - the compiler already resolved it to a type and a method
 * name in the attribute blob - so there is no guessing.
 *
 * Three outcomes per target:
 *   gone-by-type      the declaring type no longer exists in 1.7
 *   gone-by-method    the type exists, the method name does not
 *   overload-mismatch the target declares argument types and no 1.7 overload matches
 * Anything else is present and is not reported.
 *
 * Why the argument types matter more than the names: in both known failures on this profile the target
 * existed by name in 1.7. Rigor Mortis patched `MentalStateHandler::TryStartMentalState` with
 * `Pawn __instance` when the real instance is a `MentalStateHandler`; the method was never missing, the
 * signature was. A name-exists check cannot see that.
 *
 * Usage:
 *   node tools/verify-harmony-targets.mjs --targets <tsv> --old <index16> --new <index17> [--report out.md]
 */

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

const targetsPath = arg('--targets');
const oldPath = arg('--old');
const newPath = arg('--new');
const modTypesPath = arg('--mod-types', null);
const reportPath = arg('--report', null);

if (!targetsPath || !newPath) {
  console.error('usage: verify-harmony-targets.mjs --targets <tsv> --old <index16> --new <index17> [--report out.md]');
  process.exit(2);
}

/** Index a `--public` dump as type -> memberName -> Set of parameter-list strings ('' for fields). */
function indexApi(file) {
  const types = new Map();
  if (!file || !fs.existsSync(file)) return types;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const sep = line.indexOf(' :: ');
    if (sep < 0) {
      if (!types.has(line)) types.set(line, new Map());
      continue;
    }
    const type = line.slice(0, sep).trim();
    let rest = line.slice(sep + 4).trim();

    // field:      name : Type
    // method:     name(params) : Type
    // property:   name {get;set;} : Type
    let name;
    let params = null;
    const paren = rest.indexOf('(');
    const brace = rest.indexOf(' {get;set;}');
    if (paren >= 0 && (brace < 0 || paren < brace)) {
      name = rest.slice(0, paren);
      const close = rest.indexOf(')', paren);
      params = close > paren ? rest.slice(paren + 1, close) : '';
    } else if (brace >= 0) {
      name = rest.slice(0, brace);
    } else {
      const colon = rest.indexOf(' : ');
      name = colon >= 0 ? rest.slice(0, colon) : rest;
    }
    name = name.trim();
    if (!type || !name) continue;
    if (!types.has(type)) types.set(type, new Map());
    const members = types.get(type);
    if (!members.has(name)) members.set(name, new Set());
    members.get(name).add(params ?? '');
  }
  return types;
}

const oldApi = indexApi(oldPath);
const newApi = indexApi(newPath);
console.log(`1.6 索引: ${oldApi.size} 类型   1.7 索引: ${newApi.size} 类型`);

/** Strip generic arity and nested markers so `Foo\`1` and `Foo` compare equal. */
function normalizeTypeName(t) {
  return t.replace(/`\d+/g, '').replace(/\+/g, '.');
}

function shortName(full) {
  const at = full.lastIndexOf('.');
  return at < 0 ? full : full.slice(at + 1);
}

const newNormalized = new Map();
for (const [type, members] of newApi) newNormalized.set(normalizeTypeName(type), members);

/** Types defined by the mods themselves, so a cross-mod target is not called a missing game type. */
const modTypes = new Set();
if (modTypesPath && fs.existsSync(modTypesPath)) {
  for (const line of fs.readFileSync(modTypesPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (t) modTypes.add(normalizeTypeName(t));
  }
}
const modShortNames = new Set([...modTypes].map((t) => shortName(t)));
console.log(`mod 自定义类型: ${modTypes.size}`);

// ---- read targets ---------------------------------------------------------

const rows = [];
const seen = new Set();
for (const raw of fs.readFileSync(targetsPath, 'utf8').split('\n')) {
  const line = raw.replace(/\r$/, '');
  if (!line.trim()) continue;
  const parts = line.split('\t');
  if (parts.length < 4) continue;
  const [assembly, declaring, method, argTypes, patchClass] = parts;
  const key = `${assembly}|${declaring}|${method}|${argTypes}`;
  if (seen.has(key)) continue;
  seen.add(key);
  rows.push({ assembly, declaring, method, argTypes: argTypes ? argTypes.split(',') : [], patchClass });
}
console.log(`目标: ${rows.length} 条（去重后）`);

// ---- classify -------------------------------------------------------------

const byType = [];
const byMethod = [];
const byOverload = [];
const byOther = [];
const present = [];

/**
 * Resolve one target against one API index. `true` when the declaring type and method name both exist
 * (and, when the target declares argument types, some overload matches them).
 *
 * Argument matching is PREFIX matching, because that is what Harmony does with `argumentTypes`: a patch
 * that declares `(Thing, Vector3, LocalTargetInfo, LocalTargetInfo, ProjectileHitFlags)` targets the 1.7
 * overload `(Thing, Vector3, LocalTargetInfo, LocalTargetInfo, ProjectileHitFlags, Boolean, Thing,
 * ThingDef)` perfectly well. Comparing for equality instead turned every such target into a false
 * "signature mismatch" - 130 rows of them on this profile.
 */
function resolves(api, declaring, method, argTypes) {
  const members = api.get(declaring);
  if (!members) return false;
  const overloads = members.get(method);
  if (!overloads) return false;
  if (!argTypes.length) return true;
  const wanted = argTypes.map((a) => normalizeTypeName(a.trim()));
  return [...overloads].some((sig) => {
    const got = sig ? sig.split(',').map((s) => normalizeTypeName(s.trim())) : [];
    if (got.length < wanted.length) return false;
    return wanted.every((w, i) => got[i] === w || shortName(got[i]) === shortName(w));
  });
}

for (const row of rows) {
  const declaring = normalizeTypeName(row.declaring);
  const members = newNormalized.get(declaring);
  if (!members) {
    // A cross-mod patch target lives in another mod's assembly, not in the game. Reporting those as
    // missing would bury the real findings: on this profile 331 rows were flagged and almost all were
    // `Vehicles.*`, `NiceInventoryTab.*`, `CombatExtended.*` and friends.
    if (modTypes.has(declaring) || modShortNames.has(shortName(declaring))) continue;
    const candidates = [...newNormalized.keys()].filter((t) => shortName(t) === shortName(declaring));
    byType.push({ ...row, candidates: candidates.slice(0, 4) });
    continue;
  }
  const overloads = members.get(row.method);
  if (!overloads) {
    byMethod.push({ ...row });
    continue;
  }
  if (row.argTypes.length) {
    const wanted = row.argTypes.map((a) => normalizeTypeName(a.trim()));
    const ok = [...overloads].some((sig) => {
      const got = sig ? sig.split(',').map((s) => normalizeTypeName(s.trim())) : [];
      if (got.length < wanted.length) return false;
      return wanted.every((w, i) => got[i] === w || shortName(got[i]) === shortName(w));
    });
    if (!ok) {
      byOverload.push({ ...row, available: [...overloads].slice(0, 4) });
      continue;
    }
  }
  present.push(row);
}

// ---- the delta that actually matters --------------------------------------
//
// "Does not resolve in 1.7" is not the same as "the update broke it". A target that never resolved in
// 1.6 either was already dead - an optional integration for a mod that is not installed, say, which
// Harmony skips quietly - and calling that a regression would be wrong. Only targets that resolved in
// 1.6 and stopped resolving in 1.7 are caused by the game update.

const regressions = [];
const alreadyDead = [];
for (const row of [...byType, ...byMethod, ...byOverload]) {
  const declaring = normalizeTypeName(row.declaring);
  const inOld = resolves(oldApi, declaring, row.method, row.argTypes);
  if (inOld) regressions.push({ ...row });
  else alreadyDead.push({ ...row });
}

// ---- report ---------------------------------------------------------------

const pct = (n) => `${((n / rows.length) * 100).toFixed(1)}%`;
const lines = [];
lines.push('# Harmony 补丁目标核对（1.6 声明 → 1.7 实际）');
lines.push('');
lines.push('方法：从每个 mod 程序集的 `[HarmonyPatch]` 自定义特性里直接读出**声明式目标**');
lines.push('（类型 + 方法名 + 参数类型），再拿 1.7 的公开 API 索引核对。');
lines.push('不是字符串猜测 —— 编译器已经把目标解析进特性数据了。');
lines.push('');
lines.push('| 结果 | 条数 | 占比 |');
lines.push('|---|---|---|');
lines.push(`| 声明类型在 1.7 不存在 | **${byType.length}** | ${pct(byType.length)} |`);
lines.push(`| 类型在、方法名不在 | **${byMethod.length}** | ${pct(byMethod.length)} |`);
lines.push(`| 参数类型对不上任何重载 | **${byOverload.length}** | ${pct(byOverload.length)} |`);
lines.push(`| 其他/无法判定 | ${byOther.length} | ${pct(byOther.length)} |`);
lines.push(`| 目标在 1.7 存在 | ${present.length} | ${pct(present.length)} |`);
lines.push(`| **合计** | ${rows.length} | |`);
lines.push('');
lines.push('## 关键结论：哪些是 1.7 造成的');
lines.push('');
lines.push('「在 1.7 解析不了」不等于「被 1.7 弄坏」。如果一个目标在 **1.6 也解析不了**，');
lines.push('那它本来就是死的（例如针对未安装 mod 的可选联动，Harmony 会安静跳过），把它算成回归是错的。');
lines.push('');
lines.push('| 分类 | 条数 | 含义 |');
lines.push('|---|---|---|');
lines.push(`| **1.6 能解析 → 1.7 解析失败** | **${regressions.length}** | **真正由游戏更新造成的** |`);
lines.push(`| 1.6 也解析失败 | ${alreadyDead.length} | 本来就是死的，与 1.7 无关 |`);
lines.push('');

function section(title, list, render) {
  lines.push(`## ${title}（${list.length}）`);
  lines.push('');
  if (!list.length) { lines.push('（无）'); lines.push(''); return; }
  const grouped = new Map();
  for (const row of list) {
    const key = path.basename(row.assembly);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  for (const [asm, items] of [...grouped.entries()].sort((a, b) => b[1].length - a[1].length)) {
    lines.push(`### \`${asm}\`（${items.length}）`);
    lines.push('');
    for (const row of items.slice(0, 20)) lines.push(render(row));
    if (items.length > 20) lines.push(`- …另有 ${items.length - 20} 条`);
    lines.push('');
  }
}

section('一、真正由 1.7 造成的失效（1.6 能解析、1.7 解析失败）', regressions, (r) =>
  `- \`${r.declaring}::${r.method}${r.argTypes.length ? `(${r.argTypes.join(', ')})` : ''}\``
  + ` — 补丁类 \`${r.patchClass}\``
  + `${r.candidates?.length ? `；1.7 有同名类型：${r.candidates.map((c) => '`' + c + '`').join('、')}` : ''}`
  + `${r.available?.length ? `；1.7 的重载：${r.available.map((a) => '`(' + a + ')`').join('、')}` : ''}`);

section('二、声明类型已不存在（含本来就死的）', byType, (r) =>
  `- \`${r.declaring}::${r.method}\` — 补丁类 \`${r.patchClass}\``
  + `${r.candidates.length ? `；1.7 里有同名类型：${r.candidates.map((c) => '`' + c + '`').join('、')}` : ''}`);

section('三、类型在，方法名不在', byMethod, (r) =>
  `- \`${r.declaring}::${r.method}\` — 补丁类 \`${r.patchClass}\``);

section('四、参数类型对不上', byOverload, (r) =>
  `- \`${r.declaring}::${r.method}(${r.argTypes.join(', ')})\` — 补丁类 \`${r.patchClass}\``
  + `${r.available.length ? `；1.7 的重载：${r.available.map((a) => '`(' + a + ')`').join('、')}` : ''}`);

section('五、1.6 也解析不了（本来就死的，与 1.7 无关）', alreadyDead, (r) =>
  `- \`${r.declaring}::${r.method}\` — 补丁类 \`${r.patchClass}\``);

const text = lines.join('\n');
if (reportPath) {
  fs.writeFileSync(reportPath, text, 'utf8');
  console.log(`报告写入: ${reportPath}`);
}
console.log(text.split('\n').slice(0, 16).join('\n'));
