/**
 * OpenSSH authorized keys files and public key files, as `sshd` reads them.
 * A line whose first character other than white space is `#` is a comment.
 * Any other line that is not blank lists one key: an optional comma-separated
 * list of options, which ends at white space outside double quotes, then the
 * key's type, its base64 data, and a comment that runs to the end of the
 * line. A line whose first or second word is not a key type lists no key, and
 * is left uncolored. A public key file's lines have no options.
 */

import type { Document, Line, StructureNode, TokenClass } from "../../model.ts";
import { flattenStructure } from "../../model.ts";
import { linesFromClasses } from "../classes.ts";
import {
  type LocatedEntry,
  structureNode,
  structureSource,
} from "../structure.ts";

/** A key type, such as `ssh-ed25519` or `sk-ssh-ed25519@openssh.com`. */
const KEY_TYPE = /^(?:ssh|ecdsa|sk|x509v3)-[\w.@+-]+$/;

/** A run of characters other than spaces, tabs, and carriage returns, which
 * may hold them inside double quotes. */
const WORD = /(?:[^ \t\r"]|"(?:[^"\\]|\\.)*"?)+/y;

/** One part of an option list: a name, a value, or a separator. */
const OPTION_PART = /([^=,]+)|(=(?:[^,"]|"(?:[^"\\]|\\.)*"?)*)|,/g;

const SPACE = /[ \t]*/y;

/** The token classes and keys of one source, from one pass over it. */
class Scanner {
  readonly classes: (TokenClass | undefined)[];
  readonly entries: LocatedEntry[] = [];

  constructor(text: string) {
    this.classes = new Array<TokenClass | undefined>(text.length);
    for (let start = 0; start <= text.length;) {
      const feed = text.indexOf("\n", start);
      const end = feed < 0 ? text.length : feed;
      this.#line(text.slice(start, end), start);
      start = end + 1;
    }
  }

  /** Scan `line`, which starts at offset `at` and holds no line feed, without
   * a carriage return that ends it. */
  #line(line: string, at: number): void {
    if (line.endsWith("\r")) line = line.slice(0, -1);
    let offset = skip(SPACE, line, 0);
    if (offset === line.length) return;
    if (line[offset] === "#") {
      this.classes.fill("comment", at + offset, at + line.length);
      return;
    }
    const start = offset;
    const first = wordAt(line, offset);
    if (!KEY_TYPE.test(first)) {
      offset = skip(SPACE, line, offset + first.length);
      if (!KEY_TYPE.test(wordAt(line, offset))) return;
      this.#options(first, at + start);
    }
    const keyType = wordAt(line, offset);
    this.classes.fill("typeName", at + offset, at + offset + keyType.length);
    offset = skip(SPACE, line, offset + keyType.length);
    const data = wordAt(line, offset);
    this.classes.fill("string", at + offset, at + offset + data.length);
    offset = skip(SPACE, line, offset + data.length);
    const comment = line.slice(offset).trimEnd();
    this.classes.fill("comment", at + offset, at + offset + comment.length);
    this.entries.push({
      kind: "variable",
      label: comment || keyType,
      startOffset: at + start,
      endOffset: at + line.length,
      astKind: "key",
    });
  }

  /** Color the option list `options`, which starts at offset `at`. */
  #options(options: string, at: number): void {
    for (const part of options.matchAll(OPTION_PART)) {
      const [text, name, value] = part;
      const start = at + part.index;
      if (name !== undefined) {
        this.classes.fill("propertyName", start, start + text.length);
      } else if (value !== undefined) {
        this.classes[start] = "operator";
        this.classes.fill("string", start + 1, start + text.length);
      } else {
        this.classes[start] = "punctuation";
      }
    }
  }
}

/** The offset after the run of `pattern`, a sticky expression, that starts at
 * `from` in `text`. A failed match resets `lastIndex` to 0, which leaves
 * `from`. */
function skip(pattern: RegExp, text: string, from: number): number {
  pattern.lastIndex = from;
  pattern.test(text);
  return Math.max(from, pattern.lastIndex);
}

/** The word of `line` that starts at `offset`, or an empty string. */
function wordAt(line: string, offset: number): string {
  return line.slice(offset, skip(WORD, line, offset));
}

/** Color `text`, one display line per source line. */
export function authorizedKeysLines(text: string): Line[] {
  return linesFromClasses(text, new Scanner(text).classes);
}

/** Color `text` and list the keys it holds. */
export function authorizedKeysDocument(text: string): Document {
  const scanner = new Scanner(text);
  const source = structureSource(text);
  const structure: StructureNode[] = scanner.entries.map((entry) =>
    structureNode(source, entry, 0, () => [])
  );
  return {
    text,
    lines: linesFromClasses(text, scanner.classes, source.lineStarts),
    structure,
    flatStructure: flattenStructure(structure),
    definitions: source.definitions,
  };
}
