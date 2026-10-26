/**
 * RimWorld game-log reading and compacting.
 *
 * Two source formats are supported:
 *  - RimCrow realtime log (`RimCrow_Realtime.log`): one JSON object per line with
 *    {timestamp, level, message, details, count, context{relatedModIds,relatedFiles,inferredType}}.
 *    Lines are deduplicated by the writer, so `count` is authoritative.
 *  - RimWorld `Player.log` / `Player-prev.log`: plain text; entries start with a
 *    `[HH:MM:SS]` stamp and stack-trace lines follow their entry.
 *
 * Everything here is read-only. Nothing in the game or RimCrow installation is written.
 *
 * @module rimworld-log/parse
 */

import fs from 'node:fs';

import { parsePlayerLog } from './playerlog.js';

/** File names of the supported sources, in the order a report prefers them. */
export const SOURCE_KINDS = ['realtime', 'player', 'playerPrev'];

/** Human-facing description of each source, including the cost/benefit note the user asked for. */
export const SOURCE_META = {
  realtime: {
    id: 'realtime',
    fileName: 'RimCrow_Realtime.log',
    label: 'RimCrow 实时日志',
    cost: '低',
    strength: '最强',
    note: '结构化 JSON：每条带 level/完整堆栈/count 去重/关联 mod 与文件。信息密度最高、Token 花费最低，首选。',
  },
  player: {
    id: 'player',
    fileName: 'Player.log',
    label: 'RimWorld 原生日志',
    cost: '高',
    strength: '兼容',
    note: '纯文本：无结构化字段、重复堆栈无法去重，同样信息的 Token 花费约为实时日志的 2–5 倍；但未启用 RimCrow 辅助模组时它是唯一来源，可用于交叉验证。',
  },
  playerPrev: {
    id: 'playerPrev',
    fileName: 'Player-prev.log',
    label: 'RimWorld 上一次运行的日志',
    cost: '高',
    strength: '回溯',
    note: '与 Player.log 同格式，记录上一次会话；用于对比“这次新增了什么”。',
  },
  // RimCrow keeps only the current and previous realtime log. The previous one is the only
  // structured record of the last session, which is what makes "what changed since last launch"
  // answerable without hand-parsing the file.
  realtimePrev: {
    id: 'realtimePrev',
    fileName: 'RimCrow_Realtime-prev.log',
    label: 'RimCrow 上一轮实时日志',
    cost: '低',
    strength: '回溯',
    note: '与实时日志同格式（结构化 JSON、带完整堆栈），内容是上一次启动：用于对比“这次新增了什么”。',
  },
};

const LEVEL_ORDER = { CRITICAL: 0, FATAL: 0, ERROR: 1, WARNING: 2, WARN: 2, INFO: 3, DEBUG: 4, TRACE: 5 };

/** Severity rank; lower is more severe. Unknown levels sort last. */
export function levelRank(level) {
  const key = String(level || '').toUpperCase();
  return Object.hasOwn(LEVEL_ORDER, key) ? LEVEL_ORDER[key] : 9;
}

/** True when the level should be treated as a problem worth reporting. */
export function isProblemLevel(level) {
  return levelRank(level) <= 2;
}

/**
 * Stack frames that only describe the *capture* of a log record rather than its cause.
 * RimCrow Companion installs a Unity log callback, so every entry carries 2–3 frames that
 * say nothing about the actual failure while making every entry look unique.
 */
const CAPTURE_FRAME = /(?:RimCrowCompanion|Application\.CallLogCallback|OnUnityLogMessage)/;

/**
 * Normalize a mod name for cross-referencing, returning every useful spelling.
 *
 * A mod can appear under three names that do not reduce to one key: the author's build folder
 * (`GraphicsSetter`), the shipped assembly (`GraphicSetter.dll`), and the package id
 * (`Telefonmast.GraphicsSettings`). Lowercasing is not enough on its own — `GraphicsSetter`
 * keeps a doubled `s` that `GraphicSetter` does not have — so a `tight` form that collapses
 * doubled letters is included for matching against assembly file names.
 *
 * @param value - any of those spellings.
 * @returns `{ loose, lean, tight }`.
 */
export function modKeys(value) {
  const text = String(value ?? '').toLowerCase();
  const lean = text.replace(/[^a-z]/g, '');
  return {
    loose: text.replace(/[^a-z0-9]/g, ''),
    lean,
    // Query-side fallback only. Collapsing every doubled letter is lossy — it turns
    // `settings` into `setings` — so this form is never used to key an index, only tried last
    // when looking a name up, where an extra attempt costs nothing and rescues the
    // `GraphicsSetter` / `GraphicSetter` spelling pair.
    tight: lean.replace(/([a-z])\1+/g, '$1'),
  };
}

/**
 * Normalize a mod name to the letters-only form, with doubled letters collapsed.
 * @param value - any spelling.
 * @returns the comparable key.
 */
export function normalizeModKey(value) {
  return modKeys(value).tight;
}

/**
 * Drop capture-only frames, keeping the frames that identify the real cause.
 * @param frames - frames from {@link extractFrames}.
 * @returns frames worth hashing and reporting.
 */
export function stripCaptureFrames(frames) {
  const kept = (frames ?? []).filter((frame) => !CAPTURE_FRAME.test(frame.method || ''));
  return kept.length > 0 ? kept : (frames ?? []);
}

/**
 * Normalize a message so structurally identical entries collapse to one fingerprint.
 * Volatile parts (numbers, ids, ticks, timings, absolute paths) are replaced, and so are the
 * varying identifiers that RimWorld puts in the *kind* position of an otherwise identical
 * complaint — for example one error per ammunition def, which differs only by def name.
 * @param text - raw message text.
 * @returns the normalized form used for hashing.
 */
export function normalizeText(text) {
  return String(text ?? '')
    .replace(/\r/g, '')
    .replace(/0x[0-9a-f]+/gi, '<hex>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<guid>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<id>')
    .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
    .replace(/\(\s*\d+(?:\.\d+)?\s*x\s*\d+(?:\.\d+)?\s*\)/g, '(<w>x<h>)')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|ticks?|tps|fps|MB|KB|GB)\b/gi, '<n>')
    // A def/thing identifier: snake_case, dotted, or a dotted package id inside brackets.
    .replace(/\b[A-Za-z][A-Za-z0-9]*(?:_[A-Za-z0-9]+){1,}\b/g, '<def>')
    .replace(/\b[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+){1,}\b/g, '<id>')
    .replace(/\b\d+(?:\.\d+)?\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Pick file paths out of a message so a cluster can still be attributed to a mod when the
 * stack trace names only engine frames.
 * @param message - raw message text.
 * @returns candidate absolute paths.
 */
export function messagePaths(message) {
  return [...String(message ?? '').matchAll(/[A-Za-z]:\\[^\s"'()<>]+/g)].map((m) => m[0]);
}

/**
 * Recover a mod name from a build-time source path inside a stack frame.
 *
 * When a mod is compiled without a portable PDB, its frames carry the *author's* build path
 * (for example `C:\Program Files (x86)\Steam\steamapps\common\RimWorld\Mods\GraphicsSetter\Source\...`
 * or `C:\Users\<author>\CodeLibrary\rimworld-dev\...`). That directory does not exist locally,
 * so prefix matching can never attribute the frame; the name inside the path is the only usable
 * signal and is reported as inferred rather than confirmed.
 *
 * @param file - the frame's file path.
 * @returns `{ name, via }` or undefined.
 */
export function modNameFromFramePath(file) {
  const path = String(file ?? '');
  if (!path) return undefined;

  // The Workshop / Mods layout is the reliable one: `...\Mods\<folder>\...`.
  let match = /[\\/]Mods[\\/]([^\\/]+)[\\/]/i.exec(path);
  if (match) {
    const name = match[1].replace(/^_?Link_\d+_?/i, '').trim();
    if (name && !/^\d+$/.test(name)) return { name, via: 'Mods/<name>/' };
  }

  // A hand-built development tree: `...\<checkout>\<ModName>\Source\...`. The folder *before*
  // `Source` is the mod, not the checkout — `CodeLibrary\rimworld-dev\GhostMod\Source\X.cs`
  // names GhostMod, and taking the first folder after the drive would name the checkout instead.
  match = /[\\/](?:CodeLibrary|Rimworld_MOD-Devfile|rimworld-dev)[\\/](.+)[\\/]Source[\\/]/i.exec(path);
  if (match) {
    const segments = match[1].split(/[\\/]/).filter(Boolean);
    const name = segments[segments.length - 1];
    if (name) return { name, via: '作者开发目录' };
  }
  match = /[\\/](?:CodeLibrary|Rimworld_MOD-Devfile|rimworld-dev)[\\/]([^\\/]+)/i.exec(path);
  if (match) return { name: match[1].trim(), via: '作者开发目录' };
  return undefined;
}

/**
 * Build the stable identity of one problem cluster from the normalized message and
 * the deepest application frames of its stack trace.
 * @param normalizedMessage - output of {@link normalizeText}.
 * @param frames - extracted stack frames (most specific first).
 * @returns the fingerprint string.
 */
export function fingerprint(normalizedMessage, frames) {
  const appFrames = stripCaptureFrames(frames)
    .filter((f) => !/^(?:UnityEngine|System|MonoMod|Mono\.|Microsoft\.)/.test(f.method || ''))
    // Harmony wrappers that just forward to Verse.Log describe the plumbing, not the cause.
    .filter((f) => !/(?:DynamicMethodDefinition\.)?Verse\.Log\.(?:Error|Warning|Message)_Patch/.test(f.method || ''))
    .slice(0, 4)
    .map((f) => `${f.method}@${f.file || ''}:${f.line || ''}`);
  return `${normalizedMessage}||${appFrames.join('|')}`;
}

/**
 * Extract stack frames from a .NET stack trace.
 * @param details - raw stack-trace text.
 * @returns frames ordered as they appear (most specific first).
 */
export function extractFrames(details) {
  const frames = [];
  for (const raw of String(details ?? '').split('\n')) {
    const line = raw.trim();
    if (!line.startsWith('at ')) continue;
    const body = line.slice(3);
    const loc = /\[0x[0-9a-f]+\]\s+in\s+(.+?):(\d+)/i.exec(body);
    const method = body.split(/\s+\[0x/)[0].split(' in ')[0].trim();
    frames.push({
      method,
      file: loc ? loc[1] : undefined,
      line: loc ? Number(loc[2]) : undefined,
    });
  }
  return frames;
}

/**
 * Resolve which mod a stack frame belongs to, using a mod-root table.
 * The most specific (longest) matching root wins, so a mod nested inside another
 * mod's folder is attributed to the nested one.
 * @param frames - frames from {@link extractFrames}.
 * @param modRoots - [{ root, packageId, name }] of every known active mod directory.
 * @returns the matched mod identity, or undefined.
 */
export function attributeToMod(frames, modRoots) {
  if (!Array.isArray(modRoots) || modRoots.length === 0) return undefined;
  const normalized = modRoots
    .filter((mod) => mod && typeof mod.root === 'string')
    .map((mod) => ({ ...mod, key: mod.root.replace(/[\\/]+$/, '').toLowerCase() }))
    .sort((a, b) => b.key.length - a.key.length);
  for (const frame of frames) {
    if (!frame.file) continue;
    const file = frame.file.toLowerCase();
    for (const mod of normalized) {
      if (file === mod.key || file.startsWith(`${mod.key}\\`) || file.startsWith(`${mod.key}/`)) return mod;
    }
  }
  return undefined;
}

/**
 * Parse one RimCrow realtime JSON line.
 * @param line - raw line.
 * @returns the entry, or undefined when the line is not a usable JSON record.
 */
export function parseRealtimeLine(line) {
  const text = line.replace(/^\uFEFF/, '').trim();
  if (!text.startsWith('{')) return undefined;
  let obj;
  try {
    obj = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (obj === null || typeof obj !== 'object') return undefined;
  const context = obj.context && typeof obj.context === 'object' ? obj.context : {};
  const details = typeof obj.details === 'string' ? obj.details : '';
  return {
    time: typeof obj.timestamp === 'string' ? obj.timestamp : '',
    level: String(obj.level || 'INFO').toUpperCase(),
    message: String(obj.message ?? ''),
    details,
    count: Number.isFinite(obj.count) && obj.count > 0 ? obj.count : 1,
    relatedModIds: Array.isArray(context.relatedModIds) ? context.relatedModIds.filter(Boolean) : [],
    relatedFiles: Array.isArray(context.relatedFiles) ? context.relatedFiles.filter(Boolean) : [],
    inferredType: typeof context.inferredType === 'string' ? context.inferredType : '',
    frames: extractFrames(details),
    format: 'realtime',
  };
}

/**
 * Read a file as UTF-8, returning undefined instead of throwing when unreadable.
 * @param filePath - absolute path.
 * @returns the text, or undefined.
 */
export function readTextIfReadable(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * Read a whole log file into entries, dispatching on the file's own shape so a
 * renamed or relocated file still parses correctly.
 * @param filePath - absolute path to the log.
 * @returns {{ entries: object[], bytes: number, format: string }|undefined}
 */
export function readLogEntries(filePath) {
  const text = readTextIfReadable(filePath);
  if (text === undefined) return undefined;
  const sample = text.slice(0, 4096).replace(/^\uFEFF/, '').trimStart();
  const isJson = sample.startsWith('{');
  const entries = isJson
    ? text.split('\n').map(parseRealtimeLine).filter(Boolean)
    : parsePlayerLog(text);
  return { entries, bytes: Buffer.byteLength(text, 'utf8'), format: isJson ? 'realtime' : 'player' };
}

export { parsePlayerLog };

/**
 * Attribute a cluster to a mod using a ranked ladder of evidence.
 *
 * 1. `high` — a frame (or message) path lies inside a mod directory that exists on this machine.
 * 2. `high` — RimCrow itself tagged the record with `relatedModIds`; that is the mod author's own hint.
 * 3. `medium` — a frame path names a mod folder in the active mod list whose build path is not local.
 * 4. `medium` — the message names a mod directly, as Combat Extended and What's That Mod do.
 * 5. `low` — a mod name was recovered from the path but is not in the active list.
 *
 * @param cluster - a cluster from {@link clusterProblems} (needs `frames`, `files`, `modIds`).
 * @param modRoots - `[{ root, packageId, name }]` for installed mod directories.
 * @param activeMods - `[{ packageId, name, installed, dir }]` for the active load order.
 * @returns `{ name, packageId, dir, confidence, evidence }` or undefined.
 */
export function resolveMod(cluster, modRoots, activeMods, indexes = {}) {
  const active = Array.isArray(activeMods) ? activeMods : [];
  const byAssembly = indexes.byAssembly ?? new Map();
  const byFolder = indexes.byFolder ?? new Map();

  /**
   * Normalize a name for cross-referencing across three different spellings of the same mod:
   * the author's build folder (`GraphicsSetter`), the shipped assembly (`GraphicSetter.dll`)
   * and the package id (`Telefonmast.GraphicsSettings`). See {@link normalizeModKey}.
   */
  const norm = normalizeModKey;

  /**
   * Turn a disk-table hit into a result, reconciled with the active load order.
   *
   * `enabled` is what separates a real attribution from a stray-mod warning: the mod can be
   * sitting on disk while its packageId is absent from ModsConfig.xml.
   */
  const describe = (hit, evidence) => {
    const known = hit.packageId
      ? active.find((mod) => norm(mod.packageId) === norm(hit.packageId))
      : undefined;
    return {
      name: known?.name ?? hit.name,
      packageId: hit.packageId,
      dir: hit.dir,
      confidence: 'medium',
      evidence,
      enabled: Boolean(known),
    };
  };

  /**
   * Resolve a mod-name spelling against the active load order, strongest match first.
   *
   * The tiers exist because plain bidirectional substring matching produces confident nonsense. A
   * stack frame in `RigorMortis.PawnRenderNodeWorker_Patch` yields the namespace token `RigorMortis`,
   * and a patch mod named `Fix - Rigor Mortis null pawn` contains that token, so the fix mod was
   * reported as the source of unrelated warnings while the real mod — whose own namespace it is —
   * was never shown.
   *
   * So containment is split in two:
   *   - boundary containment, where the token lines up with a word start (`RigorMortis` inside
   *     `rigormortis.nullpawn` or `Rigor Mortis`) — this is how the real mod is found;
   *   - bare containment, where the token is a fragment of a longer word (`RigorMortis` inside
   *     `fixrigormortisnullpawn`) — this is a guess and is used only when nothing better exists,
   *     preferring the shortest containing name, which is the one whose identity the token actually is.
   *
   * @param needle - a namespace token, mod title, folder name or package id.
   * @returns the matching active mod, or undefined.
   */
  const findActive = (needle) => {
    const key = String(needle ?? '').toLowerCase().replace(/[\s_-]+/g, '');
    if (!key) return undefined;
    const shapes = (mod) => {
      const folder = String(mod.dir ?? '').split(/[\\/]/).pop() ?? '';
      return [mod.name, folder, mod.packageId].map((v) => String(v ?? ''));
    };
    /**
     * True when `key` lines up with whole words in `value` rather than being a fragment of one.
     *
     * The subtlety that made an earlier version wrong: the token is already separator-stripped
     * (`RigorMortis` -> `rigormortis`) while the value still has its separators, so comparing the
     * token against individual split words fails for multi-word names. `MoeLotl: Rigor Mortis` splits
     * to `moelotl: rigor mortis`, and neither part equals `rigormortis`.
     *
     * So normalize separators to single spaces on both sides, collapse the token the same way, and
     * then require a match that begins at a word boundary. `rigor mortis` then matches inside
     * `moelotl rigor mortis`, while `fix rimcrow fix rigormortis nullpawn` correctly does not, because
     * there the token is glued to `fix`.
     */
    const atBoundary = (value, k) => {
      const spaced = String(value).toLowerCase().replace(/[\s_\-.]+/g, ' ').trim();
      const flatNeedle = spaced.replace(/ /g, '');
      if (flatNeedle === k) return true;
      if (!flatNeedle.includes(k)) return false;
      // Walk word starts and test whether the flattened remainder starts with the token.
      let index = 0;
      for (const word of spaced.split(' ')) {
        if (flatNeedle.slice(index).startsWith(k)) return true;
        index += word.length;
      }
      return false;
    };
    const tier = (mod, kind) => {
      const values = shapes(mod);
      if (kind === 'exact') return values.some((v) => v.toLowerCase().replace(/[\s_-]+/g, '') === key);
      if (kind === 'boundary') return values.some((v) => atBoundary(v, key));
      return values.some((v) => v.toLowerCase().replace(/[\s_-]+/g, '').includes(key));
    };
    for (const kind of ['exact', 'boundary']) {
      const hit = active.find((mod) => tier(mod, kind));
      if (hit) return hit;
    }
    // Last resort: the shortest name containing the token is the one the token names.
    let best;
    let bestLength = Infinity;
    for (const mod of active) {
      if (!tier(mod, 'contains')) continue;
      const length = String(mod.name ?? '').length;
      if (length < bestLength) {
        best = mod;
        bestLength = length;
      }
    }
    return best;
  };
  /**
   * Match a namespace token against a mod's identity on segment boundaries only.
   *
   * Loose containment is wrong here: `gameloading` occurs inside the id `taranchuk.fastergameloading`,
   * which would otherwise claim any `…GameLoading…` namespace even when the frame belongs to a
   * different mod entirely.
   *
   * The token is matched against the package id, the title and the folder, because the namespace a
   * frame lives in does not always appear in the package id. `RigorMortis.PawnRenderNodeWorker_Patch`
   * comes from a mod titled `MoeLotl: Rigor Mortis` whose package id is `fxz.moelotlzombie.update`,
   * so a package-id-only search found nothing and fell through to whichever patch mod happened to
   * carry the word in its own id — reporting the fix as the culprit.
   *
   * @param pool - mods to search.
   * @param token - the namespace token.
   * @returns the strongest matching mod, or undefined.
   */
  const findByNamespaceToken = (pool, token) => {
    const key = String(token ?? '').toLowerCase();
    if (key.length < 4) return undefined;
    const segments = (value) => String(value ?? '').toLowerCase().split(/[._\-/\s]+/).filter(Boolean);
    const wordStart = (value) => {
      const spaced = String(value ?? '').toLowerCase().replace(/[\s_\-.]+/g, ' ').trim();
      const flat = spaced.replace(/ /g, '');
      if (flat === key) return true;
      if (!flat.includes(key)) return false;
      let index = 0;
      for (const word of spaced.split(' ')) {
        if (flat.slice(index).startsWith(key)) return true;
        index += word.length;
      }
      return false;
    };
    // A word-start match in the title or the folder comes first: the namespace belongs to the mod
    // whose name it is. The shortest title wins, because a patch mod named after the mod it patches
    // would otherwise outrank that mod. Concretely, `RigorMortis.*` frames belong to
    // `MoeLotl: Rigor Mortis`, while a patch mod's id `rimcrow.fix.rigormortis.nullpawn` also contains
    // the word as a package-id segment and used to be found first.
    const named = pool
      .filter((mod) => wordStart(mod.name) || wordStart(String(mod.dir ?? '').split(/[\\/]/).pop()))
      .sort((a, b) => String(a.name ?? '').length - String(b.name ?? '').length);
    if (named.length) return named[0];
    // Then a whole package-id segment. This is the only signal for mods whose title is unrelated to
    // their namespace, such as `taranchuk.fastergameloading`.
    return pool.find((mod) => segments(mod.packageId).includes(key));
  };

  const byDir = attributeToMod(cluster.frames, modRoots)
    ?? attributeToMod([...cluster.files].map((file) => ({ file })), modRoots);
  if (byDir) {
    return {
      name: byDir.name,
      packageId: byDir.packageId,
      dir: byDir.root,
      confidence: 'high',
      evidence: `堆栈路径位于 ${byDir.root}`,
    };
  }

  // RimCrow's own tagging: the writer already knows which mod the record came from.
  for (const id of cluster.modIds ?? []) {
    const match = findActive(id);
    if (match) {
      return {
        name: match.name,
        packageId: match.packageId,
        dir: match.dir,
        confidence: 'high',
        evidence: `日志记录自带 relatedModIds 标记: ${id}`,
      };
    }
  }

  const candidates = [];
  // Order matters: the most specific evidence is tried first, and namespace-only guesses are
  // deliberately last. A stack trace names every mod it passed *through*, so a downstream frame
  // (`FasterGameLoading.EarlyModContentLoader.Update`) would otherwise outrank the mod whose own
  // code raised the error (`GraphicSetter.Patches.TextureLoadingPatch`).
  for (const frame of cluster.frames) {
    const hit = modNameFromFramePath(frame.file);
    if (hit) candidates.push({ ...hit, file: frame.file, strength: 'path' });
  }
  for (const sample of cluster.samples ?? []) {
    const hit = /from mod ([^:：]{2,80}?)\s*[:：]/.exec(sample);
    if (hit) candidates.push({ name: hit[1].trim(), via: '消息内 “from mod …”', strength: 'message' });
  }
  for (const named of cluster.namedMods ?? []) {
    candidates.push({ name: named, via: '消息内 “from mod …”', strength: 'message' });
  }
  for (const frame of cluster.frames) {
    const hit = /^([A-Z][A-Za-z0-9_]{2,40})\./.exec(frame.method ?? '');
    if (hit && !/^(?:Verse|RimWorld|UnityEngine|System|MonoMod|HarmonyLib|Mono)$/.test(hit[1])) {
      candidates.push({ name: hit[1], via: '堆栈方法的命名空间', strength: 'namespace' });
    }
  }
  if (candidates.length === 0) return undefined;

  // Disk-first resolution. A stack path names the author's *build* folder, which frequently
  // differs from the mod's title — the folder `GraphicsSetter` belongs to the mod
  // `Graphics Settings+` / `Telefonmast.GraphicsSettings`. So resolve against what is actually
  // installed, in order of how specific the identification is:
  //   1. the assembly the mod ships (`GraphicSetter.dll`)
  //   2. the mod's folder name (a workshop id like `1678847247`)
  //   3. a fuzzy name match against the active list
  for (const candidate of candidates.filter((c) => c.strength === 'path')) {
    // The build folder named by the path, plus the `Mods\<folder>` segment of every frame — the
    // latter covers workshop-id folders, which carry no relationship to the mod's name.
    const spellings = new Set([candidate.name]);
    for (const frame of cluster.frames) {
      const parts = String(frame.file ?? '').split(/[\\/]/).filter(Boolean);
      const modsAt = parts.findIndex((p) => p.toLowerCase() === 'mods');
      if (modsAt >= 0 && parts[modsAt + 1]) spellings.add(parts[modsAt + 1]);
    }
    for (const spelling of spellings) {
      const { loose, lean, tight } = modKeys(spelling);
      for (const key of [loose, lean, tight]) {
        if (!key) continue;
        const byAssemblyHit = byAssembly.get(key);
        if (byAssemblyHit) {
          return describe(byAssemblyHit, `堆栈程序集与磁盘上的 ${byAssemblyHit.dir} 一致（程序集名 ${spelling}）`);
        }
        const byFolderHit = byFolder.get(key);
        if (byFolderHit) {
          return describe(byFolderHit, `堆栈路径中的目录名 ${spelling} 对应磁盘上的 ${byFolderHit.dir}`);
        }
      }
    }
  }

  const unresolvedPaths = candidates.filter((c) => c.strength === 'path');
  // Resolve the strongest evidence class that yields a match at all.
  for (const strength of ['path', 'message', 'namespace']) {
    for (const candidate of candidates.filter((c) => c.strength === strength)) {
      const match = strength === 'namespace'
        ? findByNamespaceToken(active, candidate.name)
        : findActive(candidate.name);
      if (match) {
        const namespaces = [...new Set(candidates
          .filter((c) => c.strength === 'namespace' && c.name !== candidate.name)
          .map((c) => c.name))].slice(0, 3);
        return {
          name: match.name,
          packageId: match.packageId,
          dir: match.dir,
          confidence: 'medium',
          evidence: `线索来自${candidate.via}指向 ${candidate.name}，已与启用列表匹配`,
          enabled: true,
          note: namespaces.length > 0
            ? `堆栈还经过 ${namespaces.join('、')} 的代码；若上一条路径线索指向未启用的 mod，优先查它`
            : undefined,
        };
      }
    }
  }

  // Nothing resolved. A path candidate is the strongest remaining clue, and a mod named by a
  // stack path but absent from the active list is itself the finding worth reporting.
  const first = unresolvedPaths[0] ?? candidates[0];
  return {
    name: first.name,
    packageId: '',
    dir: undefined,
    confidence: 'low',
    enabled: false,
    evidence: `线索来自${first.via}指向 ${first.name}，但该 mod 不在当前启用列表中`
      + '（可能已被移除或禁用，或它装在未被扫描的目录下）',
  };
}

/**
 * Fold parsed entries into ranked problem clusters.
 * @param entries - parsed entries.
 * @param modRoots - mod root table for attribution.
 * @param activeMods - active load order, used for the medium-confidence tier.
 * @returns clusters ordered by severity then occurrence count.
 */
export function clusterProblems(entries, modRoots, activeMods, indexes = {}) {
  const byKey = new Map();
  for (const entry of entries) {
    if (!isProblemLevel(entry.level)) continue;
    const normalized = normalizeText(entry.message);
    const frames = stripCaptureFrames(entry.frames);
    const key = fingerprint(normalized, entry.frames);
    let cluster = byKey.get(key);
    if (!cluster) {
      cluster = {
        key,
        normalized,
        level: entry.level,
        occurrences: 0,
        firstTime: entry.time,
        lastTime: entry.time,
        samples: [],
        modIds: new Set(),
        files: new Set(),
        namedMods: new Set(),
        frames: frames.slice(0, 12),
        inferredTypes: new Set(),
        mod: undefined,
      };
      byKey.set(key, cluster);
    }
    cluster.occurrences += entry.count;
    cluster.lastTime = entry.time;
    if (levelRank(entry.level) < levelRank(cluster.level)) cluster.level = entry.level;
    for (const id of entry.relatedModIds) cluster.modIds.add(id);
    for (const f of entry.relatedFiles) cluster.files.add(f);
    for (const p of messagePaths(entry.message)) cluster.files.add(p);
    if (entry.inferredType) cluster.inferredTypes.add(entry.inferredType);
    for (const hit of String(entry.message ?? '').matchAll(/from mod ([^:：\n]{2,80}?)\s*[:：]/g)) {
      cluster.namedMods.add(hit[1].trim());
    }
    if (cluster.samples.length < 3 && !cluster.samples.includes(entry.message)) {
      cluster.samples.push(entry.message);
    }
  }
  const clusters = [...byKey.values()];
  const byAssembly = indexes.byAssembly ?? new Map();
  const byFolder = indexes.byFolder ?? new Map();
  for (const cluster of clusters) {
    cluster.mod = resolveMod(cluster, modRoots, activeMods, indexes);
    // Mods named by a stack path but with no installed counterpart anywhere on disk. On real
    // data this is how a genuinely removed-but-still-patched mod shows up, so it is worth
    // reporting — but a mod that *is* installed must not be flagged just because its build
    // folder name differs from its packageId (the GraphicsSetter / Graphics Settings+ case).
    const strays = new Set();
    for (const frame of cluster.frames) {
      const hit = modNameFromFramePath(frame.file);
      if (!hit) continue;
      const { loose, lean, tight } = modKeys(hit.name);
      if (!loose && !lean && !tight) continue;
      if (byAssembly.has(loose) || byAssembly.has(lean) || byAssembly.has(tight)) continue;
      if (byFolder.has(loose) || byFolder.has(lean) || byFolder.has(tight)) continue;
      strays.add(hit.name);
    }
    cluster.strayMods = [...strays];
  }
  clusters.sort((a, b) => levelRank(a.level) - levelRank(b.level) || b.occurrences - a.occurrences);
  return clusters;
}

/**
 * Parse the custom command line: `[source ...] [--full] [--since <iso>] [question]`.
 * @param rawInput - text typed after the command name.
 * @returns normalized options. Sources default to the realtime log when omitted.
 */
export function parseArgs(rawInput) {
  const tokens = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean);
  const sources = [];
  let full = false;
  let since;
  const question = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    const lower = token.toLowerCase();
    if (lower === '--full') {
      full = true;
    } else if (lower === '--since' && tokens[i + 1]) {
      since = tokens[i + 1];
      i += 1;
    } else if (lower === 'game' || lower === 'realtime' || lower === 'rimcrow') {
      if (!sources.includes('realtime')) sources.push('realtime');
    } else if (lower === 'player' || lower === 'native') {
      if (!sources.includes('player')) sources.push('player');
    } else if (lower === 'prev' || lower === 'playerprev') {
      if (!sources.includes('playerPrev')) sources.push('playerPrev');
    } else {
      question.push(token);
    }
  }
  return {
    sources: sources.length > 0 ? sources : ['realtime'],
    full,
    since,
    question: question.join(' ').trim(),
  };
}
