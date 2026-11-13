/**
 * Colour for the source shown in the inspector. This is a reader's aid, not a parser: it
 * knows comments, strings, numbers and each language's commonest words, and it guesses
 * that a capitalised name is a type and a name before `(` is a function.
 */

export type TokenType = "plain" | "comment" | "string" | "number" | "keyword" | "type" | "function";

export interface Token {
  text: string;
  type: TokenType;
}

interface Grammar {
  /** Regular expression sources for comments, tried before anything else. */
  comments: string[];
  strings: string[];
  keywords: Set<string>;
}

const set = (text: string) => new Set(text.split(/\s+/).filter(Boolean));

const SLASHES = ["/\\*[\\s\\S]*?(?:\\*/|$)", "//[^\\n]*"];
const HASH = ["#[^\\n]*"];
const QUOTES = ['"(?:[^"\\\\\\n]|\\\\.)*"?', "'(?:[^'\\\\\\n]|\\\\.)*'?"];
const BACKTICK = "`(?:[^`\\\\]|\\\\[\\s\\S])*`?";

const SCRIPT = set(`const let var function return if else for while do switch case break continue new class extends
  implements interface type enum import export from default async await try catch finally throw typeof instanceof in
  of this super null undefined true false void public private protected readonly static abstract as satisfies keyof
  namespace declare yield delete get set`);
const C_LIKE = set(`class interface enum struct union public private protected internal static final const void int
  long float double char bool boolean string var val fun func return if else for foreach while do switch case default
  break continue new this base super null nullptr true false try catch finally throw throws using namespace package
  import extends implements override virtual abstract async await template typename auto unsigned signed short sizeof
  typedef function echo use when object data sealed open lateinit companion let guard self nil protocol extension
  include define ifdef ifndef endif pragma inline extern volatile record readonly out ref in is as get set`);

const GRAMMARS: Record<string, Grammar> = {
  script: { comments: SLASHES, strings: [...QUOTES, BACKTICK], keywords: SCRIPT },
  c: { comments: SLASHES, strings: QUOTES, keywords: C_LIKE },
  php: { comments: [...SLASHES, ...HASH], strings: QUOTES, keywords: C_LIKE },
  python: {
    comments: HASH,
    strings: ['"""[\\s\\S]*?(?:"""|$)', "'''[\\s\\S]*?(?:'''|$)", ...QUOTES],
    keywords: set(`def class return if elif else for while in not and or is None True False import from as with try
      except finally raise lambda yield async await pass break continue global nonlocal assert del self match case`),
  },
  go: {
    comments: SLASHES,
    strings: [...QUOTES, BACKTICK],
    keywords: set(`func package import return if else for range switch case default break continue go defer chan map
      struct interface type var const select fallthrough nil true false string int int64 float64 bool error byte any`),
  },
  rust: {
    comments: SLASHES,
    // A quote may open a lifetime (`'a`) rather than a character, so single quotes are left alone.
    strings: ['"(?:[^"\\\\]|\\\\[\\s\\S])*"?'],
    keywords: set(`fn let mut pub use mod struct enum impl trait for in if else match while loop return break continue
      as ref self Self super crate where async await move dyn static const unsafe type true false Some None Ok Err`),
  },
  ruby: {
    comments: HASH,
    strings: QUOTES,
    keywords: set(`def end class module if elsif else unless while until do return yield begin rescue ensure nil true
      false self require require_relative attr_accessor attr_reader attr_writer then case when and or not in super
      include extend private public protected raise lambda proc`),
  },
  shell: {
    comments: HASH,
    strings: QUOTES,
    keywords: set(`if then else elif fi for while do done case esac function return in echo export local set exit
      param foreach switch try catch finally throw`),
  },
  lua: {
    comments: ["--\\[\\[[\\s\\S]*?(?:\\]\\]|$)", "--[^\\n]*"],
    strings: QUOTES,
    keywords: set(`local function end if then else elseif for while do repeat until return break in and or not nil true
      false`),
  },
  sql: {
    comments: ["/\\*[\\s\\S]*?(?:\\*/|$)", "--[^\\n]*"],
    strings: QUOTES,
    keywords: set(`select from where insert into values update set delete create table index view drop alter add join
      left right inner outer on group by order having limit as and or not null primary key foreign references unique
      default SELECT FROM WHERE INSERT INTO VALUES UPDATE SET DELETE CREATE TABLE INDEX VIEW DROP ALTER ADD JOIN LEFT
      RIGHT INNER OUTER ON GROUP BY ORDER HAVING LIMIT AS AND OR NOT NULL PRIMARY KEY FOREIGN REFERENCES UNIQUE DEFAULT`),
  },
  data: { comments: [...HASH, ...SLASHES], strings: QUOTES, keywords: set("true false null yes no on off") },
  css: {
    comments: ["/\\*[\\s\\S]*?(?:\\*/|$)"],
    strings: QUOTES,
    keywords: set("important inherit initial unset none auto"),
  },
};

const BY_LANGUAGE: Record<string, string> = {
  typescript: "script",
  tsx: "script",
  javascript: "script",
  vue: "script",
  svelte: "script",
  python: "python",
  go: "go",
  rust: "rust",
  java: "c",
  kotlin: "c",
  csharp: "c",
  c: "c",
  cpp: "c",
  swift: "c",
  php: "php",
  ruby: "ruby",
  shell: "shell",
  powershell: "shell",
  lua: "lua",
  sql: "sql",
  json: "data",
  yaml: "data",
  toml: "data",
  css: "css",
  scss: "css",
};

const NUMBER = "\\b(?:0[xX][\\da-fA-F_]+|\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b";
const WORD = "[A-Za-z_$][\\w$]*";
const patterns = new Map<Grammar, RegExp>();

function patternOf(grammar: Grammar): RegExp {
  let pattern = patterns.get(grammar);
  if (!pattern) {
    const group = (sources: string[]) => `(${sources.join("|")})`;
    pattern = new RegExp(`${group(grammar.comments)}|${group(grammar.strings)}|(${NUMBER})|(${WORD})`, "g");
    patterns.set(grammar, pattern);
  }
  return pattern;
}

/** In prose only the headings stand out. */
function markdown(text: string): Token[][] {
  let fenced = false;
  return text.split("\n").map((line) => {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      return [{ text: line, type: "comment" as const }];
    }
    if (fenced) return [{ text: line, type: "string" as const }];
    return [{ text: line, type: /^#{1,6}\s/.test(line) ? ("keyword" as const) : ("plain" as const) }];
  });
}

/** The text as lines of coloured pieces. A language this does not know comes back plain. */
export function highlight(text: string, language: string | null | undefined): Token[][] {
  if (language === "markdown") return markdown(text);
  const grammar = GRAMMARS[BY_LANGUAGE[language ?? ""] ?? ""];
  if (!grammar) return text.split("\n").map((line) => [{ text: line, type: "plain" as const }]);

  const lines: Token[][] = [[]];
  const push = (piece: string, type: TokenType) => {
    // A comment or a string may run over several lines; each line gets its share.
    piece.split("\n").forEach((part, index) => {
      if (index > 0) lines.push([]);
      if (part !== "") lines[lines.length - 1]!.push({ text: part, type });
    });
  };

  const pattern = patternOf(grammar);
  pattern.lastIndex = 0;
  let at = 0;
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    if (match[0] === "") {
      pattern.lastIndex++;
      continue;
    }
    if (match.index > at) push(text.slice(at, match.index), "plain");
    const [whole, comment, string, number, word] = match;
    let type: TokenType = "plain";
    if (comment !== undefined) type = "comment";
    else if (string !== undefined) type = "string";
    else if (number !== undefined) type = "number";
    else if (word !== undefined) {
      if (grammar.keywords.has(word)) type = "keyword";
      else if (/^\s*\(/.test(text.slice(pattern.lastIndex, pattern.lastIndex + 8))) type = "function";
      else if (/^[A-Z][A-Za-z0-9]*[a-z]/.test(word)) type = "type";
    }
    push(whole, type);
    at = pattern.lastIndex;
  }
  if (at < text.length) push(text.slice(at), "plain");
  return lines;
}
