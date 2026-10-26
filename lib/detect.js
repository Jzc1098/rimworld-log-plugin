/**
 * Locate the RimCrow installation, its profiles, the active mod list and the game logs.
 *
 * Portability is the point of this module: nothing is hard-coded to one machine.
 * Every path is derived, in order, from
 *   1. explicit caller overrides,
 *   2. RimCrow's own `data/config.json`,
 *   3. each profile's `profile.json` (which carries `game_install_path` / `user_data_path`),
 *   4. conventional fallbacks (Steam library, `%USERPROFILE%\AppData\LocalLow\Ludeon Studios`).
 *
 * Reads only. The RimCrow installation is never modified.
 *
 * @module rimworld-log/detect
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { normalizeModKey } from './parse.js';

/** Absolute path candidates for a RimCrow home directory. */
export function candidateRimCrowHomes(overrides = []) {
  const list = [];
  // Highest priority: an explicit override, from a caller or from the environment. A wrong
  // guess must not be silently replaced by a conventional path, so these are tried alone first.
  const envHome = process.env.RIMCROW_HOME;
  if (envHome) list.push(envHome);
  for (const override of overrides) list.push(override);
  for (const drive of ['C', 'D', 'E', 'F', 'G']) {
    list.push(`${drive}:\\RimWorld\\RimCrow`);
  }
  const seen = new Set();
  return list.filter((p) => {
    const key = path.resolve(p).toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** True when the directory contains RimCrow's marker file. */
function looksLikeRimCrow(dir) {
  try {
    return fs.existsSync(path.join(dir, 'RimCrow.exe')) || fs.existsSync(path.join(dir, 'data', 'config.json'));
  } catch {
    return false;
  }
}

/**
 * Find the RimCrow home directory.
 * An explicit override (`options.rimcrowHome`, then `RIMCROW_HOME`) is authoritative: when it is
 * given but does not look like a RimCrow installation, discovery stops there and reports nothing
 * rather than quietly analysing a different installation than the caller asked for.
 * @param overrides - explicit candidate directories.
 * @returns the resolved directory, or undefined when none is found.
 */
export function findRimCrowHome(overrides = []) {
  const explicit = [...(process.env.RIMCROW_HOME ? [process.env.RIMCROW_HOME] : []), ...overrides];
  if (explicit.length > 0) {
    for (const candidate of explicit) {
      if (looksLikeRimCrow(candidate)) return path.resolve(candidate);
    }
    return undefined;
  }
  for (const candidate of candidateRimCrowHomes([])) {
    if (looksLikeRimCrow(candidate)) return path.resolve(candidate);
  }
  return undefined;
}

/** Read and parse a JSON file, returning undefined on any failure. */
export function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return undefined;
  }
}

/** Read RimCrow's `data/config.json`. */
export function readRimCrowConfig(home) {
  if (!home) return undefined;
  return readJson(path.join(home, 'data', 'config.json'));
}

/**
 * Conventional RimWorld user-data root (holds Player.log).
 * @returns the directory, or undefined when it does not exist.
 */
export function defaultUserDataRoot() {
  const root = path.join(os.homedir(), 'AppData', 'LocalLow', 'Ludeon Studios', 'RimWorld by Ludeon Studios');
  try {
    return fs.existsSync(root) ? root : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Enumerate RimCrow profiles.
 * @param home - RimCrow home directory.
 * @returns profile records ordered with the configured current profile first.
 */
export function listProfiles(home) {
  const config = readRimCrowConfig(home);
  const profilesDir = path.join(home, 'data', 'profiles');
  let names = [];
  try {
    names = fs.readdirSync(profilesDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
  const profiles = [];
  for (const name of names) {
    const dir = path.join(profilesDir, name);
    const meta = readJson(path.join(dir, 'profile.json')) ?? {};
    profiles.push({
      id: name,
      name: typeof meta.name === 'string' && meta.name ? meta.name : name,
      gameVersion: meta.game_version ?? '',
      gameInstallPath: meta.game_install_path ?? '',
      userDataPath: meta.user_data_path ?? dir,
      dir,
      realtimeLog: path.join(dir, 'RimCrow_Realtime.log'),
      realtimeLogPrev: path.join(dir, 'RimCrow_Realtime-prev.log'),
      modsConfig: path.join(dir, 'Config', 'ModsConfig.xml'),
      playerLog: path.join(dir, 'Player.log'),
      playerLogPrev: path.join(dir, 'Player-prev.log'),
    });
  }
  const current = config?.current_profile_id;
  profiles.sort((a, b) => {
    if (a.id === current) return -1;
    if (b.id === current) return 1;
    return a.name.localeCompare(b.name);
  });
  return profiles.map((p) => ({ ...p, isCurrent: p.id === current }));
}

/**
 * Pick the profile to analyse: an explicit id, else the profile whose realtime log is
 * newest, else RimCrow's current profile.
 * @param profiles - output of {@link listProfiles}.
 * @param wantedId - optional exact profile id.
 * @returns the chosen profile, or undefined.
 */
export function pickProfile(profiles, wantedId) {
  if (profiles.length === 0) return undefined;
  if (wantedId) {
    const exact = profiles.find((p) => p.id === wantedId || p.name === wantedId);
    if (exact) return exact;
  }
  let best;
  let bestMtime = -1;
  for (const profile of profiles) {
    for (const file of [profile.realtimeLog, profile.playerLog]) {
      try {
        const mtime = fs.statSync(file).mtimeMs;
        if (mtime > bestMtime) {
          bestMtime = mtime;
          best = profile;
        }
      } catch {
        /* missing file is not a candidate */
      }
    }
  }
  return best ?? profiles[0];
}

/**
 * Resolve the log file behind a source kind.
 * @param profile - a profile record.
 * @param kind - one of the SOURCE_KINDS ids.
 * @returns {{ path: string, exists: boolean, bytes: number, mtime: number }|undefined}
 */
export function resolveSource(profile, kind) {
  const table = {
    realtime: profile.realtimeLog,
    realtimePrev: profile.realtimeLogPrev,
    player: profile.playerLog,
    playerPrev: profile.playerLogPrev,
  };
  const candidate = table[kind];
  if (!candidate) return undefined;
  try {
    const stat = fs.statSync(candidate);
    return { path: candidate, exists: true, bytes: stat.size, mtime: stat.mtimeMs };
  } catch {
    return { path: candidate, exists: false, bytes: 0, mtime: 0 };
  }
}

/** Extract `<li>...</li>` values from a ModsConfig.xml fragment. */
function readModsConfigIds(filePath) {
  try {
    const xml = fs.readFileSync(filePath, 'utf8');
    const active = /<activeMods>([\s\S]*?)<\/activeMods>/i.exec(xml);
    const known = /<knownExpansions>([\s\S]*?)<\/knownExpansions>/i.exec(xml);
    const ids = (block) => (block ? [...block[1].matchAll(/<li>([^<]+)<\/li>/gi)].map((m) => m[1].trim()) : []);
    const version = /<gameVersion>([^<]*)<\/gameVersion>/i.exec(xml);
    return { activeMods: ids(active), knownExpansions: ids(known), gameVersion: version ? version[1] : '' };
  } catch {
    return { activeMods: [], knownExpansions: [], gameVersion: '' };
  }
}

/**
 * Read one mod's About.xml identity.
 *
 * Only the *root* `<packageId>`/`<name>` counts. Before matching, every block that repeats
 * those names for other mods is removed: a `<modDependencies>` entry is written as
 * `<li><packageId>brrainz.harmony</packageId></li>`, so a naive scan makes large numbers of
 * unrelated mods claim a dependency's id (observed on real data).
 */
function readAbout(modDir) {
  for (const rel of [path.join('About', 'About.xml'), path.join('About', 'about.xml')]) {
    let xml;
    try {
      xml = fs.readFileSync(path.join(modDir, rel), 'utf8').replace(/^\uFEFF/, '');
    } catch {
      continue;
    }
    const stripped = xml.replace(
      /<(modDependencies|loadAfter|loadBefore|incompatibleWith|modDependenciesByVersion|forceLoadAfter|forceLoadBefore)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
      '',
    );
    const fields = new Map();
    for (const match of stripped.matchAll(/<(packageId|name|modVersion)\b[^>]*>([^<]*)<\/\1\s*>/gi)) {
      const value = match[2].trim();
      if (!value || value.includes('<')) continue;
      const key = match[1].toLowerCase();
      if (!fields.has(key)) fields.set(key, value);
    }
    const versions = /<supportedVersions\b[^>]*>([\s\S]*?)<\/supportedVersions>/i.exec(xml);
    return {
      name: fields.get('name') || path.basename(modDir),
      packageId: fields.get('packageid') || '',
      // modVersion 供 mods-changed 做前后比对；很多 mod 不写它，undefined 是正常值。
      modVersion: fields.get('modversion'),
      supportedVersions: versions
        ? [...versions[1].matchAll(/<li>([^<]*)<\/li>/gi)].map((m) => m[1].trim()).slice(0, 12)
        : [],
    };
  }
  return undefined;
}

/**
 * Rank an install path so the *deployed* copy of a mod wins over a staging or link copy.
 * RimCrow keeps `.workshop-stage` snapshots and `_Link_*` junctions next to real mods; a
 * stack trace always names the deployed path, so attribution must resolve to that one.
 * @param dir - absolute mod directory.
 * @returns a score; lower is preferred.
 */
function installPathScore(dir) {
  let score = 0;
  if (/[\\/]_?[Ll]ink_\d+[\\/]/.test(dir) || /[\\/]_?[Ll]ink_\d+$/.test(dir)) score += 100;
  if (/[\\/]\.workshop-stage[\\/]/i.test(dir)) score += 1000;
  if (/(^|[\\/])\./.test(dir)) score += 2000;
  return score;
}

/**
 * Assemblies that belong to the engine, Unity or the toolchain rather than to a content mod.
 * A stack frame naming one of these says nothing about which mod is responsible.
 */
const ENGINE_ASSEMBLIES = new Set([
  'assembly-csharp', 'assembly-csharp-firstpass', 'rimworld', 'unityengine', 'unityengine.coremodule',
  'mscorlib', 'netstandard', 'system', 'system.core', 'system.xml', 'system.runtime',
  '0harmony', 'harmony', 'mono.cecil', 'monomod', 'mono.mod', 'newtonsoft.json', 'jetbrains.annotations',
]);

/**
 * Collect the assembly file names a mod ships.
 *
 * This is the bridge that makes attribution reliable: a stack trace compiled without a portable
 * PDB carries the *author's* source path, whose folder name is often the assembly name rather
 * than the mod's title. Real case: the folder in the path is `GraphicsSetter`, while the mod is
 * `Graphics Settings+` with packageId `Telefonmast.GraphicsSettings` — no name-based match works,
 * but `GraphicSetter.dll` on disk identifies it exactly.
 *
 * @param modDir - the mod directory.
 * @returns normalized assembly keys (see `normalizeModKey` in `parse.js`).
 */
function scanModAssemblies(modDir) {
  const names = new Set();
  const candidates = ['Assemblies', 'AssemblyDump'];
  let versionDirs = [];
  try {
    versionDirs = fs.readdirSync(modDir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && /^\d+\.\d+$/.test(d.name))
      .map((d) => d.name);
  } catch {
    versionDirs = [];
  }
  for (const folder of [...candidates, ...versionDirs.map((v) => path.join(v, 'Assemblies'))]) {
    let files = [];
    try {
      files = fs.readdirSync(path.join(modDir, folder), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const file of files) {
      if (!file.isFile()) continue;
      const match = /^(.+)\.dll$/i.exec(file.name);
      if (!match) continue;
      const key = normalizeModKey(match[1]);
      if (key.length < 3 || ENGINE_ASSEMBLIES.has(key)) continue;
      names.add(key);
    }
  }
  return [...names];
}

/**
 * Build the id -> directory table for every mod the profile can load.
 * A mod directory is recognised by having an `About` folder. When several copies of the same
 * package id exist (staging snapshots, link folders, coexisting trees), the deployed copy wins.
 * @param profile - a profile record.
 * @param config - RimCrow's config.json (supplies the mod search roots).
 * @returns {{ roots: string[], byPackageId: Map<string, object>, entries: object[], duplicates: object[] }}
 */
export function scanModFolders(profile, config, options = {}) {
  const roots = [];
  const push = (value) => {
    if (typeof value !== 'string' || value === '') return;
    const resolved = path.resolve(value);
    if (!roots.some((existing) => existing.toLowerCase() === resolved.toLowerCase())) roots.push(resolved);
  };
  push(config?.workshop_mods_path);
  push(config?.self_mods_path);
  push(config?.steamcmd_mods_path);
  push(profile.gameInstallPath ? path.join(profile.gameInstallPath, 'Mods') : undefined);
  // The base game and every official expansion live in `<install>\Data\<Name>`, not in `Mods`.
  push(profile.gameInstallPath ? path.join(profile.gameInstallPath, 'Data') : undefined);
  push(config?.steam_path ? path.join(config.steam_path, 'steamapps', 'workshop', 'content', '294100') : undefined);
  // RimCrow's own tool mods (the RimCrow Companion that produces the detailed realtime log).
  //
  // Accepted from the caller and also derived here. Without the derivation, every call site that
  // forgets the option reports the Companion as missing on disk, which is a misleading answer rather
  // than a helpful one. RimCrow keeps toolmods beside its own mods directory, so self_mods_path is
  // the handle: `<RimCrow>\mods` -> `<RimCrow>\toolmods`.
  const toolRoots = [...(options.toolModRoots ?? [])];
  if (typeof config?.self_mods_path === 'string' && config.self_mods_path !== '') {
    toolRoots.push(path.join(config.self_mods_path, '..', 'toolmods'));
  }
  for (const candidate of toolRoots) push(candidate);

  const entries = [];
  for (const root of roots) {
    let children = [];
    try {
      children = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const child of children) {
      // Hidden directories such as RimCrow's own `.workshop-stage` hold snapshots, not deployments.
      if (child.name.startsWith('.')) continue;
      const dir = path.join(root, child.name);
      // `<install>\Data` holds both `<Dlc>\About` and plain data folders, so accept either depth.
      const depths = path.basename(root).toLowerCase() === 'data'
        ? [path.join(dir, 'About'), path.join(dir, 'Mods', 'About')]
        : [path.join(dir, 'About')];
      let aboutDir;
      for (const candidate of depths) {
        try {
          if (fs.existsSync(candidate)) {
            aboutDir = candidate;
            break;
          }
        } catch {
          /* next candidate */
        }
      }
      if (!aboutDir) continue;
      const about = readAbout(path.dirname(aboutDir));
      entries.push({
        dir: path.dirname(aboutDir),
        folderName: child.name,
        root,
        name: about?.name ?? child.name,
        packageId: about?.packageId ?? '',
        modVersion: about?.modVersion,
        supportedVersions: about?.supportedVersions ?? [],
        assemblies: scanModAssemblies(path.dirname(aboutDir)),
        score: installPathScore(dir),
      });
    }
  }
  const byPackageId = new Map();
  const shadowed = [];
  const duplicates = [];

  // A mod's own source tree can contain a nested `About` folder, and a link folder can sit
  // inside another mod. Only the outermost `About` of each tree is a real mod identity, so
  // resolve top-down and drop anything already covered by an accepted mod directory.
  const byDepth = [...entries].sort((a, b) => {
    const da = a.dir.split(/[\\/]/).length;
    const db = b.dir.split(/[\\/]/).length;
    return da - db || a.dir.localeCompare(b.dir);
  });
  const accepted = [];
  for (const record of byDepth) {
    const parent = accepted.find((dir) => {
      const lower = dir.toLowerCase();
      const self = record.dir.toLowerCase();
      return self.startsWith(`${lower}\\`) || self.startsWith(`${lower}/`);
    });
    if (parent) {
      shadowed.push({ dir: record.dir, packageId: record.packageId, name: record.name, inside: parent });
      continue;
    }
    accepted.push(record.dir);
    if (!record.packageId) continue;
    const key = record.packageId.toLowerCase();
    const current = byPackageId.get(key);
    if (!current) {
      byPackageId.set(key, record);
      continue;
    }
    const winner = record.score < current.score ? record : current;
    const loser = winner === record ? current : record;
    byPackageId.set(key, winner);
    duplicates.push({ packageId: record.packageId, kept: winner.dir, skipped: loser.dir });
  }
  const acceptedDirs = new Set(accepted.map((dir) => dir.toLowerCase()));
  const deployed = entries.filter((record) => acceptedDirs.has(record.dir.toLowerCase()));
  return { roots, byPackageId, entries: deployed, shadowed, duplicates };
}

/**
 * Classify one active package id: base game, official expansion, RimCrow tool mod, or a real mod.
 * These are not "missing" when no mod directory declares them, because they are shipped by the
 * game or by RimCrow rather than installed into a Mods folder.
 *
 * @param packageId - the id from ModsConfig.xml.
 * @param knownExpansions - ids from the `<knownExpansions>` block, when present.
 * @returns one of `builtin` | `expansion` | `toolmod` | `mod`.
 */
export function classifyPackageId(packageId, knownExpansions = []) {
  const id = String(packageId ?? '').toLowerCase();
  if (id === 'ludeon.rimworld') return 'builtin';
  if (id.startsWith('ludeon.rimworld.')) return 'expansion';
  if (id === 'rimcrow.companion' || id.startsWith('rimcrow.')) return 'toolmod';
  if (knownExpansions.some((expansion) => String(expansion).toLowerCase() === id)) return 'expansion';
  return 'mod';
}

/**
 * Describe the active mod list of a profile.
 * @param profile - a profile record.
 * @param config - RimCrow's config.json.
 * @param options - `{ toolModRoots }` extra roots to search.
 * @returns the active mods joined with their directories.
 */
export function activeModList(profile, config, options = {}) {
  const modsConfigPath = fs.existsSync(profile.modsConfig)
    ? profile.modsConfig
    : path.join(profile.userDataPath, 'Config', 'ModsConfig.xml');
  const parsed = readModsConfigIds(modsConfigPath);
  const table = scanModFolders(profile, config, options);
  const active = parsed.activeMods.map((packageId) => {
    const found = table.byPackageId.get(packageId.toLowerCase());
    const kind = classifyPackageId(packageId, parsed.knownExpansions);
    return {
      packageId,
      kind,
      installed: Boolean(found),
      name: found?.name ?? packageId,
      dir: found?.dir,
      supportedVersions: found?.supportedVersions ?? [],
      onDisk: Boolean(found && !found.supportedVersions.every((v) => /^1\.[45]$/.test(v))),
    };
  });
  const realMods = active.filter((m) => m.kind === 'mod');
  // Assembly name -> mod table. Built from the deployed copies only, so a stack frame naming an
  // assembly resolves to the one mod that actually ships it.
  const byAssembly = new Map();
  for (const entry of table.entries) {
    for (const assembly of entry.assemblies ?? []) {
      if (!byAssembly.has(assembly)) {
        byAssembly.set(assembly, { dir: entry.dir, packageId: entry.packageId, name: entry.name });
      }
    }
  }
  // Folder name -> mod, so a stack path like `...\Mods\1678847247\Source\...` resolves too.
  // Keyed both ways: a workshop id needs its digits, a named folder needs them stripped.
  const byFolder = new Map();
  for (const entry of table.entries) {
    const hit = { dir: entry.dir, packageId: entry.packageId, name: entry.name };
    for (const key of [entry.folderName.toLowerCase(), normalizeModKey(entry.folderName)]) {
      if (key && !byFolder.has(key)) byFolder.set(key, hit);
    }
  }
  return {
    modsConfigPath,
    gameVersion: parsed.gameVersion,
    knownExpansions: parsed.knownExpansions,
    active,
    activeCount: active.length,
    realModCount: realMods.length,
    missingCount: realMods.filter((m) => !m.installed).length,
    missing: realMods.filter((m) => !m.installed).map((m) => m.packageId),
    builtinCount: active.filter((m) => m.kind !== 'mod').length,
    onDiskCount: table.entries.length,
    shadowedCount: table.shadowed.length,
    duplicateCount: table.duplicates.length,
    assemblyCount: byAssembly.size,
    searchRoots: table.roots,
    byAssembly,
    byFolder,
    modRoots: table.entries.map((e) => ({
      root: e.dir,
      packageId: e.packageId,
      name: e.name,
      folderName: e.folderName,
      version: e.modVersion,
      assemblies: e.assemblies ?? [],
    })),
  };
}

/**
 * Detect the RimCrow Companion tool mod that makes the realtime log more detailed.
 * @param config - RimCrow's config.json.
 * @param home - RimCrow home directory.
 * @returns its state and install directory.
 */
export function companionState(config, home) {
  const dir = path.join(config?.self_mods_path ?? path.join(home ?? '', 'mods'), '..', 'toolmods', 'RimCrowCompanion');
  const candidates = [
    path.join(home ?? '', 'toolmods', 'RimCrowCompanion'),
    path.resolve(dir),
  ];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(path.join(candidate, 'About', 'About.xml'))) {
        const about = readAbout(candidate);
        return { present: true, dir: candidate, name: about?.name ?? 'RimCrow Companion', packageId: about?.packageId ?? '' };
      }
    } catch {
      /* next candidate */
    }
  }
  return { present: false, dir: candidates[0] };
}

/**
 * Whole-environment snapshot used by every entry point.
 * @param options - `{ rimcrowHome?, profileId? }`.
 * @returns the environment, its diagnostics and the resolved sources.
 */
export function detectEnvironment(options = {}) {
  const home = findRimCrowHome(options.rimcrowHome ? [options.rimcrowHome] : []);
  const notes = [];
  const config = readRimCrowConfig(home);
  if (!home) notes.push('未找到 RimCrow 安装目录；可用 rimcrowHome 或环境变量 RIMCROW_HOME 指定。');
  if (home && !config) notes.push(`未读到 ${path.join(home, 'data', 'config.json')}，模组搜索路径将退化为约定路径。`);
  const profiles = home ? listProfiles(home) : [];
  const profile = pickProfile(profiles, options.profileId);
  if (home && !profile) notes.push('未找到任何 RimCrow profile（data\\profiles 下没有 profile.json）。');
  const userDataRoot = profile?.userDataPath ?? defaultUserDataRoot();
  const describe = (filePath) => {
    if (!filePath) return undefined;
    try {
      const stat = fs.statSync(filePath);
      return { path: filePath, exists: true, bytes: stat.size, mtime: stat.mtimeMs };
    } catch {
      return { path: filePath, exists: false, bytes: 0, mtime: 0 };
    }
  };
  const sources = profile
    ? {
        realtime: resolveSource(profile, 'realtime'),
        realtimePrev: resolveSource(profile, 'realtimePrev'),
        player: resolveSource(profile, 'player'),
        playerPrev: resolveSource(profile, 'playerPrev'),
      }
    : {};
  // Without a RimCrow profile (plain RimWorld, or RimCrow not found) the vanilla log is still
  // the whole story, so expose it from the conventional user-data root instead of nothing.
  if (!sources.player && userDataRoot) {
    sources.player = describe(path.join(userDataRoot, 'Player.log'));
    sources.playerPrev = describe(path.join(userDataRoot, 'Player-prev.log'));
  }
  const playerFallback = userDataRoot ? path.join(userDataRoot, 'Player.log') : undefined;
  if (sources.player && !sources.player.exists && playerFallback && sources.player.path !== playerFallback) {
    const fallback = describe(playerFallback);
    if (fallback.exists) sources.player = { ...fallback, fallback: true };
  }
  return {
    home,
    config,
    profiles,
    profile,
    userDataRoot,
    sources,
    companion: companionState(config, home),
    notes,
  };
}
