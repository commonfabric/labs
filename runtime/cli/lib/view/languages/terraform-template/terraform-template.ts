/**
 * Terraform's template syntax, which OpenTofu's and Terraform's `templatefile`
 * function reads, as a layer over the syntax of the text a template produces,
 * such as a shell script. Everything in a template is text it produces except
 * three kinds of sequence:
 *
 * - an interpolation, `${…}`, which produces the value of the expression
 *   inside it;
 * - a directive, `%{…}`, such as `%{ if … }`, `%{ else }`, `%{ endif }`,
 *   `%{ for … in … }`, and `%{ endfor }`, which produces nothing itself; and
 * - an escape, `$${` or `%%{`, which produces `${` or `%{`.
 *
 * A scan of each interpolation and directive finds where it ends and colors
 * its code, which is HCL's expression syntax, as the HCL language colors the
 * same code. The escaping character of an escape is punctuation. The host
 * reads an interpolation as a value, a directive as blank space, and an escape
 * as the text it produces, after a word character in place of its escaping
 * character.
 */

import type { TokenClass } from "../../model.ts";
import type { TemplateRegion, TemplateSyntax } from "../template.ts";

/** A `for` expression or directive the scan is inside. */
interface Loop {
  /** Among the names it binds, between its `in` and its `:`, or past it. */
  stage: "binding" | "iterating" | "body";

  /** How many brackets were open where it starts. */
  readonly depth: number;

  /** How many conditionals' `?` past its `in` await their `:`. */
  conditionals: number;
}

/** The state of the scan of an expression. */
interface Expression {
  readonly kind: "expression";

  /** Whether the expression is a directive's, where a control word starts. */
  readonly directive: boolean;

  /**
   * The brackets of each kind opened inside the expression and not yet
   * closed, innermost last.
   */
  readonly brackets: string[];

  /** How many of the open brackets are braces. */
  braces: number;

  /** The `for` expressions or directive the scan is inside, innermost last. */
  readonly loops: Loop[];

  /** The token before, other than white space, comments, and strip markers. */
  previous: string | undefined;

  /**
   * Whether the token before can end a value, as a name, a literal, or a
   * closing bracket can, so that a line break after it ends an item.
   */
  valueEnd: boolean;

  /** Whether a line break follows the token before. */
  lineBreak: boolean;

  /**
   * The name the token before is, which the token after can make a call's
   * name or an object's key, by where it starts and ends and which of the two
   * it can be.
   */
  name:
    | {
      readonly start: number;
      readonly end: number;
      readonly call: boolean;
      readonly key: boolean;
    }
    | undefined;

  /**
   * The reference the token before ends, such as `a.b`, by its first name and
   * how many names it holds.
   */
  reference: { readonly first: string; length: number } | undefined;
}

/** What the scan of a sequence is inside. */
type Frame =
  | Expression
  | { readonly kind: "quoted" }
  | { readonly kind: "heredoc"; readonly delimiter: string };

/**
 * One alternative per token shape: white space, a quote, a line comment, a
 * block comment, a heredoc's opening, an operator, a bracket, punctuation, a
 * number, with the digits that start it, and a name, which may hold `::` as a
 * provider's function does. Anything else is one character of its own.
 */
const TOKEN =
  /(\s+)|(")|(#|\/\/)|(\/\*)|<<-?([\p{ID_Start}_][\p{ID_Continue}-]*)\r?\n|(=>|==|!=|<=|>=|&&|\|\||\.\.\.|\.\*|\[\*\]|[!\-+*\/%<>=?:~])|([{}()[\]])|([.,])|(0x[0-9a-zA-Z]+|(\d+)(?:\.\d+(?:[eE][+-]?\d+)?)?)|([\p{ID_Start}_](?:[\p{ID_Continue}-]|::)*)|[\s\S]/uy;

/** The bracket each closing bracket closes. */
const OPENERS: Record<string, string> = { "}": "{", ")": "(", "]": "[" };

/** The words that start or end a directive. */
const DIRECTIVES = new Set(["if", "else", "endif", "for", "endfor"]);

/** OpenTofu's reference namespaces, whose names are keywords. */
const NAMESPACES = new Set(
  "count data each local module path self terraform var".split(" "),
);

/** The namespaces whose attributes are fixed, and name no declaration. */
const FIXED = new Set(["count", "each", "path", "self", "terraform"]);

/** Whether an escape, `$${` or `%%{`, starts at `at`. */
function escapeAt(text: string, at: number): boolean {
  const c = text[at];
  return (c === "$" || c === "%") && text[at + 1] === c &&
    text[at + 2] === "{";
}

/**
 * The offset of the line break that ends the line holding `at`, or the end of
 * `text`.
 */
function lineEnd(text: string, at: number): number {
  const end = text.indexOf("\n", at);
  return end < 0 ? text.length : end;
}

/** A new expression frame, a directive's when `directive` says so. */
function expression(directive: boolean): Expression {
  return {
    kind: "expression",
    directive,
    brackets: [],
    braces: 0,
    loops: [],
    previous: undefined,
    valueEnd: false,
    lineBreak: false,
    name: undefined,
    reference: undefined,
  };
}

/**
 * The class of the name `word` at `at` in `frame`, as the HCL language colors
 * it when no `(` follows it to call it and no `=` or `:` follows it as an
 * object's key, after updating `frame` for it: a `for` starts a loop, an `in`
 * ends the names it binds, a name starts or extends the reference it is part
 * of, and `frame.name` records which of a call's name and a key it can be.
 * The name a reference reaches a declaration by, such as `b` in `a.b` or `ami`
 * in `data.aws_ami.ami`, is an identifier, an attribute read from it a
 * property, and an attribute of a namespace whose attributes are fixed a
 * property. A control word is a keyword only where HCL's syntax gives it a
 * meaning: first in a directive, `for` after the bracket that opens its
 * expression, `in` after a `for`'s names, and `if` in a `for` expression's body.
 */
function nameClass(frame: Expression, word: string, at: number): TokenClass {
  const { reference, previous } = frame;
  const loop = frame.loops.at(-1);
  const depth = frame.brackets.length;
  const key = frame.brackets.at(-1) === "{" && loop?.depth !== depth &&
    (previous === "{" || previous === "," ||
      (frame.lineBreak && frame.valueEnd));
  const name = (call: boolean) => {
    frame.name = { start: at, end: at + word.length, call, key };
  };
  frame.reference = undefined;
  if (previous === ".") {
    if (reference === undefined) return "propertyName";
    frame.reference = { first: reference.first, length: reference.length + 1 };
    if (reference.length === 1) {
      return FIXED.has(reference.first) ? "propertyName" : "identifier";
    }
    return reference.length === 2 && reference.first === "data"
      ? "identifier"
      : "propertyName";
  }
  if (word === "true" || word === "false") return "boolean";
  if (word === "null") return "keyword";
  name(false);
  const first = frame.directive && previous === undefined;
  if (word === "for" && (first || previous === "[" || previous === "{")) {
    frame.loops.push({ stage: "binding", depth, conditionals: 0 });
    return "controlKeyword";
  }
  if (word === "in" && loop?.stage === "binding") {
    loop.stage = "iterating";
    return "controlKeyword";
  }
  if (
    (first && DIRECTIVES.has(word)) ||
    (word === "if" && loop?.stage === "body" && loop.depth === depth)
  ) {
    return "controlKeyword";
  }
  if (loop?.stage === "binding") return "parameter";
  name(true);
  frame.reference = { first: word, length: 1 };
  return NAMESPACES.has(word) ? "keyword" : "identifier";
}

/**
 * Colors the sequence that starts at `start`, an interpolation or a directive,
 * into `classes`, and returns where it ends: just past the `}` that closes it,
 * or the end of `text` when nothing does. The strings, comments, and heredocs
 * in its code, and the sequences inside them, are scanned whole, so that a
 * brace inside one closes nothing. A quoted string ends at its line's end when
 * nothing closes it, and a block comment that nothing closes is not one.
 * `lastClose` is where the last closer of a block comment in `text` starts.
 */
function scanSequence(
  text: string,
  start: number,
  classes: (TokenClass | undefined)[],
  lastClose: number,
): number {
  classes.fill("punctuation", start, start + 2);
  const frames: Frame[] = [expression(text[start] === "%")];
  let i = start + 2;
  while (i < text.length) {
    const frame = frames[frames.length - 1];
    const c = text[i];
    const next = text[i + 1];
    if (frame.kind !== "expression") {
      if (frame.kind === "heredoc" && text[i - 1] === "\n") {
        const end = lineEnd(text, i);
        if (text.slice(i, end).trim() === frame.delimiter) {
          classes.fill("string", i, end);
          frames.pop();
          i = end;
          continue;
        }
      }
      if (frame.kind === "quoted" && c === "\n") {
        frames.pop();
      } else if (escapeAt(text, i)) {
        classes.fill("string", i, i + 3);
        i += 3;
      } else if ((c === "$" || c === "%") && next === "{") {
        classes.fill("punctuation", i, i + 2);
        frames.push(expression(c === "%"));
        i += 2;
      } else {
        // A backslash escapes the next character of a quoted string, other
        // than a line break.
        const length = frame.kind === "quoted" && c === "\\" && next !== "\n"
          ? 2
          : 1;
        classes.fill("string", i, i + length);
        if (frame.kind === "quoted" && c === '"') frames.pop();
        i += length;
      }
      continue;
    }
    // The last alternative matches any character, so a match always holds at
    // least the character at `i`.
    TOKEN.lastIndex = i;
    const [
      token,
      space,
      quote,
      line,
      block,
      heredoc,
      operator,
      bracket,
      mark,
      number,
      digits,
      name,
    ] = TOKEN.exec(text) ?? [c];
    let end = i + token.length;
    // A block comment that nothing closes is not one, and its `/` and `*` are
    // operators.
    const close = block === undefined || lastClose < i + 2
      ? -1
      : text.indexOf("*/", i + 2);
    if (space !== undefined || line !== undefined || close >= 0) {
      // White space and comments separate tokens and are not tokens.
      if (space === undefined) {
        end = line !== undefined ? lineEnd(text, i) : close + 2;
        classes.fill("comment", i, end);
      }
      if (text.slice(i, end).includes("\n")) frame.lineBreak = true;
      i = end;
      continue;
    }
    let cls: TokenClass | undefined;
    const loop = frame.loops.at(-1);
    const depth = frame.brackets.length;
    if (quote !== undefined) {
      cls = "string";
      frames.push({ kind: "quoted" });
    } else if (heredoc !== undefined) {
      cls = "string";
      frames.push({ kind: "heredoc", delimiter: heredoc });
    } else if (c === "}" && frame.braces === 0) {
      classes[i] = "punctuation";
      frames.pop();
      if (frames.length === 0) return end;
      i = end;
      continue;
    } else if (operator === ":" && loop?.depth === depth) {
      // The `:` that ends a `for` expression's introduction, past any
      // conditional inside its collection.
      if (loop.stage === "iterating" && loop.conditionals === 0) {
        cls = "punctuation";
        loop.stage = "body";
      } else {
        cls = "operator";
        if (loop.conditionals > 0) loop.conditionals--;
      }
    } else if (block !== undefined) {
      cls = "operator";
      end = i + 1;
    } else if (operator !== undefined) {
      cls = "operator";
      if (
        operator === "?" && loop?.stage === "iterating" && loop.depth === depth
      ) {
        loop.conditionals++;
      }
    } else if (bracket !== undefined) {
      // A brace closes the innermost open brace, and the brackets inside it
      // that nothing closed; a parenthesis or square bracket closes only its
      // own kind, innermost.
      cls = "bracket";
      const opener = OPENERS[bracket];
      if (opener === undefined) {
        frame.brackets.push(bracket);
        if (bracket === "{") frame.braces++;
      } else if (bracket === "}") {
        while (frame.brackets.pop() !== "{");
        frame.braces--;
      } else if (frame.brackets.at(-1) === opener) {
        frame.brackets.pop();
      }
      const open = frame.brackets.length;
      while ((frame.loops.at(-1)?.depth ?? -1) > open) frame.loops.pop();
    } else if (mark !== undefined) {
      cls = "punctuation";
    } else if (number !== undefined) {
      cls = "number";
      // After a `.`, a number is an index, which ends where a fraction would
      // start.
      if (frame.previous === "." && digits !== undefined) {
        end = i + digits.length;
      }
    } else if (name !== undefined) {
      cls = nameClass(frame, name, i);
    }
    if (cls !== undefined) classes.fill(cls, i, end);
    // A name before a `(` is a call's name, and one before an `=` or `:` an
    // object's key, where it can be.
    const before = frame.name;
    if (before !== undefined && before.start !== i) {
      frame.name = undefined;
      if (bracket === "(" && before.call) {
        classes.fill("callName", before.start, before.end);
      } else if ((operator === "=" || operator === ":") && before.key) {
        classes.fill("propertyName", before.start, before.end);
      }
    }
    // A reference continues through a `.` and the name after it.
    if (name === undefined && mark !== ".") frame.reference = undefined;
    if (operator !== "~") {
      frame.previous = text.slice(i, end);
      frame.valueEnd = name !== undefined || number !== undefined ||
        quote !== undefined || heredoc !== undefined ||
        (bracket !== undefined && OPENERS[bracket] !== undefined) ||
        operator === ".*" || operator === "[*]";
      frame.lineBreak = false;
    }
    i = end;
  }
  return text.length;
}

/** Terraform's template syntax, for the template layer. */
export const terraformTemplateSyntax: TemplateSyntax = {
  id: "terraform-template",

  suffixes: [".tftpl"],

  aliases: ["tftpl"],

  scan(text) {
    const regions: TemplateRegion[] = [];
    const classes = new Array<TokenClass | undefined>(text.length);
    // Where the last block comment could close, so that looking for the end
    // of one that nothing closes costs nothing.
    const lastClose = text.lastIndexOf("*/");
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (c !== "$" && c !== "%") continue;
      if (escapeAt(text, i)) {
        regions.push({ start: i, end: i + 1, fill: "_" });
        classes[i] = "punctuation";
        i += 2;
      } else if (text[i + 1] === "{") {
        const end = scanSequence(text, i, classes, lastClose);
        regions.push({ start: i, end, fill: c === "$" ? "_" : " " });
        i = end - 1;
      }
    }
    return { regions, classes };
  },
};
