/**
 * Split a source file into named blocks, for block-level comparison and provenance.
 *
 * Why blocks instead of lines: two people's copies of the same plugin drift in whitespace, ordering and
 * formatting, so a line diff reports churn instead of change. Aligning on named blocks means a function
 * that moved is recognised as the same function, and a function that changed is reported once rather
 * than as a hunk of adjacent lines.
 *
 * Detection is a deliberate approximation, not a parser:
 *
 *   - `.js` / `.mjs` / `.cjs`  top-level `function` / `class` / `const` / `let` / `var` at brace depth 0
 *   - `.py`                     top-level `def` / `class` at indent 0
 *   - `.md`                     each heading becomes a block, so sections align by title
 *   - everything else           the whole file is one block
 *
 * ## The scanner
 *
 * The one thing this must get right is which braces nest a block. This project's sources are full of
 * template literals that build Markdown, doc comments that quote braces, and regex literals whose character
 * classes contain them, so a naive counter invents blocks that do not exist or, worse, swallows the rest of
 * a file into one.
 *
 * An earlier version interleaved two jobs - deciding what is code, and counting braces - and was patched one
 * case at a time until it was wrong in five ways at once: `/[}]/` read as division so its brace counted; a
 * doc comment after a `}` read as code; an unterminated comment swallowing the file silently; template
 * interpolations and regex bodies treated as ordinary code; and two copies of the scanner, only one of which
 * understood regexes. Each fix created the next problem. The rewrite separates the concerns: `maskOf`
 * classifies characters, and every consumer reads that classification.
 *
 * ## What the classification means
 *
 * Three states, because two were not enough:
 *
 *   0  not code            - comment text, and the prose of strings
 *   1  code, but wrapped   - the contents of a string or regex: code, yet its braces do not nest
 *   2  code                - everything else
 *
 * Brace counting wants "state is 2" - see the note in `splitJavaScript`, where reading state 1 as code
 * miscounted every brace that appears inside a string or a regex body. Identifier extraction wants the
 * same. Comparison wants string bodies replaced by a length-preserving placeholder, which is why state 1
 * exists at all: dropping string contents entirely would make `const a = "x"` and `const a = "yyyy"`
 * compare as identical, while keeping the text would make a reworded message look like a changed
 * algorithm.
 */

/** Keywords after which a `/` opens a regex rather than dividing. */
const KEYWORDS_BEFORE_REGEX = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do', 'else',
  'case', 'yield', 'await', 'throw',
]);

/**
 * Classify every character. See the state table above.
 *
 * Returns `{ mask, unbalanced }`. `unbalanced` names the construct that ran off the end of the input, if
 * any, so a caller can report it rather than silently producing a wrong answer.
 *
 * All state is local to the call and there is no backtracking: an unterminated construct ends the scan.
 */
export function maskOf(text) {
  const source = String(text ?? '');
  const n = source.length;
  const mask = new Uint8Array(n);

  let mode = 'code';
  let quote = '';
  let inClass = false;
  let lastWord = '';
  let unbalanced = null;

  const WORD = /[A-Za-z0-9_$]/;
  const ENDS_VALUE = /[A-Za-z0-9_$)\]}]/;

  /** True when a `/` at `at` opens a regex rather than dividing. */
  const regexStarts = (at) => {
    if (KEYWORDS_BEFORE_REGEX.has(lastWord)) return true;
    let back = at - 1;
    while (back >= 0 && /\s/.test(source[back])) back--;
    if (back < 0) return true;
    return !ENDS_VALUE.test(source[back]);
  };

  let i = 0;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];

    // ---- comment --------------------------------------------------------
    if (mode === 'line-comment') {
      if (c === '\n') mode = 'code';
      i++;
      continue;
    }
    if (mode === 'block-comment') {
      if (c === '*' && next === '/') { mode = 'code'; i += 2; continue; }
      i++;
      continue;
    }

    // ---- string ---------------------------------------------------------
    if (mode === 'string') {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) { mask[i] = 2; mode = 'code'; i++; continue; }
      if (c === '\n') { mode = 'code'; unbalanced = unbalanced ?? 'unterminated string'; i++; continue; }
      mask[i] = 1;
      i++;
      continue;
    }

    // ---- code -----------------------------------------------------------
    // The `//` and `/*` that open a comment are not marked: they are punctuation of the comment, not code.
    if (c === '/' && next === '/') { mode = 'line-comment'; i += 2; continue; }
    if (c === '/' && next === '*') { mode = 'block-comment'; i += 2; continue; }

    if (c === '/' && regexStarts(i)) {
      // A regex body is opaque to the scanner: scan straight to the closing `/`, honouring escapes and
      // character classes, and never look at what is inside.
      //
      // Reading the body character by character was a real failure. `/^\uFEFF/` contains no quote, but
      // `/^_?Link_\d+_?/i` and `.replace(/[\\/]+$/, '')` do - and treating that `'` as the start of a string
      // put the scanner into string mode partway through a regex, after which every quote paired wrongly
      // and the brace count drifted by one for the rest of the file. That is what made lib/report.js report
      // nine blocks instead of sixteen.
      mask[i] = 2;
      i++;
      let closed = false;
      while (i < n) {
        const d = source[i];
        if (d === '\\') { mask[i] = 1; if (i + 1 < n) mask[i + 1] = 1; i += 2; continue; }
        if (d === '\n') break;                       // not a regex after all; do not run past the line
        if (d === '[') { inClass = true; mask[i] = 1; i++; continue; }
        if (d === ']') { inClass = false; mask[i] = 1; i++; continue; }
        if (d === '/' && !inClass) {
          mask[i] = 2;
          i++;
          while (i < n && /[a-z]/i.test(source[i])) { mask[i] = 2; i++; }   // flags
          closed = true;
          break;
        }
        mask[i] = 1;
        i++;
      }
      if (!closed) unbalanced = unbalanced ?? 'unterminated regex';
      lastWord = '';
      continue;
    }

    if (c === '"' || c === "'") {
      mode = 'string';
      quote = c;
      lastWord = '';
      mask[i] = 2;
      i++;
      continue;
    }

    if (c === '`') {
      mask[i] = 2;
      i++;
      let closed = false;
      while (i < n) {
        const d = source[i];
        if (d === '\\') { mask[i] = 1; if (i + 1 < n) mask[i + 1] = 1; i += 2; continue; }
        if (d === '`') { mask[i] = 2; i++; closed = true; break; }
        if (d === '$' && source[i + 1] === '{') {
          // The interpolation is real code, and its braces nest, so state 2.
          mask[i] = 2;
          mask[i + 1] = 2;
          i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            const e = source[i];
            if (e === '{') depth++;
            else if (e === '}') depth--;
            mask[i] = 2;
            i++;
          }
          continue;
        }
        mask[i] = 1;
        i++;
      }
      if (!closed) unbalanced = unbalanced ?? 'unterminated template literal';
      lastWord = '';
      continue;
    }

    if (c === '{' || c === '}') {
      mask[i] = 2;
      lastWord = '';
      i++;
      continue;
    }

    if (WORD.test(c)) {
      let end = i;
      while (end < n && WORD.test(source[end])) end++;
      for (let k = i; k < end; k++) mask[k] = 2;
      lastWord = source.slice(i, end);
      i = end;
      continue;
    }

    if (!/\s/.test(c)) lastWord = '';
    // Whitespace in code is marked too. Leaving it out broke the consumers downstream: skeleton glued
    // `export function` into `exportfunction`, and the export regex stopped matching.
    mask[i] = 2;
    i++;
  }

  if (mode === 'block-comment') unbalanced = unbalanced ?? 'unterminated block comment';
  return { mask, unbalanced };
}

/**
 * Diagnosis helper: report every brace the classifier counts, with the state it was in when it counted it.
 *
 * Exported for working on the splitter itself. The interesting entry is a brace carrying state 1 - inside
 * a string or a regex body - sitting between depth 0 and the next declaration: counting it shifts the
 * depth for the rest of the file and swallows every later declaration into one block. That is what
 * `lib/report.js` (`startsWith('{')`) and `lib/parse.js` (`[0-9a-f]{8}`) used to hit.
 */
export function braceTrace(text) {
  const source = String(text ?? '');
  const { mask } = maskOf(source);
  const rows = [];
  let depth = 0;
  let offset = 0;
  const lines = source.split('\n');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    for (let k = 0; k < line.length; k++) {
      const abs = offset + k;
      if (mask[abs] !== 2) continue;
      const ch = line[k];
      if (ch !== '{' && ch !== '}') continue;
      depth += ch === '{' ? 1 : -1;
      rows.push({ line: index + 1, ch, depth, text: line.trim().slice(0, 76) });
    }
    offset += line.length + 1;
  }
  return rows;
}

/** Strip a block down to the text that matters for comparison. */
export function normalizeText(text) {
  return String(text ?? '')
    .replace(/^\uFEFF/, '')          // BOM
    .replace(/\r\n?/g, '\n')         // CRLF and lone CR
    .replace(/[ \t]+$/gm, '')        // trailing whitespace
    .replace(/\n{3,}/g, '\n\n')      // runs of blank lines
    .trim();
}

/**
 * Reduce a block to what decides similarity: code, with comments gone and string contents anonymised.
 *
 * String and regex bodies become `*` of the same length. Their text should not decide similarity -
 * rewording a message must not make two otherwise identical blocks look different - but the length must
 * survive, or `const a = "x"` and `const a = "yyyy"` would normalise to the same string.
 *
 * Whitespace runs become a single space rather than disappearing. Deleting them was wrong: the newline that
 * ends a `//` comment leaves a leading space, and with whitespace removed that space was trimmed away and
 * `// hi\nconst a = 1;` normalised to `//consta=1;`, gluing identifiers together.
 */
export function skeleton(text) {
  const source = String(text ?? '');
  const { mask } = maskOf(source);
  let out = '';
  for (let i = 0; i < source.length; i++) {
    const state = mask[i];
    if (state === 0) continue;                       // comment text
    out += state === 1 ? '*' : source[i];            // wrapped content, or code
  }
  return out.replace(/\s+/g, ' ').trim();
}

/**
 * Scan for top-level declarations.
 *
 * Returns `{ name, kind, start, end }` for each, where start and end are offsets into the original text.
 * Text before the first declaration becomes a leading block and text after the last becomes a trailing one,
 * so no content is silently dropped.
 *
 * Declaration detection is anchored at the current offset. An earlier version used a global regex with
 * `lastIndex = i`, which does not mean "match here": the regex could carry on and match a later
 * declaration, and rejecting it for `m.index !== i` then dropped the current one silently.
 */
export function splitJavaScript(text) {
  const source = String(text ?? '');
  const { mask } = maskOf(source);
  const n = source.length;
  const marks = [];

  const declAt = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/;
  const KEYWORD_START = new Set(['f', 'c', 'l', 'v', 'e', 'a', 'd']);

  let depth = 0;
  let i = 0;
  while (i < n) {
    // Only state 2 nests. Skipping just the comments was the bug: state 1 covers string bodies, regex
    // bodies and template text, and a brace there is a literal character, not a block boundary. The one
    // at `startsWith('{')` in lib/report.js opened a block that never closed, and the `[0-9a-f]{8}`
    // quantifiers in lib/parse.js did the same, so every later top-level declaration was swallowed.
    if (mask[i] !== 2) { i++; continue; }
    const c = source[i];

    if (c === '{') { depth++; i++; continue; }
    if (c === '}') { depth = Math.max(0, depth - 1); i++; continue; }

    if (depth === 0 && KEYWORD_START.has(c)) {
      const m = declAt.exec(source.slice(i));
      if (m) {
        // A declaration must begin a line, possibly indented, and must not be the tail of a longer
        // identifier such as `myFunction`. An accepted predecessor is the start of the file, a newline, a
        // statement terminator, a closing brace, or the end of a block comment - that last one matters
        // because every function here is preceded by a doc comment.
        let back = i - 1;
        while (back >= 0 && (source[back] === ' ' || source[back] === '\t')) back--;
        const prevChar = back >= 0 ? source[back] : '';
        const startsLine = back < 0
          || prevChar === '\n'
          || prevChar === ';'
          || prevChar === '{'
          || prevChar === '}'
          || (prevChar === '/' && source[back - 1] === '*');
        const gluedToWord = /[\w$.]/.test(prevChar);

        if (startsLine && !gluedToWord) {
          marks.push({ kind: m[1], name: m[2], start: i });
          i += m[0].length;
          continue;
        }
      }
    }

    i++;
  }

  const blocks = [];
  for (let k = 0; k < marks.length; k++) {
    const start = marks[k].start;
    const end = k + 1 < marks.length ? marks[k + 1].start : n;
    blocks.push({ name: marks[k].name, kind: marks[k].kind, start, end });
  }

  return finish(blocks, source, '__leading__');
}

/** Top-level `def` and `class` at indent 0. */
export function splitPython(text) {
  const source = String(text ?? '');
  const lines = source.split('\n');
  const offsets = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }

  const marks = [];
  for (let index = 0; index < lines.length; index++) {
    const m = /^(?:async\s+)?(def|class)\s+([A-Za-z_][\w]*)/.exec(lines[index]);
    if (m) marks.push({ kind: m[1], name: m[2], start: offsets[index] });
  }

  const blocks = [];
  for (let k = 0; k < marks.length; k++) {
    const start = marks[k].start;
    const end = k + 1 < marks.length ? marks[k + 1].start : source.length;
    blocks.push({ name: marks[k].name, kind: marks[k].kind, start, end });
  }
  return finish(blocks, source, '__leading__');
}

/**
 * Each heading is a block, so sections align by title rather than position.
 *
 * Fenced code blocks are skipped. Without that, a shell comment inside a fence - `# some note` - is
 * indistinguishable from an h1, and this project's own documents are full of them, so the split produced a
 * dozen phantom sections that no other copy could ever match.
 */
export function splitMarkdown(text) {
  const source = String(text ?? '');
  const lines = source.split('\n');
  const offsets = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }

  const marks = [];
  let fence = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];

    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker && fenceMatch[2].trim() === '') fence = null;
      continue;
    }
    if (fence !== null) continue;

    const m = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (m) marks.push({ kind: 'h' + m[1].length, name: m[2], start: offsets[index] });
  }

  const blocks = [];
  for (let k = 0; k < marks.length; k++) {
    const start = marks[k].start;
    const end = k + 1 < marks.length ? marks[k + 1].start : source.length;
    blocks.push({ name: marks[k].name, kind: marks[k].kind, start, end });
  }
  return finish(blocks, source, '__preamble__');
}

/**
 * Attach each block's leading comment to the block it documents.
 *
 * A declaration starts at its keyword, so the doc comment immediately above it otherwise counts as the tail
 * of the preceding block. That put a function's own documentation inside someone else's body, where the
 * prose words showed up among the identifiers the block "references" - `brackets`, `snake_case` and `dotted`
 * were reported as missing symbols purely because they appear in the doc comment of the function below.
 */
function absorbLeadingComments(blocks, text) {
  for (const block of blocks) {
    let start = block.start;
    for (;;) {
      let back = start - 1;
      while (back >= 0 && (text[back] === ' ' || text[back] === '\t'
                           || text[back] === '\n' || text[back] === '\r')) {
        back--;
      }
      if (back < 0) break;

      if (text[back] === '/' && text[back - 1] === '*') {
        let open = back - 1;
        while (open >= 2 && !(text[open - 2] === '/' && text[open - 1] === '*')) open--;
        open -= 2;
        if (open < 0) break;
        start = open;
        continue;
      }

      let lineEnd = back;
      let lineStart = text.lastIndexOf('\n', lineEnd) + 1;
      let absorbed = false;
      while (lineStart > 0 || lineEnd > 0) {
        const line = text.slice(lineStart, lineEnd + 1).trim();
        if (!line.startsWith('//')) break;
        start = lineStart;
        absorbed = true;
        if (lineStart === 0) break;
        lineEnd = lineStart - 2;
        if (lineEnd < 0) break;
        lineStart = text.lastIndexOf('\n', lineEnd) + 1;
      }
      if (!absorbed) break;
    }
    block.start = start;
  }

  for (let k = 0; k < blocks.length; k++) {
    const end = k + 1 < blocks.length ? blocks[k + 1].start : text.length;
    blocks[k].end = end;
    blocks[k].body = text.slice(blocks[k].start, end);
  }
  return blocks;
}

function finish(blocks, text, leadingName) {
  const out = [];
  const firstStart = blocks.length ? blocks[0].start : text.length;
  const head = text.slice(0, firstStart);
  if (head.trim()) {
    out.push({ name: leadingName, kind: 'head', start: 0, end: firstStart, body: head });
  }
  for (const b of blocks) {
    out.push({ ...b, body: text.slice(b.start, b.end) });
  }
  return absorbLeadingComments(out, text);
}

const WHOLE_FILE_KINDS = new Set(['json', 'yml', 'yaml', 'ps1', 'txt', 'svg', 'xml']);

/** Pick a splitter by extension. Unknown types become a single whole-file block. */
export function splitBlocks(relPath, text) {
  const lower = String(relPath ?? '').toLowerCase();
  const source = String(text ?? '');

  if (lower.endsWith('.js') || lower.endsWith('.mjs') || lower.endsWith('.cjs')) {
    return splitJavaScript(source);
  }
  if (lower.endsWith('.py')) return splitPython(source);
  if (lower.endsWith('.md')) return splitMarkdown(source);

  const dot = lower.lastIndexOf('.');
  const ext = dot >= 0 ? lower.slice(dot + 1) : '';
  const kind = WHOLE_FILE_KINDS.has(ext) ? ext : 'file';
  return [{ name: '(file)', kind, start: 0, end: source.length, body: source }];
}

/**
 * Stable block id: path, kind and name.
 *
 * Path is included because the same function name can legitimately exist in two tools, and those are
 * different blocks. Callers that want to match a block across files should compare names within a file,
 * not ids across files.
 */
export function blockId(relPath, block) {
  return String(relPath).replace(/\\/g, '/') + ':' + block.kind + ':' + block.name;
}

/** Code-only text of a block: comments and string bodies removed. */
function codeOnly(body) {
  const source = String(body ?? '');
  const { mask } = maskOf(source);
  let out = '';
  for (let i = 0; i < source.length; i++) {
    if (mask[i] === 2) out += source[i];
    else if (mask[i] === 1) out += ' ';
  }
  return out;
}

/** Every identifier a block mentions, for a crude "does this symbol resolve" check. */
export function referencedNames(body) {
  const names = new Set();
  for (const m of codeOnly(body).matchAll(/\b([A-Za-z_$][\w$]{2,})\b/g)) names.add(m[1]);
  return names;
}

/** Identifiers a block declares itself. */
export function declaredNames(body) {
  const names = new Set();
  for (const m of codeOnly(body).matchAll(/\b(?:function|class|const|let|var|def)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  return names;
}

/** Names a module exports, used to spot two blocks offering the same public surface. */
export function exportedNames(body) {
  const code = codeOnly(body);
  const names = new Set();
  for (const m of code.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)) {
    names.add(m[1]);
  }
  for (const m of code.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/)[0].trim();
      if (name) names.add(name);
    }
  }
  return names;
}
