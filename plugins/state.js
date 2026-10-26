/**
 * Read and write the plugin's own install state.
 *
 * Purpose: remembering which version was last seen, and which tools and blocks existed then, so a later
 * start-up can say what changed. A version number alone cannot do that - two installs of the same version
 * can hold different tools if someone edited the copy by hand.
 *
 * Every operation swallows its errors. This module runs during plugin start-up and inside a system-prompt
 * context that is evaluated on every turn; a corrupt or unwritable state file must degrade to "no memory
 * of a previous install", never to a broken plugin or a failed prompt.
 *
 * The file sits beside the existing scan cursors, in ~/.dsh/rimworld-log/, which the install guide already
 * tells users to delete when uninstalling.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCHEMA = 'rimworld-log.install-state';
const SCHEMA_VERSION = 1;

/** Directory for plugin-owned runtime data. Overridable so tests and porting do not touch the real home. */
export function stateDir() {
  const override = process.env.RIMLOG_STATE_DIR;
  if (override) return override;
  return path.join(os.homedir(), '.dsh', 'rimworld-log');
}

export function statePath() {
  return path.join(stateDir(), 'install-state.json');
}

/**
 * Read the state, or an empty object.
 *
 * An unreadable or malformed file is treated as "first run" rather than an error: the only consequence is
 * that the next report describes the whole plugin instead of the delta, which is a harmless outcome.
 */
export function readState() {
  try {
    const file = statePath();
    if (!existsSync(file)) return {};
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return {};
    if (parsed.schema && parsed.schema !== SCHEMA) return {};
    return parsed;
  } catch {
    return {};
  }
}

/** Merge a patch into the state. Returns true when it was written. */
export function writeState(patch) {
  try {
    const current = readState();
    const next = {
      schema: SCHEMA,
      schemaVersion: SCHEMA_VERSION,
      ...current,
      ...patch,
    };
    const dir = stateDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(statePath(), JSON.stringify(next, null, 2) + '\n', 'utf8');
    return true;
  } catch {
    return false;
  }
}

/** True when this looks like a first run, i.e. nothing has been recorded yet. */
export function isFirstRun() {
  const state = readState();
  return !state.version;
}

export { SCHEMA as STATE_SCHEMA, SCHEMA_VERSION as STATE_SCHEMA_VERSION };
