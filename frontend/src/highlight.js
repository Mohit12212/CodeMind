/*
 * Tiny dependency-free syntax tokenizer.
 * tokenize(code, lang) -> [{ t: "kw" | "str" | "com" | "num" | "fn" | "cls" | "const" | "dec" | "op" | null, s: "text" }]
 * Pure function: output text joined === input text, so it can sit under a <textarea> pixel-for-pixel.
 */

const words = (s) => new Set(s.split(/\s+/).filter(Boolean));

const KEYWORDS = {
  python: words(`and as assert async await break class continue def del elif else except finally for from global
    if import in is lambda nonlocal not or pass raise return try while with yield match case`),
  javascript: words(`async await break case catch class const continue debugger default delete do else export extends
    finally for from function if import in instanceof let new of return static super switch throw try typeof var void
    while with yield get set`),
  typescript: words(`async await break case catch class const continue debugger default delete do else enum export
    extends finally for from function if implements import in instanceof interface let namespace new of private
    protected public readonly return static super switch throw try type typeof var void while with yield abstract
    declare as is keyof get set`),
  go: words(`break case chan const continue default defer else fallthrough for func go goto if import interface map
    package range return select struct switch type var`),
  java: words(`abstract assert break case catch class continue default do else enum extends final finally for if
    implements import instanceof interface native new package private protected public return static super switch
    synchronized this throw throws try void volatile while var record`),
  cpp: words(`alignas auto break case catch class const constexpr continue default delete do else enum explicit
    extern for friend goto if inline namespace new noexcept operator private protected public return sizeof static
    struct switch template this throw try typedef typename union using virtual volatile while override`),
  c: words(`auto break case const continue default do else enum extern for goto if inline register return sizeof
    static struct switch typedef union volatile while`),
};

const TYPES = {
  python: words(`int str float bool list dict set tuple bytes object type range len print open input isinstance super`),
  javascript: words(`Array Object String Number Boolean Promise Map Set JSON Math Date console window document require`),
  typescript: words(`Array Object String Number Boolean Promise Map Set JSON Math Date console string number boolean any unknown never void`),
  go: words(`int int8 int16 int32 int64 uint uint8 uint16 uint32 uint64 float32 float64 string bool byte rune error any make len cap append`),
  java: words(`int long double float boolean char byte short String Object List Map Set System`),
  cpp: words(`int long double float bool char short void unsigned signed size_t string vector map set std`),
  c: words(`int long double float char short void unsigned signed size_t FILE`),
};

const CONSTS = words(`True False None self cls null undefined true false nil NaN Infinity this`);

const COMMENT = {
  python: String.raw`#[^\n]*`,
  c: String.raw`\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)`,
};

function build(lang) {
  const py = lang === "python";
  const comment = py ? COMMENT.python : COMMENT.c;
  const strings = py
    ? String.raw`"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|(?:[rRbBfFuU]{1,2})?"(?:[^"\\\n]|\\.)*(?:"|(?=\n)|$)|(?:[rRbBfFuU]{1,2})?'(?:[^'\\\n]|\\.)*(?:'|(?=\n)|$)`
    : String.raw`"(?:[^"\\\n]|\\.)*(?:"|(?=\n)|$)|'(?:[^'\\\n]|\\.)*(?:'|(?=\n)|$)|` + "`(?:[^`\\\\]|\\\\.)*(?:`|$)";
  const number = String.raw`\b0[xX][0-9a-fA-F_]+\b|\b\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?\b`;
  const deco = py ? String.raw`@[A-Za-z_][\w.]*` : "";
  const word = String.raw`[A-Za-z_$][\w$]*`;
  const parts = [
    `(${comment})`,
    `(${strings})`,
    `(${number})`,
    `(${deco || "(?!)"})`,
    `(${word})`,
  ];
  return new RegExp(parts.join("|"), "g");
}

const CACHE = {};

export function tokenize(code, lang = "python") {
  const key = lang;
  const re = (CACHE[key === "python" ? "python" : "c"] ||= build(key === "python" ? "python" : "c-like"));
  const kws = KEYWORDS[key] || KEYWORDS.python;
  const types = TYPES[key] || TYPES.python;
  const out = [];
  let last = 0;
  let prevWord = "";
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(code))) {
    if (m[0] === "") { re.lastIndex++; continue; }
    if (m.index > last) out.push({ t: null, s: code.slice(last, m.index) });
    const s = m[0];
    let t = null;
    let isWord = false;
    if (m[1] !== undefined) t = "com";
    else if (m[2] !== undefined) t = "str";
    else if (m[3] !== undefined) t = "num";
    else if (m[4] !== undefined) t = "dec";
    else {
      isWord = true;
      if (kws.has(s)) t = "kw";
      else if (CONSTS.has(s)) t = "const";
      else if (prevWord === "def" || prevWord === "function" || prevWord === "func") t = "fn";
      else if (prevWord === "class" || prevWord === "interface" || prevWord === "struct" || prevWord === "enum") t = "cls";
      else if (types.has(s)) t = "type";
      else if (code[re.lastIndex] === "(") t = "fn";
      else if (/^[A-Z][a-z]/.test(s)) t = "cls";
    }
    prevWord = isWord ? s : "";
    out.push({ t, s });
    last = re.lastIndex;
  }
  if (last < code.length) out.push({ t: null, s: code.slice(last) });
  return out;
}
