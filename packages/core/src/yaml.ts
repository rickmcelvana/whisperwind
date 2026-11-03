/**
 * Minimal YAML subset reader, enough for `models.yaml` and run configs.
 *
 * Supported: nested block mappings, block sequences of mappings, quoted and unquoted
 * scalars, `true`/`false`/`null`/numbers, `#` comments, and blank lines.
 * Not supported: anchors, aliases, multi-document streams, flow collections
 * (`{a: 1}`), block scalars (`|`, `>`), and merge keys.
 *
 * Rejecting the unsupported cases loudly is deliberate: a config that silently
 * parses to the wrong shape would change which model an arm runs.
 */

export type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue };
export type YamlObject = { [k: string]: YamlValue };

export class YamlError extends Error {
  /** Line number in the source file (1-based). */
  readonly line: number;

  constructor(message: string, line: number) {
    super(`models.yaml:${line}: ${message}`);
    this.name = "YamlError";
    this.line = line;
  }
}

interface Line {
  readonly indent: number;
  readonly text: string;
  readonly number: number;
}

function tokenize(source: string): Line[] {
  const out: Line[] = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    if (/^\s*$/.test(raw)) continue;
    if (/^\s*#/.test(raw)) continue;
    const withoutComment = stripComment(raw);
    if (/^\s*$/.test(withoutComment)) continue;
    const indent = withoutComment.length - withoutComment.trimStart().length;
    out.push({ indent, text: withoutComment.trim(), number: i + 1 });
  }
  return out;
}

/** Remove a trailing comment, respecting quotes. */
function stripComment(raw: string): string {
  let quote: string | null = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      continue;
    }
    if (c === "#" && (i === 0 || raw[i - 1] === " " || raw[i - 1] === "\t")) {
      return raw.slice(0, i).trimEnd();
    }
  }
  return raw.trimEnd();
}

function scalar(text: string, line: number): YamlValue {
  const t = text.trim();
  if (t === "") return null;
  if (
    (t.startsWith('"') && t.endsWith('"') && t.length >= 2) ||
    (t.startsWith("'") && t.endsWith("'") && t.length >= 2)
  ) {
    return t.slice(1, -1);
  }
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null" || t === "~") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.startsWith("{") || t.startsWith("[")) {
    throw new YamlError("flow collections are not supported; use block style", line);
  }
  if (t.startsWith("|") || t.startsWith(">")) {
    throw new YamlError("block scalars are not supported", line);
  }
  if (t.startsWith("&") || t.startsWith("*")) {
    throw new YamlError("anchors and aliases are not supported", line);
  }
  return t;
}

class Parser {
  private i = 0;
  /** Mutable: a sequence item that opens a mapping is re-read with its key indented. */
  private readonly lines: Line[];

  constructor(lines: readonly Line[]) {
    this.lines = [...lines];
  }

  parse(): YamlObject {
    if (this.lines.length === 0) return {};
    const value = this.parseBlock(this.lines[0]?.indent ?? 0);
    if (!isObject(value)) throw new YamlError("top level must be a mapping", this.lines[0]?.number ?? 1);
    if (this.i < this.lines.length) {
      throw new YamlError("unexpected content after the document", this.lines[this.i]?.number ?? 0);
    }
    return value;
  }

  private parseBlock(indent: number): YamlValue {
    const first = this.lines[this.i];
    if (!first) return null;
    if (first.text.startsWith("- ") || first.text === "-") return this.parseSequence(indent);
    return this.parseMapping(indent);
  }

  private parseSequence(indent: number): YamlValue[] {
    const out: YamlValue[] = [];
    while (this.i < this.lines.length) {
      const line = this.lines[this.i];
      if (!line || line.indent !== indent) break;
      if (!line.text.startsWith("- ") && line.text !== "-") break;
      const rest = line.text === "-" ? "" : line.text.slice(2).trim();
      if (rest === "") {
        this.i++;
        const next = this.lines[this.i];
        out.push(next && next.indent > indent ? this.parseBlock(next.indent) : null);
        continue;
      }
      // "- key: value" opens a mapping whose remaining keys align under `key`.
      if (/^[A-Za-z0-9_.-]+\s*:/.test(rest)) {
        const keyIndent = indent + 2;
        this.lines[this.i] = { indent: keyIndent, text: rest, number: line.number };
        out.push(this.parseMapping(keyIndent));
        continue;
      }
      out.push(scalar(rest, line.number));
      this.i++;
    }
    return out;
  }

  private parseMapping(indent: number): YamlObject {
    const out: YamlObject = {};
    while (this.i < this.lines.length) {
      const line = this.lines[this.i];
      if (!line || line.indent !== indent) break;
      if (line.text.startsWith("- ")) break;
      const m = /^([^:]+):\s*(.*)$/.exec(line.text);
      if (!m) throw new YamlError(`expected "key: value", got ${JSON.stringify(line.text)}`, line.number);
      const key = (m[1] ?? "").trim();
      const rest = (m[2] ?? "").trim();
      if (key === "") throw new YamlError("empty key", line.number);
      this.i++;
      if (rest !== "") {
        out[key] = scalar(rest, line.number);
        continue;
      }
      const next = this.lines[this.i];
      if (next && next.indent > indent) {
        out[key] = this.parseBlock(next.indent);
      } else if (next && next.indent === indent && (next.text.startsWith("- ") || next.text === "-")) {
        out[key] = this.parseSequence(indent);
      } else {
        out[key] = null;
      }
    }
    return out;
  }
}

function isObject(v: YamlValue): v is YamlObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseYaml(source: string): YamlObject {
  return new Parser(tokenize(source)).parse();
}
