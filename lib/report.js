/**
 * Read logs (fully or incrementally), aggregate them, and render the compact brief
 * that is handed to the agent.
 *
 * The brief is the token-efficiency layer: instead of shipping raw megabytes, it ships
 * ranked clusters with occurrence counts, mod attribution, representative frames and a
 * small number of raw samples. Raw lines are always retrievable through `readRaw`.
 *
 * @module rimworld-log/report
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  SOURCE_META,
  clusterProblems,
  isProblemLevel,
  levelRank,
  messagePaths,
  modNameFromFramePath,
  normalizeText,
  parseRealtimeLine,
  stripCaptureFrames,
} from './parse.js';
import { parsePlayerLog } from './playerlog.js';

/** Directory holding the incremental cursors. Kept out of the RimCrow installation. */
export function cursorDir() {
  const base = process.env.DSH_RIMWORLD_LOG_STATE
    ?? path.join(os.homedir(), '.dsh', 'rimworld-log');
  return base;
}

/** Path of the cursor file for one log source. */
function cursorFile(sourcePath) {
  const safe = Buffer.from(sourcePath, 'utf8').toString('base64url').slice(0, 120);
  return path.join(cursorDir(), `${safe}.json`);
}

/** Read the stored cursor for a log source. */
export function readCursor(sourcePath) {
  try {
    return JSON.parse(fs.readFileSync(cursorFile(sourcePath), 'utf8'));
  } catch {
    return undefined;
  }
}

/** Persist the cursor for a log source. */
export function writeCursor(sourcePath, value) {
  try {
    fs.mkdirSync(cursorDir(), { recursive: true });
    fs.writeFileSync(cursorFile(sourcePath), JSON.stringify({ path: sourcePath, ...value }, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Path of the "what did the last analysis find" sidecar for one log source.
 *
 * The cursor alone cannot answer that question: it records where reading stopped, not what was seen.
 * Storing the findings separately is what lets a delta that reads nothing still tell the reader what
 * remains outstanding, instead of implying the log is clean.
 */
function summaryFile(sourcePath) {
  const safe = Buffer.from(sourcePath, 'utf8').toString('base64url').slice(0, 120);
  return path.join(cursorDir(), `${safe}.last.json`);
}

/** Read the previous analysis findings for a log source, if any. */
export function readLastSummary(sourcePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(summaryFile(sourcePath), 'utf8'));
    return Array.isArray(parsed?.top) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Persist the findings of this analysis so a later delta can refer back to them. */
export function writeLastSummary(sourcePath, value) {
  try {
    fs.mkdirSync(cursorDir(), { recursive: true });
    fs.writeFileSync(summaryFile(sourcePath), JSON.stringify(value, null, 2), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide whether an incremental read is valid for a file.
 * A stored offset is only trusted while the file is at least that large, so a rotated
 * or truncated log falls back to a full read instead of silently skipping content.
 * @param stat - current file stat.
 * @param cursor - stored cursor.
 * @returns `{ from, incremental }`.
 */
export function resolveReadRange(stat, cursor) {
  if (cursor && typeof cursor.offset === 'number' && cursor.offset > 0 && stat.size >= cursor.offset) {
    return { from: cursor.offset, incremental: true };
  }
  return { from: 0, incremental: false };
}

/**
 * Read log entries starting at a byte offset.
 * @param filePath - absolute path.
 * @param fromByte - byte offset to start from; the first partial line is discarded.
 * @returns `{ entries, bytes, format, totalBytes, from }` or undefined when unreadable.
 */
export function readLogEntriesFrom(filePath, fromByte = 0) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return undefined;
  }
  try {
    const stat = fs.fstatSync(fd);
    const start = Math.max(0, Math.min(fromByte, stat.size));
    const length = stat.size - start;
    const buffer = Buffer.alloc(length);
    if (length > 0) fs.readSync(fd, buffer, 0, length, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      const newline = text.indexOf('\n');
      text = newline === -1 ? '' : text.slice(newline + 1);
    }
    const sample = (start > 0 ? text : text).slice(0, 4096).replace(/^\uFEFF/, '').trimStart();
    const asJson = sample.startsWith('{');
    const entries = asJson
      ? text.split('\n').map(parseRealtimeLine).filter(Boolean)
      : parsePlayerLog(text);
    return {
      entries,
      bytes: length,
      format: asJson ? 'realtime' : 'player',
      totalBytes: stat.size,
      from: start,
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** Sum occurrences and split them by severity. */
function summarize(entries) {
  let errors = 0;
  let warnings = 0;
  let infos = 0;
  for (const entry of entries) {
    const rank = levelRank(entry.level);
    if (rank <= 1) errors += entry.count;
    else if (rank === 2) warnings += entry.count;
    else infos += entry.count;
  }
  return { errors, warnings, infos, entries: entries.length };
}

/**
 * Count problem occurrences per mod, split by severity.
 *
 * Only ERROR and WARNING clusters count. This used to tally every cluster, which produced a
 * badly misleading line: `[ShowModUpdates] ... 14 个 Mod 更新` is an INFO record that lists the
 * names of the mods that were updated, and naming a mod was enough to put it under a heading that
 * reads "mods where errors are concentrated". A single startup notice could therefore list a dozen
 * innocent mods, including this plugin's own guard patches, as error sources.
 *
 * The two buckets stay separate because they mean different things: an ERROR is almost always a real
 * fault, while a WARNING is often informational (RimWorld logs plenty of benign warnings).
 */
function modTally(clusters) {
  const errors = new Map();
  const warnings = new Map();
  const bump = (map, key, count) => {
    if (!key) return;
    map.set(key, (map.get(key) ?? 0) + count);
  };
  for (const cluster of clusters) {
    const rank = levelRank(cluster.level);
    if (rank > 2) continue; // INFO and below are not problems
    const bucket = rank <= 1 ? errors : warnings;
    for (const id of cluster.modIds) bump(bucket, id, cluster.occurrences);
    const attributed = cluster.mod;
    if (attributed) bump(bucket, attributed.packageId || attributed.name, cluster.occurrences);
  }
  const sorted = (map) => [...map.entries()].sort((a, b) => b[1] - a[1]);
  return { errors: sorted(errors), warnings: sorted(warnings) };
}

/** Look up a friendly name for a package id using the active mod list. */
function nameFor(packageId, activeMods) {
  const hit = activeMods.find((m) => m.packageId.toLowerCase() === String(packageId).toLowerCase());
  if (!hit) return undefined;
  return hit.installed ? `${hit.name} (${hit.packageId})` : `${hit.packageId} — 未安装`;
}

/**
 * Run the full or incremental analysis for one or more sources.
 *
 * @param env - output of `detectEnvironment`.
 * @param options - `{ sources?, full?, since?, maxClusters?, maxSamples?, persist? }`.
 * @returns a structured analysis plus its rendered brief.
 */
export function analyze(env, options = {}) {
  const sources = options.sources?.length ? options.sources : ['realtime'];
  const maxClusters = options.maxClusters ?? 14;
  const maxSamples = options.maxSamples ?? 2;
  const persist = options.persist !== false;
  const sinceMs = options.since ? Date.parse(options.since) : undefined;

  const perSource = [];
  const allEntries = [];
  const modRoots = options.modRoots ?? [];
  // Kept so the brief can still say what is outstanding when a delta turns out to be empty.
  const previousByPath = new Map();

  for (const kind of sources) {
    const meta = SOURCE_META[kind];
    const file = env.sources?.[kind];
    if (!meta || !file) {
      perSource.push({ kind, label: meta?.label ?? kind, available: false, reason: '未知来源' });
      continue;
    }
    if (!file.exists) {
      perSource.push({
        kind,
        label: meta.label,
        available: false,
        path: file.path,
        reason: '文件不存在（该来源在当前 profile 下没有生成）',
      });
      continue;
    }
    const cursor = persist ? readCursor(file.path) : undefined;
    const previous = persist ? readLastSummary(file.path) : undefined;
    const range = options.full ? { from: 0, incremental: false } : resolveReadRange({ size: file.bytes }, cursor);
    const read = readLogEntriesFrom(file.path, range.from);
    if (!read) {
      perSource.push({ kind, label: meta.label, available: false, path: file.path, reason: '读取失败' });
      continue;
    }
    let entries = read.entries;
    if (Number.isFinite(sinceMs)) {
      entries = entries.filter((entry) => {
        const t = Date.parse(entry.time);
        return !Number.isFinite(t) || t >= sinceMs;
      });
    }
    allEntries.push(...entries);
    perSource.push({
      kind,
      label: meta.label,
      available: true,
      path: file.path,
      cost: meta.cost,
      strength: meta.strength,
      note: meta.note,
      format: read.format,
      bytesRead: read.bytes,
      totalBytes: read.totalBytes,
      fromByte: read.from,
      incremental: range.incremental,
      analysedAt: cursor?.analysedAt,
      entries: entries.length,
      summary: summarize(entries),
    });
    if (persist) {
      writeCursor(file.path, { offset: file.bytes, mtimeMs: file.mtime, analysedAt: new Date().toISOString() });
      if (previous) previousByPath.set(file.path, previous);
    }
  }

  const clusters = clusterProblems(allEntries, modRoots, options.activeMods ?? [], options.indexes ?? {});
  const problems = clusters.filter((c) => levelRank(c.level) <= 1);
  const warnings = clusters.filter((c) => levelRank(c.level) === 2);
  const selected = [...problems, ...warnings].slice(0, maxClusters);

  const analysis = {
    generatedAt: new Date().toISOString(),
    profile: env.profile
      ? { id: env.profile.id, name: env.profile.name, gameVersion: env.profile.gameVersion }
      : undefined,
    companion: env.companion,
    notes: env.notes,
    sources: perSource,
    totals: summarize(allEntries),
    problemClusters: problems.length,
    warningClusters: warnings.length,
    modTally: {
      errors: modTally(clusters).errors.slice(0, 12),
      warnings: modTally(clusters).warnings.slice(0, 12),
    },
    // Not rendered directly: renderBrief reads it to describe what is still outstanding when the
    // current delta turned out to be empty.
    previousByPath,
    clusters: selected.map((cluster) => ({
      level: cluster.level,
      occurrences: cluster.occurrences,
      normalized: cluster.normalized,
      firstTime: cluster.firstTime,
      lastTime: cluster.lastTime,
      relatedModIds: [...cluster.modIds],
      strayMods: cluster.strayMods ?? [],
      attributedMod: cluster.mod
        ? {
            name: cluster.mod.name,
            packageId: cluster.mod.packageId,
            dir: cluster.mod.dir,
            confidence: cluster.mod.confidence,
            evidence: cluster.mod.evidence,
            note: cluster.mod.note,
            enabled: cluster.mod.enabled !== false,
          }
        : undefined,
      inferredTypes: [...cluster.inferredTypes],
      files: [...cluster.files].slice(0, 6),
      frames: cluster.frames.slice(0, 8),
      samples: cluster.samples.slice(0, maxSamples),
      key: cluster.key,
    })),
  };

  analysis.brief = renderBrief(analysis, env);

  // Remember what this run found, so the next empty delta can name it. Stored per source because
  // that is the granularity the cursor already uses.
  if (persist) {
    const top = [...problems, ...warnings].slice(0, 10).map((cluster) => ({
      level: cluster.level,
      occurrences: cluster.occurrences,
      message: String(cluster.samples?.[0] ?? cluster.normalized ?? '').slice(0, 200),
      mod: cluster.mod?.name,
      packageId: cluster.mod?.packageId,
    }));
    for (const source of perSource) {
      if (!source.available || !source.path) continue;
      writeLastSummary(source.path, {
        analysedAt: analysis.generatedAt,
        entries: source.entries,
        incremental: source.incremental,
        problemClusters: analysis.problemClusters,
        warningClusters: analysis.warningClusters,
        top,
      });
    }
  }

  return analysis;
}

/** Render one cluster as a compact Markdown block. */
function renderCluster(cluster, index, activeMods) {
  const lines = [];
  const CONFIDENCE_LABEL = { high: '已确认', medium: '推断', low: '仅路径线索' };
  const attribution = cluster.attributedMod
    ? `${cluster.attributedMod.name}${cluster.attributedMod.packageId ? ` [${cluster.attributedMod.packageId}]` : ''}`
      + `（${CONFIDENCE_LABEL[cluster.attributedMod.confidence] ?? cluster.attributedMod.confidence}`
      + `${cluster.attributedMod.dir ? `，${cluster.attributedMod.dir}` : ''}`
      + `${cluster.attributedMod.enabled ? '，已启用' : '，⚠ 不在启用列表'}）`
    : undefined;
  const related = cluster.relatedModIds
    .map((id) => nameFor(id, activeMods) ?? id)
    .slice(0, 4);
  lines.push(`### ${index}. [${cluster.level}] ×${cluster.occurrences} ${cluster.normalized.slice(0, 160)}`);
  lines.push(`- 首次: ${cluster.firstTime || '?'}   末次: ${cluster.lastTime || '?'}`);
  if (attribution) {
    lines.push(`- 归属 mod: ${attribution}`);
    if (cluster.attributedMod.confidence !== 'high' && cluster.attributedMod.evidence) {
      lines.push(`  - 依据: ${cluster.attributedMod.evidence}`);
    }
    if (cluster.attributedMod.note) lines.push(`  - 注意: ${cluster.attributedMod.note}`);
  } else {
    lines.push('- 归属 mod: 未能确定（堆栈只含引擎帧或编译期路径无 mod 线索）');
  }
  if (cluster.strayMods?.length) {
    lines.push(`- ⚠ 堆栈路径提到但不在启用列表中的 mod: ${cluster.strayMods.slice(0, 4).join('、')}`
      + '（常见于已卸载/已禁用但补丁仍生效，或它装在未被扫描的目录，优先核查）');
  }
  if (related.length) lines.push(`- 日志标记的关联 mod: ${related.join('; ')}`);
  if (cluster.inferredTypes.length) lines.push(`- 推断类型: ${cluster.inferredTypes.join(', ')}`);
  if (cluster.files.length) lines.push(`- 关联文件: ${cluster.files.slice(0, 4).join(', ')}`);
  const frames = cluster.frames.slice(0, 5).map((f) => `  - ${f.method}${f.file ? ` @ ${f.file}${f.line ? `:${f.line}` : ''}` : ''}`);
  if (frames.length) {
    lines.push('- 关键堆栈帧:');
    lines.push(...frames);
  }
  for (const sample of cluster.samples.slice(0, 2)) {
    const text = sample.length > 400 ? `${sample.slice(0, 400)}…` : sample;
    lines.push(`- 原始样本: \`${text.replace(/`/g, "'").replace(/\n/g, ' ⏎ ')}\``);
  }
  return lines.join('\n');
}

/**
 * Render the Markdown brief that a model reads.
 * @param analysis - the structured analysis (without `brief`).
 * @param env - the detected environment.
 * @returns the brief.
 */
export function renderBrief(analysis, env = {}) {
  const activeMods = env.activeMods ?? [];
  const out = [];
  out.push('# RimWorld 游戏日志分析载荷');
  out.push('');
  out.push(`- 生成时间: ${analysis.generatedAt}`);
  if (analysis.profile) {
    out.push(`- RimCrow profile: ${analysis.profile.name} (\`${analysis.profile.id}\`)  游戏版本: ${analysis.profile.gameVersion || '未知'}`);
  }
  if (env.modSummary) {
    out.push(`- 启用模组: ${env.modSummary.activeCount} 个（其中 ${env.modSummary.missingCount} 个在磁盘上找不到）；已安装可见模组 ${env.modSummary.onDiskCount} 个`);
  }
  out.push(`- 辅助模组 RimCrow Companion: ${analysis.companion?.present ? '已安装（日志含深度诊断信息）' : '未安装（日志较简略；启用后可得更完整堆栈）'}`);
  out.push('');
  out.push('## 日志来源');
  for (const source of analysis.sources) {
    if (!source.available) {
      out.push(`- ✗ ${source.label}: 不可用 — ${source.reason}${source.path ? ` (\`${source.path}\`)` : ''}`);
      continue;
    }
    const range = source.incremental ? `增量（自上一轮，字节 ${source.fromByte} 起）` : '全量';
    const when = source.analysedAt ? `，上轮分析于 ${source.analysedAt}` : '';
    out.push(`- ✓ ${source.label} [${source.format}] **${range}**${when}: 文件 ${source.totalBytes} 字节，**本次解析 ${source.entries} 条**；其中错误 ${source.summary.errors}、警告 ${source.summary.warnings}`);
    out.push(`  - 性价比: Token 花费 ${source.cost} / 信息强度 ${source.strength} — ${source.note}`);
  }
  out.push('');
  out.push('## 汇总');
  // Say what the numbers measure before showing them. A delta that reads nothing is correct and
  // still shows zero, and that zero must not be read as "this log is clean".
  const deltaZero = analysis.totals.entries === 0 && analysis.sources.some((s) => s.available && s.incremental);
  out.push(`- 以下统计**只覆盖上方「本次解析」的条目**，不是整份日志的历史总量`
    + `${deltaZero ? '（本次为增量且无新增，故全为 0）' : ''}`);
  out.push(`- 问题簇: 错误类 ${analysis.problemClusters} 个，警告类 ${analysis.warningClusters} 个`);
  out.push(`- 事件计数: 错误 ${analysis.totals.errors}、警告 ${analysis.totals.warnings}、信息 ${analysis.totals.infos}`);
  // An incremental read that finds nothing is correct but confusing, so say so explicitly, name the
  // way out, and report what the previous run had found so the answer cannot be mistaken for "clean".
  if (deltaZero) {
    out.push('');
    const prior = analysis.sources
      .filter((s) => s.available && s.path)
      .map((s) => analysis.previousByPath?.get(s.path))
      .find(Boolean);
    out.push('> ⚠️ **本次增量没有任何新增日志**（游标已在文件末尾）。上面的「0」**只代表「自上一轮以来没有新内容」**，'
      + '**不代表这份日志是干净的**。');
    if (prior?.top?.length) {
      out.push(`> 上一轮（${prior.analysedAt}）在 ${prior.entries} 条里发现：`
        + `错误类 ${prior.problemClusters} 个、警告类 ${prior.warningClusters} 个。仍未处理的例如：`);
      for (const item of prior.top.slice(0, 5)) {
        const who = item.mod ? ` — 归属 ${item.mod}` : '';
        out.push(`>   - [${item.level}] ×${item.occurrences} ${item.message}${who}`);
      }
    } else {
      out.push('> 尚未有上一轮记录（该来源还没被完整分析过）。');
    }
    out.push('> **要看整份日志请用 `/rimlog --full`**（或工具的 `full: true`）。');
  }
  // Render errors and warnings as separate lines. They used to share one line headed "mods where
  // errors are concentrated", which meant a startup INFO record listing updated mod names could
  // present a dozen innocent mods as error sources.
  const attributedNames = new Map();
  for (const cluster of analysis.clusters) {
    if (cluster.attributedMod) {
      attributedNames.set(cluster.attributedMod.packageId || cluster.attributedMod.name, cluster.attributedMod.name);
    }
  }
  const renderTally = (rows) => rows
    .map(([id, count]) => `${attributedNames.get(id) ?? nameFor(id, activeMods) ?? id} ×${count}`)
    .join('; ');
  if (analysis.modTally.errors.length) {
    out.push(`- 错误集中出现的 mod: ${renderTally(analysis.modTally.errors)}`);
  }
  if (analysis.modTally.warnings.length) {
    out.push(`- 警告集中出现的 mod: ${renderTally(analysis.modTally.warnings)}`);
  }
  if (analysis.notes?.length) {
    out.push('');
    out.push('## 探测提示');
    for (const note of analysis.notes) out.push(`- ${note}`);
  }
  out.push('');
  out.push(`## 问题簇（按严重度与出现次数排序，最多 ${analysis.clusters.length} 个）`);
  if (analysis.clusters.length === 0) {
    out.push(deltaZero
      ? '本次增量为空，因此这里没有可列出的簇。**这不等于日志没有错误**——见上方提示，用 `--full` 看整份。'
      : '未发现 ERROR/WARNING 级别的问题。');
  } else {
    analysis.clusters.forEach((cluster, i) => {
      out.push('');
      out.push(renderCluster(cluster, i + 1, activeMods));
    });
  }
  out.push('');
  out.push('---');
  out.push('载荷结束。以上为本地预处理结果；需要更多细节时可直接读取上面列出的日志文件与 mod 源码。');
  return out.join('\n');
}

/**
 * Return raw lines matching a predicate, for follow-up questions.
 *
 * When `options.mod` is given, each matching line is attributed the same way the analysis brief
 * attributes a cluster, and only lines belonging to that mod survive. Attribution is decided by the
 * same indexes the brief uses, so a grep and the brief cannot disagree about who owns a line.
 *
 * @param filePath - log file.
 * @param pattern - case-insensitive substring or `/regex/flags`.
 * @param limit - maximum lines returned.
 * @param options - `{ mod, modRoots, activeMods, indexes }`.
 * @returns matching lines with their line numbers.
 */
export function grepRaw(filePath, pattern, limit = 40, options = {}) {
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { error: `无法读取 ${filePath}` };
  }
  const test = (() => {
    const asRegex = /^\/(.*)\/([gimsuy]*)$/.exec(pattern ?? '');
    if (asRegex) {
      try {
        const re = new RegExp(asRegex[1], asRegex[2].includes('i') ? asRegex[2] : `${asRegex[2]}i`);
        return (line) => re.test(line);
      } catch {
        return undefined;
      }
    }
    const needle = String(pattern ?? '').toLowerCase();
    return needle === '' ? () => true : (line) => line.toLowerCase().includes(needle);
  })();
  if (!test) return { error: `无效的正则: ${pattern}` };

  const wanted = typeof options.mod === 'string' && options.mod.trim() !== ''
    ? options.mod.trim().toLowerCase()
    : undefined;

  const lines = text.split('\n');
  const hits = [];
  let scanned = 0;
  let skippedOtherMods = 0;

  // context（0-3）：命中行前后各取几条相邻日志行，渲染成与命中行相同的紧凑形式。
  // 两个保护：预算上限防止一次把整份日志带出去；跳过的行（空行/非 JSON）不占预算。
  const wantContext = Math.min(Math.max(Number(options.context) || 0, 0), 3);
  let contextBudget = 300;
  const renderLike = (rawLine) => {
    let parsed;
    try {
      parsed = JSON.parse(rawLine.replace(/^\uFEFF/, ''));
    } catch {
      parsed = undefined;
    }
    if (parsed && typeof parsed === 'object') {
      const rendered = `[${parsed.level}] ${parsed.message}${parsed.details ? ` :: ${String(parsed.details).split('\n')[0]}` : ''} (count=${parsed.count ?? 1})`;
      return rendered.length > 600 ? `${rendered.slice(0, 600)}…` : rendered;
    }
    return rawLine.length > 600 ? `${rawLine.slice(0, 600)}…` : rawLine;
  };

  for (let i = 0; i < lines.length && hits.length < limit; i += 1) {
    if (!test(lines[i])) continue;
    const raw = lines[i];
    let parsed;
    try {
      parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
    } catch {
      parsed = undefined;
    }

    if (wanted) {
      // Realtime entries are JSON. Attribution goes through the same parser and the same indexes the
      // analysis brief uses, so a grep and the brief cannot disagree about who owns a line and the
      // entry shape is guaranteed to be the one clusterProblems expects.
      const entry = parsed && typeof parsed === 'object' ? parseRealtimeLine(raw) : undefined;
      if (entry) {
        const [cluster] = clusterProblems([entry], options.modRoots ?? [], options.activeMods ?? [], options.indexes ?? {});
        // Identity terms are lowercased before comparing - the request is lowercased at parse time
        // above, and a case-sensitive compare here silently matched nothing for assembly names.
        //
        // The terms cover every name a reader might have to hand: the resolved packageId and display
        // name, the directory it was found in, the assembly name recovered from the stack path, the
        // ids RimCrow tagged on the record, and stray names that have no installed counterpart. The
        // assembly name matters in practice: `Telefonmast.GraphicsSettings` is only reachable through
        // the stack path, because that record carries no relatedModIds at all.
        // modNameFromFramePath returns `{ name, via }` rather than a bare string, so unwrap it -
        // stringifying the object directly yields "[object Object]" and matches nothing.
        const fromFrames = (cluster?.frames ?? [])
          .map((frame) => modNameFromFramePath(frame.file)?.name)
          .filter(Boolean);
        const terms = cluster
          ? [
              cluster.mod?.packageId,
              cluster.mod?.name,
              cluster.mod?.dir ? path.basename(cluster.mod.dir) : undefined,
              ...(cluster.modIds ?? []),
              ...(cluster.namedMods ?? []),
              ...(cluster.strayMods ?? []),
              ...fromFrames,
            ].filter(Boolean).map((id) => String(id).toLowerCase())
          : [];
        if (!terms.some((id) => id.includes(wanted))) {
          skippedOtherMods += 1;
          continue;
        }
      } else if (!raw.toLowerCase().includes(wanted)) {
        // Plain-text logs (Player.log) carry no structure, so a direct mention is the only signal.
        skippedOtherMods += 1;
        continue;
      }
      scanned += 1;
    }

    let rendered = raw;
    if (parsed && typeof parsed === 'object') {
      rendered = `[${parsed.level}] ${parsed.message}${parsed.details ? ` :: ${String(parsed.details).split('\n')[0]}` : ''} (count=${parsed.count ?? 1})`;
    }
    const hit = { line: i + 1, text: rendered.length > 600 ? `${rendered.slice(0, 600)}…` : rendered };

    // 相邻行只看位置，不做 mod 过滤——命中已经过滤过了，上下文的职责是还原现场。
    if (wantContext > 0 && contextBudget > 0) {
      const around = [];
      for (let j = Math.max(0, i - wantContext); j <= Math.min(lines.length - 1, i + wantContext); j += 1) {
        if (j === i) continue;
        const text = lines[j];
        if (text.trim() === '') continue;
        around.push({ line: j + 1, text: renderLike(text) });
        contextBudget -= 1;
        if (contextBudget <= 0) break;
      }
      if (around.length > 0) hit.context = around;
    }

    hits.push(hit);
  }
  return {
    totalLines: lines.length,
    returned: hits.length,
    hits,
    ...(wanted ? { modFilter: options.mod, matchedLines: scanned, filteredOut: skippedOtherMods } : {}),
  };
}

/** Normalize helper re-exported for the tool layer. */
export { normalizeText, isProblemLevel };
