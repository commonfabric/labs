/**
 * Makefiles for the pager, as GNU make reads them. A makefile is a series of
 * logical lines, each one or more physical lines joined where a line ends in
 * an odd number of backslashes. A logical line that starts with the recipe
 * prefix, a tab unless `.RECIPEPREFIX` names another character, is a recipe
 * line when it follows a rule. Every other logical line is a comment, a
 * directive, a variable assignment, a rule, or a line that make only expands.
 *
 * Make hands some of its text to the shell: recipe lines, the recipe after a
 * rule's `;`, the command of a `!=` assignment, and the argument of the
 * `shell` function. The shell language's grammar colors that text, and make's
 * own syntax inside it is colored over the shell's. References, written
 * `$(NAME)`, `${NAME}`, or `$X`, are colored wherever make expands them, and a
 * function call names its function. A `define` block's body is text whose
 * references are colored.
 *
 * A source that opens with recipe lines, such as a diff hunk inside a rule,
 * reads them as recipe lines until a line shows otherwise.
 *
 * The structure tree lists the targets each rule names, other than special
 * targets such as `.PHONY`, and the variables the file assigns.
 */

import type {
  Definition,
  Document,
  Line,
  StructureNode,
  TokenClass,
} from "../../model.ts";
import { flattenStructure } from "../../model.ts";
import { computeLineStarts } from "../../lines.ts";
import { linesFromClasses } from "../classes.ts";
import { shellGrammar } from "../shell/shell.ts";
import {
  type LocatedEntry,
  structureNode,
  type StructureSource,
} from "../structure.ts";
import { tokenClasses } from "../treesitter/adapter.ts";

const CONDITIONALS = new Set([
  "ifeq",
  "ifneq",
  "ifdef",
  "ifndef",
  "else",
  "endif",
]);

const MODIFIERS = new Set([
  "export",
  "unexport",
  "override",
  "private",
  "undefine",
]);

const INCLUDES = new Set([
  "include",
  "-include",
  "sinclude",
  "load",
  "-load",
  "vpath",
]);

const DIRECTIVES = new Set([
  ...CONDITIONALS,
  ...MODIFIERS,
  ...INCLUDES,
  "define",
  "endef",
]);

const FUNCTIONS = new Set([
  "abspath",
  "addprefix",
  "addsuffix",
  "and",
  "basename",
  "call",
  "dir",
  "error",
  "eval",
  "file",
  "filter",
  "filter-out",
  "findstring",
  "firstword",
  "flavor",
  "foreach",
  "guile",
  "if",
  "info",
  "intcmp",
  "join",
  "lastword",
  "let",
  "notdir",
  "or",
  "origin",
  "patsubst",
  "realpath",
  "shell",
  "sort",
  "strip",
  "subst",
  "suffix",
  "value",
  "warning",
  "wildcard",
  "word",
  "wordlist",
  "words",
]);

/** A directive or function name. */
const WORD = /-?[a-z]+(?:-[a-z]+)*/y;

/** White space inside a logical line, line continuations included. */
const SPACE = /(?:[ \t]|\\\r?\n)*/y;

const SPECIAL_TARGET = /^\.[A-Z_]+$/;

// What the scanner colors in a stretch of text besides references, as bits of
// one number.

/** A `#` comment to the end of the logical line. */
const COMMENTS = 1;

/** The commas between a function's arguments. */
const COMMAS = 2;

/** The `=` of a substitution reference. */
const EQUALS = 4;

/** A conditional's brackets, commas, and quoted strings. */
const CONDITIONAL = 8;

/** A rule's separators, and the recipe after its `;`. */
const RULE = 16;

/** Variable names. */
const NAMES = 32;

/** A variable's name, up to the `:` of a substitution reference. */
const VARIABLE = 64;

/** A stretch of source. */
interface Range {
  readonly start: number;
  readonly end: number;
}

/** Make syntax inside shell text, and what the shell grammar reads there. */
interface Mask extends Range {
  readonly fill: string;
}

/** The operator that makes a line an assignment or a rule. */
interface Separator extends Range {
  readonly assignment: boolean;
}

/** A reference's end, and the part of it colored as text of its own. */
interface Reference {
  readonly end: number;
  readonly body?: Range & { readonly syntax: number };
}

/** Where coloring resumes once a reference or quoted string ends. */
interface Frame {
  readonly resume: number;
  readonly limit: number;
  readonly syntax: number;
}

/** A stretch of shell text, which a `.ONESHELL` recipe line extends. */
interface Script {
  readonly start: number;
  end: number;
}

/** A rule's target, which the structure tree lists. */
interface Target {
  readonly name: string;
  readonly offset: number;
}

/** The token classes and structure entries of one source, from one pass. */
class Scanner {
  /** The token class of each character. */
  readonly classes: (TokenClass | undefined)[];

  /** Each target and variable the source defines, in order. */
  readonly entries: LocatedEntry[] = [];

  /** The stretches of shell text. */
  readonly #shell: Script[] = [];

  /** The make syntax inside shell text. */
  readonly #masks: Mask[] = [];

  /**
   * The index of the bracket that closes each reference's opening `$`, or 0
   * where none does.
   */
  readonly #closes: Int32Array;

  /** Whether make runs all of a rule's recipe lines as one script. */
  readonly #oneShell: boolean;

  /** The character that starts a recipe line. */
  #prefix = "\t";

  /**
   * Whether a recipe line belongs to a rule; undefined until a line other
   * than a recipe line, a comment, or a conditional settles it.
   */
  #inRule: boolean | undefined;

  /** The open rule's targets, its extent so far, and its recipe's script. */
  #openRule: {
    readonly targets: Target[];
    readonly start: number;
    end: number;
    script?: Script;
  } | undefined;

  /** How deeply `define` blocks nest at the current line. */
  #defines = 0;

  /** The outermost open `define` block, and the name it defines. */
  #define: {
    readonly start: number;
    readonly name?: string;
    readonly nameOffset: number;
  } | undefined;

  /** Constructs an instance which colors `text` and finds its structure. */
  constructor(readonly text: string) {
    this.classes = new Array<TokenClass | undefined>(text.length);
    this.#closes = new Int32Array(text.length);
    this.#oneShell = /^\.ONESHELL[ \t]*:/m.test(text);
    for (let at = 0; at < text.length;) {
      const end = this.#logicalEnd(at);
      this.#matchReferences(at, end);
      this.#line(at, end);
      at = end + 1;
    }
    this.#closeRule();
    if (this.#defines > 0) this.#closeDefine(text.length);
    this.#colorShell();
  }

  /** Returns the end of the logical line that starts at `at`. */
  #logicalEnd(at: number): number {
    const text = this.text;
    for (;;) {
      const end = text.indexOf("\n", at);
      if (end < 0) return text.length;
      let backslashes = 0;
      let i = text[end - 1] === "\r" ? end - 2 : end - 1;
      while (i >= at && text[i--] === "\\") backslashes++;
      if (backslashes % 2 === 0) return end;
      at = end + 1;
    }
  }

  /**
   * Records the bracket that closes each reference from `start` to `end`. Make
   * counts the brackets of a reference's own kind inside it.
   */
  #matchReferences(start: number, end: number): void {
    const text = this.text;
    const open: { readonly at: number; readonly bracket: string }[] = [];
    const depths: number[] = [];
    for (let i = start; i < end; i++) {
      const c = text[i];
      if (c === "$") {
        const next = text[i + 1];
        if (next === "(" || next === "{") {
          open.push({ at: i, bracket: next });
          depths.push(0);
        }
        if (next === "$" || next === "(" || next === "{") i++;
        continue;
      }
      const top = open.at(-1);
      if (top === undefined) continue;
      if (c === top.bracket) {
        depths[depths.length - 1]++;
      } else if (c === (top.bracket === "(" ? ")" : "}")) {
        if (depths[depths.length - 1]-- > 0) continue;
        this.#closes[top.at] = i;
        open.pop();
        depths.pop();
      }
    }
  }

  /** Returns whether an odd number of backslashes comes before `at`. */
  #escaped(at: number): boolean {
    let i = at;
    while (i > 0 && this.text[i - 1] === "\\") i--;
    return (at - i) % 2 === 1;
  }

  /** Returns the end of the white space at `at`, no further than `end`. */
  #space(at: number, end: number): number {
    SPACE.lastIndex = at;
    SPACE.test(this.text);
    return Math.min(SPACE.lastIndex, end);
  }

  /**
   * Returns where the text from `start` to `end` ends without its trailing
   * white space.
   */
  #trimEnd(start: number, end: number): number {
    while (end > start && " \t\r".includes(this.text[end - 1])) end--;
    return end;
  }

  /** Returns the directive whose name starts at `at`, if one does. */
  #directive(at: number, end: number): string | undefined {
    WORD.lastIndex = at;
    const word = WORD.exec(this.text)?.[0];
    if (word === undefined || !DIRECTIVES.has(word)) return undefined;
    const next = at + word.length;
    return next >= end || /[\s("'#]/.test(this.text[next]) ? word : undefined;
  }

  /** Colors the logical line from `start` to `end`, by what kind it is. */
  #line(start: number, end: number): void {
    const text = this.text;
    if (this.#defines > 0) return this.#defineLine(start, end);
    if (text[start] === this.#prefix && this.#inRule !== false) {
      return this.#recipe(start, end);
    }
    let at = this.#space(start, end);
    if (at === end) return;
    if (text[at] === "#") {
      this.classes.fill("comment", at, end);
      this.#hideFromShell(start, end);
      return;
    }
    // A variable may be named like a directive, as in `export = 1`.
    const separator = this.#separator(at, end);
    const named = separator?.assignment === true &&
      !/\s/.test(text.slice(at, this.#trimEnd(at, separator.start)));
    let word = named ? undefined : this.#directive(at, end);
    if (word !== undefined && CONDITIONALS.has(word)) {
      // `else` may open another conditional on its own line.
      while (word !== undefined && CONDITIONALS.has(word)) {
        this.classes.fill("controlKeyword", at, at + word.length);
        at = this.#space(at + word.length, end);
        word = this.#directive(at, end);
      }
      this.#inRule ??= false;
      this.#text(at, end, COMMENTS | CONDITIONAL);
      this.#hideFromShell(start, end);
      return;
    }
    this.#closeRule();
    this.#inRule = false;
    const lineStart = at;
    if (!named) {
      at = this.#modifiers(at, end);
      word = this.#directive(at, end);
    }
    if (word === "endef") {
      this.classes.fill("storageKeyword", at, at + word.length);
      this.#text(at + word.length, end, COMMENTS);
      return;
    }
    if (word === "define") {
      this.classes.fill("storageKeyword", at, at + word.length);
      at = this.#space(at + word.length, end);
      const separator = this.#separator(at, end);
      const op = separator?.assignment ? separator : undefined;
      if (op !== undefined) this.classes.fill("operator", op.start, op.end);
      const name = this.#name(at, this.#trimEnd(at, op?.start ?? end));
      this.#defines = 1;
      this.#define = { start: lineStart, name, nameOffset: at };
      return;
    }
    if (word !== undefined && INCLUDES.has(word)) {
      this.classes.fill("keyword", at, at + word.length);
      this.#text(at + word.length, end, COMMENTS);
      return;
    }
    const statement = at === lineStart ? separator : this.#separator(at, end);
    if (statement?.assignment) {
      this.#assignment(at, statement, end, lineStart);
    } else if (statement !== undefined) {
      this.#rule(at, statement, end);
    } else {
      this.#text(at, end, at === lineStart ? COMMENTS : COMMENTS | NAMES);
    }
  }

  /**
   * Hides a line from the shell grammar. A make comment or conditional between
   * a rule's recipe lines is not part of the script that `.ONESHELL` makes of
   * them.
   */
  #hideFromShell(start: number, end: number): void {
    this.#masks.push({ start, end, fill: " " });
  }

  /** Colors the modifiers at `at`, such as `export`, and returns their end. */
  #modifiers(at: number, end: number): number {
    for (
      let word = this.#directive(at, end);
      word !== undefined && MODIFIERS.has(word);
      word = this.#directive(at, end)
    ) {
      this.classes.fill("storageKeyword", at, at + word.length);
      at = this.#space(at + word.length, end);
    }
    return at;
  }

  /**
   * Returns the first assignment operator or rule colon from `from`, outside
   * references, or undefined when a comment or a recipe's `;` comes first.
   */
  #separator(from: number, end: number): Separator | undefined {
    const text = this.text;
    for (let i = from; i < end; i++) {
      const c = text[i];
      if (c === "$") {
        i = this.#referenceEnd(i, end) - 1;
      } else if ((c === "#" || c === ";") && !this.#escaped(i)) {
        return undefined;
      } else if ((c === "=" || c === ":") && this.#escaped(i)) {
        continue;
      } else if (c === "=") {
        const op = i > from && "?+!".includes(text[i - 1]) ? i - 1 : i;
        return { start: op, end: i + 1, assignment: true };
      } else if (c === ":") {
        let colons = i;
        while (text[colons] === ":") colons++;
        if (text[colons] === "=") {
          return { start: i, end: colons + 1, assignment: true };
        }
        const op = i > from && text[i - 1] === "&" ? i - 1 : i;
        return { start: op, end: colons, assignment: false };
      }
    }
    return undefined;
  }

  /**
   * Colors an assignment of the value after `separator` to the name from `at`.
   * A rule's target-specific assignment passes no `entryStart`, and is not a
   * structure entry.
   */
  #assignment(
    at: number,
    separator: Separator,
    end: number,
    entryStart?: number,
  ): void {
    const name = this.#name(at, this.#trimEnd(at, separator.start));
    this.classes.fill("operator", separator.start, separator.end);
    const value = this.#space(separator.end, end);
    const valueEnd = this.#text(value, end, COMMENTS);
    if (this.text[separator.start] === "!") {
      this.#shell.push({ start: value, end: valueEnd });
    }
    const prefix = this.text.slice(value, valueEnd);
    if (name === ".RECIPEPREFIX" && !prefix.includes("$")) {
      this.#prefix = prefix[0] ?? "\t";
    }
    if (name !== undefined && entryStart !== undefined) {
      this.entries.push({
        kind: "variable",
        label: name,
        name,
        nameOffset: at,
        startOffset: entryStart,
        endOffset: end,
        astKind: "assignment",
      });
    }
  }

  /**
   * Colors the variable name from `start` to `end`, and returns it unless it
   * holds a reference.
   */
  #name(start: number, end: number): string | undefined {
    const stop = this.#trimEnd(start, this.#text(start, end, COMMENTS | NAMES));
    const name = this.text.slice(start, stop);
    return name === "" || name.includes("$") ? undefined : name;
  }

  /**
   * Colors a rule, or a target-specific assignment, whose targets run from `at`
   * to `separator`.
   */
  #rule(at: number, separator: Separator, end: number): void {
    const text = this.text;
    const targets: Target[] = [];
    for (let i = at; i < separator.start;) {
      i = this.#space(i, separator.start);
      let j = i;
      let plain = true;
      while (j < separator.start && !/\s/.test(text[j])) {
        if (text[j] === "\\") {
          // A backslash escapes the character after it, as in `a\ b`, unless
          // it continues the line.
          if (/[\r\n]/.test(text[j + 1])) break;
          const escapeEnd = Math.min(j + 2, separator.start);
          this.classes.fill("functionName", j, escapeEnd);
          j = escapeEnd;
        } else if (text[j] === "$") {
          plain = false;
          const referenceEnd = this.#referenceEnd(j, separator.start);
          this.#text(j, referenceEnd, 0);
          j = referenceEnd;
        } else {
          this.classes[j++] = "functionName";
        }
      }
      const name = text.slice(i, j);
      if (plain && name !== "" && !SPECIAL_TARGET.test(name)) {
        targets.push({ name, offset: i });
      }
      i = Math.max(j, i + 1);
    }
    this.classes.fill("operator", separator.start, separator.end);
    const assignment = this.#separator(separator.end, end);
    if (assignment?.assignment) {
      const name = this.#modifiers(this.#space(separator.end, end), end);
      this.#assignment(name, assignment, end);
      return;
    }
    this.#inRule = true;
    this.#openRule = { targets, start: at, end };
    this.#text(separator.end, end, COMMENTS | RULE);
  }

  /** Colors a recipe line, whose text after its prefixes is shell. */
  #recipe(start: number, end: number): void {
    const text = this.text;
    let at = start + 1;
    for (; at < end && "@-+ \t".includes(text[at]); at++) {
      if (!" \t".includes(text[at])) this.classes[at] = "operator";
    }
    this.#masks.push({ start, end: at, fill: " " });
    // Make removes the recipe prefix from the start of a continuation line.
    for (
      let line = text.indexOf("\n", at) + 1;
      line > 0 && line < end;
      line = text.indexOf("\n", line) + 1
    ) {
      if (text[line] === this.#prefix) {
        this.#masks.push({ start: line, end: line + 1, fill: " " });
      }
    }
    const rule = this.#openRule;
    if (this.#oneShell && rule?.script !== undefined) {
      rule.script.end = end;
    } else {
      const script = { start: at, end };
      this.#shell.push(script);
      if (rule !== undefined) rule.script = script;
    }
    this.#text(at, end, 0);
    if (rule !== undefined) rule.end = end;
  }

  /**
   * Colors a line of a `define` block, which may close or nest a block unless
   * it starts with the recipe prefix.
   */
  #defineLine(start: number, end: number): void {
    const at = this.#space(start, end);
    const word = this.text[start] === this.#prefix
      ? undefined
      : this.#directive(at, end);
    if (word !== "define" && word !== "endef") {
      this.#text(start, end, 0);
      return;
    }
    this.classes.fill("storageKeyword", at, at + word.length);
    this.#text(at + word.length, end, 0);
    this.#defines += word === "define" ? 1 : -1;
    if (this.#defines === 0) this.#closeDefine(end);
  }

  /** Ends the outermost `define` block at `end`, and lists what it defines. */
  #closeDefine(end: number): void {
    const name = this.#define?.name;
    if (this.#define === undefined || name === undefined) return;
    this.entries.push({
      kind: "variable",
      label: `define ${name}`,
      name,
      nameOffset: this.#define.nameOffset,
      startOffset: this.#define.start,
      endOffset: end,
      astKind: "define",
    });
  }

  /** Ends the open rule, and lists its targets. */
  #closeRule(): void {
    const rule = this.#openRule;
    if (rule === undefined) return;
    this.#openRule = undefined;
    for (const { name, offset } of rule.targets) {
      this.entries.push({
        kind: "function",
        label: name,
        name,
        nameOffset: offset,
        startOffset: rule.start,
        endOffset: rule.end,
        astKind: "rule",
      });
    }
  }

  /**
   * Colors the references from `start` to `end`, and whatever `syntax` names
   * besides. Returns where a comment starts, or `end` when none does.
   */
  #text(start: number, end: number, syntax: number): number {
    const text = this.text;
    const classes = this.classes;
    const outer: Frame[] = [];
    let limit = end;
    let flags = syntax;
    for (let i = start;;) {
      if (i >= limit) {
        const frame = outer.pop();
        if (frame === undefined) return end;
        ({ resume: i, limit, syntax: flags } = frame);
        continue;
      }
      const c = text[i];
      if (c === "$") {
        const { end: referenceEnd, body } = this.#reference(i, limit);
        if (body === undefined) {
          i = referenceEnd;
        } else {
          outer.push({ resume: referenceEnd, limit, syntax: flags });
          ({ start: i, end: limit, syntax: flags } = body);
        }
        continue;
      }
      if (flags & COMMENTS && c === "#" && !this.#escaped(i)) {
        classes.fill("comment", i, limit);
        return i;
      }
      if (flags & VARIABLE) {
        classes[i] = c === ":" ? "operator" : "propertyName";
        if (c === ":") flags = EQUALS;
      } else if (flags & (COMMAS | CONDITIONAL) && c === ",") {
        classes[i] = "punctuation";
      } else if (flags & EQUALS && c === "=") {
        classes[i] = "operator";
      } else if (flags & RULE && (c === "|" || c === ":")) {
        classes[i] = "operator";
      } else if (flags & RULE && c === ";" && !this.#escaped(i)) {
        classes[i] = "punctuation";
        this.#shell.push({ start: i + 1, end: limit });
        flags = 0;
      } else if (flags & CONDITIONAL && (c === "(" || c === ")")) {
        classes[i] = "bracket";
      } else if (flags & CONDITIONAL && (c === '"' || c === "'")) {
        const close = text.indexOf(c, i + 1);
        const stop = close < 0 || close >= limit ? limit : close;
        const resume = Math.min(stop + 1, limit);
        classes.fill("string", i, resume);
        outer.push({ resume, limit, syntax: flags });
        limit = stop;
        flags = 0;
      } else if (flags & NAMES && !/\s/.test(c)) {
        classes[i] = "propertyName";
      }
      i++;
    }
  }

  /**
   * Returns the index of the bracket that closes the reference at `at` before
   * `end`,
   * or undefined when none does.
   */
  #closing(at: number, end: number): number | undefined {
    const close = this.#closes[at];
    return close > 0 && close < end ? close : undefined;
  }

  /** Returns the end of the reference at `at`, which holds a `$`. */
  #referenceEnd(at: number, end: number): number {
    const next = this.text[at + 1];
    if (at + 1 >= end || /\s/.test(next)) return at + 1;
    if (next !== "(" && next !== "{") return at + 2;
    const close = this.#closing(at, end);
    return close === undefined ? end : close + 1;
  }

  /**
   * Colors the delimiters and name of the reference at `at`, which holds a
   * `$`, and returns its end and the part of it left to color as text.
   */
  #reference(at: number, end: number): Reference {
    const text = this.text;
    const classes = this.classes;
    const referenceEnd = this.#referenceEnd(at, end);
    if (referenceEnd === at + 1) return { end: referenceEnd };
    const next = text[at + 1];
    classes[at] = "punctuation";
    if (next === "$") {
      // An escaped dollar sign; in shell text the shell reads the second, as
      // part of the word the first leaves in its place.
      classes[at + 1] = "punctuation";
      this.#masks.push({ start: at, end: at + 1, fill: "_" });
      return { end: referenceEnd };
    }
    this.#masks.push({ start: at, end: referenceEnd, fill: "_" });
    if (next !== "(" && next !== "{") {
      classes[at + 1] = "propertyName";
      return { end: referenceEnd };
    }
    classes[at + 1] = "bracket";
    const close = this.#closing(at, end);
    if (close !== undefined) classes[close] = "bracket";
    const bodyEnd = close ?? end;
    WORD.lastIndex = at + 2;
    const name = WORD.exec(text)?.[0];
    const args = at + 2 + (name?.length ?? 0);
    if (name !== undefined && FUNCTIONS.has(name) && /\s/.test(text[args])) {
      classes.fill("callName", at + 2, args);
      if (name !== "shell") {
        return {
          end: referenceEnd,
          body: { start: args, end: bodyEnd, syntax: COMMAS },
        };
      }
      const command = this.#space(args, bodyEnd);
      this.#shell.push({ start: command, end: bodyEnd });
      return {
        end: referenceEnd,
        body: { start: command, end: bodyEnd, syntax: 0 },
      };
    }
    // A variable, or a substitution reference such as `$(SOURCES:.c=.o)`.
    return {
      end: referenceEnd,
      body: { start: at + 2, end: bodyEnd, syntax: VARIABLE },
    };
  }

  /**
   * Colors each stretch of shell text with the shell grammar, leaving make's
   * syntax inside it as make colored it.
   */
  #colorShell(): void {
    const masks = this.#masks.sort((left, right) => left.start - right.start);
    for (const { start, end } of this.#shell) {
      const view = this.text.slice(start, end).split("");
      const masked = new Uint8Array(view.length);
      let covered = start;
      for (let m = firstMask(masks, start); m < masks.length; m++) {
        const mask = masks[m];
        if (mask.start >= end) break;
        // A mask inside one already applied, such as a nested reference, adds
        // nothing to it.
        const from = Math.max(mask.start, covered);
        covered = Math.max(covered, mask.end);
        for (let i = from; i < mask.end; i++) {
          view[i - start] = mask.fill;
          masked[i - start] = 1;
        }
      }
      const shell = tokenClasses(shellGrammar, view.join(""));
      if (shell === undefined) return;
      for (let i = 0; i < shell.length; i++) {
        if (masked[i] === 0 && shell[i] !== undefined) {
          this.classes[start + i] = shell[i];
        }
      }
    }
  }
}

/**
 * Returns the index of the first of `masks`, sorted by start, starting at
 * `start` or
 * later.
 */
function firstMask(masks: readonly Mask[], start: number): number {
  let low = 0;
  let high = masks.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (masks[middle].start < start) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Colors `text`, one display line per source line. */
export function makeLines(text: string): Line[] {
  return linesFromClasses(text, new Scanner(text).classes);
}

/** Colors `text` and lists the targets and variables it defines. */
export function makeDocument(text: string): Document {
  const scanner = new Scanner(text);
  const source: StructureSource = {
    text,
    lineStarts: computeLineStarts(text),
    definitions: new Map<string, Definition[]>(),
  };
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
