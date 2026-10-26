/**
 * 「哪些 mod 变了」的只读探测。
 *
 * 两个信息源，一粗一细：
 *  1. **目录 mtime**（`fs.statSync`，每个 mod 目录一次，便宜）——粗筛，回答「谁动过」；
 *  2. **About.xml 的 modVersion** 与上次记录的基线比对——细判，回答「从什么版本变成了什么版本」。
 *
 * 基线存 `~/.dsh/rimworld-log/mod-versions.json`（可用 `RIMLOG_STATE_DIR` 改址，与
 * install-state.json 同目录）。**只在运行本动作时读写**：detect 每次都要扫近三千个目录，
 * 不能再背一份版本记录的成本。
 *
 * 首次运行没有基线：记录一版并明说「本次只建基线」，同时仍按 mtime 报告窗口内变动的目录。
 * 之后每次运行先比对、后写回，所以基线永远反映「上一次运行本动作时」的状态。
 *
 * 为什么不放进 install-state.json：近三千个 mod 的映射会把它撑到几百 KB，
 * 而 install-state 的用途（记录插件自身的安装状态）要求它小而稳。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const SCHEMA = 'rimworld-log.mod-versions';
const SCHEMA_VERSION = 1;

/** 每个分区（更新/新增/移除）最多列几条，防止一次输出几百行。 */
const LIST_LIMIT = 60;

/**
 * 基线文件路径。与 install-state.json 同目录，共享 `RIMLOG_STATE_DIR` 覆盖，
 * 这样卸载指南里「删掉 ~/.dsh/rimworld-log/」一句话对两个文件都成立。
 */
export function baselinePath() {
  const override = process.env.RIMLOG_STATE_DIR;
  const dir = override || path.join(os.homedir(), '.dsh', 'rimworld-log');
  return path.join(dir, 'mod-versions.json');
}

/** 读基线；读不到、格式不对、schema 不符都按「没有基线」处理。 */
export function readBaseline() {
  try {
    const file = baselinePath();
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.schema && parsed.schema !== SCHEMA) return null;
    if (!parsed.mods || typeof parsed.mods !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** 写基线；失败只返回 false，绝不抛——本动作的价值高于它的记账。 */
function writeBaseline(mods) {
  try {
    const dir = path.dirname(baselinePath());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(baselinePath(), JSON.stringify({
      schema: SCHEMA,
      schemaVersion: SCHEMA_VERSION,
      recordedAt: new Date().toISOString(),
      mods,
    }, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * 解析 `since` 参数为毫秒窗口。
 *
 * 支持：ISO 时间戳、`"3d"`/`"12h"`/`"30m"`、纯数字（按小时）。无法解析时回退到 24 小时
 * 并在返回里说明，而不是报错——「大概多久以来」是探测口径，不是硬约束。
 *
 * @param {string} raw
 * @param {number} [now]
 * @returns {{ms: number, cutoff: number, fallback: boolean, parsed: string}}
 */
export function parseSince(raw, now = Date.now()) {
  const fallback = { ms: 24 * 3600_000, cutoff: now - 24 * 3600_000, fallback: true, parsed: '24h（默认）' };
  const text = String(raw ?? '').trim();
  if (text === '') return fallback;

  // 只有长得像日期的才交给 Date.parse：`Date.parse('6')` 会把纯数字当成年份解析成一个
  // 有效的毫秒数（实测 '6' → 2001 年），把「6 小时」变成「25 年」。先做形态检查。
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) {
    const iso = Date.parse(text);
    if (Number.isFinite(iso)) {
      return { ms: now - iso, cutoff: iso, fallback: false, parsed: text };
    }
  }

  const m = /^(\d+(?:\.\d+)?)\s*(d|h|m|ms)?$/i.exec(text);
  if (m) {
    const value = Number(m[1]);
    const unit = (m[2] || 'h').toLowerCase();
    const ms = unit === 'd' ? value * 86400_000
      : unit === 'h' ? value * 3600_000
      : unit === 'm' ? value * 60_000
      : value;
    if (Number.isFinite(ms) && ms > 0) {
      return { ms, cutoff: now - ms, fallback: false, parsed: text };
    }
  }
  return fallback;
}

/**
 * 探测 mod 变动。
 *
 * @param {Array<{root: string, packageId?: string, name?: string, folderName?: string, version?: string}>} modRoots
 *   detect 侧已扫好的全量 mod 表（`env.modRoots`）。
 * @param {object} [options]
 * @param {string} [options.since] - 时间窗（见 parseSince）。
 * @returns 探测结果；`firstRun` 为 true 表示本次只建立了基线。
 */
export function modChanges(modRoots, options = {}) {
  const since = parseSince(options.since);
  const mods = Array.isArray(modRoots) ? modRoots : [];

  // 当前状态：目录 stat + 从 modRoots 带来的身份与版本。
  const current = new Map();
  let statFailures = 0;
  for (const mod of mods) {
    if (!mod?.root) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(mod.root).mtimeMs;
    } catch {
      statFailures += 1;
      continue;
    }
    current.set(mod.root, {
      dir: mod.root,
      folderName: mod.folderName ?? path.basename(mod.root),
      name: mod.name ?? mod.folderName ?? path.basename(mod.root),
      packageId: mod.packageId ?? '',
      version: mod.version,
      mtimeMs,
    });
  }

  const baseline = readBaseline();
  const previous = baseline?.mods ?? null;

  const updated = [];
  const added = [];
  if (previous) {
    for (const [dir, cur] of current) {
      const before = previous[dir];
      if (!before) {
        added.push(withMtime(cur, since.cutoff));
        continue;
      }
      const versionChanged = String(cur.version ?? '') !== String(before.version ?? '');
      const touched = cur.mtimeMs > since.cutoff;
      if (versionChanged || touched) {
        updated.push({
          ...trim(cur),
          mtime: toIso(cur.mtimeMs),
          touched: touched || undefined,
          oldVersion: before.version || undefined,
          newVersion: cur.version || undefined,
          versionChanged: versionChanged || undefined,
        });
      }
    }
  } else {
    // 没有基线时仍按 mtime 报告，让第一次运行也有产出。
    for (const [dir, cur] of current) {
      if (cur.mtimeMs > since.cutoff) added.push(withMtime(cur, since.cutoff));
    }
  }

  const removed = previous
    ? Object.keys(previous)
      .filter((dir) => !current.has(dir))
      .map((dir) => trim(previous[dir]))
    : [];

  // 写回基线：本次的「现在」就是下次的「上次」。
  const recorded = writeBaseline(Object.fromEntries([...current].map(([dir, cur]) => [dir, trim(cur)])));

  const sortRecent = (a, b) => (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0) || (b.mtime ?? '').localeCompare(a.mtime ?? '');
  return {
    ok: true,
    since: { parsed: since.parsed, fallback: since.fallback || undefined, cutoff: toIso(since.cutoff) },
    scanned: current.size,
    statFailures: statFailures > 0 ? statFailures : undefined,
    firstRun: !previous || undefined,
    baseline: { recorded, previousAt: baseline?.recordedAt },
    updated: previous ? updated.sort(sortRecent).slice(0, LIST_LIMIT) : undefined,
    updatedCount: previous ? updated.length : 0,
    added: added.sort(sortRecent).slice(0, LIST_LIMIT),
    addedCount: added.length,
    removed: removed.slice(0, LIST_LIMIT),
    removedCount: removed.length,
    note: !previous
      ? '首次记录基线：本次只按目录时间报告，版本对比从下一次运行开始生效。'
      : undefined,
  };
}

function trim(mod) {
  return {
    dir: mod.dir,
    folderName: mod.folderName,
    name: mod.name,
    packageId: mod.packageId,
    version: mod.version ?? undefined,
  };
}

function withMtime(mod, cutoff) {
  const { mtimeMs, ...rest } = mod;
  return { ...rest, mtimeMs, mtime: toIso(mtimeMs), recent: mtimeMs > cutoff || undefined };
}

function toIso(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : undefined;
}
