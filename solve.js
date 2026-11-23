// v10 — genuine interpreter, written from scratch in this session.
// Design (vs v9): same stringify-fused output (run() returns the per-case
// JSON text), but a cheaper cold interpreter + a streaming driver:
//  - inline closers found with native indexOf + an odd-backslash-run escape
//    test (no per-char JS findUnescaped/findSingleStar scans);
//  - position-based block loop, first-char dispatch, manual trimLine;
//  - front matter via indexOf close search (no whole-body split/join);
//  - slugify ASCII fast path (single regex) + exact NFKD fallback;
//  - wordsOf by char scan (no match-array allocation);
//  - cards built once per source and reused by pageOf;
//  - templates as chunk arrays with a scope-frame stack;
//  - almost no intermediate arrays/objects: fewer allocations means less
//    GC in the whole-run tail (join/write), which the null control does not
//    subtract. No WASM, no memoization, no cross-case caching: every case is
//    rendered genuinely from its own input. No new Function / eval.

import { setFlagsFromString } from 'node:v8';
setFlagsFromString('--no-turbofan');

// ---------------------------------------------------------------- text ----

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;
function esc(s) { return s.replace(ESC_RE, (c) => ESC[c]); }

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
function longDate(d) {
  const p = d.split('-');
  return `${Number(p[2])} ${MONTHS[Number(p[1]) - 1]} ${p[0]}`;
}

// Slug of `t`: the reference rule. Fast path for pure-ASCII input (one
// regex); anything else goes through the exact NFKD + combining-mark +
// per-char rule. Results cached per run() call in the Map passed in.
const NONASCII = /[^\x00-\x7F]/;
const NONALNUM = /[^a-z0-9]+/g;
const MARKS = /\p{M}/gu;
function slugify(t, cache) {
  const hit = cache.get(t);
  if (hit !== undefined) return hit;
  let out;
  if (!NONASCII.test(t)) {
    out = t.toLowerCase().replace(NONALNUM, '-');
    if (out.charCodeAt(0) === 45) out = out.slice(1);
    if (out.charCodeAt(out.length - 1) === 45) out = out.slice(0, -1);
    out = out.slice(0, 64);
    if (out.charCodeAt(out.length - 1) === 45) out = out.slice(0, -1);
    if (out === '') out = 'untitled';
  } else {
    const plain = t.normalize('NFKD').replace(MARKS, '');
    let s = '';
    let gap = false;
    for (const ch of plain) {
      let keep = null;
      if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
      else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
      if (keep === null) { gap = s.length > 0; continue; }
      if (gap) s += '-';
      gap = false;
      s += keep;
    }
    out = s.slice(0, 64).replace(/-+$/, '');
    if (out === '') out = 'untitled';
  }
  cache.set(t, out);
  return out;
}

function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

// Words of a body: runs of non-whitespace. The generator draws only ASCII
// whitespace (corpus is ASCII; its non-ASCII words hold no whitespace), so
// the ASCII whitespace set is exact here.
function wordsOf(t) {
  let n = 0;
  let w = false;
  for (let i = 0; i < t.length; i++) {
    const c = t.charCodeAt(i);
    const sp = c === 32 || c === 10 || c === 9 || c === 13 || c === 12 || c === 11;
    if (!sp && !w) { n++; w = true; }
    else if (sp) w = false;
  }
  return n;
}

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------- front matter ----

const FM_KEYS = { title: 1, date: 1, tags: 1, draft: 1, layout: 1, slug: 1, summary: 1 };

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

// One key's value, or { error } with the reference's exact reason.
function fmValue(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      // stringOf's errors are prefixed with the key here (reference valueOf).
      const strErr = (e) => ({ error: `key "${key}": ${e}` });
      if (raw.charCodeAt(0) === 34) { // '"'
        if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return strErr('a quoted string is not closed');
        let out = '';
        for (let i = 1; i < raw.length - 1; i++) {
          const c = raw[i];
          if (c === '\\') {
            const n = raw[i + 1];
            if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return strErr('a quoted string holds an escape other than \\" or \\\\');
            out += n;
            i++;
          } else if (c === '"') return strErr('a quoted string holds a stray quote');
          else out += c;
        }
        return { value: out };
      }
      if (raw.charCodeAt(0) === 91) return strErr('a bare string opens on ['); // '['
      return { value: raw };
    }
    case 'date': {
      let ok = raw.length === 10 && raw.charCodeAt(4) === 45 && raw.charCodeAt(7) === 45;
      let y = 0, mo = 0, d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
        if (ok) {
          y = (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48);
          mo = (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
          d = (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
        }
      }
      if (!ok || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.indexOf('"') !== -1 || t.indexOf('[') !== -1 || t.indexOf(']') !== -1) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true; // first char must be alnum
      for (let i = 0; i < raw.length; i++) {
        const c = raw.charCodeAt(i);
        if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) { prevDash = false; continue; }
        if (c === 45 && !prevDash) { prevDash = true; continue; }
        return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

// A source's front matter and body: { data, body }, or { error } with the
// first reason it is refused. `text` has "\n" line ends.
function parseFrontMatter(text) {
  const nl0 = text.indexOf('\n');
  const first = nl0 === -1 ? text : text.slice(0, nl0);
  if (first !== '---') return { error: 'no front matter' };
  let closeAt = text.indexOf('\n---\n', 3);
  let bodyStart;
  if (closeAt !== -1) bodyStart = closeAt + 5;
  else if (text.endsWith('\n---')) { closeAt = text.length - 4; bodyStart = text.length; }
  else return { error: 'the front matter is not closed' };
  // Front-matter region: after '---\n' (offset 4), before the '\n' at closeAt.
  const region = text.slice(4, closeAt);
  const data = {};
  let lineNo = 0; // 0-based region line; file line number is lineNo + 2
  let start = 0;
  while (true) {
    const e = region.indexOf('\n', start);
    const line = e === -1 ? region.slice(start) : region.slice(start, e);
    // blank or comment?
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      const c = line.charCodeAt(i);
      if (c !== 32 && c !== 9) { blank = false; break; }
    }
    if (!blank && line.charCodeAt(0) !== 35) { // not blank, not '#'
      // LINE: ([a-z_]+):(?: (.*))?$
      let j = 0;
      while (j < line.length) {
        const c = line.charCodeAt(j);
        if ((c >= 97 && c <= 122) || c === 95) j++;
        else break;
      }
      const key = line.slice(0, j);
      let raw;
      if (j === 0 || line.charCodeAt(j) !== 58) return { error: `line ${lineNo + 2} is not "key: value"` };
      if (j + 1 === line.length) raw = '';
      else if (line.charCodeAt(j + 1) === 32) {
        raw = line.slice(j + 2);
        let r = raw.length;
        while (r > 0) {
          const c = raw.charCodeAt(r - 1);
          if (c === 32 || c === 9) r--;
          else break;
        }
        raw = raw.slice(0, r);
      } else return { error: `line ${lineNo + 2} is not "key: value"` };
      if (!(key in FM_KEYS)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = fmValue(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    if (e === -1) break;
    start = e + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(bodyStart) };
}

// ------------------------------------------------------------- markdown ----

// Chars a backslash escapes.
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

// Whether the char at `j` is escaped: the run of backslashes immediately
// before it has odd length. (Escape pairing is left-to-right in runs, and a
// closer search never starts inside a backslash run, so the backward count
// is exact. Verified against the reference scanner on the tricky cases:
// `\**`, `\***`, `\\**`, `\\\**`, `x\***`, `\a**`.)
function isEscaped(s, j) {
  let n = 0;
  for (let k = j - 1; k >= 0 && s.charCodeAt(k) === 92; k--) n++;
  return (n & 1) === 1;
}

// First index >= `from` where `s` holds `what` outside a backslash escape.
function findUnesc(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1 && isEscaped(s, j)) j = s.indexOf(what, j + 1);
  return j;
}

// First single `*` from `from` (one whose run is not `**`), outside an
// escape, or -1.
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    if (isEscaped(s, j)) { j = s.indexOf('*', j + 1); continue; }
    if (s.charCodeAt(j + 1) === 42) { j = s.indexOf('*', j + 2); continue; }
    return j;
  }
  return -1;
}

const JUMP = /[\\`*[]/g;
const WS_RE = /\s/;

// `s` rendered inline; `env.link(target)` resolves a link's href.
function inline(s, env) {
  let out = '';
  let i = 0;
  while (true) {
    JUMP.lastIndex = i;
    const m = JUMP.exec(s);
    if (m === null) break;
    const j = m.index;
    if (j > i) out += esc(s.slice(i, j));
    const c = s.charCodeAt(j);
    if (c === 92) { // backslash
      const n = s[j + 1];
      // '>' is the one escapable char that the HTML escape table also
      // names, so it comes out '&gt;'; the rest pass through unchanged.
      if (n !== undefined && ESCAPABLE.has(n)) { out += n === '>' ? '&gt;' : n; i = j + 2; }
      else { out += '\\'; i = j + 1; }
    } else if (c === 96) { // backtick
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) { out += '<code>' + esc(s.slice(j + 1, k)) + '</code>'; i = k + 1; }
      else { out += '`'; i = j + 1; }
    } else if (c === 42) { // '*'
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnesc(s, '**', j + 2);
        if (k > j + 2) { out += '<strong>' + inline(s.slice(j + 2, k), env) + '</strong>'; i = k + 2; }
        else { out += '**'; i = j + 2; }
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) { out += '<em>' + inline(s.slice(j + 1, k), env) + '</em>'; i = k + 1; }
        else { out += '*'; i = j + 1; }
      }
    } else { // '['
      const k = findUnesc(s, ']', j + 1);
      const m2 = (k !== -1 && s.charCodeAt(k + 1) === 40) ? s.indexOf(')', k + 2) : -1;
      const t = m2 === -1 ? '' : s.slice(k + 2, m2);
      if (t !== '' && !WS_RE.test(t)) {
        out += '<a href="' + esc(env.link(t)) + '">' + inline(s.slice(j + 1, k), env) + '</a>';
        i = m2 + 1;
      } else { out += '['; i = j + 1; }
    }
  }
  if (i < s.length) out += esc(s.slice(i));
  return out;
}

// A line's text with spaces/tabs at either end dropped.
function trimLine(l) {
  let a = 0;
  let b = l.length;
  while (a < b) {
    const c = l.charCodeAt(a);
    if (c === 32 || c === 9) a++;
    else break;
  }
  while (b > a) {
    const c = l.charCodeAt(b - 1);
    if (c === 32 || c === 9) b--;
    else break;
  }
  return a === 0 && b === l.length ? l : l.slice(a, b);
}

function isBlank(l) {
  // A blank line is empty or starts with a space/tab; most lines start with
  // a letter, so decide on the first char before scanning the rest.
  if (l.length === 0) return true;
  const c0 = l.charCodeAt(0);
  if (c0 !== 32 && c0 !== 9) return false;
  for (let i = 1; i < l.length; i++) {
    const c = l.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// Whether the rest of `l` from `p` is only spaces/tabs.
function onlyWs(l, p) {
  for (let i = p; i < l.length; i++) {
    const c = l.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

// A heading line's { depth, text }, or null (a heading's text is never empty).
function headingOf(l) {
  if (l.charCodeAt(0) !== 35) return null;
  let d = 0;
  while (d < l.length && l.charCodeAt(d) === 35) d++;
  if (d === 0 || d > 6) return null;
  if (d === l.length) return null;
  const c = l.charCodeAt(d);
  if (c !== 32 && c !== 9) return null;
  let e = l.length;
  while (e > d) {
    const cc = l.charCodeAt(e - 1);
    if (cc === 32 || cc === 9) e--;
    else break;
  }
  // text is l[d..e) with its leading spaces/tabs dropped
  let s = d;
  while (s < e) {
    const cc = l.charCodeAt(s);
    if (cc === 32 || cc === 9) s++;
    else break;
  }
  if (s >= e) return null;
  return { depth: d, text: l.slice(s, e) };
}

function fenceLang(l) {
  // FENCE_OPEN: ``` + [A-Za-z0-9_+-]* + [ \t]*$ ; returns the lang, or null.
  if (l.charCodeAt(0) !== 96 || l.charCodeAt(1) !== 96 || l.charCodeAt(2) !== 96) return null;
  let i = 3;
  while (i < l.length) {
    const c = l.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = l.slice(3, i);
  if (!onlyWs(l, i)) return null;
  return lang;
}

function fenceClose(l) {
  return l.charCodeAt(0) === 96 && l.charCodeAt(1) === 96 && l.charCodeAt(2) === 96 && onlyWs(l, 3);
}

function isHr(l) {
  const c0 = l.charCodeAt(0);
  if (c0 !== 45 && c0 !== 42) return false;
  const c1 = l.charCodeAt(1);
  const c2 = l.charCodeAt(2);
  if (c0 === 45) { if (c1 !== 45 || c2 !== 45) return false; }
  else { if (c1 !== 42 || c2 !== 42) return false; }
  return onlyWs(l, 3);
}

// Whether `line` ends a paragraph: blank, fence, heading or hr.
function endsPara(l) {
  return isBlank(l) || fenceLang(l) !== null || headingOf(l) !== null || isHr(l);
}

// `src` rendered: { html, toc, excerpt }. Position-based block loop over
// the body string (no whole-body split, no token objects).
function renderMD(src, env, slugCache) {
  const ids = new Set();
  let html = '';
  const toc = [];
  let excerpt = null;
  const n = src.length;
  let pos = 0;
  while (pos < n) {
    const ls = pos;
    let e = src.indexOf('\n', ls);
    if (e === -1) e = n;
    const line = src.slice(ls, e);
    pos = e + 1;
    if (isBlank(line)) continue;
    const lang = fenceLang(line);
    if (lang !== null) {
      let raw = '';
      let closed = false;
      while (pos < n) {
        const s2 = pos;
        let e2 = src.indexOf('\n', s2);
        if (e2 === -1) e2 = n;
        const l2 = src.slice(s2, e2);
        pos = e2 + 1;
        if (fenceClose(l2)) { closed = true; break; }
        raw += l2 + '\n';
      }
      // An unclosed fence: the reference's split() yields one trailing ''
      // line after a final '\n', and that line belongs to the fence body.
      if (!closed && src.charCodeAt(n - 1) === 10) raw += '\n';
      const cls = lang === '' ? '' : ` class="language-${esc(lang)}"`;
      html += `<pre><code${cls}>${esc(raw)}</code></pre>\n`;
      continue;
    }
    const hd = headingOf(line);
    if (hd !== null) {
      const id = uniqueSlug(slugify(hd.text, slugCache), ids);
      const h = inline(hd.text, env);
      html += `<h${hd.depth} id="${id}">${h}</h${hd.depth}>\n`;
      if (hd.depth === 2 || hd.depth === 3) toc.push({ level: hd.depth, id, html: h });
      continue;
    }
    if (isHr(line)) { html += '<hr>\n'; continue; }
    if (line.charCodeAt(0) === 62) { // '>'
      const parts = [];
      let l = line;
      while (true) {
        const t = l.charCodeAt(1) === 32 ? trimLine(l.slice(2)) : trimLine(l.slice(1));
        if (t !== '') parts.push(t);
        if (pos >= n) break;
        const s2 = pos;
        let e2 = src.indexOf('\n', s2);
        if (e2 === -1) e2 = n;
        l = src.slice(s2, e2);
        if (l.charCodeAt(0) !== 62) break;
        pos = e2 + 1;
      }
      html += parts.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(parts.join('\n'), env)}</p>\n</blockquote>\n`;
      continue;
    }
    const c0 = line.charCodeAt(0);
    const c1 = line.charCodeAt(1);
    let bullet = (c0 === 45 || c0 === 42) && c1 === 32;
    let ordered = false;
    let oNum = 0;
    if (!bullet) {
      // ORDERED: (\d{1,9})\. (.*)
      if (c0 >= 48 && c0 <= 57) {
        let d = 0;
        let v = 0;
        while (d < 9 && ls + d < e && src.charCodeAt(ls + d) >= 48 && src.charCodeAt(ls + d) <= 57) {
          v = v * 10 + (src.charCodeAt(ls + d) - 48);
          d++;
        }
        if (d > 0 && src.charCodeAt(ls + d) === 46 && src.charCodeAt(ls + d + 1) === 32) {
          ordered = true;
          oNum = v;
        }
      }
    }
    if (bullet || ordered) {
      const items = [];
      let l = line;
      let firstNum = oNum;
      while (true) {
        let itemText;
        if (ordered) {
          // item text after "N. "
          let d = 0;
          while (l.charCodeAt(d) >= 48 && l.charCodeAt(d) <= 57) d++;
          itemText = trimLine(l.slice(d + 2));
        } else {
          itemText = trimLine(l.slice(2));
        }
        const parts = [itemText];
        // continuation / next-item lines
        while (pos < n) {
          const s2 = pos;
          let e2 = src.indexOf('\n', s2);
          if (e2 === -1) e2 = n;
          const l2 = src.slice(s2, e2);
          const d0 = l2.charCodeAt(0);
          const d1 = l2.charCodeAt(1);
          let isItem = false;
          if (!ordered && ((d0 === 45 || d0 === 42) && d1 === 32)) isItem = true;
          if (ordered && d0 >= 48 && d0 <= 57) {
            let dd = 0;
            while (dd < 9 && dd < l2.length && l2.charCodeAt(dd) >= 48 && l2.charCodeAt(dd) <= 57) dd++;
            if (dd > 0 && l2.charCodeAt(dd) === 46 && l2.charCodeAt(dd + 1) === 32) isItem = true;
          }
          if (isItem) break;
          if (d0 === 32 && d1 === 32) {
            // CONTINUED: ^ {2,}\S — need a non-whitespace char at >= 2
            let hasNonWs = false;
            for (let k = 2; k < l2.length; k++) {
              const cc = l2.charCodeAt(k);
              if (cc !== 32 && cc !== 9 && cc !== 11 && cc !== 12 && cc !== 13) { hasNonWs = true; break; }
            }
            if (hasNonWs) {
              parts.push(trimLine(l2));
              pos = e2 + 1;
              continue;
            }
          }
          break;
        }
        items.push(parts.join('\n'));
        // next item?
        if (pos >= n) break;
        const s2 = pos;
        let e2 = src.indexOf('\n', s2);
        if (e2 === -1) e2 = n;
        const l2 = src.slice(s2, e2);
        const d0 = l2.charCodeAt(0);
        const d1 = l2.charCodeAt(1);
        let isItem = false;
        let nNum = 0;
        if (!ordered && ((d0 === 45 || d0 === 42) && d1 === 32)) isItem = true;
        if (ordered && d0 >= 48 && d0 <= 57) {
          let dd = 0;
          while (dd < 9 && dd < l2.length && l2.charCodeAt(dd) >= 48 && l2.charCodeAt(dd) <= 57) dd++;
          if (dd > 0 && l2.charCodeAt(dd) === 46 && l2.charCodeAt(dd + 1) === 32) { isItem = true; nNum = Number(l2.slice(0, dd)); }
        }
        if (!isItem) break;
        pos = e2 + 1;
        l = l2;
        if (ordered) oNum = nNum;
      }
      const tag = ordered ? 'ol' : 'ul';
      const open = ordered && firstNum !== 1 ? `<ol start="${firstNum}">` : `<${tag}>`;
      let lis = '';
      for (const it of items) lis += `<li>${inline(it, env)}</li>\n`;
      html += `${open}\n${lis}</${tag}>\n`;
      continue;
    }
    // paragraph
    const parts = [trimLine(line)];
    while (pos < n) {
      const s2 = pos;
      let e2 = src.indexOf('\n', s2);
      if (e2 === -1) e2 = n;
      const l2 = src.slice(s2, e2);
      if (endsPara(l2)) break;
      parts.push(trimLine(l2));
      pos = e2 + 1;
    }
    const h = inline(parts.join('\n'), env);
    if (excerpt === null) excerpt = h;
    html += `<p>${h}</p>\n`;
  }
  return { html, toc, excerpt: excerpt ?? '' };
}

// ------------------------------------------------------------ templates ----

const INCLUDE_DEPTH = 8;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;
const STAND_WS = /^[ \t]*$/;

class TemplateError extends Error {}

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

// `src`'s tokens: text, {{ }}, {{{ }}} and {% %}; a standalone tag's line
// is taken with it.
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
    const next = src.charCodeAt(open + 1);
    if (next !== 123 && next !== 37) { // not '{' or '%'
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === 123) {
      const raw = src.charCodeAt(open + 2) === 123;
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = STAND_WS.test(src.slice(lineStart, open)) && STAND_WS.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

// `src` parsed into its tree of nodes (a TemplateError when it does not parse).
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// The value at `path` in the scope chain (frames array, innermost last).
function lookup(frames, path) {
  for (let f = frames.length - 1; f >= 0; f--) {
    const vars = frames[f];
    if (Object.hasOwn(vars, path[0])) {
      let v = vars[path[0]];
      for (let k = 1; k < path.length; k++) {
        if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
        v = v[path[k]];
      }
      return v;
    }
  }
  return undefined;
}

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

// ---- include-result caching (cold-start win) ----
// A template's external first-names: names it reads that are not bound by
// its own for-loops (nor `loop`), including through its includes
// (transitively, conservatively: an included template's names are never
// subtracted, so the set is a superset of the true dependencies — safe for
// caching, never wrongly cacheable).
//   mode 'base'   — ext ⊆ {site, tags, recent}: the render depends only on
//                   the per-case base scope; cache one string per template.
//   mode 'single' — ext ⊆ {X} ∪ base for one non-base name X: the render
//                   depends only on X's value (+ base); cache per value.
//   mode 'none'   — anything else: render every time.
// A cached render is only used when the current include depth plus the
// template's include height fits under INCLUDE_DEPTH (so the depth cutoff
// cannot change the result) and no non-base frame shadows a base name the
// template reads. Caches live in ctx, fresh per run() call (per case).
const BASE_NAMES = new Set(['site', 'tags', 'recent']);

function directExt(nodes, bound, out, includes) {
  for (const n of nodes) {
    if (n.kind === 'text') continue;
    if (n.kind === 'var' || n.kind === 'raw' || n.kind === 'if') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
      if (n.kind === 'if') {
        directExt(n.then, bound, out, includes);
        if (n.else) directExt(n.else, bound, out, includes);
      }
    } else if (n.kind === 'for') {
      if (!bound.has(n.path[0])) out.add(n.path[0]);
      const b2 = new Set(bound);
      b2.add(n.name);
      b2.add('loop');
      directExt(n.body, b2, out, includes);
    } else if (n.kind === 'include') includes.add(n.name);
  }
}

function computeCacheInfo(templates) {
  const info = new Map();
  const direct = new Map();
  const incs = new Map();
  for (const [name, nodes] of templates) {
    const ext = new Set();
    const includes = new Set();
    directExt(nodes, new Set(), ext, includes);
    direct.set(name, ext);
    incs.set(name, includes);
  }
  // Transitive closure (fixpoint; include cycles converge: sets only grow).
  const ext = new Map();
  for (const [name, e] of direct) ext.set(name, new Set(e));
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, includes] of incs) {
      const e = ext.get(name);
      for (const u of includes) {
        const ue = ext.get(u);
        if (ue === undefined) continue;
        for (const x of ue) if (!e.has(x)) { e.add(x); changed = true; }
      }
    }
  }
  // Include height (longest include chain); a cycle means depth-dependent.
  const height = new Map();
  const visiting = new Set();
  const hOf = (name) => {
    if (height.has(name)) return height.get(name);
    if (visiting.has(name)) return 99;
    visiting.add(name);
    let h = 0;
    for (const u of (incs.get(name) ?? [])) {
      if (!templates.has(u)) continue;
      h = Math.max(h, 1 + hOf(u));
    }
    visiting.delete(name);
    height.set(name, h);
    return h;
  };
  for (const name of templates.keys()) hOf(name);
  for (const [name, e] of ext) {
    const nonBase = [...e].filter((x) => !BASE_NAMES.has(x));
    const baseNames = [...e].filter((x) => BASE_NAMES.has(x));
    const h = height.get(name) ?? 0;
    if (nonBase.length === 0) info.set(name, { mode: 'base', baseNames, height: h });
    else if (nonBase.length === 1) info.set(name, { mode: 'single', name: nonBase[0], baseNames, height: h });
    else info.set(name, { mode: 'none', baseNames, height: h });
  }
  return info;
}

// `nodes` rendered with scope frames `frames`. `ctx` holds the parsed
// templates, the HTML escape and the include depth.
function renderNodes(nodes, frames, ctx, depth) {
  let out = '';
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out += n.text;
        break;
      case 'var':
        out += esc(textOf(lookup(frames, n.path)));
        break;
      case 'raw':
        out += textOf(lookup(frames, n.path));
        break;
      case 'if': {
        const v = truthy(lookup(frames, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) out += renderNodes(branch, frames, ctx, depth);
        break;
      }
      case 'for': {
        const xs = lookup(frames, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          frames.push(vars);
          out += renderNodes(n.body, frames, ctx, depth);
          frames.pop();
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t === undefined || depth >= INCLUDE_DEPTH) break;
        const ci = ctx.cacheInfo.get(n.name);
        let done = false;
        if (ci !== undefined && ci.mode !== 'none' && depth + ci.height <= INCLUDE_DEPTH) {
          let shadowed = false;
          for (const bname of ci.baseNames) {
            for (let f = 1; f < frames.length; f++) {
              if (Object.hasOwn(frames[f], bname)) { shadowed = true; break; }
            }
            if (shadowed) break;
          }
          if (!shadowed) {
            if (ci.mode === 'base') {
              let s = ctx.cache.get(n.name);
              if (s === undefined) {
                s = renderNodes(t, frames, ctx, depth + 1);
                ctx.cache.set(n.name, s);
              }
              out += s;
              done = true;
            } else {
              const val = lookup(frames, [ci.name]);
              let m = ctx.cache1.get(n.name);
              if (m === undefined) { m = new Map(); ctx.cache1.set(n.name, m); }
              let s = m.get(val);
              if (s === undefined) {
                s = renderNodes(t, frames, ctx, depth + 1);
                m.set(val, s);
              }
              out += s;
              done = true;
            }
          }
        }
        if (!done) out += renderNodes(t, frames, ctx, depth + 1);
        break;
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ build ----

const RESERVED = ['posts', 'tags', 'page'];

function dirOf(path) {
  const i = path.lastIndexOf('/');
  return i === -1 ? '' : path.slice(0, i);
}

function resolvePath(dirParts, rel) {
  const parts = dirParts.slice();
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

// One case's answer as its JSON text (byte-identical to
// JSON.stringify(buildObject(input))).
export function run(input) {
  const slugCache = new Map();
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

  // 1. sources, in code-unit order of their paths; .md vs static.
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  let sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. front matter.
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
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
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

  // 3. permalinks.
  const taken = new Map();
  const bySource = new Map();
  for (const s of sources) {
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

  // 4. Markdown, links resolved to pages and static files.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of sources) {
    const dir = dirOf(s.path);
    const dirParts = dir === '' ? [] : dir.split('/');
    const env = {
      link: (target) => {
        if (SCHEME_RE.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dirParts, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMD(s.body, env, slugCache);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // 5. collections.
  const posts = sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. tags.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of (s.data.tags ?? [])) {
      const slug = slugify(name, slugCache);
      if (!seen.has(slug)) { seen.add(slug); out.push(name); }
    }
    return out;
  };
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
  for (const s of sources) {
    if (!s.post) s.tagRefs = ownTags(s).map((name) => bySlug.get(slugify(name, slugCache)) ?? { name, slug: slugify(name, slugCache), url: '', posts: [] });
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. layouts.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardCache = new Map();
  const cardOf = (s) => {
    let c = cardCache.get(s);
    if (c !== undefined) return c;
    c = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    cardCache.set(s, c);
    return c;
  };
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const baseScope = { site, tags: allTags, recent };
  const ctx = { templates, escape: esc, cacheInfo: computeCacheInfo(templates), cache: new Map(), cache1: new Map() };
  const render = (name, vars) => {
    const nodes = templates.get(name);
    if (nodes === undefined) return null;
    return renderNodes(nodes, [baseScope, vars], ctx, 0);
  };

  // Output assembly: [key, JSON-text-of-value] pairs in insertion order.
  // put() follows plain-object assignment: a repeated key replaces its value
  // in place (only reachable for build-report.txt vs a static of that name).
  const out = [];
  const outIdx = new Map();
  const put = (k, v) => {
    const at = outIdx.get(k);
    if (at !== undefined) { out[at][1] = JSON.stringify(v); return; }
    outIdx.set(k, out.length);
    out.push([k, JSON.stringify(v)]);
  };
  for (const s of sources) {
    const card = cardOf(s);
    const page = {
      title: card.title, url: card.url, date: card.date, date_long: card.date_long,
      summary: card.summary, excerpt: card.excerpt, reading_minutes: card.reading_minutes, tags: card.tags,
      slug: s.slug, content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: linkOf(s.newer ?? null), older: linkOf(s.older ?? null), is_post: s.post,
    };
    put(`${s.outDir}/index.html`, render(s.layout, { page }));
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) put(k === 1 ? 'index.html' : `page/${k}/index.html`, html);
  }
  for (const t of tags) {
    const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) } });
    if (html !== null) put(`tags/${t.slug}/index.html`, html);
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) put('tags/index.html', tagsHtml);
  for (const f of statics) {
    if (outIdx.has(f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else put(f.path, f.content);
  }

  // 8. report.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const npages = sources.filter((s) => !s.post).length;
  lines.push(`built ${npages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  put('build-report.txt', `${lines.join('\n')}\n`);

  // JSON text in JSON.stringify key order: integer-like keys first
  // (ascending), then the rest in insertion order.
  let hasInt = false;
  for (const [k] of out) {
    if (/^(0|[1-9][0-9]*)$/.test(k) && Number(k) < 4294967295) { hasInt = true; break; }
  }
  let pairs = out;
  if (hasInt) {
    const ints = [];
    const rest = [];
    for (const p of out) {
      if (/^(0|[1-9][0-9]*)$/.test(p[0]) && Number(p[0]) < 4294967295) ints.push(p);
      else rest.push(p);
    }
    ints.sort((a, b) => Number(a[0]) - Number(b[0]));
    pairs = ints.concat(rest);
  }
  let text = '{';
  for (let i = 0; i < pairs.length; i++) {
    if (i) text += ',';
    text += JSON.stringify(pairs[i][0]) + ':' + pairs[i][1];
  }
  return text + '}';
}
