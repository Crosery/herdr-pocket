import { Fragment, memo, useMemo, type ReactNode } from "react";

export type SyntaxTokenKind =
  | "plain"
  | "comment"
  | "string"
  | "number"
  | "keyword"
  | "type"
  | "fn"
  | "prop"
  | "operator"
  | "tag"
  | "attr"
  | "var"
  | "punct";

export interface SyntaxToken {
  kind: SyntaxTokenKind;
  text: string;
}

export type CodeLanguage =
  | "js"
  | "ts"
  | "py"
  | "rust"
  | "go"
  | "c"
  | "java"
  | "swift"
  | "json"
  | "html"
  | "css"
  | "sh"
  | "yaml"
  | "toml"
  | "sql"
  | "md"
  | "plain";

const EXT_TO_LANG: Record<string, CodeLanguage> = {
  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "js",
  javascript: "js",
  ts: "ts",
  mts: "ts",
  cts: "ts",
  tsx: "ts",
  ets: "ts",
  arkts: "ts",
  typescript: "ts",
  py: "py",
  pyw: "py",
  pyi: "py",
  python: "py",
  rs: "rust",
  rust: "rust",
  go: "go",
  golang: "go",
  c: "c",
  h: "c",
  cc: "c",
  cpp: "c",
  cxx: "c",
  hpp: "c",
  hh: "c",
  m: "c",
  mm: "c",
  cs: "java",
  csharp: "java",
  java: "java",
  kt: "java",
  kts: "java",
  kotlin: "java",
  dart: "java",
  scala: "java",
  swift: "swift",
  json: "json",
  jsonc: "json",
  json5: "json",
  jsonl: "json",
  ndjson: "json",
  html: "html",
  htm: "html",
  xml: "html",
  svg: "html",
  vue: "html",
  svelte: "html",
  plist: "html",
  css: "css",
  scss: "css",
  sass: "css",
  less: "css",
  sh: "sh",
  bash: "sh",
  zsh: "sh",
  fish: "sh",
  shell: "sh",
  dockerfile: "sh",
  makefile: "sh",
  mk: "sh",
  env: "sh",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  ini: "toml",
  cfg: "toml",
  conf: "toml",
  properties: "toml",
  sql: "sql",
  sqlite: "sql",
  md: "md",
  mdx: "md",
  markdown: "md",
};

export function detectCodeLanguage(hint?: string | null, filePath?: string | null): CodeLanguage {
  const cleanHint = (hint ?? "").trim().toLowerCase();
  if (cleanHint && EXT_TO_LANG[cleanHint]) return EXT_TO_LANG[cleanHint]!;
  const rawPath = (filePath ?? "").trim();
  if (rawPath) {
    const base = rawPath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
    if (base === "dockerfile" || base.startsWith("dockerfile.")) return "sh";
    if (base === "makefile" || base === "gnumakefile") return "sh";
    if (base.endsWith(".d.ts")) return "ts";
    const dot = base.lastIndexOf(".");
    if (dot >= 0 && dot < base.length - 1) {
      const ext = base.slice(dot + 1);
      if (EXT_TO_LANG[ext]) return EXT_TO_LANG[ext]!;
    }
  }
  return "plain";
}

const KW_JS = new Set([
  "as", "async", "await", "break", "case", "catch", "class", "const", "continue", "debugger",
  "default", "delete", "do", "else", "enum", "export", "extends", "finally", "for", "from",
  "function", "get", "if", "implements", "import", "in", "instanceof", "interface", "let",
  "new", "of", "package", "private", "protected", "public", "readonly", "return", "satisfies",
  "set", "static", "super", "switch", "this", "throw", "try", "type", "typeof", "var", "void",
  "while", "with", "yield", "true", "false", "null", "undefined", "NaN", "Infinity",
  "declare", "namespace", "abstract", "override", "keyof", "infer", "asserts", "is",
]);

const KW_PY = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "case", "class",
  "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if",
  "import", "in", "is", "lambda", "match", "nonlocal", "not", "or", "pass", "raise", "return",
  "try", "while", "with", "yield", "self", "cls",
]);

const KW_RUST = new Set([
  "as", "async", "await", "break", "const", "continue", "crate", "dyn", "else", "enum", "extern",
  "false", "fn", "for", "if", "impl", "in", "let", "loop", "match", "mod", "move", "mut", "pub",
  "ref", "return", "self", "Self", "static", "struct", "super", "trait", "true", "type", "unsafe",
  "use", "where", "while", "Some", "None", "Ok", "Err",
]);

const KW_GO = new Set([
  "break", "case", "chan", "const", "continue", "default", "defer", "else", "fallthrough", "for",
  "func", "go", "goto", "if", "import", "interface", "map", "package", "range", "return", "select",
  "struct", "switch", "type", "var", "true", "false", "nil", "iota",
]);

const KW_C = new Set([
  "auto", "bool", "break", "case", "catch", "char", "class", "const", "constexpr", "continue",
  "default", "delete", "do", "double", "else", "enum", "explicit", "extern", "false", "float",
  "for", "friend", "goto", "if", "inline", "int", "long", "mutable", "namespace", "new", "noexcept",
  "nullptr", "NULL", "operator", "override", "private", "protected", "public", "register", "return",
  "short", "signed", "sizeof", "static", "struct", "switch", "template", "this", "throw", "true",
  "try", "typedef", "typename", "union", "unsigned", "using", "virtual", "void", "volatile", "while",
]);

const KW_JAVA = new Set([
  "abstract", "assert", "async", "await", "boolean", "break", "byte", "case", "catch", "char",
  "class", "const", "continue", "data", "default", "do", "double", "else", "enum", "extends",
  "false", "final", "finally", "float", "for", "fun", "if", "implements", "import", "in",
  "instanceof", "int", "interface", "is", "late", "lateinit", "long", "native", "new", "null",
  "object", "open", "override", "package", "private", "protected", "public", "record", "return",
  "sealed", "short", "static", "super", "suspend", "switch", "synchronized", "this", "throw",
  "throws", "transient", "true", "try", "val", "var", "void", "volatile", "when", "while", "yield",
]);

const KW_SWIFT = new Set([
  "actor", "as", "associatedtype", "async", "await", "break", "case", "catch", "class", "continue",
  "default", "defer", "deinit", "do", "else", "enum", "extension", "fallthrough", "false", "fileprivate",
  "for", "func", "guard", "if", "import", "in", "init", "inout", "internal", "is", "let", "nil",
  "open", "operator", "private", "protocol", "public", "repeat", "rethrows", "return", "self", "Self",
  "some", "static", "struct", "subscript", "super", "switch", "throw", "throws", "true", "try",
  "typealias", "var", "where", "while",
]);

const KW_SH = new Set([
  "if", "then", "else", "elif", "fi", "for", "in", "do", "done", "while", "until", "case", "esac",
  "function", "return", "local", "export", "readonly", "unset", "shift", "break", "continue", "exit",
  "true", "false", "source", "eval", "exec", "trap", "set", "FROM", "RUN", "CMD", "COPY", "ADD",
  "ENV", "ARG", "WORKDIR", "EXPOSE", "ENTRYPOINT", "VOLUME", "USER", "LABEL",
]);

const KW_SQL = new Set([
  "select", "from", "where", "join", "left", "right", "inner", "outer", "full", "cross", "on",
  "as", "and", "or", "not", "in", "is", "null", "true", "false", "like", "ilike", "between",
  "order", "by", "group", "having", "limit", "offset", "distinct", "insert", "into", "values",
  "update", "set", "delete", "create", "alter", "drop", "table", "index", "view", "if", "exists",
  "primary", "key", "foreign", "references", "unique", "default", "constraint", "union", "all",
  "case", "when", "then", "else", "end", "with", "returning", "conflict", "do", "nothing", "desc", "asc",
]);

const BUILTIN_TYPES = new Set([
  "string", "number", "boolean", "symbol", "bigint", "unknown", "never", "any", "object",
  "Promise", "Array", "Map", "Set", "WeakMap", "WeakSet", "Record", "Partial", "Required",
  "Pick", "Omit", "Readonly", "Date", "RegExp", "Error", "URL", "Buffer", "Uint8Array", "Math",
  "JSON", "console", "window", "document", "process", "globalThis",
  "str", "int", "float", "bool", "bytes", "list", "dict", "set", "tuple",
  "i8", "i16", "i32", "i64", "i128", "isize", "u8", "u16", "u32", "u64", "u128", "usize", "f32", "f64",
  "String", "Vec", "Option", "Result", "Box", "Arc", "Rc", "HashMap", "HashSet", "BTreeMap",
  "error", "rune", "byte", "uintptr", "int8", "int16", "int32", "int64", "uint8", "uint16", "uint32", "uint64", "float32", "float64",
]);

interface LexState {
  mode: "normal" | "blockComment" | "template" | "pyTripleDouble" | "pyTripleSingle" | "htmlComment";
}

function pushToken(out: SyntaxToken[], kind: SyntaxTokenKind, text: string): void {
  if (!text) return;
  const last = out[out.length - 1];
  if (last && last.kind === kind) {
    last.text += text;
  } else {
    out.push({ kind, text });
  }
}

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch);
}

function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

function isHexDigit(ch: string): boolean {
  return /[0-9a-fA-F_]/.test(ch);
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

function readQuoted(line: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < line.length) {
    const ch = line[i]!;
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) return i + 1;
    i += 1;
  }
  return line.length;
}

function tokenizeJsonLine(line: string): SyntaxToken[] {
  const out: SyntaxToken[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    const ch = line[i]!;
    if (/\s/.test(ch)) {
      let j = i + 1;
      while (j < n && /\s/.test(line[j]!)) j += 1;
      pushToken(out, "plain", line.slice(i, j));
      i = j;
      continue;
    }
    if (ch === "/" && line[i + 1] === "/") {
      pushToken(out, "comment", line.slice(i));
      break;
    }
    if (ch === '"') {
      const end = readQuoted(line, i, '"');
      let k = end;
      while (k < n && /\s/.test(line[k]!)) k += 1;
      const isKey = line[k] === ":";
      pushToken(out, isKey ? "prop" : "string", line.slice(i, end));
      i = end;
      continue;
    }
    if (ch === "-" || isDigit(ch)) {
      const m = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(line.slice(i));
      if (m) {
        pushToken(out, "number", m[0]);
        i += m[0].length;
        continue;
      }
    }
    const kw = /^(?:true|false|null)\b/.exec(line.slice(i));
    if (kw) {
      pushToken(out, "keyword", kw[0]);
      i += kw[0].length;
      continue;
    }
    if (/[{}\[\]:,]/.test(ch)) {
      pushToken(out, "punct", ch);
      i += 1;
      continue;
    }
    pushToken(out, "plain", ch);
    i += 1;
  }
  return out;
}

function tokenizeYamlOrTomlLine(line: string, lang: "yaml" | "toml"): SyntaxToken[] {
  const out: SyntaxToken[] = [];
  const trimmed = line.trimStart();
  const leadLen = line.length - trimmed.length;
  if (leadLen > 0) pushToken(out, "plain", line.slice(0, leadLen));
  if (!trimmed) return out;
  if (trimmed.startsWith("#") || (lang === "toml" && trimmed.startsWith(";"))) {
    pushToken(out, "comment", trimmed);
    return out;
  }
  if (lang === "toml" && trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    if (close > 0) {
      pushToken(out, "tag", trimmed.slice(0, close + 1));
      if (close + 1 < trimmed.length) pushToken(out, "comment", trimmed.slice(close + 1));
      return out;
    }
  }
  const sepRe = lang === "yaml" ? /^(-[ \t]+)?([A-Za-z0-9_.-]+|"[^"]+"|'[^']+')([ \t]*:)/ : /^([A-Za-z0-9_.-]+|"[^"]+")([ \t]*=)/;
  const m = sepRe.exec(trimmed);
  let rest = trimmed;
  if (m) {
    if (lang === "yaml") {
      if (m[1]) pushToken(out, "punct", m[1]);
      pushToken(out, "prop", m[2]!);
      pushToken(out, "punct", m[3]!);
    } else {
      pushToken(out, "prop", m[1]!);
      pushToken(out, "operator", m[2]!);
    }
    rest = trimmed.slice(m[0].length);
  }
  let i = 0;
  while (i < rest.length) {
    const ch = rest[i]!;
    if (ch === "#" && (i === 0 || /\s/.test(rest[i - 1]!))) {
      pushToken(out, "comment", rest.slice(i));
      break;
    }
    if (ch === '"' || ch === "'") {
      const end = readQuoted(rest, i, ch);
      pushToken(out, "string", rest.slice(i, end));
      i = end;
      continue;
    }
    const lit = /^(?:true|false|null|yes|no|on|off)\b/i.exec(rest.slice(i));
    if (lit && (i === 0 || /[\s,\[{]/.test(rest[i - 1]!))) {
      pushToken(out, "keyword", lit[0]);
      i += lit[0].length;
      continue;
    }
    const num = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/.exec(rest.slice(i));
    if (num && (i === 0 || /[\s,\[{]/.test(rest[i - 1]!))) {
      pushToken(out, "number", num[0]);
      i += num[0].length;
      continue;
    }
    pushToken(out, "plain", ch);
    i += 1;
  }
  return out;
}

function tokenizeHtmlLine(line: string, state: LexState): SyntaxToken[] {
  const out: SyntaxToken[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    if (state.mode === "htmlComment") {
      const end = line.indexOf("-->", i);
      if (end < 0) {
        pushToken(out, "comment", line.slice(i));
        return out;
      }
      pushToken(out, "comment", line.slice(i, end + 3));
      i = end + 3;
      state.mode = "normal";
      continue;
    }
    if (line.startsWith("<!--", i)) {
      state.mode = "htmlComment";
      const end = line.indexOf("-->", i + 4);
      if (end < 0) {
        pushToken(out, "comment", line.slice(i));
        return out;
      }
      pushToken(out, "comment", line.slice(i, end + 3));
      i = end + 3;
      state.mode = "normal";
      continue;
    }
    if (line[i] === "<") {
      const close = line.indexOf(">", i + 1);
      const tagEnd = close < 0 ? n : close + 1;
      const chunk = line.slice(i, tagEnd);
      const tm = /^(<\/?[A-Za-z!?][\w:-]*)/.exec(chunk);
      if (tm) {
        pushToken(out, "tag", tm[1]!);
        let j = tm[1]!.length;
        while (j < chunk.length) {
          const c = chunk[j]!;
          if (c === '"' || c === "'") {
            const qEnd = readQuoted(chunk, j, c);
            pushToken(out, "string", chunk.slice(j, qEnd));
            j = qEnd;
          } else if (c === "/" && chunk[j + 1] === ">") {
            pushToken(out, "tag", "/>");
            j += 2;
          } else if (c === ">") {
            pushToken(out, "tag", ">");
            j += 1;
          } else if (/[A-Za-z_:@-]/.test(c)) {
            let k = j + 1;
            while (k < chunk.length && /[A-Za-z0-9_:@.-]/.test(chunk[k]!)) k += 1;
            pushToken(out, "attr", chunk.slice(j, k));
            j = k;
          } else {
            pushToken(out, "punct", c);
            j += 1;
          }
        }
        i = tagEnd;
        continue;
      }
    }
    const nextLt = line.indexOf("<", i + 1);
    const stop = nextLt < 0 ? n : nextLt;
    pushToken(out, "plain", line.slice(i, stop));
    i = stop;
  }
  return out;
}

function tokenizeCssLine(line: string, state: LexState): SyntaxToken[] {
  const out: SyntaxToken[] = [];
  let i = 0;
  const n = line.length;
  while (i < n) {
    if (state.mode === "blockComment") {
      const end = line.indexOf("*/", i);
      if (end < 0) {
        pushToken(out, "comment", line.slice(i));
        return out;
      }
      pushToken(out, "comment", line.slice(i, end + 2));
      i = end + 2;
      state.mode = "normal";
      continue;
    }
    const ch = line[i]!;
    if (ch === "/" && line[i + 1] === "*") {
      state.mode = "blockComment";
      const end = line.indexOf("*/", i + 2);
      if (end < 0) {
        pushToken(out, "comment", line.slice(i));
        return out;
      }
      pushToken(out, "comment", line.slice(i, end + 2));
      i = end + 2;
      state.mode = "normal";
      continue;
    }
    if (ch === "/" && line[i + 1] === "/") {
      pushToken(out, "comment", line.slice(i));
      break;
    }
    if (ch === '"' || ch === "'") {
      const end = readQuoted(line, i, ch);
      pushToken(out, "string", line.slice(i, end));
      i = end;
      continue;
    }
    if (ch === "@") {
      const m = /^@[A-Za-z-]+/.exec(line.slice(i));
      if (m) {
        pushToken(out, "keyword", m[0]);
        i += m[0].length;
        continue;
      }
    }
    if (ch === "-" && line[i + 1] === "-") {
      const m = /^--[A-Za-z0-9_-]+/.exec(line.slice(i));
      if (m) {
        pushToken(out, "var", m[0]);
        i += m[0].length;
        continue;
      }
    }
    if (ch === "#") {
      const hex = /^#[0-9a-fA-F]{3,8}\b/.exec(line.slice(i));
      if (hex) {
        pushToken(out, "number", hex[0]);
        i += hex[0].length;
        continue;
      }
    }
    const num = /^-?\d+(?:\.\d+)?(?:px|rem|em|vh|vw|cqi|cqw|%|ms|s|deg|fr)?\b/.exec(line.slice(i));
    if (num && (i === 0 || /[\s:(,]/.test(line[i - 1]!))) {
      pushToken(out, "number", num[0]);
      i += num[0].length;
      continue;
    }
    if (/[A-Za-z_-]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_-]/.test(line[j]!)) j += 1;
      const word = line.slice(i, j);
      let k = j;
      while (k < n && line[k] === " ") k += 1;
      const before = line.slice(0, i);
      const inPseudoSelector = /^\s*[.#@a-zA-Z*\[][^{]*$/.test(before) && before.trim().length > 0 && !before.includes(";");
      if (line[k] === ":" && line[k + 1] !== ":" && !inPseudoSelector) {
        pushToken(out, "prop", word);
      } else if (line[j] === "(") {
        pushToken(out, "fn", word);
      } else if (i > 0 && (line[i - 1] === "." || line[i - 1] === "#")) {
        pushToken(out, "tag", word);
      } else {
        pushToken(out, "plain", word);
      }
      i = j;
      continue;
    }
    pushToken(out, /[{};:(),]/.test(ch) ? "punct" : "plain", ch);
    i += 1;
  }
  return out;
}

function tokenizeMarkdownLine(line: string): SyntaxToken[] {
  if (/^\s*#{1,6}\s/.test(line)) return [{ kind: "keyword", text: line }];
  if (/^\s*>/.test(line)) return [{ kind: "comment", text: line }];
  if (/^\s*```/.test(line)) return [{ kind: "tag", text: line }];
  const out: SyntaxToken[] = [];
  const re = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line)) !== null) {
    if (m.index > last) pushToken(out, "plain", line.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("`")) pushToken(out, "string", tok);
    else if (tok.startsWith("**")) pushToken(out, "keyword", tok);
    else pushToken(out, "fn", tok);
    last = m.index + tok.length;
  }
  if (last < line.length) pushToken(out, "plain", line.slice(last));
  return out;
}

function keywordsFor(lang: CodeLanguage): Set<string> {
  switch (lang) {
    case "js":
    case "ts":
      return KW_JS;
    case "py":
      return KW_PY;
    case "rust":
      return KW_RUST;
    case "go":
      return KW_GO;
    case "c":
      return KW_C;
    case "java":
      return KW_JAVA;
    case "swift":
      return KW_SWIFT;
    case "sh":
      return KW_SH;
    case "sql":
      return KW_SQL;
    default:
      return KW_JS;
  }
}

function tokenizeCodeLine(line: string, lang: CodeLanguage, state: LexState): SyntaxToken[] {
  if (lang === "json") return tokenizeJsonLine(line);
  if (lang === "yaml" || lang === "toml") return tokenizeYamlOrTomlLine(line, lang);
  if (lang === "html") return tokenizeHtmlLine(line, state);
  if (lang === "css") return tokenizeCssLine(line, state);
  if (lang === "md") return tokenizeMarkdownLine(line);
  if (lang === "plain") return [{ kind: "plain", text: line }];

  const out: SyntaxToken[] = [];
  const kws = keywordsFor(lang);
  const hashComment = lang === "py" || lang === "sh";
  const slashComment = lang !== "py" && lang !== "sh" && lang !== "sql";
  const dashComment = lang === "sql";
  const supportsBacktick = lang === "js" || lang === "ts" || lang === "go" || lang === "sh";

  let i = 0;
  const n = line.length;

  while (i < n) {
    if (state.mode === "blockComment") {
      const end = line.indexOf("*/", i);
      if (end < 0) {
        pushToken(out, "comment", line.slice(i));
        return out;
      }
      pushToken(out, "comment", line.slice(i, end + 2));
      i = end + 2;
      state.mode = "normal";
      continue;
    }
    if (state.mode === "template") {
      let j = i;
      while (j < n) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line[j] === "`") {
          pushToken(out, "string", line.slice(i, j + 1));
          i = j + 1;
          state.mode = "normal";
          break;
        }
        j += 1;
      }
      if (state.mode === "template") {
        pushToken(out, "string", line.slice(i));
        return out;
      }
      continue;
    }
    if (state.mode === "pyTripleDouble" || state.mode === "pyTripleSingle") {
      const delim = state.mode === "pyTripleDouble" ? '"""' : "'''";
      const end = line.indexOf(delim, i);
      if (end < 0) {
        pushToken(out, "string", line.slice(i));
        return out;
      }
      pushToken(out, "string", line.slice(i, end + 3));
      i = end + 3;
      state.mode = "normal";
      continue;
    }

    const ch = line[i]!;

    // Whitespace
    if (/\s/.test(ch)) {
      let j = i + 1;
      while (j < n && /\s/.test(line[j]!)) j += 1;
      pushToken(out, "plain", line.slice(i, j));
      i = j;
      continue;
    }

    // Comments
    if (slashComment && ch === "/" && line[i + 1] === "/") {
      pushToken(out, "comment", line.slice(i));
      break;
    }
    if ((slashComment || lang === "sql") && ch === "/" && line[i + 1] === "*") {
      const end = line.indexOf("*/", i + 2);
      if (end < 0) {
        state.mode = "blockComment";
        pushToken(out, "comment", line.slice(i));
        return out;
      }
      pushToken(out, "comment", line.slice(i, end + 2));
      i = end + 2;
      continue;
    }
    if (hashComment && ch === "#") {
      pushToken(out, "comment", line.slice(i));
      break;
    }
    if (dashComment && ch === "-" && line[i + 1] === "-") {
      pushToken(out, "comment", line.slice(i));
      break;
    }

    // C/C++ preprocessor directives & Rust attributes & Python/TS decorators
    if (lang === "c" && ch === "#" && /^\s*$/.test(line.slice(0, i))) {
      const m = /^#[ \t]*[A-Za-z_]\w*/.exec(line.slice(i));
      if (m) {
        pushToken(out, "keyword", m[0]);
        i += m[0].length;
        continue;
      }
    }
    if ((lang === "py" || lang === "ts" || lang === "java" || lang === "swift") && ch === "@") {
      const m = /^@[A-Za-z_][\w.]*/.exec(line.slice(i));
      if (m) {
        pushToken(out, "attr", m[0]);
        i += m[0].length;
        continue;
      }
    }
    if (lang === "sh" && ch === "$") {
      const m = /^\$(?:\{[^}]+\}|[A-Za-z_]\w*|[0-9@#?$!*_-])/.exec(line.slice(i));
      if (m) {
        pushToken(out, "var", m[0]);
        i += m[0].length;
        continue;
      }
    }

    // Python triple-quoted strings
    if (lang === "py" && (line.startsWith('"""', i) || line.startsWith("'''", i))) {
      const delim = line.slice(i, i + 3);
      const end = line.indexOf(delim, i + 3);
      if (end < 0) {
        state.mode = delim === '"""' ? "pyTripleDouble" : "pyTripleSingle";
        pushToken(out, "string", line.slice(i));
        return out;
      }
      pushToken(out, "string", line.slice(i, end + 3));
      i = end + 3;
      continue;
    }

    // Template literals (multi-line capable)
    if (supportsBacktick && ch === "`") {
      let j = i + 1;
      let closed = false;
      while (j < n) {
        if (line[j] === "\\") {
          j += 2;
          continue;
        }
        if (line[j] === "`") {
          pushToken(out, "string", line.slice(i, j + 1));
          i = j + 1;
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) {
        state.mode = "template";
        pushToken(out, "string", line.slice(i));
        return out;
      }
      continue;
    }

    // Single / Double quoted strings (skip Rust lifetimes like 'a)
    if (ch === '"' || (ch === "'" && !(lang === "rust" && i + 1 < n && /[A-Za-z_]/.test(line[i + 1]!) && line[i + 2] !== "'"))) {
      const end = readQuoted(line, i, ch);
      pushToken(out, "string", line.slice(i, end));
      i = end;
      continue;
    }

    // Numbers
    if (isDigit(ch) || (ch === "." && i + 1 < n && isDigit(line[i + 1]!))) {
      let j = i;
      if (line[j] === "0" && (line[j + 1] === "x" || line[j + 1] === "X" || line[j + 1] === "b" || line[j + 1] === "o")) {
        j += 2;
        while (j < n && isHexDigit(line[j]!)) j += 1;
      } else {
        while (j < n && (isDigit(line[j]!) || line[j] === "_")) j += 1;
        if (line[j] === "." && j + 1 < n && isDigit(line[j + 1]!)) {
          j += 1;
          while (j < n && (isDigit(line[j]!) || line[j] === "_")) j += 1;
        }
        if ((line[j] === "e" || line[j] === "E") && j + 1 < n) {
          let k = j + 1;
          if (line[k] === "+" || line[k] === "-") k += 1;
          if (k < n && isDigit(line[k]!)) {
            j = k + 1;
            while (j < n && (isDigit(line[j]!) || line[j] === "_")) j += 1;
          }
        }
      }
      if (line[j] === "n" || line[j] === "u" || line[j] === "f" || line[j] === "L") j += 1;
      pushToken(out, "number", line.slice(i, j));
      i = j;
      continue;
    }

    // Identifiers, keywords, types, functions, properties
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < n && isIdentChar(line[j]!)) j += 1;
      const word = line.slice(i, j);
      const isKeyCheck = lang === "sql" ? kws.has(word.toLowerCase()) : kws.has(word);
      const prevNonSpace = (() => {
        for (let p = i - 1; p >= 0; p -= 1) {
          if (!/\s/.test(line[p]!)) return line[p]!;
        }
        return "";
      })();
      let nextNonSpaceIdx = j;
      while (nextNonSpaceIdx < n && line[nextNonSpaceIdx] === " ") nextNonSpaceIdx += 1;
      const nextCh = line[nextNonSpaceIdx] ?? "";

      if (isKeyCheck && prevNonSpace !== ".") {
        pushToken(out, "keyword", word);
      } else if (nextCh === "(" || (lang === "rust" && nextCh === "!")) {
        pushToken(out, "fn", word);
      } else if (prevNonSpace === ".") {
        pushToken(out, "prop", word);
      } else if (BUILTIN_TYPES.has(word) || (/^[A-Z][A-Za-z0-9_]*$/.test(word) && /[a-z]/.test(word))) {
        pushToken(out, "type", word);
      } else if (nextCh === ":" && line[nextNonSpaceIdx + 1] !== ":" && (lang === "js" || lang === "ts")) {
        pushToken(out, "prop", word);
      } else {
        pushToken(out, "plain", word);
      }
      i = j;
      continue;
    }

    // Operators & punctuation
    if (/[=+\-*/%<>!&|^~?:⇒≥≤≠]/.test(ch)) {
      pushToken(out, "operator", ch);
      i += 1;
      continue;
    }
    if (/[{}\[\](),.;]/.test(ch)) {
      pushToken(out, "punct", ch);
      i += 1;
      continue;
    }

    pushToken(out, "plain", ch);
    i += 1;
  }
  return out;
}

const MAX_HIGHLIGHT_CHARS = 300_000;

export function tokenizeCodeLines(lines: readonly string[], lang: CodeLanguage): SyntaxToken[][] {
  if (lang === "plain") {
    return lines.map((text) => [{ kind: "plain", text }]);
  }
  let total = 0;
  for (const l of lines) {
    total += l.length;
    if (total > MAX_HIGHLIGHT_CHARS) {
      return lines.map((text) => [{ kind: "plain", text }]);
    }
  }
  const state: LexState = { mode: "normal" };
  return lines.map((line) => tokenizeCodeLine(line, lang, state));
}

export function renderSyntaxTokens(tokens: readonly SyntaxToken[]): ReactNode {
  if (tokens.length === 0) return " ";
  if (tokens.length === 1 && tokens[0]!.kind === "plain") {
    return tokens[0]!.text || " ";
  }
  return tokens.map((tok, i) =>
    tok.kind === "plain" ? (
      <Fragment key={i}>{tok.text}</Fragment>
    ) : (
      <span key={i} className={`tok-${tok.kind}`}>
        {tok.text}
      </span>
    ),
  );
}

export const HighlightedCodeBlock = memo(function HighlightedCodeBlock({
  code,
  language,
  filePath,
  className,
}: {
  code: string;
  language?: string | null;
  filePath?: string | null;
  className?: string;
}) {
  const lang = detectCodeLanguage(language, filePath);
  const tokenized = useMemo(() => tokenizeCodeLines(code.split("\n"), lang), [code, lang]);
  return (
    <pre className={className} data-lang={lang}>
      {tokenized.map((lineTokens, idx) => (
        <Fragment key={idx}>
          {idx > 0 ? "\n" : null}
          {renderSyntaxTokens(lineTokens)}
        </Fragment>
      ))}
    </pre>
  );
});

export function highlightSingleLine(text: string, lang: CodeLanguage): ReactNode {
  if (lang === "plain" || !text) return text;
  const tokens = tokenizeCodeLine(text, lang, { mode: "normal" });
  return renderSyntaxTokens(tokens);
}
