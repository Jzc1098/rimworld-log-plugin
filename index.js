/**
 * Host half of the RimWorld game-log analysis bundle.
 *
 * Three capabilities, all read-only against the RimCrow/RimWorld installation:
 *  - the `rimworld_log_scan` tool, so any agent turn can inspect logs on demand;
 *  - the `/rimlog` human command, which scans and then hands the brief to the agent as a user
 *    message, starting an analysis turn that DSH persists like any other conversation;
 *  - a system-prompt context describing the environment, so answers about log paths and mod
 *    load order are grounded rather than guessed.
 *
 * Nothing here writes to RimCrow, to RimWorld, or to the active mod list.
 *
 * ## Why this file imports no `@deepseek-ai/*` package
 *
 * A plugin linked into a profile from an external directory is resolved by Node from its *real*
 * path, outside the Harness installation, so `@deepseek-ai/dsh-tools` and friends are not
 * resolvable from here. Depending on the runtime's own resolver is fragile across DSH versions.
 * Everything this plugin needs is therefore either a Node builtin, a local module, or a Cordis
 * service reached through `ctx` — which also makes the bundle portable to other installations.
 *
 * The one deliberate exception is `schemastery` (public npm package, declared in package.json):
 * the row-config `Config` export must be a real Schemastery schema for the host's Standard-Schema
 * validation, and there is no way to produce a compatible instance without the library.
 *
 * @module rimworld-log
 */

import path from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import Schema from 'schemastery';

import { SOURCE_META, parseArgs } from './lib/parse.js';
import {
  activeModList,
  detectEnvironment,
  resolveSource,
} from './lib/detect.js';
import { PLUGIN_ROOT, blockSummary, pluginVersion, recordCommand, recordTool } from './plugins/registry.js';
import { installNotice, reportText, usageText } from './plugins/feature-report.js';
import { readState, writeState } from './plugins/state.js';
import { analyze, grepRaw } from './lib/report.js';
import { buildCompact, diffAnalyses } from './lib/sig.js';
import { modChanges } from './lib/modwatch.js';
import { patchAudit } from './lib/patchaudit.js';
import { get, describeAll, settingsPath, setRowConfig, SETTINGS_SCHEMA } from './lib/config.js';
import { checkAbout } from './lib/aboutcheck.js';
import {
  applyModChange,
  describeChange,
  planModChange,
  readModsConfig,
  renderDiff,
} from './lib/modconfig.js';
import {
  DEFAULT_KEEP_DAYS,
  archiveSummary,
  exportMigrationPack,
  takeSnapshot,
  verifySnapshot,
  workspaceExists,
  workspaceRoot,
  writeArchiveNote,
} from './lib/workspace-archive.js';

export const name = 'rimworld-log';

/**
 * Hard service dependencies. `commands` and `tools` are what the plugin registers into;
 * `systemPrompt` carries the environment context. Each is a shipped service, so a failure here
 * is a real configuration problem and should be reported rather than silently skipped.
 */
export const inject = ['tools', 'commands', 'systemPrompt'];

/**
 * 行配置的 Schema（cordis.patch.yml 的 `config:` / DSH 设置界面编辑的就是它）。
 *
 * 必须是 **Schemastery schema 实例**而不是裸 JSON Schema：host 走 Standard Schema 规范
 * 读 `Config['~standard'].validate` 做激活期校验——裸对象没有 `~standard`，激活直接
 * `TypeError: Cannot read properties of undefined (reading 'validate')`（实测踩过）。
 * 这里用公共 npm 包 `schemastery`（本插件唯一的运行期依赖；harness 内置的是它的
 * vendored fork `@deepseek-ai/schemastery`，从工作区真实路径解析不到，所以不能直接导）。
 * 不声明 `.default()`：未设置的键保持 undefined，落到 config.js 的下一层。
 *
 * ## 为什么手动标 `meta.volatile`
 *
 * `dsh-settings` 的 `describe()` 只把**含 volatile 字段**的插件放进设置文档
 * （`volatileForm(schema)` 为 undefined 的条目被整个跳过），`configForms` 只服务文档里的
 * 命名空间——不标 volatile，设置页永远看不到这个插件（实测踩过：标签页注册了但
 * whileServed 从不触发）。`.volatile()` 是 fork 专有 API，公共 3.18.0 没有，
 * 但读取路径只认 `schema.meta.volatile`，手动设等价。
 *
 * 注意 profileId/defaultSources 是 apply 层消费的旧键，保持非 volatile（不进表单）。
 */
const volatile = (schema) => {
  schema.meta = { ...(schema.meta ?? {}), volatile: true };
  return schema;
};

export const Config = Schema.object({
  patchDir: volatile(Schema.string().description('生成的补丁文件放在哪（默认 ~/.dsh/rimworld-log/patches）')),
  workspaceDir: volatile(Schema.string().description('工作区目录；留空则自动探测')),
  snapshotDir: volatile(Schema.string().description('快照目录；留空则放在工作区旁')),
  ignoredSignatures: volatile(Schema.array(Schema.string()).description('分析时跳过的已知噪音签名（子串匹配，大小写不敏感）')),
  clusterLimit: volatile(Schema.natural().description('analyze 最多返回多少个问题簇（默认 14，上限 40）')),
  defaultSource: volatile(Schema.union(['realtime', 'player', 'playerPrev', 'realtimePrev']).description('analyze 缺省日志来源')),
  language: volatile(Schema.string().description('输出语言（预留；当前全部中文）')),
  profileId: Schema.string().description('固定使用的 RimCrow profile id（缺省自动选日志最新的）'),
  defaultSources: Schema.array(Schema.string()).description('analyze 缺省日志来源列表（旧键，保留兼容）'),
});

const SOURCE_HINT = 'realtime | player | playerPrev（日志来源；默认 realtime）';

/**
 * Where generated patches live.
 *
 * Patches are ordinary workspace files the agent writes; this plugin's job is to make their
 * location predictable, so a user can find, review and version them without reading the
 * conversation. Overridable with `DSH_RIMWORLD_PATCH_DIR` (env) or settings.json `patchDir`.
 */
function patchRoot() {
  return get('patchDir').value;
}

/**
 * Build the environment once and cache it briefly, so a UI action and a tool call in the same
 * second do not rescan a library of thousands of mod folders twice.
 */
function createEnvironmentCache() {
  let cached;
  let cachedAt = 0;
  const ttlMs = 15_000;
  return (options = {}, force = false) => {
    const now = Date.now();
    const scoped = Boolean(options.profileId || options.rimcrowHome);
    if (!force && !scoped && cached && now - cachedAt < ttlMs) return cached;
    const env = detectEnvironment(options);
    if (env.profile) {
      const mods = activeModList(env.profile, env.config, {
        toolModRoots: env.home ? [path.join(env.home, 'toolmods')] : [],
      });
      env.activeMods = mods.active;
      env.modSummary = mods;
      env.modRoots = mods.modRoots;
    } else {
      env.activeMods = [];
      env.modSummary = undefined;
      env.modRoots = [];
    }
    cached = env;
    cachedAt = now;
    return env;
  };
}

/** Normalize the free-form `action` a caller passes. */
function normalizeAction(raw) {
  const value = String(raw ?? 'analyze').toLowerCase();
  if (['detect', 'env', 'environment', 'status'].includes(value)) return 'detect';
  if (['grep', 'search', 'raw', 'find'].includes(value)) return 'grep';
  if (['mods', 'modlist', 'plan_mods'].includes(value)) return 'mods';
  if (['mods-changed', 'modchanges', 'modwatch', 'modsupdates'].includes(value)) return 'mods-changed';
  if (['diff', 'sessiondiff', 'compare', 'sessioncompare'].includes(value)) return 'diff';
  if (['patchaudit', 'patch-audit', 'audit'].includes(value)) return 'patchaudit';
  if (['aboutcheck', 'about', 'checkabout'].includes(value)) return 'aboutcheck';
  return 'analyze';
}

/**
 * The mod table as `planModChange` needs it: every enabled mod plus every mod directory on disk.
 *
 * Judging an "enable this mod" request against the active list alone would report a perfectly
 * installed mod as missing, so the on-disk table is merged in. Enabled records win on conflict,
 * because they carry the `installed` flag the warnings depend on.
 */
function knownModsTable(env) {
  const byId = new Map();
  for (const mod of env.activeMods ?? []) {
    if (mod.packageId) byId.set(mod.packageId.toLowerCase(), mod);
  }
  for (const root of env.modRoots ?? []) {
    const key = String(root.packageId ?? '').toLowerCase();
    if (key && !byId.has(key)) {
      byId.set(key, { packageId: root.packageId, name: root.name, installed: true, dir: root.root });
    }
  }
  return [...byId.values()];
}

/**
 * Strip anything a strict JSON serializer would reject.
 *
 * The harness validates tool results as "lossless JSON" and rejects a value carrying
 * `undefined`, which is exactly what `error: result.error` produces on the success path — the
 * write went through, then the result failed validation and the caller saw an error instead of
 * a confirmation. Dropping undefined keys and non-finite numbers makes every branch safe.
 *
 * @param value - the tool result.
 * @returns an equivalent value with no undefined members or non-finite numbers.
 */
function jsonSafe(value) {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map((item) => jsonSafe(item)).filter((item) => item !== undefined);
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'bigint') return String(value);
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const clean = jsonSafe(item);
      if (clean !== undefined) out[key] = clean;
    }
    return out;
  }
  return value;
}

/**
 * Is RimWorld or RimCrow currently running?
 *
 * Read through `tasklist` because it is present on every supported Windows host and needs no
 * native module. A failure to enumerate is reported as "unknown", never as "not running": the
 * caller must not treat an error as permission to write.
 */
function gameRunning() {
  try {
    const out = execFileSync('tasklist', ['/fo', 'csv', '/nh'], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    const names = out.split('\n').map((line) => (line.split(',')[0] ?? '').replace(/"/g, '').trim().toLowerCase());
    return { rimworld: names.some((n) => n.startsWith('rimworld')), rimcrow: names.includes('rimcrow.exe') };
  } catch (error) {
    return { unknown: true, error: error?.message ?? String(error) };
  }
}

/**
 * Draft, review, or apply a change to one profile's active mod list.
 *
 * The draft path is read-only. The writing path is REFUSED here by default - see `modWritesAllowed`.
 * That is not a prompt-level request the model can talk itself out of: the check sits in the function
 * that performs the write, so no wording of a tool call reaches the file.
 */
function modWritesAllowed() {
  // Explicit, user-set opt-in only. Named RIMLOG_ALLOW_MOD_WRITES so that finding it in an environment
  // is self-explanatory, and deliberately not set anywhere by this plugin.
  return process.env.RIMLOG_ALLOW_MOD_WRITES === '1';
}

function runModChange(getEnv, args) {
  const env = getEnv({ profileId: args.profileId, rimcrowHome: args.rimcrowHome }, true);
  if (!env.profile) {
    return { ok: false, error: env.notes?.[0] ?? '未找到可用 profile。', notes: env.notes };
  }
  const filePath = env.modSummary?.modsConfigPath;
  if (!filePath) return { ok: false, error: '未定位到 ModsConfig.xml。' };

  const read = readModsConfig(filePath);
  if (!read.ok) return { ok: false, error: read.error };

  const plan = planModChange(read.config, { enable: args.enable, disable: args.disable }, knownModsTable(env));
  const summary = {
    filePath,
    changes: plan.changes,
    alreadyEnabled: plan.alreadyEnabled,
    alreadyDisabled: plan.alreadyDisabled,
    warnings: plan.warnings,
    beforeCount: plan.beforeCount,
    afterCount: plan.afterCount,
    describe: describeChange(plan),
    diff: renderDiff(plan),
  };

  if (plan.changes.length === 0) {
    return { ok: true, applied: false, reason: '没有需要变更的项。', ...summary };
  }
  if (!args.apply) {
    return {
      ok: true,
      applied: false,
      gameRunning: gameRunning(),
      reason: '这是草稿（未写入）。',
      ...summary,
    };
  }

  // The write was requested. Refuse unless the human has opted in on this machine.
  //
  // The user's rule, stated plainly: enabling and disabling mods is theirs to do. This plugin may
  // analyse, and may draft, but must not flip the switch - including when a fix mod it just built needs
  // enabling to work. Draft it, say what to enable, stop there.
  if (!modWritesAllowed()) {
    return {
      ok: false,
      applied: false,
      draftOnly: true,
      gameRunning: gameRunning(),
      error: '插件不代你写入 mod 列表：启用/禁用一律由你自己操作。'
        + '下面是现成的改动清单，请在 RimCrow 或游戏里手动勾选。',
      ...summary,
    };
  }

  // Writing to ModsConfig.xml while the game runs is a classic way to lose a session's mod list:
  // the game rewrites the file on exit. Refuse instead of racing it.
  const running = gameRunning();
  if (running.rimworld) {
    return {
      ok: false,
      applied: false,
      gameRunning: running,
      error: '检测到 RimWorld 正在运行，已放弃写入 ModsConfig.xml：游戏退出时会用内存里的列表覆盖这次改动。请先退出游戏。',
      ...summary,
    };
  }
  // Read the current mtime immediately before writing: the writer refuses when the file moved on
  // since planning, which is how a concurrent RimCrow or game write is detected.
  let mtimeMs;
  try {
    mtimeMs = statSync(filePath).mtimeMs;
  } catch {
    mtimeMs = undefined;
  }
  const result = applyModChange(filePath, plan, { dryRun: false, expectedMtimeMs: mtimeMs });
  return {
    ok: result.ok,
    applied: true,
    backupPath: result.backupPath,
    verified: result.verified,
    error: result.error,
    note: 'RimCrow 正在运行时它可能用内存里的列表覆盖这次改动；改完请在 RimCrow 里刷新一次界面。',
    ...summary,
  };
}

/** Tool + command shared implementation: perform one scan or lookup. */
function runScan(getEnv, args) {
  const action = normalizeAction(args.action);
  const options = { profileId: args.profileId, rimcrowHome: args.rimcrowHome };

  if (action === 'detect') {
    const env = getEnv(options, true);
    return {
      ok: Boolean(env.home),
      home: env.home,
      notes: env.notes,
      profile: env.profile
        ? {
            id: env.profile.id,
            name: env.profile.name,
            gameVersion: env.profile.gameVersion,
            isCurrent: env.profile.isCurrent,
          }
        : undefined,
      profiles: env.profiles.map((p) => ({ id: p.id, name: p.name, isCurrent: p.isCurrent })),
      sources: Object.entries(env.sources ?? {}).map(([kind, file]) => ({
        kind,
        label: SOURCE_META[kind]?.label ?? kind,
        path: file.path,
        exists: file.exists,
        bytes: file.bytes,
        mtime: file.mtime,
        cost: SOURCE_META[kind]?.cost,
        strength: SOURCE_META[kind]?.strength,
        note: SOURCE_META[kind]?.note,
      })),
      companion: env.companion,
      patchDir: patchRoot(),
      // packageId -> directory for every ENABLED mod.
      //
      // The analysis brief names the mod it blames, but not where that mod lives, so a reader that
      // wants to open its source files has to search the workshop roots by hand. Handing over the
      // table removes that step. Only enabled mods are listed: they are the ones an investigation
      // can act on, and the full on-disk table is an order of magnitude larger.
      modDirectories: (() => {
        const map = {};
        for (const mod of env.activeMods ?? []) {
          if (!mod?.installed || !mod.dir || !mod.packageId) continue;
          map[mod.packageId] = mod.dir;
        }
        return Object.keys(map).length > 0 ? map : undefined;
      })(),
      mods: env.modSummary
        ? {
            activeCount: env.modSummary.activeCount,
            missingCount: env.modSummary.missingCount,
            missing: env.modSummary.missing,
            onDiskCount: env.modSummary.onDiskCount,
            modsConfigPath: env.modSummary.modsConfigPath,
            searchRoots: env.modSummary.searchRoots,
          }
        : undefined,
    };
  }

  const env = getEnv(options, action === 'analyze' || action === 'mods' || action === 'mods-changed' || action === 'diff');
  if (!env.profile) {
    const hint = env.home
      ? `在 ${env.home}\\data\\profiles 下没有可用 profile。`
      : '未找到 RimCrow 安装目录；请用 rimcrowHome 参数或 RIMCROW_HOME 环境变量指定。';
    return { ok: false, error: hint, notes: env.notes };
  }

  if (action === 'mods') return runModChange(getEnv, args);

  // 「哪些 mod 变了」：目录 mtime 粗筛 + About 版本与基线比对。基线只在运行本动作时读写。
  if (action === 'mods-changed') {
    if (!Array.isArray(env.modRoots) || env.modRoots.length === 0) {
      return { ok: false, error: 'mod 目录索引为空（扫描失败或搜索根不可读）。', notes: env.notes };
    }
    return modChanges(env.modRoots, { since: args.since });
  }

  // 「本次 vs 上次」：两份日志各自全量聚类（不推进增量游标），再按签名做集合差。
  if (action === 'diff') {
    const currentKind = SOURCE_META[args.current] ? args.current : 'realtime';
    const previousKind = SOURCE_META[args.previous] ? args.previous : 'realtimePrev';
    if (currentKind === previousKind) {
      return { ok: false, error: `current 与 previous 不能是同一个来源（均为 ${currentKind}）。` };
    }
    const analyzeOpts = {
      full: true,
      maxClusters: 500,
      modRoots: env.modRoots,
      activeMods: env.activeMods,
      indexes: env.modSummary
        ? { byAssembly: env.modSummary.byAssembly, byFolder: env.modSummary.byFolder }
        : {},
      persist: false,
    };
    const current = analyze(env, { ...analyzeOpts, sources: [currentKind] });
    const previous = analyze(env, { ...analyzeOpts, sources: [previousKind] });
    if (!current.sources?.[0]?.available) {
      return { ok: false, error: `当前来源不可用: ${current.sources?.[0]?.reason ?? currentKind}` };
    }
    return {
      ok: true,
      profile: current.profile,
      sources: { current: currentKind, previous: previousKind, previousAvailable: previous.sources?.[0]?.available || undefined },
      diff: diffAnalyses(current, previous, {
        includeWarnings: String(args.level ?? '').toLowerCase() === 'both',
      }),
    };
  }

  // 「补丁部署审计」：启用中的 rimcrow.* 修复 mod，工作区源码 ↔ 部署目录是否一致。
  // 纯只读（stat + 哈希），不碰任何文件。
  if (action === 'patchaudit') {
    const audit = patchAudit(env.activeMods ?? [], {
      workspaceDir: workspaceRoot(),
      prefix: args.prefix,
    });
    return audit;
  }

  // 「About.xml 校验」：XML 结构、裸 &、description 类型、编码。不依赖 env——只读指定路径。
  if (action === 'aboutcheck') {
    const target = String(args.path ?? '').trim();
    if (!target) {
      return { ok: false, error: 'aboutcheck 需要一个 path 参数：About.xml 的路径，或包含它的 mod 目录。' };
    }
    const result = checkAbout(path.resolve(target));
    return {
      ok: result.ok,
      ...result,
      note: result.ok && result.warnings.length === 0
        ? '全部检查通过'
        : result.ok ? '没有致命错误，但有警告' : `有 ${result.errors.length} 个错误`,
    };
  }

  if (action === 'grep') {
    const kind = args.source && SOURCE_META[args.source] ? args.source : 'realtime';
    const file = resolveSource(env.profile, kind);
    if (!file?.exists) return { ok: false, error: `日志不存在: ${file?.path ?? kind}` };
    const result = grepRaw(file.path, args.pattern ?? '', Math.min(Number(args.limit) || 40, 200), {
      // Passing the same inputs the brief uses keeps grep and analysis attribution consistent.
      mod: args.mod,
      modRoots: env.modRoots,
      activeMods: env.activeMods,
      indexes: env.modSummary
        ? { byAssembly: env.modSummary.byAssembly, byFolder: env.modSummary.byFolder }
        : {},
      context: args.context,
    });
    return { ok: !result.error, source: kind, path: file.path, ...result };
  }

  const analysis = analyze(env, {
    sources: args.sources?.length ? args.sources.filter((s) => SOURCE_META[s]) : [get('defaultSource').value || 'realtime'].filter((s) => SOURCE_META[s]),
    full: Boolean(args.full),
    since: args.since,
    maxClusters: Math.min(Number(args.maxClusters) || Number(get('clusterLimit').value) || 14, 40),
    modRoots: env.modRoots,
    activeMods: env.activeMods,
    indexes: env.modSummary
      ? { byAssembly: env.modSummary.byAssembly, byFolder: env.modSummary.byFolder }
      : {},
    persist: args.incremental !== false,
  });
  // 紧凑视图：同一份 analysis，只换负载形状。不带 brief——速记归档只记完整分析。
  if (args.compact) {
    // ignore 合并：调用时传的 + settings.json 的 ignoredSignatures（如 PA's God Hands 那条
    // 故意的红字）。两者可以同时生效；重复项由子串匹配自然吞掉。
    const configIgnore = get('ignoredSignatures').value ?? [];
    const argIgnore = Array.isArray(args.ignore) ? args.ignore : [];
    return {
      ok: true,
      profile: analysis.profile,
      compact: buildCompact(analysis, { ignore: [...argIgnore, ...configIgnore] }),
    };
  }
  return {
    ok: true,
    profile: analysis.profile,
    totals: analysis.totals,
    problemClusters: analysis.problemClusters,
    warningClusters: analysis.warningClusters,
    modTally: analysis.modTally,
    sources: analysis.sources,
    clusters: analysis.clusters,
    brief: analysis.brief,
  };
}

/** Compact, human-readable rendering for the command result line. */
function commandSummary(analysis) {
  const groups = analysis.sources
    .map((s) => {
      if (!s.available) return `${s.label}(不可用)`;
      const scope = s.incremental ? '增量' : '全量';
      return `${s.label}(${scope} ${s.entries}条/错误${s.summary.errors})`;
    })
    .join('、');
  const empty = analysis.totals.entries === 0 && analysis.sources.some((s) => s.available && s.incremental);
  // The zeros must not be read as "this log is clean": spell out what they measure.
  const caveat = empty
    ? '⚠️ 本次增量无新增，以上 0 只表示「自上一轮以来没有新内容」，不代表日志干净；看整份请用 --full。'
    : '';
  return `已扫描 ${groups}；问题簇 错误 ${analysis.problemClusters} / 警告 ${analysis.warningClusters}，`
    + `事件计数 错误 ${analysis.totals.errors} / 警告 ${analysis.totals.warnings}。${caveat}`;
}

/**
 * Build the prompt that starts an analysis turn.
 *
 * Shape follows the documented `PromptContentPart[]` for `ctx.sessionController.prompt`: a list
 * of content blocks. The environment facts are prepended because the scoped system-prompt context
 * is not guaranteed to be in this session's window when the plugin was just activated.
 */
function buildAnalysisPrompt(analysis, env, question) {
  const intro = question && question.trim()
    ? question.trim()
    : '请深度分析我提交的游戏日志，给出最可能的问题根因、证据链和修复建议。'
      + '若根因指向某个 mod，请进一步查看该 mod 的源码或配置确认。';
  const roots = (env.modSummary?.searchRoots ?? []).slice(0, 6);
  const scopeLines = analysis.sources
    .filter((s) => s.available)
    .map((s) => {
      const scope = s.incremental
        ? `增量（只含字节 ${s.fromByte} 之后的新增内容，共 ${s.entries} 条）`
        : `全量（整份 ${s.totalBytes} 字节，共 ${s.entries} 条）`;
      return `- ${s.label}: ${scope}`;
    });
  const parts = [
    intro,
    '',
    `使用的日志来源: ${analysis.sources.map((s) => `${s.label}${s.available ? '' : '(不可用)'}`).join('、')}`,
  ];
  // State the scope up front. A reader who assumes "the log was analysed" when only the tail was
  // read will draw the wrong conclusion from a zero count.
  if (scopeLines.length > 0) {
    parts.push('本次分析范围（重要）:');
    parts.push(...scopeLines);
    const partial = analysis.sources.some((s) => s.available && s.incremental);
    if (partial) {
      parts.push('（增量范围意味着载荷里的计数只覆盖新增部分，不代表整份日志的历史总量；'
        + '需要整份请重新调用并传 full: true。）');
    }
  }
  if (env.profile) parts.push(`RimCrow profile: ${env.profile.name} (${env.profile.id})`);
  if (env.modSummary) {
    parts.push(`启用模组: ${env.modSummary.activeCount} 个（磁盘可见 ${env.modSummary.onDiskCount} 个）`);
  }
  if (roots.length > 0) {
    parts.push('模组搜索根目录（可用于直接读取 mod 源码）:');
    for (const root of roots) parts.push(`- ${root}`);
  }
  parts.push('', '（以下为本地预处理的日志载荷；需要更多细节可直接读取其中列出的文件。）', '', analysis.brief);
  return [{ type: 'text', text: parts.join('\n') }];
}

/** Dispatch the analysis prompt through whichever channel this DSH build exposes. */
async function submitPrompt(ctx, agent, content, log) {
  const sessionId = agent?.id;
  const controller = ctx.get('sessionController');
  if (controller && sessionId && typeof controller.prompt === 'function') {
    try {
      await controller.prompt(
        {
          requestId: `rimworld-log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          sessionId,
          mode: 'queue',
          content,
        },
        AbortSignal.timeout(20_000),
      );
      return { delivered: true, via: 'sessionController.prompt' };
    } catch (error) {
      log(`sessionController.prompt failed: ${error?.message ?? error}`);
    }
  }
  if (agent && typeof agent.followup === 'function') {
    try {
      agent.followup({ role: 'user', content, source: { kind: 'user' } });
      return { delivered: true, via: 'agent.followup' };
    } catch (error) {
      log(`agent.followup failed: ${error?.message ?? error}`);
    }
  }
  return { delivered: false, via: undefined };
}

export function apply(ctx, config) {
  // 行配置交给设置层：DSH 设置界面编辑后会重新激活插件并带上新值，
  // 所以这里每次 apply 都要重存（包括"用户清空了某个键"的情况）。
  setRowConfig(config);
  const getEnv = createEnvironmentCache();
  const defaultProfileId = config?.profileId;
  const defaultSources = Array.isArray(config?.defaultSources) && config.defaultSources.length > 0
    ? config.defaultSources.filter((s) => SOURCE_META[s])
    : ['realtime'];
  // Which source sets `/rimlog` has already scanned in this process.
  //
  // The incremental cursor is the right default for a tool the agent may call repeatedly, but it is
  // the wrong default for the button a human presses once: with the cursor already at the end of the
  // file, the run reads nothing and reports zero problems, which reads as "your log is clean". A
  // full scan the first time per session removes that false negative; later presses stay incremental
  // so repeated use is still cheap. Cleared whenever the module reloads, i.e. on a DSH restart.
  const fullyScanned = new Set();
  const log = (message) => {
    try {
      ctx.logger?.warn?.(`[rimworld-log] ${message}`);
    } catch {
      /* logging must never break a tool call */
    }
  };

  // Names of the tools this apply() call registers. Used only for the install notice's record of what
  // existed, so it is a plain list rather than the full registry.
  const toolsRegistered = [];

  // ---- install / update notice ------------------------------------------
  //
  // Computed once per process, then cached. The system-prompt context below is evaluated on every turn, so
  // doing the work inline would re-read the state file and the block registry on every turn for a string
  // that cannot change while the process lives.
  //
  // A first run records the current state and says so once. Later runs compare the declared version with
  // what was recorded and return nothing when they match, so a steady session pays nothing. The notice
  // prints both version strings as facts and draws no conclusion from them: a version number is a claim a
  // copy makes about itself, not evidence about which copy is newer.
  let installNoticeCache;
  const installNoticeText = () => {
    if (installNoticeCache !== undefined) return installNoticeCache;
    try {
      const notice = installNotice();
      if (notice) {
        const blocks = blockSummary();
        writeState({
          version: pluginVersion(),
          lastReportAt: new Date().toISOString(),
          blockCount: blocks.present ? blocks.total : undefined,
          toolNames: toolsRegistered.map((name) => name),
        });
      }
      installNoticeCache = notice;
    } catch {
      // A report is a convenience. It must never be why a prompt fails to build.
      installNoticeCache = '';
    }
    return installNoticeCache;
  };

  // ---- 自动归档 ----------------------------------------------------------
  //
  // 用户的原话是「不要我每次来说」。手工归档的问题不是忘了写，而是**写的人得先想起来**：一天里
  // 真正值得记的那一刻（跑完一次扫描、定位到根因）往往正好是上下文最满的时候，于是记录被跳过了。
  // 所以在扫描完成后自动落一份速记，把「我在哪一轮看到了什么」变成磁盘上的事实。
  //
  // 三条自我约束：
  //  - 只对 analyze 生效。grep / detect / mods 是查询动作，每次调用都归档会把这本记录变成噪声。
  //  - 十分钟内只记一次。同一轮里连续扫多个来源不该产生多条几乎相同的记录。
  //  - 开关是 RIMLOG_AUTO_ARCHIVE=0。自动写文件是个需要能被关掉的行为，哪怕默认开。
  //
  // 节流必须**落盘**，不能只放内存：第一版用的是模块级变量，插件一重载就归零，
  // 实测三分钟内连记了三条内容几乎相同的「日志扫描速记」。时间戳写进 install-state.json，
  // 跨越重载仍然有效。
  //
  // 归档失败不影响扫描结果：记录的价值低于它要记录的东西，不能反过来让扫描失败。
  const AUTO_ARCHIVE_INTERVAL_MS = 30 * 60 * 1000;

  function maybeAutoArchive(args, result) {
    try {
      if (normalizeAction(args?.action) !== 'analyze') return;
      if (String(process.env.RIMLOG_AUTO_ARCHIVE ?? '1') === '0') return;
      if (!workspaceExists()) return;

      const now = Date.now();
      const state = readState();
      const last = Number(state.lastAutoArchiveAt ?? 0);
      if (Number.isFinite(last) && now - last < AUTO_ARCHIVE_INTERVAL_MS) return;

      const brief = typeof result?.brief === 'string' ? result.brief.trim() : '';
      if (!brief) return;

      const lines = brief.split('\n');
      const head = lines.slice(0, 60).join('\n');
      const truncated = lines.length > 60 ? `\n\n…（速记只保留前 60 行，完整分析见当轮对话或原始日志）` : '';
      const sources = Array.isArray(args?.sources) ? args.sources.join('+') : 'realtime';

      const wrote = writeArchiveNote({
        title: `日志扫描速记 ${sources}`,
        body: `自动生成：每次 analyze 扫描完成后落一份速记，方便回溯「哪一轮看到了什么」。\n\n`
          + '```\n' + head + truncated + '\n```\n',
        tags: ['自动归档', '日志扫描', sources],
      });
      if (!wrote.ok) return;

      // 先记时间戳再拍快照：快照失败不该导致下次又来一条重复记录。
      writeState({ lastAutoArchiveAt: now });
      takeSnapshot({});
    } catch {
      // 归档是副产物，不该让扫描失败。
    }
  }

  // ---- agent-facing tool -------------------------------------------------
  // The self-report guide prints the description and parameter schema below, read back from the registry.
  // Keeping one copy of each string is what stops the guide from describing tools that no longer match.
  recordTool({
    name: 'rimworld_log_scan',
    description: [
      '读取并分析 RimWorld 的游戏日志（RimCrow 环境）。',
      'action=analyze：聚类错误/警告、按堆栈归属 mod、给出可回溯的证据与样本（默认，只读）。',
      'action=detect：列出 RimCrow/profile/日志文件/启用模组与日志来源的性价比（只读）。',
      'action=grep：在原始日志里按子串或 /正则/ 检索行（只读）。',
      'action=mods：只起草启用/禁用 mod 的改动清单，**不写入**。',
      'action=mods-changed：时间窗内更新/新增的 mod（目录时间 + About 版本对比，只读）。',
      'action=diff：本次 vs 上次会话的错误对比（新增/消失/计数变化，只读）。',
      'action=patchaudit：启用中的修复 mod，工作区源码与部署目录哈希/mtime 是否一致（只读）。',
      'action=aboutcheck：校验一个 About.xml（XML 结构、裸 &、description 类型、编码嗅探，只读）。',
      'analyze 加 compact=true 返回紧凑签名视图（每簇一行，配 ignore 过滤已知噪音）。',
      '插件不代用户改 mod 列表：即使传 apply=true 也会被拒绝（需要机器上显式设置',
      'RIMLOG_ALLOW_MOD_WRITES=1 才允许写入，默认不设）。启用/禁用一律由用户自己在 RimCrow 或游戏里操作。',
      '把 enable/disable 当成一份「请用户去勾选」的清单来用，不要代替用户决定。',
    ].join(' '),
  });
  toolsRegistered.push('rimworld_log_scan');
  ctx.effect(() => ctx.tools.register({
    name: 'rimworld_log_scan',
    description: [
      '读取并分析 RimWorld 的游戏日志（RimCrow 环境）。',
      'action=analyze：聚类错误/警告、按堆栈归属 mod、给出可回溯的证据与样本（默认，只读）。',
      'action=detect：列出 RimCrow/profile/日志文件/启用模组与日志来源的性价比（只读）。',
      'action=grep：在原始日志里按子串或 /正则/ 检索行（只读）。',
      'action=mods：只起草启用/禁用 mod 的改动清单，**不写入**。',
      'action=mods-changed：时间窗内更新/新增的 mod（目录时间 + About 版本对比，只读）。',
      'action=diff：本次 vs 上次会话的错误对比（新增/消失/计数变化，只读）。',
      'action=patchaudit：启用中的修复 mod，工作区源码与部署目录哈希/mtime 是否一致（只读）。',
      'action=aboutcheck：校验一个 About.xml（XML 结构、裸 &、description 类型、编码嗅探，只读）。',
      'analyze 加 compact=true 返回紧凑签名视图（每簇一行，配 ignore 过滤已知噪音）。',
      '插件不代用户改 mod 列表：即使传 apply=true 也会被拒绝（需要机器上显式设置',
      'RIMLOG_ALLOW_MOD_WRITES=1 才允许写入，默认不设）。启用/禁用一律由用户自己在 RimCrow 或游戏里操作。',
      '把 enable/disable 当成一份「请用户去勾选」的清单来用，不要代替用户决定。',
    ].join(' '),
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['analyze', 'detect', 'grep', 'mods', 'mods-changed', 'diff', 'patchaudit', 'aboutcheck'], description: '要执行的操作，默认 analyze。' },
        enable: {
          type: 'array',
          items: { type: 'string' },
          description: 'action=mods：要启用的 mod packageId 列表（追加到启用列表末尾）。',
        },
        disable: {
          type: 'array',
          items: { type: 'string' },
          description: 'action=mods：要禁用的 mod packageId 列表。',
        },
        apply: {
          type: 'boolean',
          description: 'action=mods：true 才真正写入 ModsConfig.xml；省略或 false 只返回草稿与 diff。',
        },
        sources: {
          type: 'array',
          items: { type: 'string', enum: Object.keys(SOURCE_META) },
          description: `要分析的日志来源，可多选。${SOURCE_HINT}`,
        },
        source: { type: 'string', enum: Object.keys(SOURCE_META), description: 'action=grep 时检索哪个来源，默认 realtime。' },
        pattern: { type: 'string', description: 'action=grep 的检索式：普通子串，或 /正则/flags。' },
        mod: { type: 'string', description: 'action=grep：只保留归属于该 mod 的行（packageId、名称或装配名的一部分即可）。归属判定与日志分析一致。' },
        limit: { type: 'number', description: 'action=grep 最多返回多少行，默认 40，上限 200。' },
        context: { type: 'number', description: 'action=grep：命中行前后各带几条相邻日志行（0-3，默认 0 不带）。总输出有预算上限，不会刷屏。' },
        compact: { type: 'boolean', description: 'action=analyze：true 返回紧凑签名视图——每簇一行（计数+签名+归属），不带堆栈与样本。' },
        ignore: { type: 'array', items: { type: 'string' }, description: 'compact=true 时的已知噪音忽略清单（子串匹配，大小写不敏感），如 PA\u0027s God Hands 那条故意的红字。' },
        current: { type: 'string', enum: Object.keys(SOURCE_META), description: 'action=diff：作为「本次」的来源，默认 realtime。' },
        previous: { type: 'string', enum: Object.keys(SOURCE_META), description: 'action=diff：作为「上次」的来源，默认 realtimePrev。' },
        level: { type: 'string', enum: ['error', 'both'], description: 'action=diff：只比错误（默认）或连警告一起比（both）。' },
        prefix: { type: 'string', description: 'action=patchaudit：审计的 packageId 前缀，默认 rimcrow.（工作区修复 mod 的命名约定）。' },
        path: { type: 'string', description: 'action=aboutcheck：About.xml 的路径，或包含它的 mod 目录。' },
        full: { type: 'boolean', description: 'true 表示忽略增量游标、整份重新分析。' },
        incremental: { type: 'boolean', description: 'false 表示本次不写入增量游标。' },
        since: { type: 'string', description: '只保留该时间之后的条目（ISO 或日志时间字符串）。' },
        maxClusters: { type: 'number', description: '最多返回多少个问题簇，默认 14，上限 40。' },
        profileId: { type: 'string', description: '指定 RimCrow profile id 或名称；省略则自动选择日志最新的 profile。' },
        rimcrowHome: { type: 'string', description: '手动指定 RimCrow 安装目录（用于非默认安装位置）。' },
      },
      additionalProperties: false,
    },
    // Required by the ToolDefinition contract: the schema types the value, `render` turns it
    // into model-facing content. `type` must be one of the JSON Schema types — `"json"` is NOT
    // valid here and is rejected at registration time, so the declared shape is `object`
    // (the value is always an object) and the brief is passed through by `render`.
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [
        {
          type: 'text',
          text: value && typeof value === 'object' && typeof value.brief === 'string'
            ? value.brief
            : JSON.stringify(value, null, 2),
        },
      ],
    },
    async execute(args) {
      const merged = { ...args };
      if (!merged.profileId && defaultProfileId) merged.profileId = defaultProfileId;
      if ((!merged.sources || merged.sources.length === 0) && normalizeAction(merged.action) === 'analyze') {
        // 来源优先级：调用参数 > 设置（defaultSource）> apply 行配置（defaultSources）> realtime
        const cfgSource = get('defaultSource').value;
        merged.sources = SOURCE_META[cfgSource] ? [cfgSource] : defaultSources;
      }
      const result = jsonSafe(runScan(getEnv, merged));
      // 自动归档：只对 analyze 生效，十分钟内最多一次，可用 RIMLOG_AUTO_ARCHIVE=0 关闭。
      maybeAutoArchive(merged, result);
      return result;
    },
    presentCall: (args) => ({
      card: 'generic',
      kind: 'read',
      title: `RimWorld 日志 ${normalizeAction(args?.action)}`
        + `${args?.sources?.length ? `（${args.sources.join('+')}）` : ''}`,
    }),
  }), 'rimworld-log: rimworld_log_scan');

  // ---- self-report tool ---------------------------------------------------
  //
  // Answers "what can this plugin do" and "what changed" without the user having to read files. Both
  // answers are generated from the registry and from disk, so neither can describe a tool that is not
  // registered or a parameter that does not exist.
  const guideDescription = [
    '报告本插件自身的功能与用法（只读，不碰游戏目录）。',
    'action=report：功能报告 —— 工具与命令清单、块清单、作者表、自上次记录以来的变化（默认）。',
    'action=usage：使用说明 —— 从工具与命令的注册表实时生成，含每个参数的取值与含义，因此不会与代码脱节。',
    'action=since：只列自上次记录以来新增或移除的工具与块数变化。',
    'action=config：打印当前生效的设置及各值的来源（环境变量 / settings.json / 内置默认）。',
  ].join(' ');
  const guideParameters = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['report', 'usage', 'since', 'config'], description: '要执行的操作，默认 report。' },
    },
  };
  recordTool({ name: 'rimworld_plugin_guide', description: guideDescription, parameters: guideParameters });
  toolsRegistered.push('rimworld_plugin_guide');
  ctx.effect(() => ctx.tools.register({
    name: 'rimworld_plugin_guide',
    description: guideDescription,
    parameters: guideParameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [
        { type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value, null, 2) },
      ],
    },
    // `execute`, `output.schema` and `output.render` are the ToolDefinition contract this plugin's other
    // tool already follows, and the one mock-host.mjs asserts. An earlier version of this block used
    // `handler`, then `call`; both register a tool the runtime will never invoke, and the failure is
    // silent. tools/selftest-plugin.mjs now checks the real key names.
    async execute(args) {
      try {
        const action = String(args?.action ?? 'report').toLowerCase();
        if (action === 'usage') return { text: usageText() };
        if (action === 'since') {
          const full = reportText();
          const start = full.indexOf('## 四、自上次记录以来的变化');
          const end = full.indexOf('## 五、');
          return { text: start >= 0 && end > start ? full.slice(start, end) : full };
        }
        if (action === 'config') {
          const entries = describeAll();
          const originLabel = { env: '环境变量', row: '配置界面', file: 'settings.json', default: '内置默认' };
          const lines = [
            `# 当前生效的设置（schema: ${SETTINGS_SCHEMA}）`,
            '',
            `| 键 | 值 | 来源${''} | 说明 |`,
            `|---|---|---|---|`,
            ...entries.map((e) => {
              const origin = `${originLabel[e.origin] ?? e.origin}${e.envVar ? ` (\`${e.envVar}\`)` : ''}`;
              const value = e.value === null || e.value === undefined ? '（由其他模块探测）'
                : Array.isArray(e.value) ? e.value.length === 0 ? '（空）' : e.value.join('; ')
                : String(e.value);
              return `| \`${e.key}\` | ${value} | ${origin} | ${e.label} |`;
            }),
            '',
            `修改方式：DSH 设置界面（设置 → RimWorld 日志分析）保存即写盘，**重启 DSH 后生效**（harness 不对已加载的 host 半区热重载配置）；或编辑 \`${settingsPath()}\`（文件层，下次读取即生效）。环境变量始终优先。`,
          ].join('\n');
          return { text: lines };
        }
        return { text: reportText() };
      } catch (error) {
        log(`plugin guide failed: ${error?.message ?? error}`);
        return { text: `功能报告生成失败：${error?.message ?? error}` };
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      kind: 'read',
      title: `插件功能报告（${String(args?.action ?? 'report')}）`,
    }),
  }), 'rimworld-log: rimworld_plugin_guide');

  // ---- comparison tool ----------------------------------------------------
  //
  // A thin wrapper over tools/compare-plugin.mjs. The comparison itself lives in the script so it can be
  // run, read and tested without DSH, and so the same code produces the same report either way.
  //
  // Reads only. The script is told which directories to compare and writes its report beside the local
  // copy; it never writes into the other copy.
  const compareDescription = [
    '把本地插件与另一份插件副本按块比对，报告差异（只读）。',
    '比对单位是块而不是行，所以换行、缩进与顺序变化不会被报成改动。',
    '**不判断哪一份更新** —— 版本号、文件数、日期都只是各方对自己的声明，报告里对称列出，不做裁决。',
    '输出分节：汇总、A 有 B 没有、两边都有但不同、疑似同功能、按导入安全性排序的可学清单、依赖待查。',
    '疑似同功能默认只报强信号（两块导出同名）；要连名字相似、内容相近的弱信号一起报，传 showWeakSignals=true。',
    '报告写到哪里会在返回里给出。',
  ].join(' ');
  const compareParameters = {
    type: 'object',
    properties: {
      otherDir: {
        type: 'string',
        description: '另一份插件副本的绝对目录（要包含 package.json）。',
      },
      showWeakSignals: {
        type: 'boolean',
        description: 'true 时额外报告名字相似与内容相近的疑似同功能块。误报率高，默认关闭。',
      },
    },
    required: ['otherDir'],
  };
  recordTool({ name: 'rimworld_plugin_compare', description: compareDescription, parameters: compareParameters });
  toolsRegistered.push('rimworld_plugin_compare');
  ctx.effect(() => ctx.tools.register({
    name: 'rimworld_plugin_compare',
    description: compareDescription,
    parameters: compareParameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [
        { type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value, null, 2) },
      ],
    },
    async execute(args) {
      const other = String(args?.otherDir ?? '').trim();
      if (!other) return { text: '需要 otherDir：另一份插件副本的绝对目录。' };
      if (!existsSync(other)) return { text: `目录不存在：${other}` };

      const script = path.join(PLUGIN_ROOT, 'tools', 'compare-plugin.mjs');
      if (!existsSync(script)) {
        return { text: `找不到比对脚本：${script}\n`
          + '（本副本可能只装了运行必需的文件，没有带 tools/。）' };
      }
      const argv = [script, other];
      if (args?.showWeakSignals === true) argv.push('--show-weak-signals');
      try {
        const out = execFileSync(process.execPath, argv, {
          encoding: 'utf8',
          maxBuffer: 32 * 1024 * 1024,
          timeout: 120000,
        });
        return { text: out.trim() || '（比对完成，但没有输出）' };
      } catch (error) {
        const stderr = String(error?.stderr ?? '').trim();
        const stdout = String(error?.stdout ?? '').trim();
        return {
          text: `比对失败：${error?.message ?? error}\n${stdout}\n${stderr}`.trim(),
        };
      }
    },
    presentCall: () => ({ card: 'generic', kind: 'read', title: '插件比对（只读）' }),
  }), 'rimworld-log: rimworld_plugin_compare');

  // ---- workspace snapshots and migration pack -----------------------------
  //
  // Two separate actions, and the separation is the point: a snapshot is taken repeatedly and pruned to
  // the newest few days, while a migration pack is handed to another machine and must therefore carry
  // exactly one snapshot - the newest. Exporting every snapshot would let two machines disagree about
  // which findings are current, which is the failure this design exists to avoid.
  const archiveDescription = [
    '归档工作区的成果快照，并可导出迁移包（按天保留最新三份）。',
    'action=list：列出已有快照（只读，默认）。',
    'action=snapshot：为今天拍一份快照。同一天重复执行只覆盖当天那一份，不会累积；',
    `拍完自动按天保留最新 ${DEFAULT_KEEP_DAYS} 份，更早的删除（今天是当天，永不删）。`,
    'action=export：导出迁移包。**只携带最新那一份快照**，更早的留在快照目录里不随包走。',
    'action=verify：把快照与工作区逐文件对账（清单差异 + 全量哈希核对），并解释被跳过的目录。',
    'action=note：写一份归档记录（标题 + 正文 + 标签）到工作区 归档/ 目录，重建 INDEX.md，并顺手拍快照。',
    '**每完成一件值得记的工作就调一次 note，不要等用户开口要求归档。**',
    '快照收录工作区的全部内容，**不设体积上限**；只跳过 node_modules/bin/obj 这类编译与版本控制',
    '内部目录，且跳过哪些目录会在报告里写明。',
  ].join(' ');
  const archiveParameters = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['list', 'snapshot', 'export', 'verify', 'note'],
        description: '要执行的操作，默认 list。note = 写一份归档记录并顺手拍快照。verify = 快照与工作区逐文件对账。',
      },
      keep: {
        type: 'number',
        description: `action=snapshot：按天保留多少份，默认 ${DEFAULT_KEEP_DAYS}。今天是当天，始终保留。`,
      },
      date: {
        type: 'string',
        description: 'action=verify：核对哪一天的快照（YYYY-MM-DD）；省略取最新一份。',
      },
      outDir: {
        type: 'string',
        description: 'action=export：迁移包输出目录。省略则写到快照目录下的 migration-pack-<时间戳>。不能已存在，也不能位于某份快照内。',
      },
      title: {
        type: 'string',
        description: 'action=note：这条记录的标题，会成为文件名的一部分。',
      },
      body: {
        type: 'string',
        description: 'action=note：记录正文（Markdown）。写清做了什么、为什么、还剩什么。',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'action=note：标签，便于在 INDEX.md 里检索。',
      },
      snapshot: {
        type: 'boolean',
        description: 'action=note：写完记录后是否顺手拍快照，默认 true。',
      },
    },
    additionalProperties: false,
  };
  recordTool({ name: 'rimworld_workspace_archive', description: archiveDescription, parameters: archiveParameters });
  toolsRegistered.push('rimworld_workspace_archive');
  ctx.effect(() => ctx.tools.register({
    name: 'rimworld_workspace_archive',
    description: archiveDescription,
    parameters: archiveParameters,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [
        { type: 'text', text: typeof value?.text === 'string' ? value.text : JSON.stringify(value, null, 2) },
      ],
    },
    async execute(args) {
      const action = String(args?.action ?? 'list').toLowerCase();
      const keep = Number.isFinite(args?.keep) && args.keep > 0 ? Math.floor(args.keep) : DEFAULT_KEEP_DAYS;

      // Refuse to archive a directory that is not there. An empty snapshot reports success, which is the
      // one outcome that would let a missing work area go unnoticed for three days.
      if ((action === 'snapshot') && !workspaceExists()) {
        return {
          text: `工作区不存在或不是目录：\`${workspaceRoot()}\`\n`
            + '用环境变量 `RIMLOG_WORKSPACE_DIR` 指定，或确认该目录存在后重试。'
            + '（不会为不存在的目录生成空快照。）',
        };
      }

      try {
        // Writing a record is the one action that is expected to be called without the user asking
        // for it, so it must never be gated on anything but a real failure to write.
        if (action === 'note') {
          const wrote = writeArchiveNote({
            title: args?.title,
            body: args?.body,
            tags: Array.isArray(args?.tags) ? args.tags.map(String) : [],
          });
          if (!wrote.ok) return { text: `归档记录写入失败：${wrote.error}` };

          const lines = [
            '# 归档记录已写入',
            '',
            `- 文件：\`${wrote.path}\``,
            `- 索引：\`${wrote.index}\`（当前 ${wrote.count} 条）`,
          ];

          if (args?.snapshot !== false && workspaceExists()) {
            const result = takeSnapshot({ keep });
            lines.push('');
            if (result.ok) {
              lines.push(`- 快照：${result.date}，${result.fileCount} 个文件，`
                + `${(result.bytes / 1024).toFixed(1)} KB`
                + `${result.replaced ? '（当天已有，已覆盖）' : '（当天首次）'}`);
              if (result.pruned.removed.length) {
                lines.push(`- 按保留策略删除：${result.pruned.removed.map((r) => r.date).join('、')}`);
              }
            } else {
              lines.push(`- 快照失败：${result.error}（记录本身已写入）`);
            }
          }
          return { text: lines.join('\n') };
        }

        if (action === 'snapshot') {
          const result = takeSnapshot({ keep });
          if (!result.ok) return { text: `快照失败：${result.error}` };

          const lines = [
            `# 工作区快照（${result.date}）`,
            '',
            `- 快照目录：\`${result.path}\``,
            `- 工作区：\`${workspaceRoot()}\``,
            `- 收录 ${result.fileCount} 个文件，${(result.bytes / 1024).toFixed(1)} KB`,
            `- ${result.replaced ? '当天已有一份，已覆盖（同一天不累积）' : '当天首次快照'}`,
          ];
          if (result.missing.length) {
            lines.push(`- ⚠ ${result.missing.length} 项未能收录：${result.missing.slice(0, 8).join('、')}`
              + `${result.missing.length > 8 ? ' …' : ''}`);
          }
          if (result.excludedDirs.length) {
            lines.push(`- 整目录排除：${result.excludedDirs.map((d) => `\`${d}\``).join('、')}`
              + '（编译/版本控制内部目录，可再生成）');
          }
          lines.push('');
          lines.push(`## 保留策略（按天最新 ${keep} 份）`);
          lines.push('');
          if (result.pruned.removed.length) {
            lines.push('已删除：');
            for (const item of result.pruned.removed) {
              const why = item.skipped ? `（跳过：${item.skipped}）`
                : item.error ? `（删除失败：${item.error}）` : '';
              lines.push(`- ${item.date}${why}`);
            }
          } else {
            lines.push('没有需要删除的（未超出保留份数）。');
          }
          lines.push('');
          lines.push(`当前保留：${result.kept.join('、') || '（无）'}`);
          lines.push('');
          lines.push('导出迁移包用 `action=export` —— **只会带上最新那一份**。');
          return { text: lines.join('\n') };
        }

        if (action === 'verify') {
          const result = verifySnapshot({
            date: typeof args?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.date.trim()) ? args.date.trim() : undefined,
          });
          if (!result.ok) return { text: `对账失败：${result.error}` };

          const fmtKB = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;
          const lines = [
            `# 快照对账（${result.date}）`,
            '',
            `- 快照目录：\`${result.snapshotPath}\``,
            `- 工作区：\`${result.workspace.root}\``,
            `- 文件：工作区 ${result.workspace.files} / 快照 ${result.snapshot.files}`,
            `- 体积：工作区 ${fmtKB(result.workspace.bytes)} / 快照 ${fmtKB(result.snapshot.bytes)}`,
            '',
            '## 哈希核对',
            `- 比对 ${result.hashCheck.compared} 个文件，${result.hashCheck.mismatches} 个不同`,
          ];
          if (result.hashCheck.mismatches > 0) {
            for (const f of result.hashCheck.files.slice(0, 10)) lines.push(`  - ${f}`);
            if (result.hashCheck.mismatches > 10) lines.push(`  …（还有 ${result.hashCheck.mismatches - 10} 个）`);
          }

          lines.push('');
          lines.push('## 清单差异');
          if (result.onlyInWorkspace.count === 0 && result.onlyInSnapshot.count === 0) {
            lines.push('- 两边文件清单完全一致');
          } else {
            if (result.onlyInWorkspace.count > 0) {
              lines.push(`- 只在工作区（${result.onlyInWorkspace.count} 个）：`);
              for (const f of result.onlyInWorkspace.files.slice(0, 8)) lines.push(`  - ${f}`);
            }
            if (result.onlyInSnapshot.count > 0) {
              lines.push(`- 只在快照（${result.onlyInSnapshot.count} 个）：`);
              for (const f of result.onlyInSnapshot.files.slice(0, 8)) lines.push(`  - ${f}`);
            }
          }

          if (result.skipped.dirs.length > 0) {
            lines.push('');
            lines.push(`## 策略性跳过的目录（${result.skipped.files} 个文件 / ${fmtKB(result.skipped.bytes)}）`);
            for (const d of result.skipped.dirs) {
              lines.push(`- \`${d.name}\`：${d.files} 个文件，${fmtKB(d.bytes)}`);
            }
          }

          lines.push('');
          lines.push(`**结论：${result.verdict}**`);
          return { text: lines.join('\n') };
        }

        if (action === 'export') {
          const outDir = typeof args?.outDir === 'string' && args.outDir.trim() ? args.outDir.trim() : null;
          const result = exportMigrationPack({ outDir, pluginRoot: PLUGIN_ROOT });
          if (!result.ok) return { text: `导出失败：${result.error}` };

          const lines = [
            '# 迁移包已导出',
            '',
            `- 输出目录：\`${result.path}\``,
            `- **携带的快照：${result.snapshotIncluded}（最新一份）**`,
            `- 快照目录里另有：${result.snapshotsAvailable.join('、')}`,
          ];
          if (result.omitted.length) {
            lines.push(`- **未随包导出**：${result.omitted.join('、')}（按设计只带最新一份）`);
          }
          lines.push(`- 共 ${result.fileCount} 个文件；插件本体：${result.pluginIncluded ? '已包含' : '未包含'}`
            + `；插件状态：${result.stateIncluded ? '已包含' : '未包含'}`);
          if (result.namingHint) {
            lines.push(`- ⚠️ ${result.namingHint}`);
          }
          lines.push('');
          lines.push('包内结构：`workspace-snapshot/`（最新快照）、`plugin/`（插件本体）、'
            + '`plugin-state/`（仅 install-state.json，不含按日志路径命名的游标）、`manifest.json`。');
          lines.push('');
          lines.push('> 按日志路径命名的游标文件**故意不带**：它们记录的是本机的绝对路径，'
            + '带到新机器上会让首次扫描误以为已经读过。');
          return { text: lines.join('\n') };
        }

        const summary = archiveSummary({ keep });
        const lines = [
          '# 工作区快照',
          '',
          `- 快照目录：\`${summary.dir}\``,
          `- 工作区：\`${workspaceRoot()}\``,
          `- 保留策略：按天最新 ${summary.keep} 份`,
          `- 现有 ${summary.count} 份`, '',
        ];
        if (!summary.count) {
          lines.push('（还没有快照。用 `action=snapshot` 拍一份。）');
        } else {
          lines.push('| 日期 | 文件数 | 大小 | 完整 |');
          lines.push('|---|---|---|---|');
          for (const snap of summary.snapshots) {
            lines.push(`| ${snap.date} | ${snap.files} | ${(snap.bytes / 1024).toFixed(1)} KB | `
              + `${snap.complete ? '是' : '⚠ 缺 manifest'} |`);
          }
          lines.push('');
          lines.push(`最新：**${summary.newest}**，最旧：${summary.oldest}`);
        }
        return { text: lines.join('\n') };
      } catch (error) {
        log(`workspace archive failed: ${error?.message ?? error}`);
        return { text: `归档操作失败：${error?.message ?? error}` };
      }
    },
    presentCall: (args) => ({
      card: 'generic',
      kind: 'read',
      title: `工作区归档（${String(args?.action ?? 'list')}）`,
    }),
  }), 'rimworld-log: rimworld_workspace_archive');

  // ---- human command ----------------------------------------------------
  recordCommand({
    name: 'rimlog',
    description: '分析 RimWorld 游戏日志（可选来源/问题），并把结果交给当前会话继续分析',
    input: { hint: '[realtime|realtimePrev|player|playerPrev] [--full] [--since <时间>] [其它要求]' },
  });
  ctx.effect(() => ctx.commands.register({
    definitionId: 'rimworld-log.scan',
    name: 'rimlog',
    description: '分析 RimWorld 游戏日志（可选来源/问题），并把结果交给当前会话继续分析',
    input: { hint: '[realtime|realtimePrev|player|playerPrev] [--full] [--since <时间>] [其它要求]' },
    handler: async (invocation) => {
      const parsed = parseArgs(invocation.rawInput);
      const sources = parsed.sources?.length ? parsed.sources : defaultSources;
      // First press in this session reads the whole log; afterwards the stored cursor is used, so a
      // repeated press stays cheap and still shows anything new since the last one.
      const key = [...sources].sort().join('+');
      const firstThisSession = !fullyScanned.has(key);
      const scan = runScan(getEnv, {
        action: 'analyze',
        sources,
        full: firstThisSession || parsed.full,
        since: parsed.since,
        profileId: defaultProfileId,
      });
      if (!scan.ok) return { kind: 'error', text: scan.error ?? '日志分析失败。' };
      fullyScanned.add(key);
      const scope = firstThisSession ? '本次为**全量**分析（本会话首次）' : '本次为**增量**分析（只含新增日志）';

      const env = getEnv({ profileId: defaultProfileId });
      const content = buildAnalysisPrompt(scan, env, parsed.question);
      // The agent has no way to guess where a patch should go, and the scoped system-prompt
      // context only reaches the next request, so state it in the turn that starts now.
      content.push({
        type: 'text',
        text: `如果需要产出补丁（XPath/兼容 XML、Harmony C#、ModsConfig 调整方案），`
          + `请写到 ${patchRoot()} 下，并在回复里给出文件路径与改动摘要，等我确认后再考虑落地到 mod 目录。`,
      });
      if (env.profile) {
        content.push({
          type: 'text',
          text: '如需启用/禁用 mod 以进一步排查，用 `/rimmods enable <packageId>`（默认只出草稿），'
            + '写入由你自己在 RimCrow 或游戏里完成。'
            + `ModsConfig 位于 ${env.modSummary?.modsConfigPath ?? '(未定位)'}。`,
        });
      }
      const delivery = await submitPrompt(ctx, invocation.agent, content, log);
      if (delivery.delivered) {
        return {
          kind: 'success',
          text: `${commandSummary(scan)} 载荷已交给当前会话继续分析（${delivery.via}）。`,
        };
      }
      // Never lose the analysis: report the outcome even when no turn could be started.
      return {
        kind: 'success',
        text: `${commandSummary(scan)}\n\n` +
          '⚠ 未能自动启动分析回合（本 DSH 版本没有暴露可用的 prompt 通道），' +
          '请直接让我分析下面这份载荷：\n\n' + scan.brief,
      };
    },
  }), 'rimworld-log: /rimlog command');

  // ---- mod list command -------------------------------------------------
  recordCommand({
    name: 'rimmods',
    description: '起草 RimWorld 启用/禁用 mod 的改动清单（不写入；勾选由你自己操作）',
    input: { hint: '[enable <id>...] [disable <id>...]' },
  });
  ctx.effect(() => ctx.commands.register({
    definitionId: 'rimworld-log.mods',
    name: 'rimmods',
    description: '起草 RimWorld 启用/禁用 mod 的改动清单（只出清单，写入由你自己操作）',
    input: { hint: '[enable <id>...] [disable <id>...]' },
    handler: (invocation) => {
      const tokens = String(invocation.rawInput ?? '').trim().split(/\s+/).filter(Boolean);
      const enable = [];
      const disable = [];
      let apply = false;
      let bucket = null;
      for (const token of tokens) {
        const lower = token.toLowerCase();
        if (lower === 'enable' || lower === '启用') { bucket = enable; continue; }
        if (lower === 'disable' || lower === '禁用') { bucket = disable; continue; }
        if (lower === '--apply' || lower === 'apply') { apply = true; continue; }
        if (bucket) bucket.push(token);
      }
      if (enable.length === 0 && disable.length === 0) {
        return {
          kind: 'error',
          text: '用法：/rimmods enable <packageId>... disable <packageId>...\n'
            + '只输出改动清单与 diff，不写入任何文件；勾选请你在 RimCrow 或游戏里做。',
        };
      }
      const result = runModChange(getEnv, { enable, disable, apply, profileId: defaultProfileId });
      if (!result.ok) {
        return { kind: 'error', text: result.error ?? '改动失败。' };
      }
      const header = result.applied
        ? `已写入 ${result.filePath}${result.backupPath ? `（备份 ${result.backupPath}）` : ''}`
          + `${result.verified ? '，回读校验通过' : '，⚠ 回读校验未通过'}`
        : `草稿（未写入）：${result.filePath}`;
      return {
        kind: 'success',
        text: [
          header,
          `启用 ${result.beforeCount} → ${result.afterCount} 项`,
          result.diff,
          result.describe,
          result.note ? `注: ${result.note}` : '',
          result.applied ? '' : '插件不会代你写入；请照上面的清单在 RimCrow 或游戏里勾选。',
        ].filter(Boolean).join('\n'),
      };
    },
  }), 'rimworld-log: /rimmods command');

  // ---- environment context ---------------------------------------------
  ctx.effect(() => ctx.systemPrompt.context({
    name: 'rimworld-log',
    order: 60,
    text: () => {
      let env;
      try {
        env = getEnv({ profileId: defaultProfileId });
      } catch {
        return '';
      }
      if (!env.home && !env.profile) return '';
      const lines = ['## RimWorld / RimCrow 环境（由 rimworld-log 插件探测，只读）'];
      if (env.home) lines.push(`- RimCrow 安装目录: ${env.home}`);
      if (env.profile) {
        lines.push(`- 当前分析的 profile: ${env.profile.name} (\`${env.profile.id}\`)，`
          + `游戏版本 ${env.profile.gameVersion || '未知'}`);
        const present = Object.entries(env.sources ?? {})
          .filter(([, file]) => file?.exists)
          .map(([kind]) => SOURCE_META[kind]?.label ?? kind);
        lines.push(`- 可用游戏日志: ${present.length ? present.join('、') : '无'}`);
      }
      if (env.modSummary) {
        lines.push(`- 启用模组: ${env.modSummary.activeCount} 个，其中 ${env.modSummary.missingCount} 个在磁盘上找不到；`
          + `模组搜索根目录: ${(env.modSummary.searchRoots ?? []).slice(0, 4).join(' | ')}`);
      }
      if (env.companion) {
        lines.push(`- 辅助模组 RimCrow Companion: ${env.companion.present ? '已安装' : '未安装'
          + '（启用后实时日志会带更完整的深度诊断堆栈）'}`);
      }
      lines.push('- 分析游戏日志时优先使用 `rimworld_log_scan` 工具（本地预处理，省 Token），或由用户执行 `/rimlog`。');
      lines.push(`- 生成的补丁文件放在: ${patchRoot()}（可用 DSH_RIMWORLD_PATCH_DIR 改）。`);
      lines.push(`- 工作区快照用 \`rimworld_workspace_archive\`：按天保留最新 3 份，`
        + `导出迁移包时**只带最新那一份**。工作区: ${workspaceRoot()}（可用 RIMLOG_WORKSPACE_DIR 改）。`);
      lines.push('- **插件不代你改 mod 列表**：启用/禁用一律由你自己在 RimCrow 或游戏里勾选。'
        + ' `/rimmods` 只输出一份可直接照做的清单，即使传 apply 也会被拒绝。');
      lines.push('- 写入 mod 目录、编译 DLL 之前必须先向用户确认。');

      // The install / update notice. Empty on a steady-state run, so this costs nothing until the declared
      // version differs from the one last recorded. It is appended here rather than in its own context so
      // that it appears once, attached to the environment block it belongs with.
      const notice = installNoticeText();
      if (notice) {
        lines.push('');
        lines.push(notice);
      }
      return lines.join('\n');
    },
  }), 'rimworld-log: system prompt context');
}
