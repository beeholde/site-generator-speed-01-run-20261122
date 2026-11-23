// v9 — stringify-fused genuine entry for site-generator-speed-01-run-20261122.
// Written from scratch in this session (never opened any earlier entry's solve.js).
// Design: a fast drop-in for makefun-site 1.0.0 whose run(input) returns, instead of
// the answer object, the case's answers.json TEXT (one JSON object, keys in the same
// order the reference inserts them, values escaped with native per-value
// JSON.stringify). main.ts writes the texts joined into the answers array, so the
// whole-answers JSON.stringify (~55 ms warm, more cold, NOT subtracted by the null
// control) is never paid. Cold tricks: --no-turbofan (set in main.ts before import,
// re-asserted here), no new Function/eval, no WASM, native-regex inline scanning
// with bulk plain-run escaping, position-based block loop (no whole-body split),
// chunk-array templates with parse-time scope-depth resolution, cached slugify.

import { setFlagsFromString } from 'node:v8';

// Background TurboFan threads burn CPU on a cold single run; the optimizing compiler
// never pays off here, so it stays off (same mechanism as the house baseline's
// --no-incremental-marking, which main.ts sets before importing this module).
setFlagsFromString('--no-turbofan');

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- text

/** The HTML escape table, in this order: & < > " ' */
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const HTML_ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function escapeHtml(text) {
  return text.replace(HTML_ESC_RE, (c) => ESCAPES[c]);
}

const MARK_RE = /\p{M}/gu;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), and "untitled" when nothing is left.
 */
function slugify(text) {
  const plain = text.normalize('NFKD').replace(MARK_RE, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** `slug` made unique against `taken` (and added to it): slug, slug-2, slug-3 ... */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const p = date.split('-');
  return `${Number(p[2])} ${MONTHS[Number(p[1]) - 1]} ${p[0]}`;
}

/**
 * The words of a body: its runs of characters other than whitespace. A char
 * scan, not match(/\S+/g): the match allocates an array of every word. The
 * whitespace set is exactly JavaScript \s (White_Space + line terminators).
 */
function wordsOf(text) {
  let n = 0;
  let inW = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    const ws = c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
      c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
      c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inW = false;
    else if (!inW) {
      inW = true;
      n++;
    }
  }
  return n;
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line. */
function fmString(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmString(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** Whether `line` is blank (spaces and tabs only). */
function isBlankStr(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. Lines are scanned by indexOf,
 * never split into an array.
 */
function parseFM(text) {
  const e0 = text.indexOf('\n');
  if ((e0 === -1 ? text : text.slice(0, e0)) !== '---') return { error: 'no front matter' };
  // Find the close line: a line exactly '---'.
  let cur = e0 === -1 ? text.length : e0 + 1;
  let closeStart = -1;
  while (cur < text.length) {
    const nl = text.indexOf('\n', cur);
    const end = nl === -1 ? text.length : nl;
    if (end - cur === 3 && text.charCodeAt(cur) === 45 && text.charCodeAt(cur + 1) === 45 && text.charCodeAt(cur + 2) === 45) {
      closeStart = cur;
      break;
    }
    if (nl === -1) break;
    cur = nl + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let lineStart = e0 + 1;
  let lineIdx = 1; // 0-based index of the line; the first FM line is "line 2"
  while (lineStart < closeStart) {
    const nl = text.indexOf('\n', lineStart);
    const end = nl === -1 || nl > closeStart ? closeStart : nl;
    const line = text.slice(lineStart, end);
    if (!isBlankStr(line) && line.charCodeAt(0) !== 35) {
      const m = FM_LINE.exec(line);
      if (!m) return { error: `line ${lineIdx + 1} is not "key: value"` };
      const key = m[1];
      const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
      if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = fmValue(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    lineStart = nl === -1 ? closeStart : nl + 1;
    lineIdx++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const closeNl = text.indexOf('\n', closeStart);
  return { data, body: closeNl === -1 ? '' : text.slice(closeNl + 1) };
}

// ---------------------------------------------------------------- markdown

const FENCE_OPEN_RE = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE_RE = /^```[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR_RE = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET_RE = /^[-*] (.*)$/;
const ORDERED_RE = /^(\d{1,9})\. (.*)$/;
const CONTINUED_RE = /^ {2,}\S/;

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING_RE.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line === '') return true;
  const c = line.charCodeAt(0);
  if (c === 32 || c === 9) return isBlankStr(line);
  if (c === 96) return FENCE_OPEN_RE.test(line);
  if (c === 35) return headingOf(line) !== null;
  if (c === 45 || c === 42) return HR_RE.test(line);
  return false;
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
const trimLine = (line) => {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
};

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * The next structural character for inline scanning: backslash, backtick, star
 * or open bracket. A single native scan jumps straight to it; the plain run
 * before it is escaped in bulk.
 */
const JUMP_RE = /[\\`*\[]/g;
const WS_RE = /\s/;

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  let out = '';
  let i = 0;
  JUMP_RE.lastIndex = 0;
  let m;
  while ((m = JUMP_RE.exec(s)) !== null) {
    const j = m.index;
    if (j > i) out += escapeHtml(s.slice(i, j));
    const c = s[j];
    if (c === '\\') {
      const n = s[j + 1];
      if (n !== undefined && ESCAPABLE.has(n)) {
        out += escapeHtml(n);
        i = j + 2;
      } else {
        // A backslash before anything else is itself: leave it in the plain run.
        i = j;
        JUMP_RE.lastIndex = j + 1;
        continue;
      }
      JUMP_RE.lastIndex = i;
      continue;
    }
    if (c === '`') {
      // The code closer is a plain indexOf: it does NOT skip backslash escapes.
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out += `<code>${escapeHtml(s.slice(j + 1, k))}</code>`;
        i = k + 1;
      } else {
        out += '`';
        i = j + 1;
      }
      JUMP_RE.lastIndex = i;
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out += `<strong>${inline(s.slice(j + 2, k), env)}</strong>`;
          i = k + 2;
        } else {
          out += '**';
          i = j + 2;
        }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          out += `<em>${inline(s.slice(j + 1, k), env)}</em>`;
          i = k + 1;
        } else {
          out += '*';
          i = j + 1;
        }
      }
      JUMP_RE.lastIndex = i;
      continue;
    }
    // '[': the text closer skips escapes, the target closer is a plain indexOf.
    const k = findUnescaped(s, ']', j + 1);
    const q = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = q === -1 ? '' : s.slice(k + 2, q);
    if (target !== '' && !WS_RE.test(target)) {
      out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(j + 1, k), env)}</a>`;
      i = q + 1;
    } else {
      out += '[';
      i = j + 1;
    }
    JUMP_RE.lastIndex = i;
  }
  if (i < s.length) out += escapeHtml(s.slice(i));
  return out;
}

/**
 * `src` rendered: its HTML (each block on its own lines, a "\n" after the last),
 * its table of contents (every level 2 and 3 heading) and its excerpt (the first
 * paragraph's inline HTML, or ""). Blocks are read line by line from the string
 * by position, never split into an array. `slugOf` is the run's cached slugify.
 */
function renderMarkdown(src, env, slugOf) {
  const ids = new Set();
  const toc = [];
  let excerpt = null;
  let html = '';
  const n = src.length;
  let pos = 0;
  while (pos < n) {
    let nl = src.indexOf('\n', pos);
    if (nl === -1) nl = n;
    const line = src.slice(pos, nl);
    const nextPos = nl === n ? n : nl + 1;
    if (line === '') {
      pos = nextPos;
      continue;
    }
    const c0 = line.charCodeAt(0);
    // Classify by first character; only ambiguous lines reach a regex.
    let kind = 0; // 0 paragraph, 1 fence, 2 heading, 3 hr, 4 blockquote, 5 list
    let m = null;
    let isOrd = false;
    if (c0 === 32 || c0 === 9) {
      if (isBlankStr(line)) {
        pos = nextPos;
        continue;
      }
    } else if (c0 === 96 && (m = FENCE_OPEN_RE.exec(line)) !== null) kind = 1;
    else if (c0 === 35 && (m = HEADING_RE.exec(line)) !== null && m[2] !== '') kind = 2;
    else if ((c0 === 45 || c0 === 42) && HR_RE.test(line)) kind = 3;
    else if (c0 === 62) kind = 4;
    else if (c0 === 45 || c0 === 42) {
      const b = BULLET_RE.exec(line);
      if (b !== null) {
        kind = 5;
        m = b;
      }
    } else if (c0 >= 48 && c0 <= 57) {
      const o = ORDERED_RE.exec(line);
      if (o !== null) {
        kind = 5;
        m = o;
        isOrd = true;
      }
    }
    if (kind === 1) {
      const lang = m[1];
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      const lines = [];
      pos = nextPos;
      while (pos < n) {
        let nl2 = src.indexOf('\n', pos);
        if (nl2 === -1) nl2 = n;
        const l2 = src.slice(pos, nl2);
        if (FENCE_CLOSE_RE.test(l2)) {
          pos = nl2 === n ? n : nl2 + 1;
          break;
        }
        lines.push(l2);
        pos = nl2 === n ? n : nl2 + 1;
      }
      // Each body line is escaped and ends in "\n": one escape over the join
      // (the "\n" separators are not escapable) instead of one call per line.
      html += `<pre><code${cls}>${lines.length === 0 ? '' : escapeHtml(lines.join('\n')) + '\n'}</code></pre>\n`;
      continue;
    }
    if (kind === 2) {
      const id = uniqueSlug(slugOf(m[2]), ids);
      const hhtml = inline(m[2], env);
      html += `<h${m[1].length} id="${id}">${hhtml}</h${m[1].length}>\n`;
      if (m[1].length === 2 || m[1].length === 3) toc.push({ level: m[1].length, id, html: hhtml });
      pos = nextPos;
      continue;
    }
    if (kind === 3) {
      html += '<hr>\n';
      pos = nextPos;
      continue;
    }
    if (kind === 4) {
      const qlines = [];
      let p = pos;
      while (p < n) {
        let nl2 = src.indexOf('\n', p);
        if (nl2 === -1) nl2 = n;
        const l2 = src.slice(p, nl2);
        if (l2.charCodeAt(0) !== 62) break;
        qlines.push(trimLine(l2.replace(/^> ?/, '')));
        p = nl2 === n ? n : nl2 + 1;
      }
      pos = p;
      const kept = qlines.filter((l) => l !== '');
      html += kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>\n`;
      continue;
    }
    if (kind === 5) {
      const marker = isOrd ? ORDERED_RE : BULLET_RE;
      const startNum = isOrd ? Number(m[1]) : 1;
      const items = [];
      let p = pos;
      while (p < n) {
        let nl2 = src.indexOf('\n', p);
        if (nl2 === -1) nl2 = n;
        const l2 = src.slice(p, nl2);
        const mm = marker.exec(l2);
        if (mm !== null) {
          items.push([trimLine(isOrd ? mm[2] : mm[1])]);
          p = nl2 === n ? n : nl2 + 1;
        } else if (CONTINUED_RE.test(l2)) {
          items[items.length - 1].push(trimLine(l2));
          p = nl2 === n ? n : nl2 + 1;
        } else break;
      }
      pos = p;
      const tag = isOrd ? 'ol' : 'ul';
      const open = isOrd && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`;
      html += `${open}\n`;
      for (const parts of items) html += `<li>${inline(parts.join('\n'), env)}</li>\n`;
      html += `</${tag}>\n`;
      continue;
    }
    // Paragraph: this line and the lines after it up to a blank line, a fence,
    // a heading or a thematic break (a `---` under text is a break, never a heading).
    const parts = [trimLine(line)];
    pos = nextPos;
    while (pos < n) {
      let nl2 = src.indexOf('\n', pos);
      if (nl2 === -1) nl2 = n;
      const l2 = src.slice(pos, nl2);
      if (endsParagraph(l2)) break;
      parts.push(trimLine(l2));
      pos = nl2 === n ? n : nl2 + 1;
    }
    const phtml = inline(parts.join('\n'), env);
    if (excerpt === null) excerpt = phtml;
    html += `<p>${phtml}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

// Node kinds: 0 text, 1 var, 2 raw, 3 if, 4 for, 5 include.
//   text:    [0, string]
//   var/raw: [1|2, path[], staticDepth]  (staticDepth -1 = walk the scope chain)
//   if:      [3, not, path[], staticDepth, then[], else[]|null]
//   for:     [4, name, path[], staticDepth, body[], frame]
//   include: [5, name]
// A for-node's frame is one reusable { vars, loop, busy } object: the loop's
// vars object is mutated per iteration instead of allocated, with a fresh frame
// allocated only when the same for-node renders re-entrantly (self-include).
function mkFrame(name) {
  const loop = { index: 0, first: false, last: false, length: 0 };
  return { vars: { loop }, loop, busy: false };
}

/**
 * `src` parsed into its tree of nodes (a TemplateError when it does not parse).
 * Tokenising and tree-building run in one pass. A path's staticDepth is the
 * number of enclosing for-frames up to the one binding its first name (or
 * 'loop'), counted among this template's own fors; -1 when no own for binds it,
 * in which case rendering walks the scope chain (an including template's loop
 * may bind it, exactly as the reference's lookup does).
 */
function parseTemplate(name, src) {
  const rootNode = [-1, []];
  const stack = [rootNode];
  let body = rootNode[1];
  const staticDepth = (first) => {
    let d = 0;
    for (let s = stack.length - 1; s >= 0; s--) {
      const fr = stack[s];
      if (fr[0] !== 4) continue;
      if (fr[1] === first || first === 'loop') return d;
      d++;
    }
    return -1;
  };
  let text = '';
  let i = 0;
  const pushText = () => {
    if (text !== '') {
      body.push([0, text]);
      text = '';
    }
  };
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      pushText();
      const p = pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim());
      body.push([raw ? 2 : 1, p, staticDepth(p[0])]);
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    pushText();
    const tag = src.slice(open + 2, close).trim();
    let m;
    if ((m = FOR_RE.exec(tag)) !== null) {
      const p = pathOf(name, m[2]);
      const node = [4, m[1], p, staticDepth(p[0]), [], mkFrame(m[1])];
      body.push(node);
      stack.push(node);
      body = node[4];
    } else if ((m = IF_RE.exec(tag)) !== null) {
      const p = pathOf(name, m[2]);
      const node = [3, m[1] !== undefined, p, staticDepth(p[0]), [], null];
      body.push(node);
      stack.push(node);
      body = node[4];
    } else if (tag === 'else') {
      const top = stack[stack.length - 1];
      if (top[0] !== 3 || top[5] !== null) throw new TemplateError(`template "${name}": an else outside an if`);
      top[5] = [];
      body = top[5];
    } else if (tag === 'endfor' || tag === 'endif') {
      const top = stack[stack.length - 1];
      if (top[0] !== (tag === 'endfor' ? 4 : 3)) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
      stack.pop();
      const parent = stack[stack.length - 1];
      body = parent[0] === -1 ? parent[1] : parent[0] === 4 ? parent[4] : parent[5] ?? parent[4];
    } else if ((m = INCLUDE_RE.exec(tag)) !== null) {
      body.push([5, m[1]]);
    } else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  pushText();
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1][0] === 4 ? 'for' : 'if'} is not closed`);
  return rootNode[1];
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookupDyn(scopes, path) {
  const first = path[0];
  for (let s = scopes.length - 1; s >= 0; s--) {
    const vars = scopes[s];
    if (Object.hasOwn(vars, first)) {
      let v = vars[first];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
}

/** The value at `path`, using the parse-time depth when this template's own for binds the first name. */
function lookupVal(scopes, path, depth) {
  if (depth >= 0) {
    let v = scopes[scopes.length - 1 - depth][path[0]];
    for (let k = 1; k < path.length; k++) {
      if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
      v = v[path[k]];
    }
    return v;
  }
  return lookupDyn(scopes, path);
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered in the scope stack `scopes` (an array of vars objects, the
 * root first; for-frames are pushed and popped as they render). `templates` is
 * the case's map of parsed templates; `depth` is the include depth.
 */
function renderNodes(nodes, scopes, templates, depth) {
  let out = '';
  for (let n = 0; n < nodes.length; n++) {
    const node = nodes[n];
    const k = node[0];
    if (k === 0) {
      out += node[1];
      continue;
    }
    if (k === 1) {
      const v = lookupVal(scopes, node[1], node[2]);
      out += escapeHtml(typeof v === 'string' ? v : textOf(v));
      continue;
    }
    if (k === 2) {
      const v = lookupVal(scopes, node[1], node[2]);
      out += typeof v === 'string' ? v : textOf(v);
      continue;
    }
    if (k === 3) {
      const v = truthy(lookupVal(scopes, node[2], node[3]));
      const branch = v !== node[1] ? node[4] : node[5];
      if (branch !== null) out += renderNodes(branch, scopes, templates, depth);
      continue;
    }
    if (k === 4) {
      const xs = lookupVal(scopes, node[2], node[3]);
      if (!Array.isArray(xs)) continue;
      const name = node[1];
      let fr = node[5];
      if (fr.busy) fr = mkFrame(name);
      fr.busy = true;
      const L = xs.length;
      for (let t = 0; t < L; t++) {
        fr.vars[name] = xs[t];
        fr.loop.index = t + 1;
        fr.loop.first = t === 0;
        fr.loop.last = t === L - 1;
        fr.loop.length = L;
        scopes.push(fr.vars);
        out += renderNodes(node[4], scopes, templates, depth);
        scopes.pop();
      }
      fr.busy = false;
      continue;
    }
    const t = templates.get(node[1]);
    if (t !== undefined && depth < INCLUDE_DEPTH) out += renderNodes(t, scopes, templates, depth + 1);
  }
  return out;
}

// ---------------------------------------------------------------- build

/** The top-level directories the generator writes itself, which no page's slug at the root may take. */
const RESERVED = ['posts', 'tags', 'page'];

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** A post's card, as lists show it. */
function cardOf(s) {
  return {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
}

/** A page as its layout reads it. `cards` holds the posts' cards; a post reuses its card, a page builds one. */
function pageOf(s, cards) {
  const c = cards.get(s) ?? cardOf(s);
  return {
    title: c.title,
    url: c.url,
    date: c.date,
    date_long: c.date_long,
    summary: c.summary,
    excerpt: c.excerpt,
    reading_minutes: c.reading_minutes,
    tags: c.tags,
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/**
 * One site's output tree as its answers.json text: the JSON object of every path
 * the build writes and that file's text. The text is built with native per-value
 * JSON.stringify as pages are rendered, so no whole-answers stringify is ever
 * paid; keys are emitted in the reference's insertion order, so the text is
 * byte-identical to JSON.stringify of the same answer object.
 */
export function run(input) {
  const slugCache = new Map();
  const slugOf = (t) => {
    let s = slugCache.get(t);
    if (s === undefined) {
      s = slugify(t);
      slugCache.set(t, s);
    }
    return s;
  };

  // Templates, parsed in code-unit order of name; one that does not parse is
  // reported and left out, as if it were not there.
  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources, in code-unit order of path; line ends made "\n"; non-.md is static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in the checks' order: refused, own directory, post needs a
  // date, layout is no template, draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFM(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's slug made unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugOf(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const spath = s.path;
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${spath} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugOf);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest date first, then by slug; newer/older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by slug, each named as first met walking the posts in
  // collection order; ordered by count of posts, most first, then by slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const sl = slugOf(name);
      if (!seen.has(sl)) {
        seen.add(sl);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const sl = slugOf(name);
      let tag = bySlug.get(sl);
      if (tag === undefined) {
        tag = { name, slug: sl, url: `${base}/tags/${sl}/`, posts: [] };
        bySlug.set(sl, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugOf(name)) ?? { name, slug: slugOf(name), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Layouts, emitting each output path straight into the answers JSON text.
  const segs = ['{'];
  let firstSeg = true;
  const emitted = new Set();
  const emit = (path, text) => {
    if (!firstSeg) segs.push(',');
    firstSeg = false;
    emitted.add(path);
    segs.push(JSON.stringify(path), ':', JSON.stringify(text));
  };

  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    return renderNodes(nodes, [{ site, tags: allTags, recent, ...vars }], templates, 0);
  };
  for (const s of kept) emit(`${s.outDir}/index.html`, render(s.layout, { page: pageOf(s, cards) }));
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) emit(k === 1 ? 'index.html' : `page/${k}/index.html`, html);
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) emit(`tags/${t.slug}/index.html`, html);
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) emit('tags/index.html', tagsHtml);
  for (const f of statics) {
    if (emitted.has(f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else emit(f.path, f.content);
  }

  // The report: every refusal, draft, broken link and template that did not
  // parse, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const npages = kept.filter((s) => !s.post).length;
  lines.push(`built ${npages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  emit('build-report.txt', `${lines.join('\n')}\n`);
  segs.push('}');
  return segs.join('');
}
