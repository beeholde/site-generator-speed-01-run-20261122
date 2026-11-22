// Fast drop-in for makefun-site 1.0.0 — written from scratch for this competition.
// Same answers as the reference on every input, produced by a fused single-pass
// Markdown renderer, chunked inline rendering (no per-character escaping), an
// index-driven front-matter reader, and a template interpreter whose variable
// lookups are resolved to a scope depth at parse time.

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
/** `text` with & < > " and ' escaped. */
function esc(text) {
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

const SLUG_MAX = 64;
const NON_ASCII = /[^\x00-\x7F]/;
/** The slug of `text` (NFKD, marks dropped, A-Z lowered, runs of other chars one "-"). */
function slugifyRaw(text) {
  let plain = text;
  if (NON_ASCII.test(text)) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
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
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}
/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const ws = c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
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

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');
const RESERVED = ['posts', 'tags', 'page'];

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

function isBlankLine(line) {
  for (let i = 0; i < line.length; i++) if (line[i] !== ' ' && line[i] !== '\t') return false;
  return true;
}
function rtrimSpaces(s) {
  let e = s.length;
  while (e > 0 && (s[e - 1] === ' ' || s[e - 1] === '\t')) e--;
  return s.slice(0, e);
}
function trimSpaces(s) {
  let a = 0;
  let e = s.length;
  while (a < e && (s[a] === ' ' || s[a] === '\t')) a++;
  while (e > a && (s[e - 1] === ' ' || s[e - 1] === '\t')) e--;
  return s.slice(a, e);
}

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
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

function isDigits(s, a, b) {
  for (let i = a; i < b; i++) if (s[i] < '0' || s[i] > '9') return false;
  return true;
}
function isName(s) {
  if (s.length === 0) return false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-')) return false;
  }
  return true;
}
function isSlug(s) {
  if (s.length === 0 || s.length > 64) return false;
  // [a-z0-9]+(-[a-z0-9]+)*
  let i = 0;
  const seg = () => {
    const st = i;
    while (i < s.length && ((s[i] >= 'a' && s[i] <= 'z') || (s[i] >= '0' && s[i] <= '9'))) i++;
    return i > st;
  };
  if (!seg()) return false;
  while (i < s.length) {
    if (s[i] !== '-') return false;
    i++;
    if (!seg()) return false;
  }
  return true;
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-' && isDigits(raw, 0, 4) && isDigits(raw, 5, 7) && isDigits(raw, 8, 10);
      const y = ok ? Number(raw.slice(0, 4)) : 0;
      const mo = ok ? Number(raw.slice(5, 7)) : 0;
      const d = ok ? Number(raw.slice(8, 10)) : 0;
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) {
        return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      }
      return { value: raw };
    }
    case 'tags': {
      if (raw.length < 2 || raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let i = 0; i < t.length; i++) if (t[i] === '"' || t[i] === '[' || t[i] === ']') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return isName(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return isSlug(raw) ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

/** A source's front matter and body: { data, body }, or { error }. */
function parseFrontMatter(text) {
  const firstNl = text.indexOf('\n');
  const firstEnd = firstNl === -1 ? text.length : firstNl;
  if (text.slice(0, firstEnd) !== '---') return { error: 'no front matter' };
  if (firstNl === -1) return { error: 'the front matter is not closed' };
  const data = {};
  let i = firstNl + 1;
  let lineNo = 2;
  while (true) {
    const nl = text.indexOf('\n', i);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(i, end);
    if (line === '---') {
      if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
      return { data, body: nl === -1 ? '' : text.slice(nl + 1) };
    }
    if (nl === -1) return { error: 'the front matter is not closed' };
    if (!isBlankLine(line) && line[0] !== '#') {
      // key: value — key of a-z and _, colon, one space, value
      let k = 0;
      while (k < line.length && ((line[k] >= 'a' && line[k] <= 'z') || line[k] === '_')) k++;
      if (k === 0 || line[k] !== ':' || (k + 1 < line.length && line[k + 1] !== ' ')) {
        return { error: `line ${lineNo} is not "key: value"` };
      }
      const key = line.slice(0, k);
      const raw = rtrimSpaces(k + 1 < line.length ? line.slice(k + 2) : '');
      if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    i = nl + 1;
    lineNo++;
  }
}

// ---------------------------------------------------------------- Markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const WS_RE = /\s/;

function isLangChar(c) {
  return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-';
}
function onlySpacesTabs(s, from) {
  for (let i = from; i < s.length; i++) if (s[i] !== ' ' && s[i] !== '\t') return false;
  return true;
}
/** Fence-open language of `line`, or null when it is not a fence open. */
function fenceOpen(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let j = 3;
  while (j < line.length && isLangChar(line[j])) j++;
  if (!onlySpacesTabs(line, j)) return null;
  return line.slice(3, j);
}
function fenceClose(line) {
  return line[0] === '`' && line[1] === '`' && line[2] === '`' && onlySpacesTabs(line, 3);
}
/** A heading line's level and text, or null. */
function headingOf(line) {
  let n = 0;
  while (n < line.length && line[n] === '#') n++;
  if (n < 1 || n > 6) return null;
  if (line[n] !== ' ' && line[n] !== '\t') return null;
  const text = trimSpaces(line.slice(n));
  if (text === '') return null;
  return { depth: n, text };
}
function isHR(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  return onlySpacesTabs(line, 3);
}
function endsParagraph(line) {
  if (line === '') return true;
  const c = line[0];
  if (c === '`') return fenceOpen(line) !== null;
  if (c === '#') return headingOf(line) !== null;
  if (c === '-' || c === '*') return isHR(line);
  if (c === ' ' || c === '\t') return isBlankLine(line);
  return false;
}
/** Bullet item text of `line`, or null; ordered {start, text} or null. */
function bulletOf(line) {
  if ((line[0] === '-' || line[0] === '*') && line[1] === ' ') return line.slice(2);
  return null;
}
function orderedOf(line) {
  let d = 0;
  while (d < line.length && line[d] >= '0' && line[d] <= '9') d++;
  if (d < 1 || d > 9) return null;
  if (line[d] !== '.' || line[d + 1] !== ' ') return null;
  return { start: Number(line.slice(0, d)), text: line.slice(d + 2) };
}
function isContinued(line) {
  let i = 0;
  while (i < line.length && line[i] === ' ') i++;
  if (i < 2 || i >= line.length) return false;
  const c = line[i];
  return c !== ' ' && c !== '\t' && c !== '\r' && c !== '\f' && c !== '\v';
}

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  let j = from;
  while (true) {
    const b = s.indexOf('\\', j);
    const w = s.indexOf(what, j);
    if (w === -1) return -1;
    if (b !== -1 && b < w) {
      if (b + 1 < s.length && ESCAPABLE.has(s[b + 1])) j = b + 2;
      else j = b + 1;
      continue;
    }
    return w;
  }
}
/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = from;
  while (true) {
    const b = s.indexOf('\\', j);
    const w = s.indexOf('*', j);
    if (w === -1) return -1;
    if (b !== -1 && b < w) {
      if (b + 1 < s.length && ESCAPABLE.has(s[b + 1])) j = b + 2;
      else j = b + 1;
      continue;
    }
    if (s[w + 1] === '*') {
      j = w + 2;
      continue;
    }
    return w;
  }
}

/** `s` rendered inline; `env.link(target)` is a link's href. */
function inline(s, env) {
  let out = '';
  let i = 0;
  const re = /[\\`*\[]/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const j = m.index;
    const c = m[0];
    if (c === '\\') {
      if (j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
        out += esc(s.slice(i, j)) + s[j + 1];
        i = j + 2;
        re.lastIndex = i;
      } else re.lastIndex = j + 1;
      continue;
    }
    if (c === '`') {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        out += esc(s.slice(i, j)) + `<code>${esc(s.slice(j + 1, k))}</code>`;
        i = k + 1;
        re.lastIndex = i;
      } else re.lastIndex = j + 1;
      continue;
    }
    if (c === '*') {
      if (s[j + 1] === '*') {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          out += esc(s.slice(i, j)) + `<strong>${inline(s.slice(j + 2, k), env)}</strong>`;
          i = k + 2;
          re.lastIndex = i;
        } else re.lastIndex = j + 2;
        continue;
      }
      const k = findSingleStar(s, j + 1);
      if (k > j + 1) {
        out += esc(s.slice(i, j)) + `<em>${inline(s.slice(j + 1, k), env)}</em>`;
        i = k + 1;
        re.lastIndex = i;
      } else re.lastIndex = j + 1;
      continue;
    }
    const k = findUnescaped(s, ']', j + 1);
    const p = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = p === -1 ? '' : s.slice(k + 2, p);
    if (target !== '' && !WS_RE.test(target)) {
      out += esc(s.slice(i, j)) + `<a href="${esc(env.link(target))}">${inline(s.slice(j + 1, k), env)}</a>`;
      i = p + 1;
      re.lastIndex = i;
      continue;
    }
    re.lastIndex = j + 1;
  }
  out += esc(s.slice(i));
  return out;
}

/**
 * `src` rendered: its HTML, table of contents and excerpt. Fused lex+render in
 * one pass over the lines; `slugOf` caches slugs for this page's heading ids.
 */
function renderMarkdown(src, env, slugOf) {
  const lines = src.split('\n');
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line === '') {
      i++;
      continue;
    }
    const c0 = line[0];
    if (c0 === '`') {
      const lang = fenceOpen(line);
      if (lang !== null) {
        i++;
        const body = [];
        while (i < n && !fenceClose(lines[i])) body.push(lines[i++]);
        i++;
        const code = body.length === 0 ? '' : `${body.map((l) => esc(l)).join('\n')}\n`;
        blocks.push(`<pre><code${lang === '' ? '' : ` class="language-${esc(lang)}"`}>${code}</code></pre>\n`);
        continue;
      }
    } else if (c0 === '#') {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugOf(heading.text), ids);
        const html = inline(heading.text, env);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === '-' || c0 === '*') {
      if (isHR(line)) {
        blocks.push('<hr>\n');
        i++;
        continue;
      }
      const bText = bulletOf(line);
      if (bText !== null) {
        const items = [];
        while (i < n) {
          const l = lines[i];
          const t = bulletOf(l);
          if (t !== null) {
            items.push([trimSpaces(t)]);
            i++;
          } else if (isContinued(l)) {
            items[items.length - 1].push(trimSpaces(l));
            i++;
          } else break;
        }
        let lis = '';
        for (const item of items) lis += `<li>${inline(item.join('\n'), env)}</li>\n`;
        blocks.push(`<ul>\n${lis}</ul>\n`);
        continue;
      }
    } else if (c0 === '>') {
      const body = [];
      while (i < n && lines[i][0] === '>') {
        let l = lines[i].slice(1);
        if (l[0] === ' ') l = l.slice(1);
        body.push(trimSpaces(l));
        i++;
      }
      const kept = body.filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>\n`);
      continue;
    } else if (c0 >= '0' && c0 <= '9') {
      const oMatch = orderedOf(line);
      if (oMatch !== null) {
        const items = [];
        while (i < n) {
          const l = lines[i];
          const m = orderedOf(l);
          if (m !== null) {
            items.push([trimSpaces(m.text)]);
            i++;
          } else if (isContinued(l)) {
            items[items.length - 1].push(trimSpaces(l));
            i++;
          } else break;
        }
        const open = oMatch.start !== 1 ? `<ol start="${oMatch.start}">` : '<ol>';
        let lis = '';
        for (const item of items) lis += `<li>${inline(item.join('\n'), env)}</li>\n`;
        blocks.push(`${open}\n${lis}</ol>\n`);
        continue;
      }
    } else if (c0 === ' ' || c0 === '\t') {
      if (isBlankLine(line)) {
        i++;
        continue;
      }
    }
    const body = [trimSpaces(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimSpaces(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- Templates

const INCLUDE_DEPTH = 8;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INC_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
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
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ kind: 'text', text });
      text = '';
      tokens.push({ kind: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
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
    if (text !== '') tokens.push({ kind: 'text', text });
    text = '';
    tokens.push({ kind: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ kind: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  // Loop-variable names lexically in scope, innermost last; each var/if/for node
  // records how many frames down its first name is bound (lvl), so rendering
  // reads the scope stack in O(1) instead of walking it.
  const scopes = [];
  const lvlOf = (path) => {
    const first = path[0];
    if (first === 'loop') return scopes.length === 0 ? -1 : 0;
    for (let d = scopes.length - 1; d >= 0; d--) if (scopes[d] === first) return scopes.length - 1 - d;
    return -1;
  };
  for (const tok of tokenize(name, src)) {
    if (tok.kind === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.kind === 'var' || tok.kind === 'raw') body.push({ kind: tok.kind, path: tok.path, lvl: lvlOf(tok.path) });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), lvl: lvlOf(pathOf(name, m[2])), body: [] };
        body.push(node);
        scopes.push(m[1]);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), lvl: lvlOf(pathOf(name, m[2])), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        if (tag === 'endfor') scopes.pop();
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INC_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the frame `lvl` down, then own properties.
 * A node whose first name no lexically enclosing loop binds (lvl -1: a name the
 * including template's loop binds, or a root name) walks the chain at render time. */
function lookup(sc, node) {
  const path = node.path;
  let v;
  if (node.lvl >= 0) {
    const f = sc[sc.length - 1 - node.lvl];
    v = path[0] === 'loop' ? f.loop : f[path[0]];
  } else {
    let found = false;
    for (let d = sc.length - 1; d >= 0; d--) {
      const f = sc[d];
      if (path[0] === 'loop') {
        if (d === 0) break; // the root frame binds no loop
        v = f.loop;
        found = true;
        break;
      }
      if (Object.hasOwn(f, path[0])) {
        v = f[path[0]];
        found = true;
        break;
      }
    }
    if (!found) return undefined;
  }
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** `nodes` rendered into `out` in the scope chain `sc` (frames, root first). */
function renderNodes(nodes, sc, out, templates, depth) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var': {
        const v = lookup(sc, n);
        out.push(typeof v === 'string' ? esc(v) : esc(textOf(v)));
        break;
      }
      case 'raw':
        out.push(textOf(lookup(sc, n)));
        break;
      case 'if': {
        const v = truthy(lookup(sc, n));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, sc, out, templates, depth);
        break;
      }
      case 'for': {
        const xs = lookup(sc, n);
        if (!Array.isArray(xs)) break;
        const frame = {};
        const loop = { index: 0, first: true, last: false, length: xs.length };
        frame.loop = loop;
        sc.push(frame);
        for (let k = 0; k < xs.length; k++) {
          frame[n.name] = xs[k];
          loop.index = k + 1;
          loop.first = k === 0;
          loop.last = k === xs.length - 1;
          renderNodes(n.body, sc, out, templates, depth);
        }
        sc.pop();
        break;
      }
      case 'include': {
        const t = templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, sc, out, templates, depth + 1);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** One site's output tree: path -> text. */
export function build(input) {
  const slugCache = new Map();
  const slugOf = (text) => {
    const hit = slugCache.get(text);
    if (hit !== undefined) return hit;
    const s = slugifyRaw(text);
    slugCache.set(text, s);
    return s;
  };
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
  const output = {};

  // 1. Sources, in code-unit order of their paths; .md is a source, the rest static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Front matter, in order: refused, generator's own dir, post with no date,
  // layout no template has, draft.
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
  sources = kept;

  // 3. Permalinks: slug unique in its directory, in source order.
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
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

  // 4. Markdown, links resolved to pages and static files.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null) {
          const pg = bySource.get(path);
          if (pg !== undefined) return `${pg.url}${frag}`;
          if (staticPaths.has(path)) return `${base}/${path}${frag}`;
        }
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env, slugOf);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. Collections: posts newest first, then by slug; newer/older neighbours.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. Tags, grouped by slug, named as first met in collection order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugOf(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugOf(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugOf(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards and pages as templates read them (each card built once).
  const cardOf = (s) => {
    if (s.card === undefined) {
      s.card = {
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
    return s.card;
  };
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });

  // 7. Layouts: pages, index pages, tag pages, tags page, then static files.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, [{ site, tags: allTags, recent, ...vars }], out, templates, 0);
    return out.join('');
  };
  for (const s of sources) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
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
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // 8. The report, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = sources.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
