/**
 * Read the facts about this plugin: the tool and command surface, the block registry, the file lists.
 *
 * The tool and command inventories are collected by index.js as it registers each one, rather than being
 * written out by hand. That matters because a hand-written usage guide drifts: this project already
 * shipped a manifest claiming 55 files when the directory held 83. Every description and parameter blurb
 * this module reports is the same string the model is shown, so the guide cannot disagree with the tools.
 *
 * The collectors are no-ops when nothing has registered, so the module is safe to import from a test or a
 * CLI tool that never loads index.js.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_ROOT = path.resolve(here, '..');

/** Registration order, which is the order the guide lists things in. */
const tools = [];
const commands = [];

/** Called by index.js immediately before each tools.register. */
export function recordTool(info) {
  if (!info?.name) return;
  const index = tools.findIndex((t) => t.name === info.name);
  const entry = {
    name: info.name,
    description: info.description ?? '',
    parameters: info.parameters ?? null,
  };
  if (index >= 0) tools[index] = entry;
  else tools.push(entry);
}

/** Called by index.js immediately before each commands.register. */
export function recordCommand(info) {
  if (!info?.name) return;
  const index = commands.findIndex((c) => c.name === info.name);
  const entry = {
    name: info.name,
    description: info.description ?? '',
    input: info.input ?? null,
  };
  if (index >= 0) commands[index] = entry;
  else commands.push(entry);
}

export function listTools() {
  return tools.map((t) => ({ ...t }));
}

export function listCommands() {
  return commands.map((c) => ({ ...c }));
}

export function toolNames() {
  return tools.map((t) => t.name);
}

/** Cleared between tests. Not used at runtime. */
export function resetRegistry() {
  tools.length = 0;
  commands.length = 0;
}

// ---------------------------------------------------------------- files and versions

/**
 * The version declared in package.json.
 *
 * Recorded for context only. Nothing in this plugin decides anything from it - not which copy is newer,
 * not what to import, not what changed. Two installs can share a version and differ, and a version can be
 * bumped without a change.
 */
export function pluginVersion() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : null;
  } catch {
    return null;
  }
}

export function pluginName() {
  try {
    const pkg = JSON.parse(readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'));
    return typeof pkg.name === 'string' ? pkg.name : null;
  } catch {
    return null;
  }
}

/**
 * Load blocks.json, or null.
 *
 * A missing registry is not an error. It means the copy predates the registry, so block-level
 * attribution is simply unavailable and the caller should say so rather than invent it.
 */
export function readBlocksRegistry() {
  try {
    const file = path.join(PLUGIN_ROOT, 'blocks.json');
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed?.schema !== 'rimworld-log.blocks') return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Summary of the registry: counts, authors, and whether anything carries a name at all. */
export function blockSummary() {
  const registry = readBlocksRegistry();
  if (!registry) {
    return { present: false, total: 0, byKind: {}, authors: {}, named: 0, baseline: 0 };
  }
  const byKind = {};
  let named = 0;
  let baseline = 0;
  for (const block of registry.blocks ?? []) {
    const kind = block.kind ?? 'unknown';
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    if (block.author) named++;
    if (block.baseline) baseline++;
  }
  const authors = {};
  for (const [id, entry] of Object.entries(registry.authors ?? {})) {
    authors[id] = {
      display: entry.display ?? id,
      blocks: (registry.blocks ?? []).filter((b) => b.author === id || b.modifiedBy === id).length,
      firstSeen: entry.firstSeen ?? null,
    };
  }
  return {
    present: true,
    total: (registry.blocks ?? []).length,
    byKind,
    authors,
    named,
    baseline,
    pluginVersion: registry.pluginVersion ?? null,
  };
}

/** Files under tools/, relative to the plugin root. */
export function listToolScripts() {
  try {
    return readdirSync(path.join(PLUGIN_ROOT, 'tools'), { withFileTypes: true })
      .filter((e) => e.isFile())
      .map((e) => 'tools/' + e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Markdown documents at the plugin root, in a stable order. */
export function listDocs() {
  try {
    return readdirSync(PLUGIN_ROOT, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.toLowerCase().endsWith('.md'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/** Subdirectories that ship with the plugin, for the guide's file-section. */
export function listTopLevelDirs() {
  try {
    return readdirSync(PLUGIN_ROOT, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}
