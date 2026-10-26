/**
 * RimWorld plain-text log parser (`Player.log` / `Player-prev.log`).
 *
 * The real format is not the timestamped one:
 *
 *     Mono path[0] = '...'                        <- Unity engine bootstrap noise
 *     Initialize engine version: 2022.3.35f1      <- noise
 *     Command line arguments: -savedatafolder=... <- noise
 *     RimWorld 1.6.4850 rev646                    <- game starts here
 *     Mod 1321849735 is missing packageId in About.xml! (example: ...)
 *     [09:15:22] Some timestamped message         <- timestamped lines use [H:MM:SS] or [HH:MM:SS]
 *     Exception in UIRootUpdate: System.NullReferenceException: ...
 *       at Verse.UIRoot.UIRootUpdate () [0x00000] in <hash>:0   <- indented continuation
 *
 * @module rimworld-log/playerlog
 */

import { extractFrames } from './parse.js';

/** `[H:MM:SS]` or `[HH:MM:SS]`, optionally with milliseconds. */
const TIMESTAMP = /^\[(\d{1,2}:\d{2}:\d{2}(?:\.\d+)?)\]\s?(.*)$/;

/** The line that marks where RimWorld itself starts logging. */
const GAME_START = /^RimWorld \d+\.\d+/;

/** An exception header, with or without a preceding timestamp. */
const EXCEPTION_HEAD = /^(?:Exception(?:\s+in\s+[^:]+)?|System\.\w*Exception|UnityException|\w+Exception)\b/;

/**
 * @typedef {object} PlayerLogEntry
 * @property {string} time - timestamp when present, else empty (the source has none in that region).
 * @property {string} level - ERROR for exception/detail-carrying records, INFO for plain messages.
 * @property {string} message - the entry's message, excluding indented frames.
 * @property {string} details - the full text of indented continuation lines.
 * @property {number} count - always 1; the plain format carries no dedup counter.
 * @property {string[]} relatedModIds - always empty.
 * @property {string[]} relatedFiles - always empty.
 * @property {string} inferredType - the exception type when one is recognisable.
 * @property {object[]} frames - frames extracted from `details`.
 * @property {'player'} format
 */

/**
 * Signals that a plain-text line really reports a failure. The plain format carries no severity
 * labels, so this drives classification together with {@link BENIGN}.
 */
const ERROR_SIGNAL = new RegExp([
  '\\b[A-Za-z_][A-Za-z0-9_.]*(?:Exception|Error)\\b',
  '\\bException\\b',
  '\\bFailed to\\b',
  '\\bCould not\\b',
  '\\bCannot \\b',
  '\\bUnable to\\b',
  '\\bNullReference\\b',
  '\\bIndexOutOfRange\\b',
  '\\bArgumentOutOfRange\\b',
  '\\bObject reference not set\\b',
  '\\bFatal\\b',
  '\\bcrash(?:ed)?\\b',
].join('|'), 'i');

/**
 * Benign forms that mention failure vocabulary without being failures. RimWorld itself logs
 * `Mod <id> is missing packageId in About.xml!` for every such mod, and Unity prints memory
 * statistics on shutdown; reporting either as an error buries the real ones.
 */
const BENIGN = new RegExp([
  'is missing (?:supported versions list|packageId)',
  'PreCached',
  '^\\s*Peak ',
  'Dual Thread Allocator',
  'Allocation',
  'Unused Serialized files',
  'Could not load (?:file|assembly) at path.*(?:No such file|not found)',
].join('|'), 'i');

/** Classify one plain-text entry as ERROR / WARNING / INFO. */
function classify(message, details) {
  const text = `${message}\n${details}`;
  // A benign marker anywhere in the entry (its own stack trace included) vetoes the error signal.
  if (BENIGN.test(text)) return 'INFO';
  if (ERROR_SIGNAL.test(text)) return 'ERROR';
  if (/\b(?:Warning|WARN|deprecated|unsupported)\b/i.test(text)) return 'WARNING';
  return 'INFO';
}

/**
 * Engine/shutdown chatter that the keyword pass above misreads as a problem. These lines are
 * routine Unity and Mono teardown output, and reporting them as errors would bury the real ones.
 */
const NOISE = new RegExp([
  '^Unloading \\d+ (?:Unused Serialized files|unused Assets)',
  '^\\[ALLOC_',
  '^Setting up \\d+ worker threads',
  '^Total: [\\d.]+ ms',
  '^\\s*\\(Filename:',
  '^Begin MonoManager ReloadAssembly',
  '^- Loaded All Assemblies',
  '^- Finished resetting the current domain',
  '^UnloadTime:',
  '^GfxDevice:',
  '^Direct3D:',
  '^\\s*(?:Version|Renderer|Vendor|VRAM|Driver):',
  '^\\[Subsystems\\]',
  '^\\[PhysX\\]',
  '^<RI>',
  '^(?:Mono path|Mono config path|Initialize engine version|Command line arguments)',
  '^RimWorld \\d+\\.\\d+',
  '^Save data folder overridden',
  '^Crash!!!',
  '^Fallback handler could not load library',
  '^\\s*at (?:UnityEngine|System|Mono\\.)',
].join('|'), 'i');

/** True when a line is engine chatter rather than game or mod output. */
export function isEngineNoise(line) {
  return NOISE.test(String(line ?? '').trim());
}

/** Recognise the exception type, e.g. `System.NullReferenceException`. */
function exceptionType(text) {
  const match = /\b((?:[A-Z]\w*\.)*[A-Z]\w*(?:Exception|Error))\b/.exec(text);
  return match ? match[1] : '';
}

/** True for an indented continuation line (frames, inner-exception banners, `[0x...]` traces). */
function isContinuation(line) {
  if (/^\s{2,}\S/.test(line)) return true;
  if (/^\s+at\s/.test(line)) return true;
  if (/^\s*---\s*End of (?:inner )?exception/.test(line)) return true;
  return false;
}

/**
 * Parse a RimWorld plain-text log into entries.
 *
 * Unity engine preamble lines (before `RimWorld <version>`) are dropped: they describe the
 * engine, not the game, and on real files they are the bulk of the first screen of text.
 *
 * @param text - the whole file content.
 * @param options - `{ dropPreamble }` defaults to true.
 * @returns entries in file order.
 */
export function parsePlayerLog(text, options = {}) {
  const dropPreamble = options.dropPreamble !== false;
  const lines = String(text ?? '').replace(/^\uFEFF/, '').split('\n');
  const entries = [];
  let started = !dropPreamble;
  let current = null;

  const push = () => {
    if (!current) return;
    current.message = current.message.replace(/\s+$/, '');
    current.details = current.details.replace(/\s+$/, '');
    current.frames = extractFrames(current.details);
    current.inferredType = exceptionType(`${current.message}\n${current.details}`);
    current.level = classify(current.message, current.details);
    if (current.message || current.details) entries.push(current);
    current = null;
  };

  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (!started) {
      if (GAME_START.test(line)) started = true;
      else continue;
    }
    if (line.trim() === '') {
      // A blank line ends an entry only when nothing more is being collected.
      if (current && current.details) push();
      continue;
    }
    // Engine chatter is skipped in place; it neither opens nor extends an entry.
    if (isEngineNoise(line)) {
      if (current && (current.details || current.frames.length > 0)) push();
      continue;
    }
    const stamped = TIMESTAMP.exec(line);
    if (stamped) {
      push();
      current = {
        time: stamped[1],
        level: 'INFO',
        message: stamped[2],
        details: '',
        count: 1,
        relatedModIds: [],
        relatedFiles: [],
        inferredType: '',
        frames: [],
        format: 'player',
      };
      continue;
    }
    if (!current) {
      current = {
        time: '',
        level: 'INFO',
        message: line,
        details: '',
        count: 1,
        relatedModIds: [],
        relatedFiles: [],
        inferredType: '',
        frames: [],
        format: 'player',
      };
      // An exception header starts its own entry even without a timestamp.
      if (EXCEPTION_HEAD.test(line)) current.message = line;
      continue;
    }
    if (isContinuation(line)) {
      current.details += `${line}\n`;
      continue;
    }
    // A fresh unindented line while an entry is open: a new exception header starts a new entry,
    // anything else is a continuation of the same message (multi-line warnings are common).
    if (EXCEPTION_HEAD.test(line)) {
      push();
      current = {
        time: '',
        level: 'ERROR',
        message: line,
        details: '',
        count: 1,
        relatedModIds: [],
        relatedFiles: [],
        inferredType: '',
        frames: [],
        format: 'player',
      };
      continue;
    }
    if (current.details) {
      push();
      current = {
        time: '',
        level: 'INFO',
        message: line,
        details: '',
        count: 1,
        relatedModIds: [],
        relatedFiles: [],
        inferredType: '',
        frames: [],
        format: 'player',
      };
      continue;
    }
    current.message += `\n${line}`;
  }
  push();
  return entries;
}
