// v4 — a faster drop-in for makefun-site 1.0.0, written from scratch in this session.
// Design: one fused pass over each body (no token objects), char-code block dispatch,
// Irregexp-style inline scan (one regex finds the next structural character; plain runs
// are appended untouched), ASCII fast-path slugify with a per-run cache, and templates
// compiled with `new Function` to plain JS (prototype-chained scopes, so a partial reads
// its caller's loop variables exactly as the reference's scope walk does).
// No WebAssembly, no native addon, no eval of input: generated code comes only from the
// template grammar's own validated names; every value still flows through the same
// escape / text / truthiness rules as the reference.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
const ESC_TEST = /[&<>"']/;
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const RESERVED = ['posts', 'tags', 'page'];
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WS_RE = /\s/;
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export function escapeHtml(text) {
  return ESC_TEST.test(text) ? text.replace(ESC_RE, (c) => ESCAPES[c]) : text;
}

/** The slug of `text`, with a per-run cache; ASCII words take a one-pass fast path. */
function slugify(text, cache) {
  const hit = cache.get(text);
  if (hit !== undefined) return hit;
  let out = '';
  let gap = false;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let k = -1;
    if (c >= 65 && c <= 90) k = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) k = c;
    else if (c > 127) { ascii = false; break; }
    if (k === -1) {
      if (out.length > 0) gap = true;
      continue;
    }
    if (gap) { out += '-'; gap = false; }
    out += String.fromCharCode(k);
  }
  if (!ascii) {
    const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
    out = '';
    gap = false;
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
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  cache.set(text, out);
  return out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** Runs of characters other than whitespace (the reference's /\S+/g count, without the array). */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13 || c === 12 || c === 11 || c === 160 || c === 5760 ||
      (c >= 8192 && c <= 8202) || c === 8232 || c === 8233 || c === 8239 || c === 8287 || c === 12288 || c === 65279) {
      inWord = false;
    } else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
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
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      if (ok) for (let i = 0; i < 10; i++) {
        if (i === 4 || i === 7) continue;
        const c = raw.charCodeAt(i);
        if (c < 48 || c > 57) { ok = false; break; }
      }
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const parts = inner.split(',');
      for (let i = 0; i < parts.length; i++) {
        const t = parts[i].trim();
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        parts[i] = t;
      }
      return { value: parts };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      let ok = raw.length > 0;
      if (ok) for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) { ok = false; break; }
      }
      return ok ? { value: raw } : { error: 'key "layout": not a template name' };
    }
    case 'slug': {
      let ok = raw.length > 0 && raw.length <= 64;
      if (ok) {
        let prevDash = true;
        for (let i = 0; i < raw.length; i++) {
          const c = raw.charCodeAt(i);
          if (c === 45) {
            if (prevDash) { ok = false; break; }
            prevDash = true;
          } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
          else { ok = false; break; }
        }
        if (prevDash) ok = false;
      }
      return ok ? { value: raw } : { error: 'key "slug": not a slug' };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** A source's front matter and body: { data, body }, or { error } with the first reason. */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  let close = -1;
  let from = 3;
  for (;;) {
    const p = text.indexOf('\n---', from);
    if (p === -1) break;
    const after = p + 4;
    if (after === text.length || text.charCodeAt(after) === 10) { close = p; break; }
    from = p + 1;
  }
  if (close === -1) return { error: 'the front matter is not closed' };
  const data = {};
  const region = text.slice(4, close);
  if (region !== '') {
    const lines = region.split('\n');
    for (let j = 0; j < lines.length; j++) {
      const line = lines[j];
      const n = j + 2;
      let blank = true;
      for (let k = 0; k < line.length; k++) {
        const c = line.charCodeAt(k);
        if (c !== 32 && c !== 9) { blank = false; break; }
      }
      if (blank || line.charCodeAt(0) === 35) continue;
      let i = 0;
      while (i < line.length) {
        const c = line.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || c === 95)) break;
        i++;
      }
      if (i === 0 || i >= line.length || line.charCodeAt(i) !== 58) return { error: `line ${n} is not "key: value"` };
      const key = line.slice(0, i);
      let raw;
      if (i + 1 === line.length) raw = '';
      else if (line.charCodeAt(i + 1) === 32) raw = line.slice(i + 2);
      else return { error: `line ${n} is not "key: value"` };
      let e = raw.length;
      while (e > 0) {
        const c = raw.charCodeAt(e - 1);
        if (c !== 32 && c !== 9) break;
        e--;
      }
      raw = raw.slice(0, e);
      if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  const after = close + 4;
  const body = after === text.length ? '' : text.slice(after + 1);
  return { data, body };
}

// ---------------------------------------------------------------- Markdown

const ESCAPABLE = '\\`*_[]()#+-.!>';
const SPECIAL_RE = /[\\`*\[&<>"']/;
const SCAN_RE = /[\\`*\[&<>"']/g;

function isEscaped(s, j) {
  let n = 0;
  for (let k = j - 1; k >= 0 && s.charCodeAt(k) === 92; k--) n++;
  return (n & 1) === 1;
}

/** First unescaped `**` at or after `from`, or -1. */
function findStarStar(s, from) {
  let j = s.indexOf('**', from);
  while (j !== -1) {
    if (!isEscaped(s, j)) return j;
    j = s.indexOf('**', j + 1);
  }
  return -1;
}

/** First single `*` (not beside another `*`, not escaped) at or after `from`, or -1. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    if (isEscaped(s, j)) { j = s.indexOf('*', j + 1); continue; }
    if (s.charCodeAt(j + 1) === 42) { j = s.indexOf('*', j + 2); continue; }
    return j;
  }
  return -1;
}

/** First unescaped `]` at or after `from`, or -1. */
function findBracket(s, from) {
  let j = s.indexOf(']', from);
  while (j !== -1) {
    if (!isEscaped(s, j)) return j;
    j = s.indexOf(']', j + 1);
  }
  return -1;
}

/** `s` rendered inline; `link(target)` resolves a link's href; `esc` is the HTML escape. */
function inline(s, link, esc) {
  if (!SPECIAL_RE.test(s)) return s;
  let out = '';
  let pos = 0;
  SCAN_RE.lastIndex = 0;
  let m;
  while ((m = SCAN_RE.exec(s)) !== null) {
    const i = m.index;
    const c = m[0];
    if (i > pos) out += s.slice(pos, i);
    if (c === '&') { out += '&amp;'; pos = i + 1; }
    else if (c === '<') { out += '&lt;'; pos = i + 1; }
    else if (c === '>') { out += '&gt;'; pos = i + 1; }
    else if (c === '"') { out += '&quot;'; pos = i + 1; }
    else if (c === "'") { out += '&#39;'; pos = i + 1; }
    else if (c === '\\') {
      const n = s[i + 1];
      if (n !== undefined && ESCAPABLE.indexOf(n) !== -1) {
        out += n === '>' ? '&gt;' : n;
        pos = i + 2;
      } else {
        out += '\\';
        pos = i + 1;
      }
    } else if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += `<code>${esc(s.slice(i + 1, j))}</code>`;
        pos = j + 1;
      } else {
        out += '`';
        pos = i + 1;
      }
    } else if (c === '*') {
      if (s.charCodeAt(i + 1) === 42) {
        const j = findStarStar(s, i + 2);
        if (j > i + 2) {
          out += `<strong>${inline(s.slice(i + 2, j), link, esc)}</strong>`;
          pos = j + 2;
        } else {
          out += '**';
          pos = i + 2;
        }
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          out += `<em>${inline(s.slice(i + 1, j), link, esc)}</em>`;
          pos = j + 1;
        } else {
          out += '*';
          pos = i + 1;
        }
      }
    } else { // '['
      const k = findBracket(s, i + 1);
      const t = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = t === -1 ? '' : s.slice(k + 2, t);
      if (target !== '' && !WS_RE.test(target)) {
        out += `<a href="${esc(link(target))}">${inline(s.slice(i + 1, k), link, esc)}</a>`;
        pos = t + 1;
      } else {
        out += '[';
        pos = i + 1;
      }
    }
    SCAN_RE.lastIndex = pos;
  }
  if (pos < s.length) out += s.slice(pos);
  return out;
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** Fence-open language, or null: ``` + [A-Za-z0-9_+-]* + spaces/tabs only. */
function fenceLang(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return null;
    i++;
  }
  return lang;
}

function isFenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Heading {depth, text}, or null. */
function headingOf(line) {
  if (line.charCodeAt(0) !== 35) return null;
  let d = 0;
  while (d < line.length && line.charCodeAt(d) === 35) d++;
  if (d === 0 || d > 6) return null;
  const c = line.charCodeAt(d);
  if (c !== 32 && c !== 9) return null;
  let a = d;
  while (a < line.length && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  let b = line.length;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  if (b === a) return null;
  return { depth: d, text: line.slice(a, b) };
}

function isHr(line) {
  const c0 = line.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  const c1 = line.charCodeAt(1);
  const c2 = line.charCodeAt(2);
  if (c0 === 45) {
    if (c1 !== 45 || c2 !== 45) return false;
  } else if (c1 !== 42 || c2 !== 42) return false;
  for (let i = 3; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** List start {ordered, start, content}, or null. */
function listOf(line) {
  const c0 = line.charCodeAt(0);
  if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) return { ordered: false, start: 1, content: line.slice(2) };
  let i = 0;
  while (i < line.length && line.charCodeAt(i) >= 48 && line.charCodeAt(i) <= 57) i++;
  if (i >= 1 && i <= 9 && line.charCodeAt(i) === 46 && line.charCodeAt(i + 1) === 32) {
    return { ordered: true, start: Number(line.slice(0, i)), content: line.slice(i + 2) };
  }
  return null;
}

function isContinued(line) {
  if (line.charCodeAt(0) !== 32 || line.charCodeAt(1) !== 32) return false;
  let i = 2;
  while (i < line.length && line.charCodeAt(i) === 32) i++;
  if (i >= line.length) return false;
  const c = line.charCodeAt(i);
  if (c === 32 || c === 9 || c === 13 || c === 12 || c === 11) return false;
  if (c > 127) return !WS_RE.test(line[i]);
  return true;
}

function endsParagraph(line) {
  // A line ends a paragraph only if blank, a fence, a heading or a break; any line
  // whose first character is none of those starters cannot end one.
  if (line.length === 0) return true;
  const c0 = line.charCodeAt(0);
  if (c0 !== 32 && c0 !== 9 && c0 !== 96 && c0 !== 35 && c0 !== 45 && c0 !== 42) return false;
  return isBlank(line) || fenceLang(line) !== null || headingOf(line) !== null || isHr(line);
}

function renderMarkdown(src, link, slugCache, esc) {
  const lines = src.split('\n');
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    const lang = fenceLang(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < lines.length && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${lang}"`;
      blocks.push(`<pre><code${cls}>${body.length === 0 ? '' : `${esc(body.join('\n'))}\n`}</code></pre>`);
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text, slugCache), ids);
      const html = inline(heading.text, link, esc);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < lines.length && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1));
      }
      const kept = [];
      for (const l of body) {
        const t = trimLine(l);
        if (t !== '') kept.push(t);
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), link, esc)}</p>\n</blockquote>`);
      continue;
    }
    const list = listOf(line);
    if (list !== null) {
      const items = [];
      while (i < lines.length) {
        const m = listOf(lines[i]);
        if (m !== null && m.ordered === list.ordered) {
          items.push([trimLine(m.content)]);
          i++;
        } else if (items.length > 0 && isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = list.ordered ? 'ol' : 'ul';
      const open = list.ordered && list.start !== 1 ? `<ol start="${list.start}">` : `<${tag}>`;
      let out = `${open}\n`;
      for (const parts of items) out += `<li>${inline(parts.join('\n'), link, esc)}</li>\n`;
      blocks.push(`${out}</${tag}>`);
      continue;
    }
    const parts = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) parts.push(trimLine(lines[i++]));
    const html = inline(parts.join('\n'), link, esc);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function blankSpan(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `src` parsed into a node tree (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
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
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ k: 't', x: text });
      text = '';
      tokens.push({ k: raw ? 'r' : 'v', p: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = blankSpan(src.slice(lineStart, open)) && blankSpan(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ k: 't', x: text });
    text = '';
    tokens.push({ k: 'g', g: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ k: 't', x: text });

  const root = { k: 'root', b: [] };
  const stack = [root];
  let body = root.b;
  for (const tok of tokens) {
    if (tok.k === 't') body.push(tok);
    else if (tok.k === 'v' || tok.k === 'r') body.push(tok);
    else {
      const tag = tok.g;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { k: 'f', n: m[1], p: pathOf(name, m[2]), b: [] };
        body.push(node);
        stack.push(node);
        body = node.b;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { k: 'i', not: m[1] !== undefined, p: pathOf(name, m[2]), a: [], e: null };
        body.push(node);
        stack.push(node);
        body = node.a;
      } else if (tag === 'else') {
        if (top.k !== 'i' || top.e !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.e = [];
        body = top.e;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.k !== (tag === 'endfor' ? 'f' : 'i')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.k === 'root' ? parent.b : parent.k === 'f' ? parent.b : parent.e ?? parent.a;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ k: 'c', n: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].k === 'f' ? 'for' : 'if'} is not closed`);
  return root.b;
}

/** A value as text. */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** Own-property descent: the value at `k` of `v`, or undefined. */
function hasOwnGet(v, k) {
  return v !== null && typeof v === 'object' && Object.hasOwn(v, k) ? v[k] : undefined;
}

/** Whether template `name`'s output depends only on site/tags/recent (and include depth):
 * every path it reads, directly or through includes, must come from a root var in
 * {site, tags, recent} or from a for-loop over such a value. `bound` maps names bound by
 * enclosing fors to whether their source is case-constant. */
function analyzeConstant(parsed, name, bound, visiting, cache) {
  const key = `${name}|${[...bound.entries()].map(([k, v]) => `${k}=${v ? 1 : 0}`).sort().join(',')}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  if (visiting.has(name)) return false;
  const nodes = parsed.get(name);
  if (nodes === undefined) return true;
  visiting.add(name);
  let ok = true;
  const pathConst = (p) => {
    const f = p[0];
    if (bound.has(f)) return bound.get(f);
    return f === 'site' || f === 'tags' || f === 'recent';
  };
  const walk = (ns, b) => {
    for (const n of ns) {
      if (!ok) return;
      if (n.k === 'v' || n.k === 'r' || n.k === 'i') {
        if (!pathConst(n.p)) ok = false;
      } else if (n.k === 'f') {
        const ac = pathConst(n.p);
        const b2 = new Map(b);
        b2.set(n.n, ac);
        b2.set('loop', ac);
        walk(n.b, b2);
      } else if (n.k === 'c') {
        if (!analyzeConstant(parsed, n.n, b, visiting, cache)) ok = false;
      }
    }
  };
  walk(nodes, bound);
  visiting.delete(name);
  cache.set(key, ok);
  return ok;
}

/** Render a case-constant template once per include depth and reuse the string. */
function memoRender(fn, S, X, D) {
  let s = fn.memo.get(D);
  if (s === undefined) {
    s = fn(S, X, D);
    fn.memo.set(D, s);
  }
  return s;
}

/** Compile a parsed template into a function (S, X, D) -> string. */
function compileTemplate(nodes, constSet) {
  let code = '';
  let tmp = 0;
  const pathCode = (path, scopeVar) => {
    const v = `_v${tmp++}`;
    let c = `let ${v}=${scopeVar}.${path[0]};`;
    for (let k = 1; k < path.length; k++) c += `${v}=(${v}!==null&&typeof ${v}==="object"&&Object.hasOwn(${v},${JSON.stringify(path[k])}))?${v}.${path[k]}:undefined;`;
    return [c, v];
  };
  const walk = (ns, scopeVar, depth) => {
    for (const n of ns) {
      if (n.k === 't') code += `o+=${JSON.stringify(n.x)};`;
      else if (n.k === 'v' || n.k === 'r') {
        const [c, v] = pathCode(n.p, scopeVar);
        code += c;
        code += n.k === 'v'
          ? `o+=X.E(typeof ${v}==="string"?${v}:X.T(${v}));`
          : `o+=typeof ${v}==="string"?${v}:X.T(${v});`;
      } else if (n.k === 'i') {
        const [c, v] = pathCode(n.p, scopeVar);
        code += `${c}if(X.Y(${v})!==${n.not}){`;
        walk(n.a, scopeVar, depth);
        if (n.e !== null) {
          code += '}else{';
          walk(n.e, scopeVar, depth);
        }
        code += '}';
      } else if (n.k === 'f') {
        const [c, v] = pathCode(n.p, scopeVar);
        const sv = `S${tmp++}`;
        const a = `_a${tmp++}`;
        const k = `_k${tmp++}`;
        const l = `_l${tmp++}`;
        code += `${c}const ${a}=${v};if(Array.isArray(${a})){const ${sv}=Object.create(${scopeVar});const ${l}={index:0,first:false,last:false,length:${a}.length};${sv}.loop=${l};for(let ${k}=0;${k}<${a}.length;${k}++){${sv}.${n.n}=${a}[${k}];${n.n === 'loop' ? `${sv}.loop=${l};` : ''}${l}.index=${k}+1;${l}.first=${k}===0;${l}.last=${k}===${a}.length-1;`;
        walk(n.b, sv, depth + 1);
        code += '}}';
      } else if (n.k === 'c') {
        const f = `_f${tmp++}`;
        if (constSet.has(n.n)) code += `if(D<8){const ${f}=X.tpl.get(${JSON.stringify(n.n)});if(${f}!==undefined)o+=X.M(${f},${scopeVar},X,D+1);}`;
        else code += `if(D<8){const ${f}=X.tpl.get(${JSON.stringify(n.n)});if(${f}!==undefined)o+=${f}(${scopeVar},X,D+1);}`;
      }
    }
  };
  walk(nodes, 'S', 0);
  const fn = new Function('S', 'X', 'D', `"use strict";let o="";${code}return o;`);
  fn.memo = new Map();
  return fn;
}

// ---------------------------------------------------------------- build

function dirOf(path) {
  return path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
}

function resolvePath(dirParts, rel) {
  const parts = dirParts.slice();
  let i = 0;
  while (i <= rel.length) {
    let j = rel.indexOf('/', i);
    if (j === -1) j = rel.length;
    const seg = rel.slice(i, j);
    if (seg === '' || seg === '.') { /* skip */ }
    else if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
    i = j + 1;
  }
  return parts.join('/');
}

const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

export function run(input) {
  const slugCache = new Map();
  // Per-run escape cache: titles/urls/names are escaped many times each (card, index,
  // tag pages, nav); long strings (code bodies) bypass it.
  const escCache = new Map();
  const esc = (t) => {
    if (t.length > 128) return escapeHtml(t);
    let e = escCache.get(t);
    if (e === undefined) {
      e = escapeHtml(t);
      escCache.set(t, e);
    }
    return e;
  };
  const parsed = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      parsed.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // Case-constant templates (output depends only on site/tags/recent + depth) are
  // rendered once per depth and reused: header/footer/nav and the filler partials
  // are identical on every page. Disabled for the case if any loop variable shadows
  // site/tags/recent (the generator only ever uses p/t/h, so this stays on).
  const loopNames = new Set();
  const collectLoops = (ns) => {
    for (const n of ns) {
      if (n.k === 'f') {
        loopNames.add(n.n);
        collectLoops(n.b);
      } else if (n.k === 'i') {
        collectLoops(n.a);
        if (n.e !== null) collectLoops(n.e);
      }
    }
  };
  for (const nodes of parsed.values()) collectLoops(nodes);
  const constSet = new Set();
  if (!loopNames.has('site') && !loopNames.has('tags') && !loopNames.has('recent')) {
    const cache = new Map();
    for (const name of parsed.keys()) {
      if (analyzeConstant(parsed, name, new Map(), new Set(), cache)) constSet.add(name);
    }
  }
  const templates = new Map();
  for (const [name, nodes] of parsed) templates.set(name, compileTemplate(nodes, constSet));
  const rawBase = input.site.base_url;
  const base = rawBase.charCodeAt(rawBase.length - 1) === 47 ? rawBase.replace(/\/+$/, '') : rawBase;

  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push(f);
  }

  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
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

  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title, slugCache), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const link = (target) => {
      if (SCHEME_RE.test(target) || target.charCodeAt(0) === 47 || target.charCodeAt(0) === 35) return target;
      const hash = target.indexOf('#');
      const rel = hash === -1 ? target : target.slice(0, hash);
      const frag = hash === -1 ? '' : target.slice(hash);
      const path = rel === '' ? null : resolvePath(dirParts, rel);
      if (path !== null) {
        const pg = bySource.get(path);
        if (pg !== undefined) return `${pg.url}${frag}`;
        if (staticPaths.has(path)) return `${base}/${path}${frag}`;
      }
      broken.add(`broken-link ${s.path} -> ${target}`);
      return target;
    };
    const md = renderMarkdown(s.body, link, slugCache, esc);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of (s.data.tags ?? [])) {
      const slug = slugify(name, slugCache);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name, slugCache);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name, slugCache);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const cards = new Map();
  for (const p of posts) cards.set(p, cardOf(p));
  const pageOf = (s) => {
    const card = s.post ? cards.get(s) : cardOf(s);
    return Object.assign({}, card, {
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    });
  };

  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const X = { tpl: templates, E: esc, T: textOf, Y: truthy, M: memoRender };
  const baseScope = Object.create(null);
  baseScope.site = site;
  baseScope.tags = allTags;
  baseScope.recent = recent;
  const render = (name, vars) => {
    const fn = templates.get(name);
    if (fn === undefined) return null;
    const R = Object.assign(Object.create(baseScope), vars);
    return fn(R, X, 0);
  };

  const output = {};
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
