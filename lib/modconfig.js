/**
 * ModsConfig.xml editing: enable and disable mods for a RimCrow profile.
 *
 * This is the only module in the plugin that writes anything, and it is deliberately narrow:
 *
 *  - it only ever touches `<activeMods>` inside `Config/ModsConfig.xml` of the selected profile;
 *  - every write is preceded by a timestamped backup next to the original;
 *  - every write is verified by re-reading and re-parsing the file it just wrote;
 *  - the plugin's default is `dryRun`, so a caller must opt in explicitly;
 *  - the tool layer still asks the user for approval per operation, because a wrong mod list can
 *    make a save unloadable. That approval is the user's, never the model's.
 *
 * The hand-written parser exists because this module must not depend on an XML library: see the
 * note in `index.js` about plugins linked into a profile being unable to resolve packages from
 * the Harness installation.
 *
 * @module rimworld-log/modconfig
 */

import fs from 'node:fs';
import path from 'node:path';

const INDENT = '  ';
const XML_DECLARATION = "<?xml version='1.0' encoding='UTF-8'?>";

/** Escape the five XML predefined entities. */
function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** Unescape those same entities. */
function unescapeXml(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Parse a ModsConfig.xml into its parts without an XML dependency.
 * @param text - the whole file.
 * @returns `{ version, activeMods, knownExpansions }`, each `undefined`/`[]` when absent.
 */
export function parseModsConfig(text) {
  const source = String(text ?? '').replace(/^\uFEFF/, '');
  const version = /<version\b[^>]*>([\s\S]*?)<\/version\s*>/i.exec(source);
  const active = /<activeMods\b[^>]*>([\s\S]*?)<\/activeMods\s*>/i.exec(source);
  const expansions = /<knownExpansions\b[^>]*>([\s\S]*?)<\/knownExpansions\s*>/i.exec(source);
  const items = (block) => (block
    ? [...block[1].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li\s*>/gi)].map((m) => unescapeXml(m[1].trim()))
    : []);
  return {
    version: version ? unescapeXml(version[1].trim()) : undefined,
    activeMods: items(active),
    knownExpansions: items(expansions),
  };
}

/**
 * Render a ModsConfig.xml, preserving the layout RimWorld itself writes.
 * @param config - `{ version, activeMods, knownExpansions }`.
 * @returns the file text.
 */
export function renderModsConfig(config) {
  const lines = [XML_DECLARATION, '<ModsConfigData>'];
  if (config.version) lines.push(`${INDENT}<version>${escapeXml(config.version)}</version>`);
  lines.push(`${INDENT}<activeMods>`);
  for (const id of config.activeMods ?? []) lines.push(`${INDENT}${INDENT}<li>${escapeXml(id)}</li>`);
  lines.push(`${INDENT}</activeMods>`);
  if ((config.knownExpansions ?? []).length > 0) {
    lines.push(`${INDENT}<knownExpansions>`);
    for (const id of config.knownExpansions) lines.push(`${INDENT}${INDENT}<li>${escapeXml(id)}</li>`);
    lines.push(`${INDENT}</knownExpansions>`);
  }
  lines.push('</ModsConfigData>');
  return `${lines.join('\n')}\n`;
}

/** Read and parse a ModsConfig.xml, or report why not. */
export function readModsConfig(filePath) {
  try {
    return { ok: true, config: parseModsConfig(fs.readFileSync(filePath, 'utf8')) };
  } catch (error) {
    return { ok: false, error: `无法读取 ${filePath}: ${error?.message ?? error}` };
  }
}

/**
 * Resolve what a requested change would do, without writing.
 *
 * `knownMods` must describe every mod this profile *could* load, not just the enabled ones —
 * enabling a currently-disabled mod is the main use case, and judging that against the active
 * list alone would report a perfectly installed mod as missing.
 *
 * @param config - a parsed ModsConfig from {@link parseModsConfig}.
 * @param request - `{ enable?, disable? }` arrays of package ids.
 * @param knownMods - records with `{ packageId, installed, kind? }` covering the whole mod table.
 * @returns the plan: resulting order, the per-id effect, and any warnings.
 */
export function planModChange(config, request, knownMods = []) {
  const enable = (request.enable ?? []).map((id) => String(id).trim()).filter(Boolean);
  const disable = new Set((request.disable ?? []).map((id) => String(id).trim()).filter(Boolean));
  const current = [...(config.activeMods ?? [])];
  const index = new Map(current.map((id, i) => [id.toLowerCase(), i]));
  const byId = new Map();
  for (const mod of knownMods) {
    const key = String(mod?.packageId ?? '').toLowerCase();
    if (key && !byId.has(key)) byId.set(key, mod);
  }

  const changes = [];
  const alreadyEnabled = [];
  const alreadyDisabled = [];
  const warnings = [];

  // Disabling never reorders the rest; removing an id keeps RimWorld's relative order stable.
  const result = current.filter((id) => {
    if (!disable.has(id)) return true;
    changes.push({ packageId: id, action: 'disable', position: index.get(id.toLowerCase()) ?? null });
    return false;
  });

  for (const id of enable) {
    const key = id.toLowerCase();
    if (index.has(key)) {
      alreadyEnabled.push(id);
      continue;
    }
    const known = byId.get(key);
    if (!known) {
      warnings.push(`启用列表与磁盘上都找不到 ${id}；仍会按请求加入（可能导致游戏启动时报缺 mod）。`);
    } else if (known.installed === false) {
      warnings.push(`${id} 已安装记录存在但在磁盘上找不到目录，启用后可能启动报错。`);
    }
    result.push(id);
    changes.push({
      packageId: id,
      action: 'enable',
      position: result.length - 1,
      // Surfacing the directory makes the review concrete: the user sees which copy wins when
      // several mod trees contain the same package id.
      dir: known?.dir,
      name: known?.name,
    });
  }

  for (const id of disable) {
    if (!index.has(id.toLowerCase())) alreadyDisabled.push(id);
  }

  return {
    changes,
    alreadyEnabled,
    alreadyDisabled,
    warnings,
    before: current,
    after: result,
    beforeCount: current.length,
    afterCount: result.length,
  };
}

/** Timestamp suffix safe for a filename. */
function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Copy the file next to itself, so an undo never depends on this plugin's state. */
export function backupFile(filePath) {
  const target = `${filePath}.bak-${stamp()}`;
  fs.copyFileSync(filePath, target);
  return target;
}

/**
 * Apply a plan produced by {@link planModChange}.
 *
 * @param filePath - the ModsConfig.xml to modify.
 * @param plan - the plan.
 * @param options - `{ dryRun }` defaults to dry-run; nothing is written when true.
 * @returns a result describing the backup, byte counts and verification.
 */
export function applyModChange(filePath, plan, options = {}) {
  const dryRun = options.dryRun !== false;
  const before = fs.readFileSync(filePath, 'utf8');
  const beforeStat = fs.statSync(filePath);
  const parsedBefore = parseModsConfig(before);

  // Refuse to act on a file that changed since the caller planned against it: another writer
  // (RimCrow, a text editor, a running game) would otherwise be silently clobbered.
  if (options.expectedMtimeMs && Math.abs(beforeStat.mtimeMs - options.expectedMtimeMs) > 1) {
    return {
      ok: false,
      error: 'ModsConfig.xml 在计划生成之后被改动过（可能是 RimCrow 或游戏正在写），已放弃写入。请重新执行一次。',
      currentMtimeMs: beforeStat.mtimeMs,
    };
  }

  const next = renderModsConfig({
    version: parsedBefore.version,
    activeMods: plan.after,
    knownExpansions: parsedBefore.knownExpansions,
  });

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      filePath,
      bytesBefore: Buffer.byteLength(before, 'utf8'),
      bytesAfter: Buffer.byteLength(next, 'utf8'),
      beforeCount: plan.beforeCount,
      afterCount: plan.afterCount,
      changes: plan.changes,
      warnings: plan.warnings,
      preview: next,
    };
  }

  const backupPath = backupFile(filePath);
  fs.writeFileSync(filePath, next, 'utf8');

  // Verify by re-reading: a write this consequential must not be assumed to have worked.
  const verifyRead = readModsConfig(filePath);
  const verified = verifyRead.ok
    && verifyRead.config.activeMods.length === plan.after.length
    && verifyRead.config.activeMods.every((id, i) => id === plan.after[i]);

  return {
    ok: verified,
    dryRun: false,
    filePath,
    backupPath,
    bytesBefore: Buffer.byteLength(before, 'utf8'),
    bytesAfter: Buffer.byteLength(next, 'utf8'),
    beforeCount: plan.beforeCount,
    afterCount: plan.afterCount,
    changes: plan.changes,
    warnings: plan.warnings,
    verified,
    ...(verified ? {} : { error: '写入后回读校验失败，请用备份恢复。' }),
  };
}

/** Describe the diff between two mod lists in a compact, reviewable form. */
export function describeChange(plan, limit = 40) {
  const lines = [];
  if (plan.changes.length === 0) lines.push('（无实际变化）');
  for (const change of plan.changes.slice(0, limit)) {
    lines.push(`${change.action === 'enable' ? '＋启用' : '－禁用'} ${change.packageId}`);
  }
  if (plan.changes.length > limit) lines.push(`… 其余 ${plan.changes.length - limit} 项省略`);
  if (plan.alreadyEnabled.length) lines.push(`（已在启用列表，忽略）${plan.alreadyEnabled.join(', ')}`);
  if (plan.alreadyDisabled.length) lines.push(`（本就不在启用列表，忽略）${plan.alreadyDisabled.join(', ')}`);
  for (const warning of plan.warnings) lines.push(`⚠ ${warning}`);
  return lines.join('\n');
}

/** Render a reviewable unified diff of the active-list section. */
export function renderDiff(plan) {
  const before = new Set(plan.before);
  const after = new Set(plan.after);
  const removed = plan.before.filter((id) => !after.has(id));
  const added = plan.after.filter((id) => !before.has(id));
  const lines = ['--- activeMods（当前）', '+++ activeMods（变更后）'];
  for (const id of removed) lines.push(`- ${id}`);
  for (const id of added) lines.push(`+ ${id}`);
  if (removed.length === 0 && added.length === 0) lines.push('（无增删）');
  // Reordering is worth surfacing too, since load order matters in RimWorld.
  const moved = plan.after
    .map((id, i) => ({ id, i }))
    .filter(({ id, i }) => before.has(id) && plan.before.indexOf(id) !== i);
  if (moved.length > 0) {
    lines.push(`（顺序变化 ${moved.length} 项；启用新 mod 会追加到末尾）`);
  }
  return lines.join('\n');
}
