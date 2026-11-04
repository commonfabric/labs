/**
 * ProGuard and R8 keep rules for the pager. A rules file is a series of
 * options, each a word starting with `-` followed by its arguments, and `#`
 * comments that run to the end of a line. The arguments name classes and
 * members in Java's syntax, extended with wildcards. A token's class follows
 * from its own spelling and from whether a parenthesis follows it, so coloring
 * keeps no state from one line to the next.
 */

import type { Document, Line, TokenClass } from "../../model.ts";
import { linesFromClasses } from "../classes.ts";

/**
 * One alternative per token shape, tried in order: comment, quoted name,
 * option, special member name, annotation, name, operator, bracket,
 * punctuation. A name may hold wildcards, inner-class separators, and array
 * brackets.
 */
const TOKENS =
  /(#.*)|('[^'\n]*'?|"[^"\n]*"?)|((?<![\w$.*?%])-[A-Za-z]\w*)|(<\w+>)|(@)|([\w$.*?%\[\]]+)|([!]+)|([(){}])|([;,:])/g;

/** Access flags, member kinds, and option modifiers. */
const KEYWORDS = new Set([
  "abstract",
  "allowaccessmodification",
  "allowobfuscation",
  "allowoptimization",
  "allowshrinking",
  "bridge",
  "class",
  "enum",
  "extends",
  "final",
  "implements",
  "includecode",
  "includedescriptorclasses",
  "interface",
  "mandated",
  "native",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "strictfp",
  "synchronized",
  "synthetic",
  "transient",
  "varargs",
  "volatile",
]);

const PRIMITIVES = new Set([
  "boolean",
  "byte",
  "char",
  "double",
  "float",
  "int",
  "long",
  "short",
  "void",
]);

/** A parenthesis after optional space, which makes a name a method's. */
const CALL = /[ \t]*\(/y;

/** The class of a name, from its spelling and whether a call follows it. */
function nameClass(name: string, called: boolean): TokenClass {
  if (/^(?:[*?%]+|\.\.\.)$/.test(name)) return "operator";
  if (KEYWORDS.has(name)) return "keyword";
  if (PRIMITIVES.has(name.replace(/(?:\[\])+$/, ""))) return "typeKeyword";
  if (called) return "callName";
  return /[.*?%$]|^[A-Z]/.test(name) ? "typeName" : "identifier";
}

function called(text: string, end: number): boolean {
  CALL.lastIndex = end;
  return CALL.test(text);
}

/** Color `text`, one display line per source line. */
export function proguardLines(text: string): Line[] {
  const classes = new Array<TokenClass | undefined>(text.length);
  for (const match of text.matchAll(TOKENS)) {
    const start = match.index;
    const end = start + match[0].length;
    const cls: TokenClass = match[1] !== undefined
      ? "comment"
      : match[2] !== undefined
      ? "string"
      : match[3] !== undefined || match[4] !== undefined
      ? "keyword"
      : match[5] !== undefined || match[7] !== undefined
      ? "operator"
      : match[6] !== undefined
      ? nameClass(match[6], called(text, end))
      : match[8] !== undefined
      ? "bracket"
      : "punctuation";
    classes.fill(cls, start, end);
  }
  return linesFromClasses(text, classes);
}

/** A document with colored lines and no structure. */
export function proguardDocument(text: string): Document {
  return {
    text,
    lines: proguardLines(text),
    structure: [],
    flatStructure: [],
    definitions: new Map(),
  };
}
