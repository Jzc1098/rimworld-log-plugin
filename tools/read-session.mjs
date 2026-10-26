/**
 * Read and summarise DSH session transcripts.
 *
 * DSH writes each session as a zstd-compressed JSONL file. Two things about that format are easy to
 * get wrong, and both were:
 *
 *   - The file is multi-frame. `zlib.zstdDecompressSync` stops after the first frame, so a 3 MB
 *     session appears to hold 216 bytes. This decodes frame by frame.
 *   - Record payloads sit under `data`, and the shape of `data` differs per record type. Code that
 *     assumes one layout silently reads nothing. This searches structurally instead.
 *
 * Usage:
 *   node read-session.mjs <file.v4.jsonl.zstd> [options]
 *   node read-session.mjs --survey [--root <sessions-dir>] [--workspace <dir-name>]
 *
 * Options (single-session mode):
 *   --summary            record-type counts and the plugin surfaces that were used (default view)
 *   --turns              human turns and assistant replies, in order
 *   --tools              tool calls by name, then every call in order
 *   --commands           every shell command, with its description
 *   --errors             records containing error / failure markers
 *   --raw <seq>[,<seq>]  dump the raw JSON of specific records
 *   --grep <text>        records containing a substring
 *   --limit <n>          cap rows per section (default 40)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { pathToFileURL } from 'node:url';

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/**
 * Decode every zstd frame in a concatenated stream.
 *
 * The one-shot decompressor has no "read all frames" switch, so the stream is split on the frame
 * magic and each frame is decoded on its own. A frame that will not decode is skipped rather than
 * aborting the read, because a live session can end mid-frame.
 *
 * @param {Buffer} buf - raw file contents.
 * @returns {{ text: string, frames: number }}
 */
export function decompressAll(buf) {
  const starts = [];
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (
      buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1]
      && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]
    ) {
      starts.push(i);
    }
  }
  const parts = [];
  let frames = 0;
  for (let f = 0; f < starts.length; f++) {
    const from = starts[f];
    const to = f + 1 < starts.length ? starts[f + 1] : buf.length;
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(from, to)));
      frames += 1;
    } catch {
      /* skip an undecodable frame */
    }
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames };
}

/** Read a session file into records, in sequence order. */
export function readSession(file) {
  const raw = fs.readFileSync(file);
  const { text, frames } = decompressAll(raw);
  const records = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      malformed += 1; // a live session can end mid-line
    }
  }
  records.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  return { records, frames, bytes: raw.length, unpacked: text.length, malformed };
}

const clip = (value, n) => {
  const s = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return s.length > n ? `${s.slice(0, n)}…[+${s.length - n}]` : s;
};

/** The record's type tag, whatever field it uses. */
const typeOf = (r) => r.type ?? r.kind ?? r.role ?? '?';

/** Text parts of a message-shaped record. */
function messageText(record) {
  const content = record.data?.content ?? record.content;
  if (!Array.isArray(content)) {
    const t = record.data?.text ?? record.text;
    return typeof t === 'string' ? t : '';
  }
  return content
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('\n');
}

/**
 * Find tool calls in a session.
 *
 * The authoritative source is the `tool/call` record, whose `data.callId` is unique per call
 * (repeating the same command still yields distinct ids). A structural search is kept as a fallback
 * for transcripts that use a different shape, but it is only consulted when no `tool/call` records
 * exist at all - walking the tree on a normal transcript also matches the nested copies DSH keeps
 * inside inbox and delivery records, which inflates the count several times over.
 *
 * @param {object[]} records - session records, already in sequence order.
 * @returns {{ name: string, args: unknown, callId?: string, seq?: number }[]}
 */
export function findToolCalls(records) {
  const direct = [];
  const seenIds = new Set();
  for (const r of records) {
    if ((r.type ?? r.kind) !== 'tool/call') continue;
    const d = r.data ?? {};
    if (typeof d.name !== 'string') continue;
    const id = d.callId;
    if (id) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
    }
    direct.push({ name: d.name, args: d.arguments ?? d.args ?? d.input, callId: id, seq: r.seq });
  }
  if (direct.length > 0) return direct;

  const out = [];
  const seen = new Set();
  const walk = (node, depth) => {
    if (depth > 12 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const v of node) walk(v, depth + 1);
      return;
    }
    const name = node.name ?? node.toolName;
    const args = node.arguments ?? node.args ?? node.input;
    // `parameters` marks a tool *definition* rather than a call, so exclude it.
    if (typeof name === 'string' && args !== undefined && node.parameters === undefined) {
      const id = node.callId ?? `${name}:${JSON.stringify(args)}`;
      if (!seen.has(id)) {
        seen.add(id);
        out.push({ name, args, callId: node.callId });
      }
    }
    for (const v of Object.values(node)) walk(v, depth + 1);
  };
  walk(records, 0);
  return out;
}

const PLUGIN_SURFACES = ['rimworld_log_scan', '/rimlog', '/rimmods', 'RimCrow 安装目录'];

// --- single session ------------------------------------------------------

function showSummary(session) {
  const { records, frames, bytes, unpacked, malformed } = session;
  console.log(`packed   : ${bytes.toLocaleString()} bytes`);
  console.log(`frames   : ${frames}`);
  console.log(`unpacked : ${unpacked.toLocaleString()} bytes`);
  console.log(`records  : ${records.length.toLocaleString()}${malformed ? `  (${malformed} malformed lines skipped)` : ''}`);

  const kinds = new Map();
  for (const r of records) kinds.set(typeOf(r), (kinds.get(typeOf(r)) ?? 0) + 1);
  console.log('\n=== record types ===');
  for (const [k, n] of [...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25)) {
    console.log(`  ${String(n).padStart(6)}  ${k}`);
  }

  const calls = findToolCalls(records);
  if (calls.length) {
    const byName = new Map();
    for (const c of calls) byName.set(c.name, (byName.get(c.name) ?? 0) + 1);
    console.log(`\n=== tool calls (${calls.length}) ===`);
    for (const [n, k] of [...byName.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(k).padStart(6)}  ${n}`);
    }
  }

  console.log('\n=== plugin surfaces ===');
  for (const key of PLUGIN_SURFACES) {
    let n = 0;
    for (const r of records) if (JSON.stringify(r).includes(key)) n += 1;
    console.log(`  ${String(n).padStart(6)}  ${key}`);
  }
}

function showTurns(session) {
  for (const r of session.records) {
    const t = typeOf(r);
    if (t !== 'user/message' && t !== 'assistant/message') continue;
    const text = messageText(r);
    if (!text.trim()) continue;
    const who = t === 'user/message' ? 'USER' : 'ASSISTANT';
    console.log(`\n--- [seq ${r.seq}] ${who} ---`);
    console.log(clip(text.replace(/\s+/g, ' '), 500));
  }
}

function showTools(session, limit) {
  const calls = findToolCalls(session.records);
  console.log(`=== ${calls.length} distinct tool calls, in order ===`);
  for (const [i, c] of calls.slice(0, limit).entries()) {
    console.log(`  ${String(i + 1).padStart(3)}. ${c.name.padEnd(24)} ${clip(c.args, 220)}`);
  }
  if (calls.length > limit) console.log(`  … ${calls.length - limit} more (raise --limit)`);
}

function showCommands(session, limit) {
  const calls = findToolCalls(session.records).filter((c) => /pwsh|shell|bash|command/i.test(c.name));
  console.log(`=== ${calls.length} shell commands ===`);
  for (const [i, c] of calls.slice(0, limit).entries()) {
    let args = {};
    if (typeof c.args === 'string') {
      try {
        args = JSON.parse(c.args);
      } catch {
        args = { command: c.args };
      }
    } else if (c.args && typeof c.args === 'object') {
      args = c.args;
    }
    console.log(`\n${String(i + 1).padStart(3)}. ${args.description ?? '(no description)'}`);
    console.log(`     ${String(args.command ?? '').replace(/\s+/g, ' ').slice(0, 240)}`);
  }
  if (calls.length > limit) console.log(`\n… ${calls.length - limit} more (raise --limit)`);
}

const ERROR_MARKERS = [
  'is not lossless JSON', 'FAIL', 'Error:', 'error:', '失败',
  'not found', '未找到', 'permission denied', 'exit code: 1',
];

function showErrors(session, limit) {
  let shown = 0;
  for (const r of session.records) {
    const s = JSON.stringify(r);
    const hits = ERROR_MARKERS.filter((m) => s.includes(m));
    if (hits.length === 0) continue;
    console.log(`\n--- [seq ${r.seq}] ${typeOf(r)}  markers: ${hits.join(', ')} ---`);
    console.log(clip(s, 700));
    if (++shown >= limit) break;
  }
  if (shown === 0) console.log('no error markers found');
}

// --- survey mode ---------------------------------------------------------

function survey(root, workspaceFilter) {
  const workspaces = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => !workspaceFilter || n === workspaceFilter);

  for (const ws of workspaces) {
    console.log(`\n${'='.repeat(90)}\nWORKSPACE  ${ws}\n${'='.repeat(90)}`);
    const wsPath = path.join(root, ws);
    const rows = [];
    for (const name of fs.readdirSync(wsPath, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
      const file = path.join(wsPath, name, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(file)) continue;
      const st = fs.statSync(file);
      let info = { note: 'unreadable' };
      try {
        const session = readSession(file);
        const calls = findToolCalls(session.records);
        const firstUser = session.records
          .filter((r) => typeOf(r) === 'user/message')
          .map(messageText)
          .find((t) => t && !t.startsWith('Current runtime context.'));
        info = {
          records: session.records.length,
          frames: session.frames,
          calls: calls.length,
          scan: calls.filter((c) => c.name === 'rimworld_log_scan').length,
          firstUser,
        };
      } catch {
        /* keep the unreadable note */
      }
      rows.push({ name, mtime: st.mtime, packed: st.size, ...info });
    }
    rows.sort((a, b) => b.mtime - a.mtime);
    for (const r of rows) {
      const when = r.mtime.toISOString().slice(0, 16).replace('T', ' ');
      console.log(`\n  ${r.name.slice(0, 24)}  ${when}  packed ${(r.packed / 1024).toFixed(0)}KB`);
      console.log(`      records=${r.records ?? '?'} frames=${r.frames ?? '?'} toolCalls=${r.calls ?? '?'} logScanCalls=${r.scan ?? '?'}`);
      console.log(`      first human msg: ${clip(r.firstUser ?? '(none)', 110)}`);
    }
  }
}

// --- dispatch ------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);

  if (argv.includes('--survey')) {
    const rootIdx = argv.indexOf('--root');
    const root = rootIdx > -1 ? argv[rootIdx + 1] : path.join(os.homedir(), '.dsh', 'sessions');
    const wsIdx = argv.indexOf('--workspace');
    survey(root, wsIdx > -1 ? argv[wsIdx + 1] : null);
    return;
  }

  const file = argv[0];
  if (!file || file.startsWith('--')) {
    console.error('usage: node read-session.mjs <file.v4.jsonl.zstd> [--summary|--turns|--tools|--commands|--errors|--raw <seqs>|--grep <text>] [--limit n]');
    console.error('       node read-session.mjs --survey [--root <dir>] [--workspace <name>]');
    process.exit(2);
  }

  const limitIdx = argv.indexOf('--limit');
  const limit = limitIdx > -1 ? Number(argv[limitIdx + 1]) : 40;
  const session = readSession(file);
  console.log(`file: ${file}`);

  const rawIdx = argv.indexOf('--raw');
  const grepIdx = argv.indexOf('--grep');

  if (rawIdx > -1) {
    const seqs = String(argv[rawIdx + 1] ?? '').split(',').map(Number).filter(Number.isFinite);
    for (const seq of seqs) {
      const r = session.records.find((x) => x.seq === seq);
      console.log(`\n${'='.repeat(80)}\nseq ${seq}  ${r ? typeOf(r) : 'NOT FOUND'}\n${'='.repeat(80)}`);
      if (r) console.log(clip(JSON.stringify(r, null, 1), 6000));
    }
    return;
  }

  if (grepIdx > -1) {
    const needle = argv[grepIdx + 1] ?? '';
    let n = 0;
    for (const r of session.records) {
      const s = JSON.stringify(r);
      if (!s.includes(needle)) continue;
      console.log(`\n--- [seq ${r.seq}] ${typeOf(r)} ---`);
      console.log(clip(s, 1200));
      if (++n >= limit) break;
    }
    if (n === 0) console.log(`no record contains ${JSON.stringify(needle)}`);
    return;
  }

  if (argv.includes('--turns')) return showTurns(session);
  if (argv.includes('--tools')) return showTools(session, limit);
  if (argv.includes('--commands')) return showCommands(session, limit);
  if (argv.includes('--errors')) return showErrors(session, limit);
  return showSummary(session);
}

// Run the CLI only when invoked directly, so the helpers stay importable.
//
// The comparison goes through pathToFileURL because import.meta.url is percent-encoded while
// process.argv[1] is a plain path - and this workspace's path contains spaces and non-ASCII
// characters, so the two never match by string concatenation.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
