// parse.js — dependency-free markdown renderer, byte-identical to marked 18.1.3
// (default options: gfm on, breaks off, pedantic off). Written clean-room from the
// CommonMark/GFM specs and marked's published grammar; no marked code is copied.
// Renders directly to HTML (no inline token objects) for speed.

// ---------- tiny regex composer (same idea as marked's edit helper) ----------
function edit(src, flags) {
  let s = typeof src === 'string' ? src : src.source;
  return {
    rep(pat, sub) {
      let o = typeof sub === 'string' ? sub : sub.source;
      o = o.replace(/(^|[^\[])\^/g, '$1');
      s = s.replace(pat, o);
      return this;
    },
    rx() { return new RegExp(s, flags); },
  };
}

// ---------- shared regexes ----------
const R = {
  codeRemoveIndent: /^(?: {0,3}\t| {1,4})/gm,
  outputLinkReplace: /\\([\[\]])/g,
  indentCodeCompensation: /^(\s+)(?:```)/,
  beginningSpace: /^\s+/,
  endingHash: /#$/,
  startingSpaceChar: /^ /,
  endingSpaceChar: / $/,
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
  numericCharacterReference: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/,
  numericCharacterReferenceOrAmpersand: /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  escapeTest: /[&<>"']/,
  escapeReplace: /[&<>"']/g,
  escapeTestNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/,
  escapeReplaceNoEncode: /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g,
  percentDecode: /%25/g,
  findPipe: /\|/g,
  splitPipe: / \|/,
  slashPipe: /\\\|/g,
  carriageReturn: /\r\n|\r/g,
  notSpaceStart: /^\S*/,
  endingNewline: /\n$/,
};

const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML_COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;

// per-indent cached regex builders (indent only ever 0..3 for these)
function cached(fn) {
  const c = [];
  return (n) => {
    const i = Math.max(0, Math.min(3, n - 1));
    return c[i] || (c[i] = fn(i));
  };
}
const listItemRegex = (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\n]*)?(?:\n|$))`);
const nextBulletRegex = cached((n) => new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\\n|$))`));
const hrRegex = cached((n) => new RegExp(`^ {0,${n}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
const fencesBeginRegex = cached((n) => new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`));
const headingBeginRegex = cached((n) => new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`));
const htmlBeginRegex = cached((n) => new RegExp(`^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const blockquoteBeginRegex = cached((n) => new RegExp(`^ {0,${n}}>`));

// ---------- block grammar (gfm) ----------
const BULL = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const BLOCK = {
  newline: /^(?:[ \t]*(?:\n|$))+/,
  code: /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/,
  fences: /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/,
  hr: /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/,
  heading: /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/,
  text: /^[^\n]+/,
};
const LHEADING_SRC = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const PARA_SRC = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
function buildParagraph(listRx) {
  return edit(PARA_SRC)
    .rep('hr', BLOCK.hr)
    .rep('heading', ' {0,3}#{1,6}(?:\\s|$)')
    .rep('|lheading', '')
    .rep('|table', '')
    .rep('blockquote', ' {0,3}>')
    .rep('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
    .rep('list', listRx)
    .rep('html', ` {0,3}(?:</?(?:${BLOCK_TAGS})(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`)
    .rx();
}
function buildLheading(tableRx) {
  return edit(LHEADING_SRC)
    .rep(/bull/g, BULL)
    .rep(/blockCode/g, /(?: {4}| {0,3}\t)/)
    .rep(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
    .rep(/blockquote/g, / {0,3}>/)
    .rep(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
    .rep(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
    .rep(/html/g, / {0,3}<[^\n>]+>\n/)
    .rep(/table/g, tableRx)
    .rx();
}
BLOCK.table = edit(/^ *([^\n ].*)\n {0,3}((?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?)(?:\n((?:(?! *\n|hr|heading|blockquote|code|fences|list|html).*(?:\n|$))*)|\n*|$)/)
  .rep('hr', BLOCK.hr)
  .rep('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .rep('blockquote', ' {0,3}>')
  .rep('code', '(?: {4}| {0,3}\t)[^\\n]')
  .rep('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .rep('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .rep('html', ` {0,3}(?:</?(?:${BLOCK_TAGS})(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`)
  .rx();
BLOCK.lheading = buildLheading(/ {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/);
BLOCK.paragraph = buildParagraph(/ {0,3}(?:[*+-]|1[.)])[ \t]+[^ \t\n]/);
BLOCK.list = edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).rep(/bull/g, BULL).rx();
const LABEL_BRACKETED = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LABEL = edit(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/).rep('brackets', LABEL_BRACKETED).rx();
const LABEL_SIMPLE = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const LABEL_REF = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const LABEL_SEARCH = edit(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/).rep('brackets', LABEL_BRACKETED).rx();
const TITLE_RX = /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\)/;
BLOCK.def = edit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .rep('label', LABEL_SIMPLE)
  .rep('title', TITLE_RX)
  .rx();
BLOCK.html = edit("^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))", 'i')
  .rep('comment', HTML_COMMENT)
  .rep('tag', BLOCK_TAGS)
  .rep('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .rx();
BLOCK.blockquote = edit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).rep('paragraph', buildParagraph(/ {0,3}(?:[*+-]|\d{1,9}[.)])(?:[ \t]|\n|$)/)).rx();

// ---------- inline grammar (gfm) ----------
const PUNCT = /[\p{P}\p{S}]/u;
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u;
const PUNCT_NOTILDE = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_SPACE_NOTILDE = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_SPACE_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u;
const INLINE = {
  escape: /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/,
  code: /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/,
  br: /^( {2,}|\\)\n(?!\s*$)[ \t]*/,
  del: /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/,
  autolink: edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/)
    .rep('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
    .rep('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
    .rx(),
  tag: edit("^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>")
    .rep('comment', edit(HTML_COMMENT).rep('(?:-->|$)', '-->').rx())
    .rep('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
    .rx(),
  url: edit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
    .rep('emailProtocol', edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).rep(/email/g, /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/).rx())
    .rep('protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/)
    .rep('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
    .rx(),
  backpedal: /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/,
  punctuation: edit(/^((?![*_])punctSpace)/, 'u').rep(/punctSpace/g, PUNCT_SPACE).rx(),
};
INLINE.link = edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .rep('label', LABEL)
  .rep('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .rep('title', TITLE_RX)
  .rx();
INLINE.reflink = edit(/^!?\[(label)\]\[(ref)\]/).rep('label', LABEL).rep('ref', LABEL_SIMPLE).rx();
INLINE.nolink = edit(/^!?\[(ref)\](?:\[\])?/).rep('ref', LABEL_SIMPLE).rx();
INLINE.reflinkSearch = edit('reflink|nolink(?!\\()', 'g')
  .rep('reflink', edit(/^!?\[(label)\]\[(ref)\]/).rep('label', LABEL_SEARCH).rep('ref', LABEL_REF).rx())
  .rep('nolink', edit(/^!?\[(ref)\](?:\[\])?/).rep('ref', LABEL_REF).rx())
  .rx();
const EM_LDELIM_SRC = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
INLINE.emLDelim = edit(EM_LDELIM_SRC, 'u').rep(/punct/g, PUNCT).rx();
INLINE.emLDelimTilde = edit(EM_LDELIM_SRC, 'u').rep(/punct/g, PUNCT_NOTILDE).rx();
const EM_RDELIM_AST_SRC = '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)';
const EM_RDELIM_AST2_SRC = '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)[\\s](\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|(?:(?!\\*)punct|notPunctSpace)(\\*+)(?!\\*)(?=notPunctSpace)';
const EM_RDELIM_UND_SRC = '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)';
const EM_RDELIM_UND2_SRC = '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)[\\s](_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)|(?:(?!_)punct|notPunctSpace)(_+)(?!_)(?=notPunctSpace)';
INLINE.emRDelimAst = edit(EM_RDELIM_AST_SRC, 'gu').rep(/notPunctSpace/g, NOT_PUNCT_SPACE).rep(/punctSpace/g, PUNCT_SPACE).rep(/punct/g, PUNCT).rx();
INLINE.emRDelimAstTilde = edit(EM_RDELIM_AST_SRC, 'gu').rep(/notPunctSpace/g, NOT_PUNCT_SPACE_TILDE).rep(/punctSpace/g, PUNCT_SPACE_NOTILDE).rep(/punct/g, PUNCT_NOTILDE).rx();
INLINE.emRDelimAst2 = edit(EM_RDELIM_AST2_SRC, 'gu').rep(/notPunctSpace/g, NOT_PUNCT_SPACE).rep(/punctSpace/g, PUNCT_SPACE).rep(/punct/g, PUNCT).rx();
INLINE.emRDelimUnd = edit(EM_RDELIM_UND_SRC, 'gu').rep(/notPunctSpace/g, NOT_PUNCT_SPACE).rep(/punctSpace/g, PUNCT_SPACE).rep(/punct/g, PUNCT).rx();
INLINE.emRDelimUnd2 = edit(EM_RDELIM_UND2_SRC, 'gu').rep(/notPunctSpace/g, NOT_PUNCT_SPACE).rep(/punctSpace/g, PUNCT_SPACE).rep(/punct/g, PUNCT).rx();
INLINE.delLDelim = edit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u').rep(/punct/g, PUNCT).rx();
const DEL_RDELIM_SRC = '^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)';
INLINE.delRDelim = edit(DEL_RDELIM_SRC, 'gu').rep(/notPunctSpace/g, NOT_PUNCT_SPACE).rep(/punctSpace/g, PUNCT_SPACE).rep(/punct/g, PUNCT).rx();
INLINE.anyPunctuation = edit(/\\(punct)/, 'gu').rep(/punct/g, PUNCT).rx();
INLINE.anyPunctuationOutsideCode = edit(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu').rep(/punct/g, PUNCT).rx();
INLINE.blockSkip = edit(/link|precode-code|html/, 'g')
  .rep('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .rep('precode-', '(?<!`)()')
  .rep('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .rep('html', /<(?! )[^<>]*?>/)
  .rx();
INLINE.text = edit(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .rep('protocol', /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/)
  .rep(/emailProtocol/g, /(?:mailto|xmpp):/)
  .rep('wwwStart', '(?<![^\\s*_~(])www\\.')
  .rx();

// ---------- small helpers ----------
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s, encode) {
  if (encode) {
    if (R.escapeTest.test(s)) return s.replace(R.escapeReplace, (c) => ESC_MAP[c]);
  } else if (R.escapeTestNoEncode.test(s)) return s.replace(R.escapeReplaceNoEncode, (c) => ESC_MAP[c]);
  return s;
}
function unesc(s) {
  if (!R.numericCharacterReference.test(s)) return s;
  return s.replace(R.numericCharacterReferenceOrAmpersand, (m, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? parseInt(hex, 16) : parseInt(dec, 10);
    if (code === 0 || code > 1114111 || (code >= 55296 && code <= 57343)) return '\uFFFD';
    if (code === 38) return '&amp;';
    return String.fromCodePoint(code);
  });
}
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(R.percentDecode, '%');
  } catch { return null; }
}
function splitCells(row, count) {
  const parts = row.replace(R.findPipe, (m, off, str) => {
    let escaped = false;
    for (let p = off - 1; p >= 0 && str[p] === '\\'; p--) escaped = !escaped;
    return escaped ? '|' : ' |';
  }).split(R.splitPipe);
  let i = 0;
  if (parts[0].trim() || parts.shift(), parts.length > 0 && !parts[parts.length - 1]?.trim()) parts.pop();
  if (count) {
    if (parts.length > count) parts.splice(count);
    else while (parts.length < count) parts.push('');
  }
  for (; i < parts.length; i++) parts[i] = parts[i].trim().replace(R.slashPipe, '|');
  return parts;
}
function rtrim(s, ch, invert) {
  const n = s.length;
  if (n === 0) return '';
  let k = 0;
  for (; k < n;) {
    const c = s.charAt(n - k - 1);
    if (c === ch && !invert) k++;
    else if (c !== ch && invert) k++;
    else break;
  }
  return s.slice(0, n - k);
}
function stripTrailingBlank(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && R.blankLine.test(lines[t]);) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}
function normLabel(s) {
  return s.trim().replace(R.multipleSpaceGlobal, ' ').toLowerCase().toUpperCase().toLowerCase();
}
function findClosingBracket(s, pair) {
  if (s.indexOf(pair[0]) === -1 && s.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === pair[0]) depth++;
    else if (s[i] === pair[1] && (depth--, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}
function expandTabs(s, start = 0) {
  let col = start, out = '';
  for (const ch of s) {
    if (ch === '\t') {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
    } else {
      out += ch;
      col++;
    }
  }
  return out;
}
function indentComp(raw, content) {
  const m = raw.match(R.indentCodeCompensation);
  if (m === null) return content;
  const pad = m[1];
  return content.split('\n').map((line) => {
    const o = line.match(R.beginningSpace);
    if (o === null) return line;
    return line.slice(Math.min(o[0].length, pad.length));
  }).join('\n');
}
// last-possible-closer scan over a masked source (for em/strong/del)
function maskInfo(masked) {
  const idx = { '*': -1, '_': -1 };
  let del = -1;
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const ch = masked[s];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = s === 0 ? '\n' : masked[s - 1];
    let e = s + 1;
    while (e < n && masked[e] === ch) e++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') del = s;
      else idx[ch] = s;
    }
    s = e - 1;
  }
  return { masked, em: idx, del };
}
function hasInlineTag(src, label, bangPos) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const m = INLINE.code.exec(label.slice(s));
      if (m) { s += m[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const rest = src.slice(bangPos + s);
    const m = INLINE.tag.exec(rest) || INLINE.autolink.exec(rest);
    if (m) {
      if (m[0].length > label.length - s) return true;
      s += m[0].length - 1;
    }
  }
  return false;
}

// ---------- lexer / parser (single class, one instance per parse call) ----------
class P2 {
  constructor() {
    this.links = Object.create(null);
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
    this.maskStack = [];
  }

  // ----- entry -----
  lex(src) {
    src = src.replace(R.carriageReturn, '\n');
    const tokens = [];
    this.blockTokens(src, tokens);
    return tokens;
  }
  blockTokens(src, tokens, inQuote = false) {
    let shortest = Infinity;
    for (; src;) {
      if (src.length < shortest) shortest = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      let tok;
      if ((tok = this.tokSpace(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
        else tokens.push(tok);
        continue;
      }
      if ((tok = this.tokCode(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
        } else tokens.push(tok);
        continue;
      }
      if ((tok = this.tokFences(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokHeading(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokHr(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokBlockquote(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokList(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokHtml(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokDef(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.raw;
        } else {
          if (!this.links[tok.tag]) this.links[tok.tag] = { href: tok.href, title: tok.title };
          tokens.push(tok);
        }
        continue;
      }
      if ((tok = this.tokTable(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokLheading(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (this.state.top && (tok = this.tokParagraph(src))) {
        const prev = tokens.at(-1);
        if (inQuote && prev?.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
        } else tokens.push(tok);
        inQuote = false;
        src = src.substring(tok.raw.length);
        continue;
      }
      if ((tok = this.tokText(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens.at(-1);
        if (prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
        } else tokens.push(tok);
        continue;
      }
      if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      break;
    }
    this.state.top = true;
    return tokens;
  }

  // ----- block tokenizers -----
  tokSpace(src) {
    const m = BLOCK.newline.exec(src);
    if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
  }
  tokCode(src) {
    const m = BLOCK.code.exec(src);
    if (m) {
      const raw = stripTrailingBlank(m[0]);
      return { type: 'code', raw, text: raw.replace(R.codeRemoveIndent, '') };
    }
  }
  tokFences(src) {
    const m = BLOCK.fences.exec(src);
    if (m) {
      return {
        type: 'code', raw: m[0],
        lang: m[2] ? m[2].trim().replace(INLINE.anyPunctuation, '$1') : m[2],
        text: indentComp(m[0], m[3] || ''),
      };
    }
  }
  tokHeading(src) {
    const m = BLOCK.heading.exec(src);
    if (m) {
      let text = m[2].trim();
      if (R.endingHash.test(text)) {
        const cut = rtrim(text, '#');
        if (!cut || R.endingSpaceTabChar.test(cut)) text = cut.trim();
      }
      return { type: 'heading', raw: rtrim(m[0], '\n'), depth: m[1].length, text };
    }
  }
  tokHr(src) {
    const m = BLOCK.hr.exec(src);
    if (m) return { type: 'hr', raw: rtrim(m[0], '\n') };
  }
  tokBlockquote(src) {
    const m = BLOCK.blockquote.exec(src);
    if (!m) return;
    const lines = rtrim(m[0], '\n').split('\n');
    let raw = '', text = '';
    const tokens = [];
    while (lines.length > 0) {
      let seen = false;
      const chunk = [];
      let p;
      for (p = 0; p < lines.length; p++) {
        if (R.blockquoteStart.test(lines[p])) { chunk.push(lines[p]); seen = true; }
        else if (!seen) chunk.push(lines[p]);
        else break;
      }
      lines.splice(0, p);
      const chunkRaw = chunk.join('\n');
      const stripped = chunkRaw
        .replace(R.blockquoteMarkerWhitespace, (g, b, m2) => b + expandTabs(m2, b.length))
        .replace(R.blockquoteSetextReplace, '\n    $1')
        .replace(R.blockquoteSetextReplace2, '');
      raw = raw ? raw + '\n' + chunkRaw : chunkRaw;
      text = text ? text + '\n' + stripped : stripped;
      const savedTop = this.state.top;
      this.state.top = true;
      this.blockTokens(stripped, tokens, true);
      this.state.top = savedTop;
      if (lines.length === 0) break;
      const last = tokens.at(-1);
      if (last?.type === 'code' || last?.type === 'heading' || last?.type === 'hr' || last?.type === 'html' || last?.type === 'table') break;
      if (last?.type === 'blockquote') {
        const rest = lines.join('\n');
        const whole = last.raw + '\n' + rest.replace(R.blockquoteSetextReplace2, '');
        const nested = this.tokBlockquote(whole);
        tokens[tokens.length - 1] = nested;
        const leftover = whole.substring(nested.raw.length).replace(/^\n/, '');
        const leftLines = leftover ? leftover.split('\n').length : 0;
        const consumed = leftLines ? lines.slice(0, -leftLines) : lines;
        if (consumed.length > 0) raw = raw + '\n' + consumed.join('\n');
        text = text.substring(0, text.length - last.text.length) + nested.text;
        lines.splice(0, consumed.length);
        if (lines.length > 0 && R.blockquoteStart.test(lines[0])) continue;
        break;
      } else if (last?.type === 'list') {
        const rest = lines.join('\n');
        const whole = last.raw + '\n' + rest;
        const relisted = this.tokList(whole);
        tokens[tokens.length - 1] = relisted;
        let extra = 0;
        if (relisted.raw.length > last.raw.length) {
          extra = whole.slice(last.raw.length + 1, relisted.raw.length).split('\n').length;
        }
        if (extra > 0) {
          const taken = lines.slice(0, extra).join('\n');
          raw = raw + '\n' + taken;
          text = text + '\n' + taken;
        }
        lines.splice(0, extra);
        continue;
      }
    }
    return { type: 'blockquote', raw, tokens, text };
  }
  tokList(src) {
    const m = BLOCK.list.exec(src);
    if (!m) return;
    const orig = src;
    const consumed = () => orig.length - src.length;
    const bullet = m[1].trim();
    const ordered = bullet.length > 1;
    const list = { type: 'list', raw: '', ordered, start: ordered ? +bullet.slice(0, -1) : '', loose: false, items: [] };
    let bullRx = ordered ? `\\d{1,9}\\${bullet.slice(-1)}` : `\\${bullet}`;
    const itemRx = listItemRegex(bullRx);
    let hasDoubleBlank = false;
    for (; src;) {
      let isBlankItem = false;
      const parts = [];
      const t = itemRx.exec(src);
      if (!t || BLOCK.hr.test(src)) break;
      const start = consumed();
      src = src.substring(t[0].length);
      const firstLine = t[2].split('\n', 1)[0];
      const markerLen = t[1].length;
      const fc0 = firstLine.charCodeAt(0);
      let marker = (fc0 === 32 || fc0 === 9) ? firstLine.replace(R.leadingSpaceTab, (v) => expandTabs(v, markerLen)) : firstLine;
      let nextLine = src.split('\n', 1)[0];
      let emptyMarker = !marker.trim();
      let indent = 0;
      if (emptyMarker) indent = markerLen + 1;
      else {
        indent = marker.search(R.nonSpaceChar);
        if (indent > 4) indent = 1;
        parts.push(marker.slice(indent));
        indent += markerLen;
      }
      if (emptyMarker && R.blankLine.test(nextLine)) {
        src = src.substring(nextLine.length + 1);
        isBlankItem = true;
      }
      if (!isBlankItem) {
        const nextBullet = nextBulletRegex(indent);
        const hrAt = hrRegex(indent);
        const fencesAt = fencesBeginRegex(indent);
        const headingAt = headingBeginRegex(indent);
        const htmlAt = htmlBeginRegex(indent);
        const quoteAt = blockquoteBeginRegex(indent);
        let p = 0;
        const srcLen = src.length;
        while (p < srcLen) {
          let e = src.indexOf('\n', p);
          if (e === -1) e = srcLen;
          // walk leading whitespace, tracking the expanded column (tab = next multiple of 4)
          let q = p, col = 0;
          while (q < e) {
            const c = src.charCodeAt(q);
            if (c === 32) { q++; col++; }
            else if (c === 9) { q++; col += 4 - (col % 4); }
            else break;
          }
          const blank = q >= e;
          const lead = blank ? -1 : col;
          let content;
          if (blank || lead >= indent) {
            // continuation: content is the expanded line from column `indent`
            // (a tab straddling the indent leaves `col - indent` spaces behind)
            content = col > indent ? ' '.repeat(col - indent) + src.slice(q, e) : src.slice(q, e);
            parts.push('\n', content);
          } else {
            const line = src.slice(p, e);
            if (fencesAt.test(line) || headingAt.test(line) || htmlAt.test(line) || quoteAt.test(line) || nextBullet.test(line) || hrAt.test(line)) break;
            if (emptyMarker || marker.replace(R.tabCharGlobal, '    ').search(R.nonSpaceChar) >= 4 || fencesAt.test(marker) || headingAt.test(marker) || htmlAt.test(marker) || hrAt.test(marker)) break;
            const lc0 = line.charCodeAt(0);
            const expanded = (lc0 === 32 || lc0 === 9) ? line.replace(R.leadingSpaceTab, (v) => expandTabs(v)) : line;
            const setext = /^ {0,3}(?:=+|-+) *$/.test(line) && BLOCK.lheading.test(marker + '\n' + line)
              ? '    ' + expanded.replace(/^ {0,3}/, '')
              : line;
            parts.push('\n', setext);
            content = expanded.slice(indent);
          }
          emptyMarker = blank;
          marker = content;
          p = e < srcLen ? e + 1 : srcLen;
        }
        src = src.substring(p);
      }
      const itemText = parts.join('');
      const itemRaw = orig.slice(start, consumed());
      if (!list.loose) {
        if (hasDoubleBlank) list.loose = true;
        else if (R.doubleBlankLine.test(itemRaw)) hasDoubleBlank = true;
      }
      list.items.push({
        type: 'list_item', raw: itemRaw,
        task: R.listIsTask.test(itemText), loose: false, text: itemText, tokens: [],
      });
    }
    const lastItem = list.items.at(-1);
    if (!lastItem) return;
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
    list.raw = orig.slice(0, consumed()).trimEnd();
    for (const item of list.items) {
      this.state.top = false;
      item.tokens = this.blockTokens(item.text, []);
      if (!list.loose) {
        const spaces = item.tokens.filter((g) => g.type === 'space');
        if (spaces.length > 0 && spaces.some((g) => R.anyLine.test(g.raw))) list.loose = true;
      }
    }
    for (const item of list.items) {
      const first = item.tokens[0];
      if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
        item.text = item.text.replace(R.listReplaceTask, '');
        first.raw = first.raw.replace(R.listReplaceTask, '');
        first.text = first.text.replace(R.listReplaceTask, '');
        const ck = R.listTaskCheckbox.exec(item.raw);
        if (ck) {
          const checked = ck[0] !== '[ ]';
          item.checked = checked;
          if (list.loose) {
            if (first && (first.type === 'paragraph' || first.type === 'text')) {
              first.checkbox = checked;
            } else {
              item.tokens.unshift({ type: 'paragraph', raw: ck[0] + ' ', text: '', checkbox: checked });
            }
          } else {
            item.tokens.unshift({ type: 'checkbox', raw: ck[0] + ' ', checked });
          }
        }
      } else if (item.task) item.task = false;
    }
    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const t of item.tokens) if (t.type === 'text') t.type = 'paragraph';
      }
    }
    return list;
  }
  tokHtml(src) {
    const m = BLOCK.html.exec(src);
    if (m) {
      const raw = stripTrailingBlank(m[0]);
      return { type: 'html', raw, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style', text: raw };
    }
  }
  tokDef(src) {
    const m = BLOCK.def.exec(src);
    if (m) {
      if (!R.startAngleBracket.test(m[2]) && findClosingBracket(m[2], '()') !== -1) return;
      const tag = normLabel(m[1]);
      const href = m[2] ? m[2].replace(R.hrefBrackets, '$1').replace(INLINE.anyPunctuation, '$1') : '';
      const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(INLINE.anyPunctuation, '$1') : m[3];
      return { type: 'def', tag, raw: rtrim(m[0], '\n'), href, title };
    }
  }
  tokTable(src) {
    const m = BLOCK.table.exec(src);
    if (!m || !R.tableDelimiter.test(m[2])) return;
    const headerCells = splitCells(m[1]);
    const aligns = m[2].replace(R.tableAlignChars, '').split('|');
    const rowLines = m[3]?.trim() ? m[3].replace(R.tableRowBlankLine, '').split('\n') : [];
    if (headerCells.length !== aligns.length) return;
    const table = { type: 'table', raw: rtrim(m[0], '\n'), header: [], align: [], rows: [] };
    for (const a of aligns) {
      if (R.tableAlignRight.test(a)) table.align.push('right');
      else if (R.tableAlignCenter.test(a)) table.align.push('center');
      else if (R.tableAlignLeft.test(a)) table.align.push('left');
      else table.align.push(null);
    }
    for (let i = 0; i < headerCells.length; i++) {
      table.header.push({ text: headerCells[i], header: true, align: table.align[i] });
    }
    for (const row of rowLines) {
      table.rows.push(splitCells(row, headerCells.length).map((cell, p) => ({ text: cell, header: false, align: table.align[p] })));
    }
    return table;
  }
  tokLheading(src) {
    const m = BLOCK.lheading.exec(src);
    if (m) {
      const text = m[1].trim();
      return { type: 'heading', raw: rtrim(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text };
    }
  }
  tokParagraph(src) {
    const m = BLOCK.paragraph.exec(src);
    if (m) {
      const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
      return { type: 'paragraph', raw: m[0], text };
    }
  }
  tokText(src) {
    const m = BLOCK.text.exec(src);
    if (m) return { type: 'text', raw: m[0], text: m[0] };
  }
}

// ----- inline tokenizers: return {h: html, n: consumed} or null -----
INLINE.punctuation = edit(/^((?![*_])punctSpace)/, 'u').rep(/punctSpace/g, PUNCT_SPACE).rx();

P2.prototype.tokEscape = function (src, mode) {
  const m = INLINE.escape.exec(src);
  if (m) return { h: (mode === 'text' || mode === 'textonly') ? m[1] : esc(m[1]), n: m[0].length };
  return null;
};
P2.prototype.tokTag = function (src, mode) {
  const m = INLINE.tag.exec(src);
  if (!m) return null;
  if (mode === 'textonly') return { h: m[0], n: m[0].length };
  if (!this.state.inLink && R.startATag.test(m[0])) this.state.inLink = true;
  else if (this.state.inLink && R.endATag.test(m[0])) this.state.inLink = false;
  if (!this.state.inRawBlock && R.startPreScriptTag.test(m[0])) this.state.inRawBlock = true;
  else if (this.state.inRawBlock && R.endPreScriptTag.test(m[0])) this.state.inRawBlock = false;
  return { h: m[0], n: m[0].length };
};
P2.prototype.linkHtml = function (href, text, title, autolink) {
  const inner = autolink ? esc(text, true) : text;
  const clean = cleanUrl(href);
  if (clean === null) return inner;
  let out = '<a href="' + esc(clean, autolink) + '"';
  if (title) out += ' title="' + esc(title) + '"';
  return out + '>' + inner + '</a>';
};
P2.prototype.makeLink = function (m, href, title, rawLen, mode) {
  const label = m[1].replace(R.outputLinkReplace, '$1');
  const isImage = m[0].charAt(0) === '!';
  const savedInLink = this.state.inLink, savedEmitted = this.state.linkEmitted, savedRaw = this.state.inRawBlock;
  this.state.inLink = true;
  this.state.linkEmitted = false;
  if (isImage) {
    const alt = this.renderInline(label, 'textonly');
    const afterRaw = this.state.inRawBlock;
    this.state.linkEmitted = savedEmitted;
    this.state.inLink = savedInLink;
    this.state.inRawBlock = afterRaw;
    if (mode === 'text') return { h: alt, n: rawLen };
    const clean = cleanUrl(href);
    if (clean === null) return { h: esc(alt), n: rawLen };
    let out = `<img src="${esc(clean)}" alt="${esc(alt)}"`;
    if (title) out += ` title="${esc(title)}"`;
    return { h: out + '>', n: rawLen };
  }
  const inner = this.renderInline(label, mode);
  const nested = this.state.linkEmitted;
  const afterRaw = this.state.inRawBlock;
  this.state.linkEmitted = savedEmitted;
  this.state.inLink = savedInLink;
  this.state.inRawBlock = afterRaw;
  if (nested) { this.state.inRawBlock = savedRaw; return null; }
  this.state.linkEmitted = true;
  if (mode === 'text') return { h: inner, n: rawLen };
  const clean = cleanUrl(href);
  if (clean === null) return { h: inner, n: rawLen };
  let out = '<a href="' + esc(clean) + '"';
  if (title) out += ' title="' + esc(title) + '"';
  return { h: out + '>' + inner + '</a>', n: rawLen };
};
P2.prototype.tokLink = function (src, mode) {
  if (this.state.linkParenPossible === false) return null;
  const m = INLINE.link.exec(src);
  if (!m) return null;
  const bang = m[0].charAt(0) === '!' ? 2 : 1;
  if (hasInlineTag(src, m[1], bang)) return null;
  const dest = m[2].trim();
  if (R.startAngleBracket.test(dest)) {
    if (!R.endAngleBracket.test(dest)) return null;
    const cut = rtrim(dest.slice(0, -1), '\\');
    if ((dest.length - cut.length) % 2 === 0) return null;
  } else {
    const close = findClosingBracket(m[2], '()');
    if (close === -2) return null;
    if (close > -1) {
      const cutLen = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + close;
      m[2] = m[2].substring(0, close);
      m[0] = m[0].substring(0, cutLen).trim();
      m[3] = '';
    }
  }
  const trail = rtrim(m[0].slice(0, -1), '\\');
  if ((m[0].length - trail.length) % 2 === 0) return null;
  if (mode === 'textonly') {
    const label = m[1].replace(R.outputLinkReplace, '$1');
    const isImage = m[0].charAt(0) === '!';
    const savedEmitted = this.state.linkEmitted;
    this.state.linkEmitted = false;
    const h = this.renderInline(label, 'textonly');
    const nested = this.state.linkEmitted;
    this.state.linkEmitted = savedEmitted;
    if (!isImage && nested) return null;
    if (!isImage) this.state.linkEmitted = true;
    return { h, n: m[0].length };
  }
  let href = m[2].trim();
  const title = m[3] ? m[3].slice(1, -1) : '';
  if (R.startAngleBracket.test(href)) href = href.slice(1, -1);
  return this.makeLink(m, href.replace(INLINE.anyPunctuation, '$1'), title.replace(INLINE.anyPunctuation, '$1'), m[0].length, mode);
};
P2.prototype.tokReflink = function (src, mode) {
  const m = INLINE.reflink.exec(src) || INLINE.nolink.exec(src);
  if (!m) return null;
  const bang = m[0].charAt(0) === '!' ? 2 : 1;
  if (hasInlineTag(src, m[1], bang)) return null;
  const def = this.links[normLabel(m[2] || m[1])];
  if (!def) {
    const ch = m[0].charAt(0);
    return { h: esc(ch), n: 1 };
  }
  if (mode === 'textonly') {
    const label = m[1].replace(R.outputLinkReplace, '$1');
    const isImage = m[0].charAt(0) === '!';
    const savedEmitted = this.state.linkEmitted;
    this.state.linkEmitted = false;
    const h = this.renderInline(label, 'textonly');
    const nested = this.state.linkEmitted;
    this.state.linkEmitted = savedEmitted;
    if (!isImage && nested) return null;
    if (!isImage) this.state.linkEmitted = true;
    return { h, n: m[0].length };
  }
  return this.makeLink(m, def.href, def.title || null, m[0].length, mode);
};
P2.prototype.lastCloser = function (masked, ch) {
  const top = this.maskStack.at(-1);
  if (top && top.masked === masked) {
    if (!top.em) { const info = maskInfo(masked); top.em = info.em; top.del = info.del; }
    return ch === '~' ? top.del : top.em[ch];
  }
  const info = maskInfo(masked);
  return ch === '~' ? info.del : info.em[ch];
};
P2.prototype.tokEmStrong = function (src, masked, prev, mode) {
  const s0 = INLINE.emLDelimTilde.exec(src);
  if (!s0 || (!s0[1] && !s0[2] && !s0[3] && !s0[4])) return null;
  const ch = s0[0][0];
  const sameAsPrev = prev === ch;
  const off = masked.length - src.length;
  let l = off;
  while (l > 0 && masked[l - 1] === ch) l--;
  const before = [...masked.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const beforeIsDelimOrPunct = before === '*' || before === '_' || !!INLINE.punctuation.exec(before);
  let n = prev;
  if (l < off) n = before;
  const canOpen = l < off ? beforeIsDelimOrPunct : !!INLINE.punctuation.exec(n);
  if (s0[4] && R.unicodeAlphaNumeric.test(n)) return null;
  const d = s0[1] || s0[3] || '';
  if (!d || !n || canOpen) {
    const k = [...s0[0]].length - 1;
    let m = k, f = 0;
    const y = off - l + k;
    const rightOk = !!before.trim() && (!!d || (ch === '*' && !beforeIsDelimOrPunct));
    if (ch !== '*' && ch !== '_') return null;
    const rx = ch === '*' ? INLINE.emRDelimAstTilde : INLINE.emRDelimUnd;
    const last = this.lastCloser(masked, ch);
    const q = masked.length - src.length + k;
    if (last < q) return null;
    const tail = masked.slice(-1 * src.length + k);
    const limit = last - q;
    let s;
    for (rx.lastIndex = 0; (s = rx.exec(tail)) !== null && !(s.index > limit);) {
      const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!g) continue;
      const b0 = [...g].length;
      if (s[3] || s[4]) { m += b0; continue; }
      else if (s[5] || s[6] || rightOk) {
        if (sameAsPrev && (s[5] || s[6])) break;
        if (y % 3 && !((y + b0) % 3)) { f += b0; continue; }
      }
      m -= b0;
      if (m > 0) continue;
      let b = Math.min(b0, b0 + m + f);
      const firstLen = [...s[0]][0].length;
      const raw = src.slice(0, k + s.index + firstLen + b);
      if (Math.min(k, b) % 2) {
        const inner = raw.slice(1, -1);
        if (mode === 'textonly') return { h: this.renderInline(inner, 'textonly'), n: raw.length };
        return { h: `<em>${this.renderInline(inner, mode)}</em>`, n: raw.length };
      }
      const inner = raw.slice(2, -2);
      if (mode === 'textonly') return { h: this.renderInline(inner, 'textonly'), n: raw.length };
      return { h: `<strong>${this.renderInline(inner, mode)}</strong>`, n: raw.length };
    }
  }
  return null;
};
P2.prototype.tokCodespan = function (src, mode) {
  const m = INLINE.code.exec(src);
  if (!m) return null;
  let text = m[2].replace(R.newLineCharGlobal, ' ');
  if (R.nonSpaceChar.test(text) && R.startingSpaceChar.test(text) && R.endingSpaceChar.test(text)) {
    text = text.substring(1, text.length - 1);
  }
  if (mode === 'textonly') return { h: text, n: m[0].length };
  return { h: `<code>${esc(text, true)}</code>`, n: m[0].length };
};
P2.prototype.tokBr = function (src, mode) {
  const m = INLINE.br.exec(src);
  if (m) return { h: mode === 'textonly' ? '' : '<br>', n: m[0].length };
  return null;
};
P2.prototype.tokDel = function (src, masked, prev, mode) {
  const s0 = INLINE.delLDelim.exec(src);
  if (!s0) return null;
  if (!(s0[1] || '') || !prev || INLINE.punctuation.exec(prev)) {
    const o = [...s0[0]].length - 1;
    let p = o;
    const last = this.lastCloser(masked, '~');
    const d = masked.length - src.length + o;
    if (last < d) return null;
    const tail = masked.slice(-1 * src.length + o);
    const limit = last - d;
    const rx = INLINE.delRDelim;
    let s;
    for (rx.lastIndex = 0; (s = rx.exec(tail)) !== null && !(s.index > limit);) {
      const g = s[1] || s[2] || s[3] || s[4] || s[5] || s[6];
      if (!g) continue;
      let l = [...g].length;
      if (l !== o) continue;
      if (s[3] || s[4]) { p += l; continue; }
      p -= l;
      if (p > 0) continue;
      l = Math.min(l, l + p);
      const firstLen = [...s[0]][0].length;
      const raw = src.slice(0, o + s.index + firstLen + l);
      const inner = raw.slice(o, -o);
      if (mode === 'textonly') return { h: this.renderInline(inner, 'textonly'), n: raw.length };
      return { h: `<del>${this.renderInline(inner, mode)}</del>`, n: raw.length };
    }
  }
  return null;
};
P2.prototype.tokAutolink = function (src, mode) {
  const m = INLINE.autolink.exec(src);
  if (!m) return null;
  let text, href;
  if (m[2] === '@') { text = m[1]; href = 'mailto:' + text; }
  else { text = m[1]; href = text; }
  if (mode === 'textonly') return { h: text, n: m[0].length };
  return { h: this.linkHtml(href, text, null, true), n: m[0].length };
};
P2.prototype.tokUrl = function (src, mode) {
  const m = INLINE.url.exec(src);
  if (!m) return null;
  let text, href;
  if (m[2] === '@') { text = m[0]; href = 'mailto:' + text; }
  else {
    let prev;
    do {
      prev = m[0];
      m[0] = INLINE.backpedal.exec(m[0])?.[0] ?? '';
    } while (prev !== m[0]);
    text = m[0];
    href = m[1] === 'www.' ? 'http://' + m[0] : m[0];
  }
  if (mode === 'textonly') return { h: text, n: m[0].length };
  return { h: this.linkHtml(href, text, null, true), n: m[0].length };
};

// ----- inline text run: one native regex scan (same stop rules as the spec) -----
// A text run starts with a backtick/tilde run or any single char, then continues
// until just before: a special char (\ < ! [ ` * ~ _), 2+ spaces + newline,
// http(s):// or ftp://, www. (after start/space/*/_/~/( ), an email address,
// or mailto:/xmpp: after a non-alnum char. The email lookahead is guarded by a
// lookbehind so it only fires at the start of an email-char run.
const TEXT_RUN = /^(?:`+|~+|[^`~])(?:(?![\\<!\[`*~_])(?! {2,}\n)(?![hH][tT][tT][pP][sS]?:\/\/)(?![fF][tT][pP]:\/\/)(?!(?<=[ \t\n\r\f*_~(])www\.)(?!(?<![a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-])[a-zA-Z0-9.!#$%&'*+\/=?_`{|}~-]+@)(?!(?<=[^a-zA-Z0-9])(?:mailto:|xmpp:))[\s\S])*/;

P2.prototype.tokInlineText = function (src, mode) {
  const m = TEXT_RUN.exec(src);
  if (!m) return null;
  const run = m[0];
  let h;
  if (this.state.inRawBlock) h = run;
  else if (mode === 'text' || mode === 'textonly') h = run.indexOf('&') !== -1 ? unesc(run) : run;
  else h = run.indexOf('&') !== -1 ? esc(unesc(run)) : esc(run);
  return { h, n: run.length, last: run.charAt(run.length - 1) };
};


// ----- masking (for em/strong/del closer search) -----
P2.prototype.maskSrc = function (src) {
  let t = src;
  if (this.links && src.includes('[')) {
    const re = INLINE.reflinkSearch;
    const maskReflink = (m) => {
      const open = m.lastIndexOf('[');
      if (!Object.hasOwn(this.links, normLabel(m.slice(open + 1, -1)))) return m;
      if (open > 1 && m.charAt(0) !== '!') {
        const inner = m.slice(1, open - 1);
        if (this.linkInText(inner)) {
          return '[' + inner.replace(re, maskReflink) + '][' + 'a'.repeat(m.length - open - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(m.length - 2) + ']';
    };
    t = t.replace(re, maskReflink);
  }
  t = t.replace(INLINE.anyPunctuationOutsideCode, (m, ticks, punct) => {
    if (punct) return '+'.repeat(m.length);
    if (ticks) return ticks + m.slice(ticks.length, -ticks.length).replace(/`/g, '+') + ticks;
    return m;
  });
  if (t.includes('[') || t.includes('<') || t.includes('`')) t = t.replace(INLINE.blockSkip, (m) => '[' + 'a'.repeat(m.length - 2) + ']');
  return t;
};
P2.prototype.linkInText = function (s) {
  if (!s.includes('[')) return false;
  for (const m of s.matchAll(INLINE.blockSkip)) {
    if (INLINE.link.test(m[0]) && s.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of s.matchAll(INLINE.reflinkSearch)) {
    const txt = m[0];
    const r = txt.lastIndexOf('[');
    if (!(txt.charAt(0) === '!' || !Object.hasOwn(this.links, normLabel(txt.slice(r + 1, -1)))) && !(r > 1 && this.linkInText(txt.slice(1, r - 1)))) return true;
  }
  return false;
};

// ----- inline rendering loop -----
P2.prototype.renderInline = function (src, mode) {
  if (!src) return '';
  const savedParen = this.state.linkParenPossible;
  this.state.linkParenPossible = savedParen && src.includes(')');
  const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
  const masked = needsMask ? this.maskSrc(src) : src;
  this.maskStack.push(needsMask ? { masked, em: null, del: -1 } : { masked, em: { '*': -1, '_': -1 }, del: -1 });
  try {
    return this.inlineLoop(src, masked, mode);
  } finally {
    this.maskStack.pop();
    this.state.linkParenPossible = savedParen;
  }
};
P2.prototype.inlineLoop = function (src, masked, mode) {
  let out = '';
  let prev = '';
  let wasText = false;
  let shortest = Infinity;
  while (src) {
    if (src.length < shortest) shortest = src.length;
    else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    if (!wasText) prev = '';
    wasText = false;
    let res;
    if ((res = this.tokEscape(src, mode))) { src = src.substring(res.n); out += res.h; continue; }
    if ((res = this.tokTag(src, mode))) { src = src.substring(res.n); out += res.h; continue; }
    if ((res = this.tokLink(src, mode))) { src = src.substring(res.n); out += res.h; continue; }
    if ((res = this.tokReflink(src, mode))) { src = src.substring(res.n); out += res.h; continue; }
    if ((res = this.tokEmStrong(src, masked, prev, mode))) { src = src.substring(res.n); out += res.h; continue; }
    if ((res = this.tokCodespan(src, mode))) { src = src.substring(res.n); out += res.h; continue; }
    if ((res = this.tokBr(src, mode))) { src = src.substring(res.n); out += res.h; continue; }
    if ((res = this.tokDel(src, masked, prev, mode))) { src = src.substring(res.n); out += res.h; continue; }
    if ((res = this.tokAutolink(src, mode))) { src = src.substring(res.n); out += res.h; continue; }
    if (!this.state.inLink && (res = this.tokUrl(src, mode))) { src = src.substring(res.n); out += res.h; continue; }
    if ((res = this.tokInlineText(src, mode))) {
      src = src.substring(res.n);
      if (res.last !== '_') prev = res.last;
      wasText = true;
      out += res.h;
      continue;
    }
    if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    break;
  }
  return out;
};

// ----- block rendering -----
P2.prototype.renderCheckbox = function (checked) {
  return '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
};
P2.prototype.renderCode = function (t) {
  const lang = (t.lang || '').match(R.notSpaceStart)?.[0];
  const text = t.text ? t.text.replace(R.endingNewline, '') + '\n' : '';
  const body = esc(text, true);
  return lang
    ? `<pre><code class="language-${esc(lang)}">${body}</code></pre>\n`
    : `<pre><code>${body}</code></pre>\n`;
};
P2.prototype.renderCell = function (c) {
  const tag = c.header ? 'th' : 'td';
  return (c.align ? `<${tag} align="${c.align}">` : `<${tag}>`) + this.renderInline(c.text, 'html') + `</${tag}>\n`;
};
P2.prototype.renderTable = function (t) {
  let head = '';
  for (const c of t.header) head += this.renderCell(c);
  let body = '';
  for (const row of t.rows) {
    let cells = '';
    for (const c of row) cells += this.renderCell(c);
    body += `<tr>\n${cells}</tr>\n`;
  }
  if (body) body = `<tbody>${body}</tbody>`;
  return `<table>\n<thead>\n<tr>\n${head}</tr>\n</thead>\n${body}</table>\n`;
};
P2.prototype.renderList = function (t) {
  const items = [];
  for (const item of t.items) items.push(`<li>${this.renderBlocks(item.tokens)}</li>\n`);
  const tag = t.ordered ? 'ol' : 'ul';
  const start = t.ordered && t.start !== 1 ? ` start="${t.start}"` : '';
  return `<${tag}${start}>\n${items.join('')}</${tag}>\n`;
};
P2.prototype.renderBlocks = function (tokens) {
  const out = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'space': break;
      case 'hr': out.push('<hr>\n'); break;
      case 'heading': out.push(`<h${t.depth}>${this.renderInline(t.text, 'html')}</h${t.depth}>\n`); break;
      case 'code': out.push(this.renderCode(t)); break;
      case 'table': out.push(this.renderTable(t)); break;
      case 'blockquote': out.push(`<blockquote>\n${this.renderBlocks(t.tokens)}</blockquote>\n`); break;
      case 'list': out.push(this.renderList(t)); break;
      case 'checkbox': out.push(this.renderCheckbox(t.checked)); break;
      case 'html': out.push(t.text); break;
      case 'def': break;
      case 'paragraph':
        out.push('<p>' + (t.checkbox !== undefined ? this.renderCheckbox(t.checkbox) : '') + this.renderInline(t.text, 'html') + '</p>\n');
        break;
      case 'text':
        out.push((t.checkbox !== undefined ? this.renderCheckbox(t.checkbox) : '') + this.renderInline(t.text, 'html'));
        break;
      default: throw new Error('Token with "' + t.type + '" type was not found.');
    }
  }
  return out.join('');
};

export function parse(markdown) {
  const p = new P2();
  return p.renderBlocks(p.lex(markdown));
}
