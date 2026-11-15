// parse.js — a fast CommonMark + GFM renderer, byte-compatible with marked 18.1.3
// (default options: gfm on, breaks off, pedantic off, async off).
//
// Written from scratch as a cursor-based single-pass renderer: the block pass walks
// the document with an index instead of repeatedly slicing the remaining string,
// and inline content is rendered straight to HTML (no intermediate token objects).
// The grammar decisions (which construct matches where) follow marked's rules so
// the output is identical, code unit for code unit.
//
// No dependencies, no network, no wall clock, no cross-call state: parse() is a
// pure function of its input.

const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

// Escape HTML special chars. `noEncode` keeps already-valid entities/refs intact.
function esc(str, noEncode) {
  if (noEncode) {
    if (!/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/.test(str)) return str;
    return str.replace(/[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g, (c) =>
      c === "&" ? "&amp;" : ESCAPES[c],
    );
  }
  if (!/[&<>"']/.test(str)) return str;
  return str.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

// Resolve numeric character references and bare ampersands the way marked does.
function unescapeEntities(str) {
  if (!/&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/.test(str)) return str;
  return str.replace(
    /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
    (m, dec, hex) => {
      if (dec === undefined && hex === undefined) return "&amp;";
      const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
      if (code === 0 || code > 1114111 || (code >= 55296 && code <= 57343)) return "\uFFFD";
      if (code === 38) return "&amp;";
      return String.fromCodePoint(code);
    },
  );
}

// Clean a URL the way marked's renderer does (encodeURI, keep %25 as %).
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(/%25/g, "%");
  } catch {
    return null;
  }
}

// Split a table row on unescaped pipes. `count` pads/truncates to the header size.
function splitCells(row, count) {
  const cells = row
    .replace(/\|/g, (m, off, s) => {
      let backslashes = false;
      for (let p = off - 1; p >= 0 && s[p] === "\\"; p--) backslashes = !backslashes;
      return backslashes ? "|" : " |";
    })
    .split(/ \|/);
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push("");
  }
  for (let i = 0; i < cells.length; i++) cells[i] = cells[i].trim().replace(/\\\|/g, "|");
  return cells;
}

// Remove trailing occurrences of `ch` (or trailing non-`ch` chars when `invert`).
function rtrim(str, ch, invert) {
  let n = str.length, s = 0;
  while (s < n) {
    const c = str.charAt(n - s - 1);
    if (c === ch && !invert) s++;
    else if (c !== ch && invert) s++;
    else break;
  }
  return str.slice(0, n - s);
}

// Drop trailing blank lines, keeping at most one blank line at the end.
function trimTrailingBlank(raw) {
  const lines = raw.split("\n");
  let t = lines.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(lines[t])) t--;
  return lines.length - t <= 2 ? raw : lines.slice(0, t + 1).join("\n");
}

// Normalize a link reference label for lookup.
function normLabel(label) {
  return label.trim().replace(/\s+/g, " ").toLowerCase().toUpperCase().toLowerCase();
}

// Find the closing bracket matching an opening one at `openIdx` semantics:
// returns the index of the matching close, -2 when brackets never balance, -1 none.
function findClosingBracket(str, open, close) {
  if (str.indexOf(open) === -1 && str.indexOf(close) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === "\\") i++;
    else if (str[i] === open) depth++;
    else if (str[i] === close && (--depth, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}

// Expand tabs to spaces, tracking the visual column.
function expandTabs(str, col = 0) {
  let out = "";
  for (const ch of str) {
    if (ch === "\t") {
      const n = 4 - (col % 4);
      out += " ".repeat(n);
      col += n;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}

// Compensate the indent of a fenced code block's closing fence (marked's Dt).
function fenceIndentComp(raw, text) {
  const m = raw.match(/^(\s+)(?:```)/);
  if (m === null) return text;
  const indent = m[1];
  return text
    .split("\n")
    .map((line) => {
      const lead = line.match(/^\s+/);
      if (lead === null) return line;
      return line.slice(Math.min(lead[0].length, indent.length));
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Grammar rules (the same decisions marked 18.1.3 makes, built the same way).
// `edit` lets one pattern be spliced into another, dropping stray `^` anchors
// from the spliced source, exactly like marked's rule builder.
// ---------------------------------------------------------------------------

function edit(src, flags = "") {
  let s = typeof src === "string" ? src : src.source;
  const api = {
    replace: (find, rep) => {
      let r = typeof rep === "string" ? rep : rep.source;
      r = r.replace(/(^|[^\[])\^/g, "$1");
      s = s.replace(find, r);
      return api;
    },
    regex: () => new RegExp(s, flags),
  };
  return api;
}

// Does this runtime support lookbehind? (Node 22 does.)
const HAS_LOOKBEHIND = (() => {
  try {
    return !!new RegExp("(?<=1)(?<!1)");
  } catch {
    return false;
  }
})();

const BLOCK_TAGS =
  "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul";

// Small reusable patterns used by the rule builder.
const RX = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  endingSpaceTabChar: /[ \t]$/,
  nonSpaceChar: /[^ ]/,
  newLineCharGlobal: /\n/g,
  tabCharGlobal: /\t/g,
  leadingSpaceTab: /^[ \t]+/,
  multipleSpaceGlobal: /\s+/g,
  blankLine: /^[ \t]*$/,
  doubleBlankLine: /\n[ \t]*\n[ \t]*$/,
  blockquoteStart: /^ {0,3}>/,
  blockquoteSetextReplace: /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g,
  blockquoteSetextReplace2: /^ {0,3}>[ \t]?/gm,
  blockquoteMarkerWhitespace: /^( {0,3}>)([ \t]+)/gm,
  listReplaceNesting: /^ {1,4}(?=( {4})*[^ ])/g,
  listIsTask: /^\[[ xX]\][ \t]+\S/,
  listReplaceTask: /^\[[ xX]\][ \t]+/,
  listTaskCheckbox: /\[[ xX]\]/,
  anyLine: /\n.*\n/,
  hrefBrackets: /^<(.*)>$/,
  tableDelimiter: /[:|]/,
  tableAlignChars: /^\||\| *$/g,
  tableRowBlankLine: /\n[ \t]*$/,
  tableAlignRight: /^ *-+: *$/,
  tableAlignCenter: /^ *:-+: *$/,
  tableAlignLeft: /^ *:-+ *$/,
  startATag: /^<a /i,
  endATag: /^<\/a>/i,
  startPreScriptTag: /^<(pre|code|kbd|script)(\s|>)/i,
  endPreScriptTag: /^<\/(pre|code|kbd|script)(\s|>)/i,
  startAngleBracket: /^</,
  endAngleBracket: />$/,
  unicodeAlphaNumeric: /[\p{L}\p{N}]/u,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
  spaceLine: /^ +$/gm,
};

// Cached per-indent regex builders (indent only ever matters 0..3).
function cachedRegex(build) {
  const cache = [];
  return (n) => {
    const k = Math.max(0, Math.min(3, n - 1));
    return cache[k] || (cache[k] = build(k));
  };
}
const listItemRegex = (bull) => new RegExp(`^( {0,3}${bull})((?:[ \t][^\n]*)?(?:\n|$))`);
const nextBulletRegex = cachedRegex(
  (n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\\n|$))`),
);
const hrRegex = cachedRegex(
  (n) => new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`),
);
const fencesBeginRegex = cachedRegex((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`));
const headingBeginRegex = cachedRegex((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`));
const htmlBeginRegex = cachedRegex(
  (n) =>
    new RegExp(
      `^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
      "i",
    ),
);
const blockquoteBeginRegex = cachedRegex((n) => new RegExp(`^ {0,${n}}>`));

// ---- block rules (gfm set) ----
const bullPattern = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const lheadingCore =
  /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const paragraphCore = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const htmlAttr = / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/;
const htmlComment = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

const blockRules = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences:
    /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  blockquote: edit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/)
    .replace(
      "paragraph",
      edit(paragraphCore)
        .replace("hr", /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
        .replace("heading", " {0,3}#{1,6}(?:\\s|$)")
        .replace("|lheading", "")
        .replace("|table", "")
        .replace("blockquote", " {0,3}>")
        .replace(
          "fences",
          " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)",
        )
        .replace("list", / {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/)
        .replace(
          "html",
          ` {0,3}(?:</?(?:${BLOCK_TAGS})(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
        )
        .regex(),
    )
    .regex(),
  list: edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, bullPattern).regex(),
  html: edit(
    "^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))",
    "i",
  )
    .replace("comment", htmlComment)
    .replace("tag", BLOCK_TAGS)
    .replace("attribute", htmlAttr)
    .regex(),
  def: edit(
    /^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/,
  )
    .replace("label", /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/)
    .replace(
      "title",
      /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/,
    )
    .regex(),
  table: edit(
    "^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)",
  )
    .replace("hr", /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
    .replace("heading", " {0,3}#{1,6}(?:\\s|$)")
    .replace("blockquote", " {0,3}>")
    .replace("code", "(?: {4}| {0,3}\t)[^\\n]")
    .replace(
      "fences",
      " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)",
    )
    .replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]")
    .replace(
      "html",
      ` {0,3}(?:</?(?:${BLOCK_TAGS})(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
    )
    .regex(),
  lheading: edit(lheadingCore)
    .replace(/bull/g, bullPattern)
    .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
    .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
    .replace(/blockquote/g, / {0,3}>/)
    .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
    .replace(
      /hr/g,
      / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
    )
    .replace(/html/g, / {0,3}<[^\n>]+>\n/)
    .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
    .regex(),
  paragraph: edit(paragraphCore)
    .replace(
      "hr",
      /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
    )
    .replace("heading", " {0,3}#{1,6}(?:\\s|$)")
    .replace("|lheading", "")
    .replace(
      "table",
      edit(
        "^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)",
      )
        .replace("hr", /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
        .replace("heading", " {0,3}#{1,6}(?:\\s|$)")
        .replace("blockquote", " {0,3}>")
        .replace("code", "(?: {4}| {0,3}\t)[^\\n]")
        .replace(
          "fences",
          " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)",
        )
        .replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]")
        .replace(
          "html",
          ` {0,3}(?:</?(?:${BLOCK_TAGS})(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
        )
        .regex(),
    )
    .replace("blockquote", " {0,3}>")
    .replace(
      "fences",
      " {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)",
    )
    .replace("list", " {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]")
    .replace(
      "html",
      ` {0,3}(?:</?(?:${BLOCK_TAGS})(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`,
    )
    .regex(),
  text: /^[^\n]+/,
};

// ---------------------------------------------------------------------------
// Inline rules (gfm set).
// ---------------------------------------------------------------------------

const PUNCT = /[\p{P}\p{S}]/u; // unicode punctuation/symbol
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const NOT_TILDE_PUNCT = /(?!~)[\p{P}\p{S}]/u;
const NOT_TILDE_PUNCT_SPACE = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_OR_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u;
const OPEN_QUOTE = /[\p{Pi}\p{Ps}"']/u;

const labelInner = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
// Block label pattern (marked's `le`): the `ref` in reflink/nolink.
const blockLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const labelPattern = edit(
  /(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/,
).replace("brackets", labelInner);
const labelSearch = edit(
  /(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/,
).replace("brackets", labelInner);
const refLabel = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;

const inlineRules = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,
  delLDelim: edit(/^~~?(?:((?!~)punct)|[^\s~])/, "u").replace(/punct/g, PUNCT).regex(),
  emStrongLDelim: edit(
    /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/,
    "u",
  )
    .replace(/punct/g, NOT_TILDE_PUNCT)
    .regex(),
  tag: edit(
    "^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>",
  )
    .replace("comment", edit(htmlComment).replace("(?:-->|$)", "-->").regex())
    .replace(
      "attribute",
      /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/,
    )
    .regex(),
  autolink: edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
    .replace("scheme", /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
    .replace(
      "email",
      /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/,
    )
    .regex(),
  link: edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
    .replace("label", labelPattern.regex())
    .replace("href", /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
    .replace(
      "title",
      /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/,
    )
    .regex(),
  reflink: edit(/^!?\[(label)\]\[(ref)\]/)
    .replace("label", labelPattern.regex())
    .replace("ref", blockLabel)
    .regex(),
  nolink: edit(/^!?\[(ref)\](?:\[\])?/).replace("ref", blockLabel).regex(),
  reflinkSearch: edit("reflink|nolink(?!\\()", "g")
    .replace(
      "reflink",
      edit(/^!?\[(label)\]\[(ref)\]/)
        .replace("label", labelSearch.regex())
        .replace("ref", refLabel)
        .regex(),
    )
    .replace(
      "nolink",
      edit(/^!?\[(ref)\](?:\[\])?/).replace("ref", refLabel).regex(),
    )
    .regex(),
  blockSkip: edit(/link|precode-code|html/, "g")
    .replace(
      "link",
      /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/,
    )
    .replace("precode-", HAS_LOOKBEHIND ? "(?<!`)()" : "(^^|[^`])")
    .replace("code", /(?<b>`+)[^`]+\k<b>(?!`)/)
    .replace("html", /<(?! )[^<>]*?>/)
    .regex(),
  anyPunctuation: edit(/\\(punct)/, "gu").replace(/punct/g, PUNCT).regex(),
  anyPunctuationOutsideCode: edit(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, "gu")
    .replace(/punct/g, PUNCT)
    .regex(),
  punctuation: edit(/^((?![*_])punctSpace)/, "u").replace(/punctSpace/g, PUNCT_SPACE).regex(),
  url: edit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
    .replace(
      "emailProtocol",
      edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/)
        .replace(
          /email/g,
          /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
        )
        .regex(),
    )
    .replace("protocol", /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/)
    .replace(
      "email",
      /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/,
    )
    .regex(),
  backpedal:
    /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  text: edit(
    /^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/,
  )
    .replace("protocol", /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/)
    .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
    .replace("wwwStart", HAS_LOOKBEHIND ? "(?<![^\\s*_~(])www\\." : "www\\.")
    .regex(),
};

// Emphasis/delimiter closer scans. Each pattern's first alternative only ever
// matches at the start of the scanned region (it carries a `^`); the rest of
// the alternatives scan forward. We split them so the scan can run on the full
// string with lastIndex instead of on a slice.
function splitFirstAlt(pattern) {
  let depth = 0, inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") { i++; continue; }
    if (inClass) { if (ch === "]") inClass = false; continue; }
    if (ch === "[") { inClass = true; continue; }
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "|" && depth === 0) return [pattern.slice(0, i), pattern.slice(i + 1)];
  }
  return [pattern, ""];
}
function buildRDelim(template, notPunctSpace, punctSpace, punct) {
  const src = template
    .replace(/notPunctSpace/g, notPunctSpace.source)
    .replace(/punctSpace/g, punctSpace.source)
    .replace(/punct/g, punct.source);
  const [first, rest] = splitFirstAlt(src);
  return {
    start: new RegExp(first.replace(/^\^/, ""), "yu"),
    scan: new RegExp(rest, "gu"),
  };
}
const RDELIM_AST = buildRDelim(
  "^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)",
  NOT_PUNCT_SPACE_OR_TILDE,
  NOT_TILDE_PUNCT_SPACE,
  NOT_TILDE_PUNCT,
);
const RDELIM_UND = buildRDelim(
  "^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)",
  NOT_PUNCT_SPACE,
  PUNCT_SPACE,
  PUNCT,
);
const RDELIM_DEL = buildRDelim(
  "^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)",
  NOT_PUNCT_SPACE,
  PUNCT_SPACE,
  PUNCT,
);

// Convert an anchored rule regex into a sticky one that matches at lastIndex:
// strip `^` anchors that sit at the start or after a top-level `|`.
function sticky(re) {
  const src = re.source;
  let out = "", depth = 0, inClass = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (ch === "\\") { out += src.slice(i, i + 2); i++; continue; }
    if (inClass) { out += ch; if (ch === "]") inClass = false; continue; }
    if (ch === "[") { inClass = true; out += ch; continue; }
    if (ch === "(") { depth++; out += ch; continue; }
    if (ch === ")") { depth--; out += ch; continue; }
    if (ch === "^" && depth === 0 && (out === "" || out.endsWith("|"))) continue;
    out += ch;
  }
  const flags = [...new Set((re.flags.replace(/[gy]/g, "") + "y"))].join("");
  return new RegExp(out, flags);
}

// Sticky versions of the block rules.
const B = {};
for (const k of Object.keys(blockRules)) B[k] = sticky(blockRules[k]);
// Sticky versions of the inline rules (except the RDelim scans above).
const I = {};
for (const k of ["escape", "code", "br", "del", "delLDelim", "emStrongLDelim", "tag", "autolink", "link", "reflink", "nolink", "url", "text"]) {
  I[k] = sticky(inlineRules[k]);
}

// ---------------------------------------------------------------------------
// Emphasis masking: hide link/code contents from the emphasis-closer scan.
// The mask is length-preserving, so indices in the masked string line up
// with indices in the real one.
// ---------------------------------------------------------------------------

function scanClosers(str) {
  let star = -1, und = -1, tilde = -1;
  const n = str.length;
  for (let i = 0; i < n; i++) {
    const ch = str[i];
    if (ch !== "*" && ch !== "_" && ch !== "~") continue;
    const prev = i === 0 ? "\n" : str[i - 1];
    let j = i + 1;
    while (j < n && str[j] === ch) j++;
    if (prev !== " " && prev !== "\t" && prev !== "\n" && prev !== "\r" && prev !== "\f") {
      if (ch === "~") tilde = i;
      else if (ch === "*") star = i;
      else und = i;
    }
    i = j - 1;
  }
  return { star, und, tilde };
}

function linkInText(str, ctx) {
  if (!str.includes("[")) return false;
  const linkRe = inlineRules.link;
  for (const m of str.matchAll(inlineRules.blockSkip)) {
    if (linkRe.test(m[0]) && str.charAt(m.index - 1) !== "!") return true;
  }
  for (const m of str.matchAll(inlineRules.reflinkSearch)) {
    const s = m[0];
    const r = s.lastIndexOf("[");
    if (
      !(s.charAt(0) === "!" || !Object.hasOwn(ctx.links, normLabel(s.slice(r + 1, -1)))) &&
      !(r > 1 && linkInText(s.slice(1, r - 1), ctx))
    )
      return true;
  }
  return false;
}

function maskInline(str, ctx) {
  let t = str;
  if (ctx.links && str.includes("[")) {
    const search = inlineRules.reflinkSearch;
    const maskRef = (match) => {
      const open = match.lastIndexOf("[");
      if (!Object.hasOwn(ctx.links, normLabel(match.slice(open + 1, -1)))) return match;
      if (open > 1 && match.charAt(0) !== "!") {
        const inner = match.slice(1, open - 1);
        if (linkInText(inner, ctx))
          return "[" + inner.replace(search, maskRef) + "][" + "a".repeat(match.length - open - 2) + "]";
      }
      return "[" + "a".repeat(match.length - 2) + "]";
    };
    t = t.replace(search, maskRef);
  }
  t = t.replace(inlineRules.anyPunctuationOutsideCode, (m, ticks, punct) =>
    punct
      ? "+".repeat(m.length)
      : ticks
        ? ticks + m.slice(ticks.length, -ticks.length).replace(/`/g, "+") + ticks
        : m,
  );
  t = t.replace(inlineRules.blockSkip, (m, _s, r) => {
    const o = r ? r.length : 0;
    return m.slice(0, o) + "[" + "a".repeat(m.length - o - 2) + "]";
  });
  return t;
}

// Does the link text contain a raw HTML tag that would swallow the link?
function linkTextHasHtml(src, pos, text, start) {
  if (!text.includes("<")) return false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (text[i] === "`") {
      I.code.lastIndex = i;
      const m = I.code.exec(text);
      if (m) { i += m[0].length - 1; continue; }
    }
    if (text[i] !== "<") continue;
    const rest = src.slice(pos + start + i);
    I.tag.lastIndex = 0;
    const m = I.tag.exec(rest) || (I.autolink.lastIndex = 0, I.autolink.exec(rest));
    if (m) {
      if (m[0].length > text.length - i) return true;
      i += m[0].length - 1;
    }
  }
  return false;
}

// Build a link/image from a matched `[text](href "title")` or reference.
// Returns null when the link must not be created (nested link inside a link).
function buildLink(t, dest, raw, ctx, textOnly) {
  const href = dest.href;
  const title = dest.title || null;
  const text = t[1].replace(RX.outputLinkReplace, "$1");
  const isImage = t[0].charAt(0) === "!";
  const savedInLink = ctx.state.inLink;
  const savedEmitted = ctx.state.linkEmitted;
  const savedRawBlock = ctx.state.inRawBlock;
  ctx.state.inLink = true;
  ctx.state.linkEmitted = false;
  const inner = inlineHtml(text, ctx);
  const emitted = ctx.state.linkEmitted;
  // Plain-text form of the link text (image alt text, and the textOnly
  // rendering). Re-tokenized under the same starting conditions; the shared
  // state is restored to exactly what the first pass left behind.
  let innerText = null;
  if (isImage || textOnly) {
    const postRaw = ctx.state.inRawBlock;
    ctx.state.linkEmitted = false;
    ctx.state.inRawBlock = savedRawBlock;
    innerText = inlineHtml(text, ctx, true);
    ctx.state.inRawBlock = postRaw;
  }
  ctx.state.linkEmitted = savedEmitted;
  ctx.state.inLink = savedInLink;
  if (!isImage) {
    if (emitted) {
      ctx.state.inRawBlock = savedRawBlock;
      return null;
    }
    ctx.state.linkEmitted = true;
  }
  return { isImage, href, title, inner, innerText, raw };
}

function renderLink(lk, textOnly) {
  if (textOnly) return lk.innerText;
  const cleaned = cleanUrl(lk.href);
  if (lk.isImage) {
    const alt = esc(lk.innerText, true);
    if (cleaned === null) return alt;
    let out = `<img src="${esc(cleaned, true)}" alt="${alt}"`;
    if (lk.title) out += ` title="${esc(lk.title, true)}"`;
    return out + ">";
  }
  if (cleaned === null) return lk.inner;
  const hrefAttr = esc(cleaned, true);
  let out = `<a href="${hrefAttr}"`;
  if (lk.title) out += ` title="${esc(lk.title, true)}"`;
  return out + ">" + lk.inner + "</a>";
}

// Try an inline link `[text](href "title")` at pos. Returns {html, len} or null.
function tryLink(src, pos, ctx, textOnly) {
  if (ctx.state.linkParenPossible === false) return null;
  I.link.lastIndex = pos;
  const t = I.link.exec(src);
  if (!t) return null;
  const n = t[0].charAt(0) === "!" ? 2 : 1;
  if (linkTextHasHtml(src, pos, t[1], n)) return null;
  let s = t[2].trim();
  if (RX.startAngleBracket.test(s)) {
    if (!RX.endAngleBracket.test(s)) return null;
    const l = rtrim(s.slice(0, -1), "\\");
    if ((s.length - l.length) % 2 === 0) return null;
  } else {
    const l = findClosingBracket(t[2], "(", ")");
    if (l === -2) return null;
    if (l > -1) {
      const h = (t[0].indexOf("!") === 0 ? 5 : 4) + t[1].length + l;
      t[2] = t[2].substring(0, l);
      t[0] = t[0].substring(0, h).trim();
      t[3] = "";
    }
  }
  const r = rtrim(t[0].slice(0, -1), "\\");
  if ((t[0].length - r.length) % 2 === 0) return null;
  let o = t[2];
  const i = t[3] ? t[3].slice(1, -1) : "";
  o = o.trim();
  if (RX.startAngleBracket.test(o)) o = o.slice(1, -1);
  const lk = buildLink(
    t,
    {
      href: o && o.replace(inlineRules.anyPunctuation, "$1"),
      title: i && i.replace(inlineRules.anyPunctuation, "$1"),
    },
    t[0],
    ctx,
    textOnly,
  );
  if (!lk) return null;
  return { html: renderLink(lk, textOnly), len: t[0].length };
}

// Try a reference link `[text][ref]` / `[text]` / `[text][]` at pos.
function tryReflink(src, pos, ctx, textOnly) {
  I.reflink.lastIndex = pos;
  let m = I.reflink.exec(src);
  if (!m) {
    I.nolink.lastIndex = pos;
    m = I.nolink.exec(src);
  }
  if (!m) return null;
  const n = m[0].charAt(0) === "!" ? 2 : 1;
  if (linkTextHasHtml(src, pos, m[1], n)) return null;
  const dest = ctx.links[normLabel(m[2] || m[1])];
  if (!dest) return { html: esc(m[0].charAt(0), true), len: 1 };
  const lk = buildLink(m, dest, m[0], ctx, textOnly);
  if (!lk) return null;
  return { html: renderLink(lk, textOnly), len: m[0].length };
}

// Try emphasis/strong at pos. Returns {html, len} or null.
function tryEmStrong(src, masked, pos, ctx, closers, prevChar) {
  I.emStrongLDelim.lastIndex = pos;
  const s = I.emStrongLDelim.exec(src);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const r = s[0][0];
  const o = prevChar === r;
  const i = pos;
  let l = i;
  while (l > 0 && masked[l - 1] === r) l--;
  const p = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? "";
  const h = p === "*" || p === "_" || !!inlineRules.punctuation.exec(p);
  let n = prevChar;
  if (l < i) n = p;
  const u = l < i ? h : !!inlineRules.punctuation.exec(n);
  if (s[4] && n && RX.unicodeAlphaNumeric.test(n)) return null;
  const d = s[1] || s[3] || "";
  if (!d || !n || u) {
    const k = [...s[0]].length - 1;
    let m = k, f = 0;
    const y = i - l + k;
    const R = !!p.trim() && (!!d || (r === "*" && !h));
    if (r !== "*" && r !== "_") return null;
    const rd = r === "*" ? RDELIM_AST : RDELIM_UND;
    const v = r === "*" ? closers.star : closers.und;
    const Q = i + k;
    if (v < Q) return null;
    let scanPos = i + k;
    rd.start.lastIndex = scanPos;
    const sm = rd.start.exec(masked);
    if (sm && sm.index === scanPos) scanPos += sm[0].length;
    rd.scan.lastIndex = scanPos;
    let match;
    while ((match = rd.scan.exec(masked)) !== null && !(match.index > v)) {
      const g = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!g) continue;
      const b = [...g].length;
      if (match[3] || match[4]) { m += b; continue; }
      else if (match[5] || match[6] || R) {
        if (o && (match[5] || match[6])) break;
        if (y % 3 && !((y + b) % 3)) { f += b; continue; }
      }
      if ((m -= b), m > 0) continue;
      const bb = Math.min(b, b + m + f);
      const te = match[0].codePointAt(0) > 0xffff ? 2 : 1;
      const M = src.slice(pos, match.index + te + bb);
      if (Math.min(k, bb) % 2) {
        const inner = M.slice(1, -1);
        return { html: "<em>" + inlineHtml(inner, ctx) + "</em>", len: M.length, inner };
      }
      const inner = M.slice(2, -2);
      return { html: "<strong>" + inlineHtml(inner, ctx) + "</strong>", len: M.length, inner };
    }
  }
  return null;
}

// Try strikethrough at pos. Returns {html, len} or null.
function tryDel(src, masked, pos, ctx, closers, prevChar) {
  I.delLDelim.lastIndex = pos;
  const s = I.delLDelim.exec(src);
  if (!s) return null;
  if (!(s[1] || "") || !prevChar || inlineRules.punctuation.exec(prevChar)) {
    const o = [...s[0]].length - 1;
    let p = o;
    const u = closers.tilde;
    const d = pos + o;
    if (u < d) return null;
    let scanPos = pos + o;
    RDELIM_DEL.start.lastIndex = scanPos;
    const sm = RDELIM_DEL.start.exec(masked);
    if (sm && sm.index === scanPos) scanPos += sm[0].length;
    RDELIM_DEL.scan.lastIndex = scanPos;
    let match;
    while ((match = RDELIM_DEL.scan.exec(masked)) !== null && !(match.index > u)) {
      const g = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!g) continue;
      const l = [...g].length;
      if (l !== o) continue;
      if (match[3] || match[4]) { p += l; continue; }
      if ((p -= l), p > 0) continue;
      const ll = Math.min(l, l + p);
      const te = match[0].codePointAt(0) > 0xffff ? 2 : 1;
      const raw = src.slice(pos, match.index + te + ll);
      const inner = raw.slice(o, -o);
      return { html: "<del>" + inlineHtml(inner, ctx) + "</del>", len: raw.length, inner };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Inline rendering: scan the string once, emitting HTML directly.
// `textOnly` renders like marked's text renderer (for image alt text).
// ---------------------------------------------------------------------------

function inlineHtml(src, ctx, textOnly = false) {
  if (!src) return "";
  // Fast path: nothing that can start an inline construct, no hard break
  // (two spaces or a backslash before a newline), and nothing that could be
  // a GFM autolink (://, www., @).
  if (
    !textOnly &&
    !/[\\![<*_~`&]/.test(src) &&
    !/ {2,}\n/.test(src) &&
    !/\\\n/.test(src) &&
    !/(?:\/\/|www\.|@)/.test(src)
  )
    return esc(src, true);
  if (textOnly && !/[\\![<*_~`&]/.test(src)) return unescapeEntities(src);

  const hasDelim = src.includes("*") || src.includes("_") || src.includes("~");
  // The mask only hides link/code/HTML contents and escaped punctuation;
  // with none of `[`, backtick, `<` or `\` present it is the identity, so
  // skip the (multi-regex) masking.
  const needMask =
    hasDelim &&
    (src.includes("[") || src.includes("`") || src.includes("<") || src.includes("\\"));
  const masked = needMask ? maskInline(src, ctx) : src;
  // Closer positions are only needed when an emphasis/del attempt is made.
  let closers = null;
  const end = src.length;
  let out = "";
  let pos = 0;
  let s = false; // true when the previous token was plain text
  let r = ""; // last char of the previous text token ("" when reset)
  const savedParen = ctx.state.linkParenPossible;
  ctx.state.linkParenPossible = savedParen && src.includes(")");
  try {
    while (pos < end) {
      if (!s) r = "";
      s = false;
      const ch = src[pos];

      // Escape: \X
      if (ch === "\\") {
        I.escape.lastIndex = pos;
        const m = I.escape.exec(src);
        if (m) {
          out += textOnly ? m[1] : esc(m[1], true);
          pos += m[0].length;
          continue;
        }
      }

      // Raw HTML tag / comment / processing instruction / CDATA.
      if (ch === "<") {
        I.tag.lastIndex = pos;
        const m = I.tag.exec(src);
        if (m) {
          if (!ctx.state.inLink && RX.startATag.test(m[0])) ctx.state.inLink = true;
          else if (ctx.state.inLink && RX.endATag.test(m[0])) ctx.state.inLink = false;
          if (!ctx.state.inRawBlock && RX.startPreScriptTag.test(m[0])) ctx.state.inRawBlock = true;
          else if (ctx.state.inRawBlock && RX.endPreScriptTag.test(m[0])) ctx.state.inRawBlock = false;
          out += textOnly ? m[0] : m[0];
          pos += m[0].length;
          continue;
        }
      }

      // Inline link / image: [text](href "title")
      if (ch === "[" || (ch === "!" && src[pos + 1] === "[")) {
        const lk = tryLink(src, pos, ctx, textOnly);
        if (lk) {
          out += lk.html;
          pos += lk.len;
          continue;
        }
        const rl = tryReflink(src, pos, ctx, textOnly);
        if (rl) {
          out += rl.html;
          pos += rl.len;
          continue;
        }
      }

      // Emphasis / strong.
      if (ch === "*" || ch === "_") {
        if (!closers) closers = scanClosers(masked);
        const em = tryEmStrong(src, masked, pos, ctx, closers, r);
        if (em) {
          out += textOnly ? inlineHtml(em.inner, ctx, true) : em.html;
          pos += em.len;
          continue;
        }
      }

      // Code span.
      if (ch === "`") {
        I.code.lastIndex = pos;
        const m = I.code.exec(src);
        if (m) {
          let text = m[2].replace(RX.newLineCharGlobal, " ");
          if (RX.nonSpaceChar.test(text) && /^ /.test(text) && / $/.test(text))
            text = text.substring(1, text.length - 1);
          out += textOnly ? text : "<code>" + esc(text) + "</code>";
          pos += m[0].length;
          continue;
        }
      }

      // Hard break: two spaces or backslash before a newline.
      if (ch === " " || ch === "\\") {
        I.br.lastIndex = pos;
        const m = I.br.exec(src);
        if (m) {
          out += textOnly ? "" : "<br>";
          pos += m[0].length;
          continue;
        }
      }

      // Strikethrough.
      if (ch === "~") {
        if (!closers) closers = scanClosers(masked);
        const del = tryDel(src, masked, pos, ctx, closers, r);
        if (del) {
          out += textOnly ? inlineHtml(del.inner, ctx, true) : del.html;
          pos += del.len;
          continue;
        }
      }

      // Autolink: <scheme:...> or <email>.
      if (ch === "<") {
        I.autolink.lastIndex = pos;
        const m = I.autolink.exec(src);
        if (m) {
          const text = m[1];
          if (textOnly) {
            out += text;
            pos += m[0].length;
            continue;
          }
          const href = m[2] === "@" ? "mailto:" + text : text;
          const cleaned = cleanUrl(href);
          const inner = esc(text);
          if (cleaned === null) out += inner;
          else out += `<a href="${esc(cleaned)}">${inner}</a>`;
          pos += m[0].length;
          continue;
        }
      }

      // Extended autolink (GFM): www.foo, foo@bar, http://...
      if (!ctx.state.inLink) {
        I.url.lastIndex = pos;
        const m = I.url.exec(src);
        if (m) {
          let text, href;
          if (m[2] === "@") {
            text = m[0];
            href = "mailto:" + text;
          } else {
            let raw = m[0];
            let prev;
            do {
              prev = raw;
              raw = inlineRules.backpedal.exec(raw)?.[0] ?? "";
            } while (raw !== prev);
            text = raw;
            href = m[1] === "www." ? "http://" + raw : raw;
          }
          if (textOnly) {
            out += text;
            pos += text.length;
            continue;
          }
          const cleaned = cleanUrl(href);
          const inner = esc(text);
          if (cleaned === null) out += inner;
          else out += `<a href="${esc(cleaned)}">${inner}</a>`;
          pos += text.length;
          continue;
        }
      }

      // Plain text run.
      I.text.lastIndex = pos;
      const m = I.text.exec(src);
      if (m) {
        const raw = m[0];
        if (textOnly) out += ctx.state.inRawBlock ? raw : unescapeEntities(raw);
        else if (ctx.state.inRawBlock) out += raw;
        else out += esc(unescapeEntities(raw), true);
        if (raw.slice(-1) !== "_") r = raw.slice(-1);
        s = true;
        pos += raw.length;
        continue;
      }

      // Should not happen (the text rule matches any char), but never loop.
      out += textOnly ? src[pos] : esc(src[pos], true);
      pos++;
    }
  } finally {
    ctx.state.linkParenPossible = savedParen;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block lexing. Each rule returns {node, len} (len = how far the caller
// advances) or null. Nodes carry `raw` (their source text) and, for
// paragraphs/text, `text` (the inline source). Link definitions are collected
// into ctx.links as they are found, first definition wins.
// ---------------------------------------------------------------------------

function at(re, str, pos) {
  re.lastIndex = pos;
  return re.exec(str);
}

function lexSpace(src, pos) {
  const m = at(B.newline, src, pos);
  if (m && m[0].length > 0) return { node: { type: "space", raw: m[0] }, len: m[0].length };
  return null;
}

function lexCode(src, pos) {
  const m = at(B.code, src, pos);
  if (!m) return null;
  const raw = trimTrailingBlank(m[0]);
  const text = raw.replace(RX.codeRemoveIndent, "");
  return { node: { type: "code", raw, text, lang: undefined }, len: raw.length };
}

function lexFences(src, pos) {
  const m = at(B.fences, src, pos);
  if (!m) return null;
  const raw = m[0];
  const text = fenceIndentComp(raw, m[3] || "");
  const lang = m[2] ? m[2].trim().replace(inlineRules.anyPunctuation, "$1") : m[2];
  return { node: { type: "code", raw, text, lang }, len: raw.length };
}

function lexHeading(src, pos) {
  const m = at(B.heading, src, pos);
  if (!m) return null;
  let text = m[2].trim();
  if (/#$/.test(text)) {
    const stripped = rtrim(text, "#");
    if (!stripped || /[ \t]$/.test(stripped)) text = stripped.trim();
  }
  return {
    node: { type: "heading", raw: rtrim(m[0], "\n"), depth: m[1].length, text },
    len: rtrim(m[0], "\n").length,
  };
}

function lexHr(src, pos) {
  const m = at(B.hr, src, pos);
  if (!m) return null;
  const raw = rtrim(m[0], "\n");
  return { node: { type: "hr", raw }, len: raw.length };
}

function lexHtml(src, pos) {
  const m = at(B.html, src, pos);
  if (!m) return null;
  const raw = trimTrailingBlank(m[0]);
  return {
    node: {
      type: "html",
      raw,
      pre: m[1] === "pre" || m[1] === "script" || m[1] === "style",
      text: raw,
    },
    len: raw.length,
  };
}

function lexDef(src, pos) {
  const m = at(B.def, src, pos);
  if (!m) return null;
  if (!RX.startAngleBracket.test(m[2]) && findClosingBracket(m[2], "(", ")") !== -1) return null;
  const tag = normLabel(m[1]);
  const href = m[2]
    ? m[2].replace(RX.hrefBrackets, "$1").replace(inlineRules.anyPunctuation, "$1")
    : "";
  const title = m[3]
    ? m[3].substring(1, m[3].length - 1).replace(inlineRules.anyPunctuation, "$1")
    : m[3];
  const raw = rtrim(m[0], "\n");
  return { node: { type: "def", tag, raw, href, title }, len: raw.length };
}

function lexTable(src, pos) {
  const m = at(B.table, src, pos);
  if (!m || !RX.tableDelimiter.test(m[2])) return null;
  const headerCells = splitCells(m[1]);
  const alignsRaw = m[2].replace(RX.tableAlignChars, "").split("|");
  const bodyRows = m[3]?.trim() ? m[3].replace(RX.tableRowBlankLine, "").split("\n") : [];
  if (headerCells.length !== alignsRaw.length) return null;
  const align = [];
  for (const a of alignsRaw) {
    if (RX.tableAlignRight.test(a)) align.push("right");
    else if (RX.tableAlignCenter.test(a)) align.push("center");
    else if (RX.tableAlignLeft.test(a)) align.push("left");
    else align.push(null);
  }
  const header = headerCells.map((text, i) => ({ text, align: align[i] }));
  const rows = bodyRows.map((row) =>
    splitCells(row, header.length).map((text, p) => ({ text, align: align[p] })),
  );
  const raw = rtrim(m[0], "\n");
  return { node: { type: "table", raw, header, align, rows }, len: raw.length };
}

function lexLheading(src, pos) {
  const m = at(B.lheading, src, pos);
  if (!m) return null;
  const raw = rtrim(m[0], "\n");
  return {
    node: { type: "heading", raw, depth: m[2].charAt(0) === "=" ? 1 : 2, text: m[1].trim() },
    len: raw.length,
  };
}

function lexParagraph(src, pos) {
  const m = at(B.paragraph, src, pos);
  if (!m) return null;
  const text = m[1].charAt(m[1].length - 1) === "\n" ? m[1].slice(0, -1) : m[1];
  return { node: { type: "paragraph", raw: m[0], text }, len: m[0].length };
}

function lexText(src, pos) {
  const m = at(B.text, src, pos);
  if (!m) return null;
  return { node: { type: "text", raw: m[0], text: m[0] }, len: m[0].length };
}

function lexBlockquote(src, pos, ctx) {
  const m = at(B.blockquote, src, pos);
  if (!m) return null;
  let lines = rtrim(m[0], "\n").split("\n");
  let s = "", r = "";
  const tokens = [];
  while (lines.length > 0) {
    let hasMarker = false;
    const chunk = [];
    let p;
    for (p = 0; p < lines.length; p++) {
      if (RX.blockquoteStart.test(lines[p])) { chunk.push(lines[p]); hasMarker = true; }
      else if (!hasMarker) chunk.push(lines[p]);
      else break;
    }
    lines = lines.slice(p);
    const h = chunk.join("\n");
    const u = h
      .replace(
        RX.blockquoteMarkerWhitespace,
        (g, b, mm) => b + expandTabs(mm, b.length),
      )
      .replace(RX.blockquoteSetextReplace, "\n    $1")
      .replace(RX.blockquoteSetextReplace2, "");
    s = s ? s + "\n" + h : h;
    r = r ? r + "\n" + u : u;
    const savedTop = ctx.state.top;
    ctx.state.top = true;
    lexBlocksInto(u, 0, u.length, ctx, tokens, true);
    ctx.state.top = savedTop;
    if (lines.length === 0) break;
    const k = tokens.at(-1);
    if (!k) break;
    if (k.type === "code" || k.type === "heading" || k.type === "hr" || k.type === "html" || k.type === "table") break;
    if (k.type === "blockquote") {
      const g = k;
      const b = lines.join("\n");
      const mm = g.raw + "\n" + b.replace(RX.blockquoteSetextReplace2, "");
      const f = lexBlockquote(mm, 0, ctx);
      tokens[tokens.length - 1] = f.node;
      const y = mm.substring(f.node.raw.length).replace(/^\n/, "");
      const R = y ? y.split("\n").length : 0;
      const A = R ? lines.slice(0, -R) : lines;
      if (A.length > 0) s = s + "\n" + A.join("\n");
      r = r.substring(0, r.length - g.text.length) + f.node.text;
      lines = lines.slice(A.length);
      if (lines.length > 0 && RX.blockquoteStart.test(lines[0])) continue;
      break;
    } else if (k.type === "list") {
      const g = k;
      const b = g.raw + "\n" + lines.join("\n");
      const mm = lexList(b, 0, ctx);
      tokens[tokens.length - 1] = mm.node;
      const f = mm.node.raw.length > g.raw.length
        ? b.slice(g.raw.length + 1, mm.node.raw.length).split("\n").length
        : 0;
      if (f > 0) {
        const y = lines.slice(0, f).join("\n");
        s = s + "\n" + y;
        r = r + "\n" + y;
      }
      lines = lines.slice(f);
      continue;
    }
  }
  return { node: { type: "blockquote", raw: s, tokens, text: r }, len: s.length };
}

// Line starting at pos, without copying the rest of the document.
function lineAt(src, pos) {
  const nl = src.indexOf("\n", pos);
  return nl === -1 ? src.slice(pos) : src.slice(pos, nl);
}

function lexList(src, pos, ctx) {
  const t0 = at(B.list, src, pos);
  if (!t0) return null;
  let cur = pos;
  const first = t0[1].trim();
  const ordered = first.length > 1;
  const list = {
    type: "list",
    raw: "",
    ordered,
    start: ordered ? +first.slice(0, -1) : "",
    loose: false,
    items: [],
  };
  const bull = ordered ? `\\d{1,9}\\${first.slice(-1)}` : `\\${first}`;
  const itemRe = sticky(listItemRegex(bull));
  let p = false;
  while (cur < src.length) {
    let u = false, d = "";
    const t = at(itemRe, src, cur);
    if (!t) break;
    if (at(B.hr, src, cur)) break;
    const k = cur - pos;
    cur += t[0].length;
    const g = t[2].split("\n", 1)[0];
    const b = t[1].length;
    let m = g.replace(RX.leadingSpaceTab, (v) => expandTabs(v, b));
    const f0 = lineAt(src, cur);
    const y0 = !m.trim();
    let R = 0;
    if (y0) {
      R = b + 1;
    } else {
      R = m.search(RX.nonSpaceChar);
      R = R > 4 ? 1 : R;
      d = m.slice(R);
      R += b;
    }
    let y = y0;
    let f = f0;
    if (y && RX.blankLine.test(f)) {
      cur += f.length + 1;
      u = true;
    }
    if (!u) {
      const nextBullet = nextBulletRegex(R);
      const hrRe = hrRegex(R);
      const fencesRe = fencesBeginRegex(R);
      const headingRe = headingBeginRegex(R);
      const htmlRe = htmlBeginRegex(R);
      const bqRe = blockquoteBeginRegex(R);
      while (cur < src.length) {
        const U = lineAt(src, cur);
        f = U;
        const Z = f.replace(RX.leadingSpaceTab, (me) => expandTabs(me));
        if (
          fencesRe.test(f) || headingRe.test(f) || htmlRe.test(f) ||
          bqRe.test(f) || nextBullet.test(f) || hrRe.test(f)
        )
          break;
        if (Z.search(RX.nonSpaceChar) >= R || !f.trim()) {
          d += "\n" + Z.slice(R);
        } else {
          if (
            y ||
            m.replace(RX.tabCharGlobal, "    ").search(RX.nonSpaceChar) >= 4 ||
            fencesRe.test(m) || headingRe.test(m) || htmlRe.test(m) || hrRe.test(m)
          )
            break;
          const qe =
            /^ {0,3}(?:=+|-+) *$/.test(f) && testAt(B.lheading, m + "\n" + f, 0)
              ? "    " + Z.replace(/^ {0,3}/, "")
              : f;
          d += "\n" + qe;
        }
        y = !f.trim();
        cur += U.length + 1;
        m = Z.slice(R);
      }
    }
    const A = src.slice(pos + k, cur);
    if (list.loose) {
      // already loose
    } else if (p) {
      list.loose = true;
    } else if (RX.doubleBlankLine.test(A)) {
      p = true;
    }
    list.items.push({
      type: "list_item",
      raw: A,
      task: RX.listIsTask.test(d),
      loose: false,
      text: d,
      tokens: [],
    });
  }
  const last = list.items.at(-1);
  if (!last) return null;
  last.raw = last.raw.trimEnd();
  last.text = last.text.trimEnd();
  list.raw = src.slice(pos, cur).trimEnd();
  for (const item of list.items) {
    ctx.state.top = false;
    lexBlocksInto(item.text, 0, item.text.length, ctx, item.tokens, false);
    if (!list.loose) {
      const spaces = item.tokens.filter((g) => g.type === "space");
      if (spaces.length > 0 && spaces.some((g) => RX.anyLine.test(g.raw))) list.loose = true;
    }
  }
  for (const item of list.items) {
    const firstTok = item.tokens[0];
    if (item.task && (firstTok?.type === "text" || firstTok?.type === "paragraph")) {
      item.text = item.text.replace(RX.listReplaceTask, "");
      firstTok.raw = firstTok.raw.replace(RX.listReplaceTask, "");
      firstTok.text = firstTok.text.replace(RX.listReplaceTask, "");
      const ck = RX.listTaskCheckbox.exec(item.raw);
      if (ck) {
        item.checked = ck[0] !== "[ ]";
        const box = { type: "checkbox", raw: ck[0] + " ", checked: item.checked };
        if (list.loose) {
          const first = item.tokens[0];
          if (first && (first.type === "paragraph" || first.type === "text")) {
            // Checkbox renders inside the first paragraph (marked unshifts it
            // into that paragraph's inline tokens).
            first.checkbox = box;
          } else {
            item.tokens.unshift({
              type: "paragraph",
              raw: box.raw,
              text: "",
              checkbox: box,
            });
          }
        } else {
          item.tokens.unshift(box);
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const tok of item.tokens) if (tok.type === "text") tok.type = "paragraph";
    }
  }
  return { node: list, len: list.raw.length };
}

// Test a sticky regex at a position (resets lastIndex first).
function testAt(re, str, pos) {
  re.lastIndex = pos;
  return re.exec(str) !== null;
}

// Main block loop. Appends nodes into `out`. `mergePara` mirrors marked's
// `n` flag: only the first paragraph of this chunk may merge into the
// previous paragraph node (used for blockquote chunks).
function lexBlocksInto(src, start, end, ctx, out, mergePara) {
  let pos = start;
  let merge = mergePara;
  let guard = Infinity;
  while (pos < end) {
    const remaining = end - pos;
    if (remaining >= guard) throw new Error("Infinite loop");
    guard = remaining;
    let r = null;

    if ((r = lexSpace(src, pos))) {
      pos += r.len;
      const last = out.at(-1);
      if (r.node.raw.length === 1 && last !== undefined) {
        last.raw += "\n";
      } else {
        out.push(r.node);
      }
      continue;
    }
    if ((r = lexCode(src, pos))) {
      pos += r.len;
      const last = out.at(-1);
      if (last?.type === "paragraph" || last?.type === "text") {
        last.raw += (last.raw.endsWith("\n") ? "" : "\n") + r.node.raw;
        last.text += "\n" + r.node.text;
      } else {
        out.push(r.node);
      }
      continue;
    }
    if ((r = lexFences(src, pos))) {
      pos += r.len;
      out.push(r.node);
      continue;
    }
    if ((r = lexHeading(src, pos))) {
      pos += r.len;
      out.push(r.node);
      continue;
    }
    if ((r = lexHr(src, pos))) {
      pos += r.len;
      out.push(r.node);
      continue;
    }
    if ((r = lexBlockquote(src, pos, ctx))) {
      pos += r.len;
      out.push(r.node);
      continue;
    }
    if ((r = lexList(src, pos, ctx))) {
      pos += r.len;
      out.push(r.node);
      continue;
    }
    if ((r = lexHtml(src, pos))) {
      pos += r.len;
      out.push(r.node);
      continue;
    }
    if ((r = lexDef(src, pos))) {
      pos += r.len;
      const last = out.at(-1);
      if (last?.type === "paragraph" || last?.type === "text") {
        last.raw += (last.raw.endsWith("\n") ? "" : "\n") + r.node.raw;
        last.text += "\n" + r.node.raw;
      } else {
        if (!ctx.links[r.node.tag]) {
          ctx.links[r.node.tag] = { href: r.node.href, title: r.node.title };
        }
        out.push(r.node);
      }
      continue;
    }
    if ((r = lexTable(src, pos))) {
      pos += r.len;
      out.push(r.node);
      continue;
    }
    if ((r = lexLheading(src, pos))) {
      pos += r.len;
      out.push(r.node);
      continue;
    }
    if (ctx.state.top && (r = lexParagraph(src, pos))) {
      pos += r.len;
      const last = out.at(-1);
      if (merge && last?.type === "paragraph") {
        last.raw += (last.raw.endsWith("\n") ? "" : "\n") + r.node.raw;
        last.text += "\n" + r.node.text;
      } else {
        out.push(r.node);
      }
      merge = false;
      continue;
    }
    if ((r = lexText(src, pos))) {
      pos += r.len;
      const last = out.at(-1);
      if (last?.type === "text") {
        last.raw += (last.raw.endsWith("\n") ? "" : "\n") + r.node.raw;
        last.text += "\n" + r.node.text;
      } else {
        out.push(r.node);
      }
      continue;
    }
    // Unreachable in practice: the text rule always matches at least a char.
    throw new Error("Infinite loop");
  }
  ctx.state.top = true;
  return out;
}

// ---------------------------------------------------------------------------
// Block rendering. Inline content is rendered on the fly from each node's
// `text` with the fully-collected ctx.links (link definitions may appear
// after their use, so inline parsing must happen after the whole block pass).
// ---------------------------------------------------------------------------

function renderCheckbox(box) {
  return `<input ${box.checked ? 'checked="" ' : ""}disabled="" type="checkbox"> `;
}

function renderBlock(node, ctx) {
  switch (node.type) {
    case "space":
      return "";
    case "code": {
      const lang = (node.lang || "").match(RX.notSpaceStart)?.[0];
      const text = node.text ? node.text.replace(RX.endingNewline, "") + "\n" : "";
      return lang
        ? `<pre><code class="language-${esc(lang, true)}">${esc(text)}</code></pre>\n`
        : `<pre><code>${esc(text)}</code></pre>\n`;
    }
    case "heading":
      return `<h${node.depth}>${inlineHtml(node.text, ctx)}</h${node.depth}>\n`;
    case "hr":
      return "<hr>\n";
    case "blockquote":
      return `<blockquote>\n${renderBlocks(node.tokens, ctx)}</blockquote>\n`;
    case "list":
      return renderList(node, ctx);
    case "table": {
      let head = "";
      for (const cell of node.header) {
        head += `<th${cell.align ? ` align="${cell.align}"` : ""}>${inlineHtml(cell.text, ctx)}</th>\n`;
      }
      const thead = `<thead>\n<tr>\n${head}</tr>\n</thead>\n`;
      if (node.rows.length === 0) return `<table>\n${thead}</table>\n`;
      let body = "";
      for (const row of node.rows) {
        let cells = "";
        for (const cell of row) {
          cells += `<td${cell.align ? ` align="${cell.align}"` : ""}>${inlineHtml(cell.text, ctx)}</td>\n`;
        }
        body += `<tr>\n${cells}</tr>\n`;
      }
      return `<table>\n${thead}<tbody>${body}</tbody></table>\n`;
    }
    case "html":
      return node.text;
    case "def":
      return "";
    case "paragraph": {
      const box = node.checkbox ? renderCheckbox(node.checkbox) : "";
      return `<p>${box}${inlineHtml(node.text, ctx)}</p>\n`;
    }
    case "text": {
      const box = node.checkbox ? renderCheckbox(node.checkbox) : "";
      return box + inlineHtml(node.text, ctx);
    }
    case "checkbox":
      return renderCheckbox(node);
    default:
      return "";
  }
}

function renderBlocks(nodes, ctx) {
  let out = "";
  for (const node of nodes) out += renderBlock(node, ctx);
  return out;
}

function renderList(list, ctx) {
  let items = "";
  for (const item of list.items) {
    items += `<li>${renderBlocks(item.tokens, ctx)}</li>\n`;
  }
  const tag = list.ordered ? "ol" : "ul";
  const start = list.ordered && list.start !== 1 ? ` start="${list.start}"` : "";
  return `<${tag}${start}>\n${items}</${tag}>\n`;
}

export function parse(src) {
  src = src.replace(RX.carriageReturn, "\n");
  const ctx = {
    links: Object.create(null),
    state: {
      inLink: false,
      inRawBlock: false,
      linkEmitted: false,
      linkParenPossible: true,
      top: true,
    },
  };
  const nodes = lexBlocksInto(src, 0, src.length, ctx, [], false);
  return renderBlocks(nodes, ctx);
}
