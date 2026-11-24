/**
 * Dockerfiles for the pager, as BuildKit's Dockerfile frontend reads them. A
 * Dockerfile is a series of instructions, each a keyword such as `FROM` or
 * `RUN` followed by its arguments. A line that ends in the escape character,
 * a backslash unless an `escape` parser directive names a backtick, continues
 * the instruction on the next line other than a blank line or a comment.
 * Parser directives open the file, written as comments of the form
 * `# name=value`.
 *
 * The shell form of `RUN`, `CMD`, `ENTRYPOINT`, and a `HEALTHCHECK`'s command
 * is a command the shell runs, and the shell language's grammar colors it,
 * unless a `SHELL` instruction earlier in the stage, or in the stage it is
 * built from, names a shell other than `sh`, `bash`, `dash`, or `ash`, which
 * are the shells the shell language reads. The exec form is a JSON
 * array of strings. `RUN`, `COPY`, and `ADD` take heredocs, whose bodies
 * follow the instruction. A `RUN` whose command is a single heredoc runs that
 * heredoc's body as a script, with the interpreter its shebang names, or else
 * with the stage's shell; the shell reads the heredocs of any other `RUN` as
 * part of its command.
 * The bodies of a `COPY` or `ADD` are file contents, colored as strings, with
 * the variable references BuildKit expands when the delimiter is unquoted. A
 * line continuation joins the words on either side of it. In every other
 * argument, quoted strings and variable references, written `$NAME` or
 * `${NAME}` with an optional modifier, are colored.
 *
 * A source that opens with a line whose first word is not an instruction, as a
 * diff hunk inside a `RUN` command does, reads that line as shell.
 *
 * The structure tree lists each build stage under its name, or under its base
 * image when it has none, and in each stage the variables that `ARG` and `ENV`
 * set. Variables set before the first stage are listed at the top level.
 */

import type { Document, Line, TokenClass } from "../../model.ts";
import { linesFromClasses } from "../classes.ts";
import { languageForSource } from "../language.ts";
import { shellLanguage } from "../shell/language.ts";
import { shellGrammar } from "../shell/shell.ts";
import {
  type LocatedEntry,
  scannedDocument,
  type TreeEntry,
} from "../structure.ts";
import { tokenClasses } from "../treesitter/adapter.ts";

const INSTRUCTIONS = new Set([
  "ADD",
  "ARG",
  "CMD",
  "COPY",
  "ENTRYPOINT",
  "ENV",
  "EXPOSE",
  "FROM",
  "HEALTHCHECK",
  "LABEL",
  "MAINTAINER",
  "ONBUILD",
  "RUN",
  "SHELL",
  "STOPSIGNAL",
  "USER",
  "VOLUME",
  "WORKDIR",
]);

/** The instructions that `ONBUILD` cannot register. */
const NOT_TRIGGERS = new Set(["FROM", "MAINTAINER", "ONBUILD"]);

/** The instructions whose arguments may start with `--name=value` flags. */
const FLAGGED = new Set(["ADD", "COPY", "FROM", "HEALTHCHECK", "RUN"]);

/** A parser directive BuildKit knows, and the text before each of its parts. */
const DIRECTIVE =
  /^([ \t]*#[ \t]*)(syntax|escape|check)([ \t]*)=([ \t]*)(\S(?:.*\S)?)[ \t\r]*$/i;

/** A word that is a heredoc marker, whose delimiter may be quoted. */
const HEREDOC = /^(\d*)(<<-?)(\s*)([^<]*)$/;

/** The operator that follows a variable's name inside `${}`. */
const MODIFIER = /:?[-+?]|##?|%%?|\/\/?/y;

/** A stretch of source. */
interface Range {
  readonly start: number;
  readonly end: number;
}

/** A string of a JSON array, and its value. */
interface JsonString extends Range {
  readonly value: string;
}

/** A heredoc marker and the delimiter its body ends at. */
interface Marker {
  readonly start: number;
  readonly operator: Range;
  readonly word: Range;
  readonly delimiter: string;
  readonly quoted: boolean;
  readonly stripsTabs: boolean;
}

/** A heredoc's body and the line that ends it. */
interface Body extends Range {
  readonly terminator?: Range;
}

/** A word, and the first `=` outside quotes in it. */
interface Word {
  readonly end: number;
  readonly equals?: number;
}

/** A build stage whose extent grows as instructions join it. */
interface Stage {
  readonly start: number;
  end: number;
  readonly label: string;
  readonly name?: string;
  readonly nameOffset?: number;
  readonly children: LocatedEntry[];
}

/** The token classes and structure entries of one source, from one pass. */
class Scanner {
  /** The token class of each character. */
  readonly classes: (TokenClass | undefined)[];

  /** The top-level structure entries, in order. */
  readonly entries: TreeEntry[] = [];

  /**
   * Whether each character belongs to a line continuation or to a line that
   * one skips, which an instruction's arguments read as white space.
   */
  readonly #gap: Uint8Array;

  /** The stretches of shell text. */
  readonly #shell: Range[] = [];

  /** The character that escapes the next one and continues lines. */
  #escape = "\\";

  /** Whether shell-form commands in the current stage run in a POSIX shell. */
  #posix = true;

  /** Whether an instruction has been read. */
  #seen = false;

  /** The open build stage. */
  #stage: Stage | undefined;

  /**
   * Whether each named stage that has ended runs shell-form commands in a
   * POSIX shell, which a stage built from it inherits.
   */
  readonly #stageShells = new Map<string, boolean>();

  /** Constructs an instance which colors `text` and finds its structure. */
  constructor(readonly text: string) {
    this.classes = new Array<TokenClass | undefined>(text.length);
    this.#gap = new Uint8Array(text.length);
    for (let at = this.#directives(); at < text.length;) {
      const lineEnd = this.#lineEnd(at);
      const first = this.#blankEnd(at, lineEnd);
      if (first === lineEnd) {
        at = lineEnd + 1;
      } else if (text[first] === "#") {
        this.classes.fill("comment", first, lineEnd);
        at = lineEnd + 1;
      } else {
        const end = this.#logicalEnd(first);
        at = this.#instruction(first, end, false) + 1;
        if (this.#stage !== undefined) this.#stage.end = at - 1;
      }
    }
    this.#closeStage();
    this.#colorShell();
  }

  /**
   * Colors the parser directives that open the source, and returns where the
   * line after them starts.
   */
  #directives(): number {
    const text = this.text;
    let at = 0;
    while (at < text.length) {
      const lineEnd = this.#lineEnd(at);
      const match = DIRECTIVE.exec(text.slice(at, lineEnd));
      if (match === null) break;
      const [, hash, key, beforeEquals, afterEquals, value] = match;
      const keyStart = at + hash.length;
      const equals = keyStart + key.length + beforeEquals.length;
      const valueStart = equals + 1 + afterEquals.length;
      this.classes.fill("comment", at, lineEnd);
      this.classes.fill("keyword", keyStart, keyStart + key.length);
      this.classes[equals] = "operator";
      this.classes.fill("string", valueStart, valueStart + value.length);
      if (key.toLowerCase() === "escape" && /^[\\`]$/.test(value)) {
        this.#escape = value;
      }
      at = lineEnd + 1;
    }
    return at;
  }

  /** Returns the end of the physical line that starts at `at`. */
  #lineEnd(at: number): number {
    const end = this.text.indexOf("\n", at);
    return end < 0 ? this.text.length : end;
  }

  /** Returns the end of the blanks at `at`, no further than `end`. */
  #blankEnd(at: number, end: number): number {
    while (at < end && " \t\r".includes(this.text[at])) at++;
    return at;
  }

  /**
   * Whether the character at `at` is white space outside a gap, which
   * separates words. A gap joins the words on either side of it.
   */
  #blank(at: number): boolean {
    return this.#gap[at] === 0 && /\s/.test(this.text[at]);
  }

  /** Returns the end of the white space and gaps at `at`, no further than `end`. */
  #space(at: number, end: number): number {
    while (at < end && (this.#gap[at] === 1 || this.#blank(at))) at++;
    return at;
  }

  /**
   * Returns the end of the instruction that starts at `start`, and records as
   * gaps each line continuation, which runs from the escape character through
   * the line break that ends the last line it skips.
   */
  #logicalEnd(start: number): number {
    const text = this.text;
    for (let line = start;;) {
      const lineEnd = this.#lineEnd(line);
      const escape = this.#continuation(line, lineEnd);
      if (escape === undefined) return lineEnd;
      let next = lineEnd + 1;
      let joinEnd = lineEnd;
      while (next < text.length) {
        const nextEnd = this.#lineEnd(next);
        const first = this.#blankEnd(next, nextEnd);
        if (first < nextEnd && text[first] !== "#") break;
        this.classes.fill("comment", first, nextEnd);
        joinEnd = nextEnd;
        next = nextEnd + 1;
      }
      if (next >= text.length) {
        // Nothing continues the instruction, so the lines it would skip are
        // left to be read as the lines they are.
        this.#gap.fill(1, escape, lineEnd);
        return lineEnd;
      }
      this.#gap.fill(1, escape, joinEnd + 1);
      line = next;
    }
  }

  /**
   * Returns where the escape character that continues the line from `start`
   * to `end` is, or undefined when the line does not continue.
   */
  #continuation(start: number, end: number): number | undefined {
    let at = end;
    while (at > start && " \t\r".includes(this.text[at - 1])) at--;
    // An escape character that another escapes does not continue the line.
    const escape = at - 1;
    return escape >= start && this.text[escape] === this.#escape &&
        (escape === start || this.text[escape - 1] !== this.#escape)
      ? escape
      : undefined;
  }

  /**
   * Returns the letters of the word at `at`, which a gap does not end, and
   * where they end.
   */
  #letters(at: number, end: number): { word: string; end: number } {
    let word = "";
    for (; at < end; at++) {
      if (this.#gap[at] === 1) continue;
      if (!/[A-Za-z]/.test(this.text[at])) break;
      word += this.text[at];
    }
    return { word, end: at };
  }

  /** Returns where each character from `start` to `end` outside gaps is. */
  #offsets(start: number, end: number): number[] {
    const offsets: number[] = [];
    for (let at = start; at < end; at++) {
      if (this.#gap[at] === 0) offsets.push(at);
    }
    return offsets;
  }

  /** Returns the text from `start` to `end` without its gaps. */
  #joined(start: number, end: number): string {
    return this.#characters(this.#offsets(start, end));
  }

  /** Returns the characters at `offsets`, joined. */
  #characters(offsets: readonly number[]): string {
    return offsets.map((at) => this.text[at]).join("");
  }

  /**
   * Returns the end of the variable name, or the number of a positional
   * parameter, at `start`, which a gap does not end, or `start` when there is
   * none.
   */
  #nameEnd(start: number, end: number): number {
    let name: RegExp | undefined;
    let nameEnd = start;
    for (let at = start; at < end; at++) {
      if (this.#gap[at] === 1) continue;
      const c = this.text[at];
      name ??= /[0-9]/.test(c) ? /[0-9]/ : /[A-Za-z_]/.test(c) ? /\w/ : /(?!)/;
      if (!name.test(c)) break;
      nameEnd = at + 1;
    }
    return nameEnd;
  }

  /** Sets the class of the characters from `start` to `end` outside gaps. */
  #paint(cls: TokenClass, start: number, end: number): void {
    for (let at = start; at < end; at++) {
      if (this.#gap[at] === 0) this.classes[at] = cls;
    }
  }

  /**
   * Colors the instruction from `start` to `end`, and returns where it ends
   * once the bodies of its heredocs, which follow it, are included. `nested`
   * is true for the instruction that an `ONBUILD` registers.
   */
  #instruction(start: number, end: number, nested: boolean): number {
    const text = this.text;
    const { word, end: wordEnd } = this.#letters(start, end);
    const name = word.toUpperCase();
    let at = wordEnd;
    const seen = this.#seen;
    this.#seen = true;
    if (
      !INSTRUCTIONS.has(name) || (nested && NOT_TRIGGERS.has(name)) ||
      (at < end && !this.#blank(at))
    ) {
      if (!seen) this.#shell.push({ start, end });
      return end;
    }
    this.#paint("keyword", start, at);
    at = this.#space(at, end);
    if (FLAGGED.has(name)) at = this.#flags(at, end);
    switch (name) {
      case "FROM":
        this.#from(start, at, end);
        return end;
      case "RUN":
        return this.#run(at, end);
      case "CMD":
      case "ENTRYPOINT":
        this.#command(at, end);
        return end;
      case "HEALTHCHECK": {
        const option = this.#letters(at, end);
        const keyword = option.word.toUpperCase();
        if (keyword === "CMD" || keyword === "NONE") {
          this.#paint("keyword", at, option.end);
          if (keyword === "CMD") {
            this.#command(this.#space(option.end, end), end);
          }
        }
        return end;
      }
      case "SHELL": {
        const [program, argument] = (this.#exec(at, end) ?? []).map((
          { value },
        ) => value.replace(/^.*[\\/]/, "").replace(/\.exe$/i, ""));
        const shell = program === "env" ? argument : program;
        if (shell !== undefined && !nested) {
          this.#posix = shellLanguage.metadata.interpreters.includes(shell);
        }
        return end;
      }
      case "ONBUILD":
        return this.#instruction(at, end, true);
      case "ENV":
      case "LABEL":
      case "ARG":
        this.#pairs(start, at, end, name, nested);
        return end;
      case "ADD":
      case "COPY":
      case "VOLUME": {
        const exec = this.#exec(at, end) !== undefined;
        this.#words(at, end, true);
        return exec || name === "VOLUME" ? end : this.#files(at, end);
      }
      case "EXPOSE":
        for (let i = at; i < end; i++) {
          if (this.#gap[i] === 0 && /\d/.test(text[i])) {
            this.classes[i] = "number";
          }
        }
        this.#words(at, end, true);
        return end;
      default:
        this.#words(at, end, name !== "MAINTAINER");
        return end;
    }
  }

  /** Colors the `--name=value` flags at `at`, and returns their end. */
  #flags(at: number, end: number): number {
    while (this.text.startsWith("--", at)) {
      const word = this.#word(at, end);
      const equals = word.equals ?? word.end;
      this.#paint("parameter", at, equals);
      if (word.equals !== undefined) {
        this.classes[equals] = "operator";
        this.#words(equals + 1, word.end, true);
      }
      at = this.#space(word.end, end);
    }
    return at;
  }

  /**
   * Returns the end of the word at `at`, which white space outside quotes
   * ends, and the first `=` outside quotes in it.
   */
  #word(at: number, end: number): Word {
    const text = this.text;
    let quote: string | undefined;
    let equals: number | undefined;
    for (; at < end; at++) {
      const c = text[at];
      if (this.#gap[at] === 1) continue;
      if (quote === undefined && this.#blank(at)) break;
      if (c === this.#escape && quote !== "'") at++;
      else if (c === quote) quote = undefined;
      else if (quote === undefined && (c === '"' || c === "'")) quote = c;
      else if (quote === undefined && c === "=") equals ??= at;
    }
    return { end: Math.min(at, end), equals };
  }

  /** Colors a `FROM` instruction's image and stage name, and opens a stage. */
  #from(start: number, at: number, end: number): void {
    const image = this.#word(at, end);
    this.#paint("typeName", at, image.end);
    this.#words(at, image.end, true);
    let next = this.#space(image.end, end);
    let name: string | undefined;
    let nameOffset: number | undefined;
    const as = this.#word(next, end);
    if (/^as$/i.test(this.#joined(next, as.end))) {
      this.#paint("keyword", next, as.end);
      next = this.#space(as.end, end);
      const stage = this.#word(next, end);
      if (stage.end > next) {
        this.#paint("functionName", next, stage.end);
        name = this.#joined(next, stage.end);
        nameOffset = next;
      }
    }
    this.#closeStage();
    const base = this.#joined(at, image.end);
    this.#posix = this.#stageShells.get(base.toLowerCase()) ?? true;
    this.#stage = {
      start,
      end,
      label: name ?? (base.replace(/@sha256:\w+$/, "") || "FROM"),
      name,
      nameOffset,
      children: [],
    };
  }

  /** Lists the open stage, if there is one. */
  #closeStage(): void {
    const stage = this.#stage;
    if (stage === undefined) return;
    this.#stage = undefined;
    if (stage.name !== undefined) {
      this.#stageShells.set(stage.name.toLowerCase(), this.#posix);
    }
    this.entries.push({
      kind: "class",
      label: stage.label,
      name: stage.name,
      nameOffset: stage.nameOffset,
      startOffset: stage.start,
      endOffset: stage.end,
      astKind: "stage",
      children: stage.children,
    });
  }

  /**
   * Colors the `name=value` pairs of an `ENV`, `LABEL`, or `ARG` instruction,
   * and lists the variables that `ENV` and `ARG` set, unless the instruction
   * is one an `ONBUILD` registers.
   */
  #pairs(
    start: number,
    at: number,
    end: number,
    instruction: string,
    nested: boolean,
  ): void {
    for (at = this.#space(at, end); at < end; at = this.#space(at, end)) {
      const word = this.#word(at, end);
      const nameEnd = word.equals ?? word.end;
      this.#paint("propertyName", at, nameEnd);
      const name = this.#joined(at, nameEnd);
      if (
        !nested && instruction !== "LABEL" &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
      ) {
        const entry: LocatedEntry = {
          kind: "variable",
          label: `${instruction} ${name}`,
          name,
          nameOffset: at,
          startOffset: start,
          endOffset: end,
          astKind: instruction,
        };
        if (this.#stage === undefined) {
          this.entries.push(entry);
        } else {
          this.#stage.children.push(entry);
        }
      }
      if (word.equals !== undefined) {
        this.classes[word.equals] = "operator";
        this.#words(word.equals + 1, word.end, true);
      } else if (instruction !== "ARG") {
        // `ENV NAME value` sets one variable to the rest of the line.
        this.#words(this.#space(word.end, end), end, true);
        return;
      }
      at = word.end;
    }
  }

  /**
   * Colors the quoted strings and, when `expand` is true, the variable
   * references of the words from `start` to `end`. A heredoc's body, as
   * BuildKit expands it, has no quotes and takes a backslash as its escape
   * character.
   */
  #words(start: number, end: number, expand: boolean, heredoc = false): void {
    const text = this.text;
    const classes = this.classes;
    const escape = heredoc ? "\\" : this.#escape;
    let quote: string | undefined;
    // How many `${` references are open.
    let open = 0;
    for (let at = start; at < end; at++) {
      if (this.#gap[at] === 1) continue;
      const c = text[at];
      if (c === escape && quote !== "'") {
        if (quote !== undefined) this.#paint("string", at, at + 2);
        at++;
      } else if (c === quote) {
        classes[at] = "string";
        quote = undefined;
      } else if (!heredoc && quote === undefined && (c === '"' || c === "'")) {
        classes[at] = "string";
        quote = c;
      } else if (expand && quote !== "'" && c === "$") {
        const braced = text[at + 1] === "{";
        const nameStart = at + (braced ? 2 : 1);
        const nameEnd = this.#nameEnd(nameStart, end);
        if (nameEnd === nameStart) {
          if (quote !== undefined) classes[at] = "string";
          continue;
        }
        classes[at] = "punctuation";
        if (braced) {
          classes[at + 1] = "punctuation";
          open++;
        }
        this.#paint("propertyName", nameStart, nameEnd);
        at = nameEnd - 1;
        if (braced) {
          MODIFIER.lastIndex = nameEnd;
          const modifier = MODIFIER.exec(text)?.[0];
          if (modifier !== undefined && nameEnd + modifier.length <= end) {
            classes.fill("operator", nameEnd, nameEnd + modifier.length);
            at += modifier.length;
          }
        }
      } else if (open > 0 && c === "}") {
        classes[at] = "punctuation";
        open--;
      } else if (quote !== undefined) {
        classes[at] = "string";
      }
    }
  }

  /**
   * Returns the strings of the JSON array of strings from `at` to `end`, after
   * coloring it, or undefined when the text is not one.
   */
  #exec(at: number, end: number): JsonString[] | undefined {
    const text = this.text;
    if (text[at] !== "[") return undefined;
    const strings: JsonString[] = [];
    const commas: number[] = [];
    // JSON's white space, and the gaps that line continuations leave.
    const space = (i: number) => {
      while (i < end && (this.#gap[i] === 1 || " \t\r\n".includes(text[i]))) {
        i++;
      }
      return i;
    };
    let i = space(at + 1);
    while (text[i] !== "]") {
      if (strings.length > 0) {
        if (text[i] !== ",") return undefined;
        commas.push(i);
        i = space(i + 1);
      }
      if (text[i] !== '"') return undefined;
      let close = i + 1;
      while (close < end && (this.#gap[close] === 1 || text[close] !== '"')) {
        close += this.#gap[close] === 0 && text[close] === "\\" ? 2 : 1;
      }
      if (close >= end) return undefined;
      const value = jsonString(this.#joined(i, close + 1));
      if (value === undefined) return undefined;
      strings.push({ start: i, end: close + 1, value });
      i = space(close + 1);
    }
    if (space(i + 1) < end) return undefined;
    this.classes[at] = "bracket";
    this.classes[i] = "bracket";
    for (const comma of commas) this.classes[comma] = "punctuation";
    for (const string of strings) {
      this.#paint("string", string.start, string.end);
    }
    return strings;
  }

  /** Colors a command's exec form, or records its shell form as shell. */
  #command(at: number, end: number): void {
    if (this.#exec(at, end) !== undefined || !this.#posix) return;
    this.#shell.push({ start: at, end });
  }

  /**
   * Colors a `RUN` instruction's command and the heredocs that follow it, and
   * returns where the last of them ends.
   */
  #run(at: number, end: number): number {
    if (this.#exec(at, end) !== undefined) return end;
    const markers = this.#markers(at, end);
    const bodies = this.#bodies(markers, end);
    const last = lastEnd(bodies, end);
    const [only] = markers;
    if (
      markers.length !== 1 || only.start !== at ||
      this.#space(only.word.end, end) < end
    ) {
      // The shell reads the heredocs as part of the command.
      if (this.#posix) this.#shell.push({ start: at, end: last });
      else this.#heredocs(markers, bodies, false);
      return last;
    }
    // The single heredoc's body is the script, which a shebang can give an
    // interpreter of its own.
    this.#heredocs(markers, [], false);
    const [body] = bodies;
    if (body === undefined) return last;
    // BuildKit strips a `<<-` body's tabs before it looks for a shebang.
    const content = this.text.slice(body.start, body.end);
    const script = only.stripsTabs ? content.replace(/^\t+/gm, "") : content;
    if (
      script.startsWith("#!")
        ? languageForSource(undefined, script) === shellLanguage
        : this.#posix
    ) {
      this.#shell.push({ start: body.start, end: body.end });
    } else {
      this.classes.fill("string", body.start, body.end);
    }
    if (body.terminator !== undefined) {
      this.classes.fill("string", body.terminator.start, body.terminator.end);
    }
    return last;
  }

  /**
   * Colors the heredocs of a `COPY` or `ADD` instruction, and returns where the
   * last of them ends.
   */
  #files(at: number, end: number): number {
    const markers = this.#markers(at, end);
    const bodies = this.#bodies(markers, end);
    this.#heredocs(markers, bodies, true);
    return lastEnd(bodies, end);
  }

  /**
   * Colors heredoc markers, and their bodies as strings, with the variable
   * references that BuildKit expands when `expand` is true and the
   * delimiter is unquoted.
   */
  #heredocs(
    markers: readonly Marker[],
    bodies: readonly Body[],
    expand: boolean,
  ): void {
    for (const { operator, word } of markers) {
      this.#paint("operator", operator.start, operator.end);
      this.#paint("string", word.start, word.end);
    }
    bodies.forEach(({ start, end, terminator }, index) => {
      this.classes.fill("string", start, terminator?.end ?? end);
      if (expand && !markers[index].quoted) {
        this.#words(start, end, true, true);
      }
    });
  }

  /** Returns the heredoc markers among the words from `at` to `end`. */
  #markers(at: number, end: number): Marker[] {
    const markers: Marker[] = [];
    for (at = this.#space(at, end); at < end; at = this.#space(at, end)) {
      let wordEnd = this.#word(at, end).end;
      // BuildKit keeps the blanks after a `<<` in the word they follow.
      if (/^\d*<<$/.test(this.#joined(at, wordEnd))) {
        const next = this.#space(wordEnd, end);
        if (next < end) wordEnd = this.#word(next, end).end;
      }
      const offsets = this.#offsets(at, wordEnd);
      const match = HEREDOC.exec(this.#characters(offsets));
      if (match !== null && match[4] !== "") {
        const [, digits, operator, blanks, delimiter] = match;
        const wordStart =
          offsets[digits.length + operator.length + blanks.length];
        markers.push({
          start: at,
          operator: { start: offsets[digits.length], end: wordStart },
          word: { start: wordStart, end: wordEnd },
          delimiter: delimiter.replace(/\\(.)|["']/g, "$1"),
          quoted: /["']/.test(delimiter.replace(/\\./g, "")),
          stripsTabs: operator === "<<-",
        });
      }
      at = wordEnd;
    }
    return markers;
  }

  /** Returns the bodies of the heredocs `markers` names, which follow `end`. */
  #bodies(markers: readonly Marker[], end: number): Body[] {
    const text = this.text;
    const bodies: Body[] = [];
    let line = end + 1;
    for (const { delimiter, stripsTabs } of markers) {
      if (line >= text.length) break;
      const start = line;
      let terminator: Range | undefined;
      while (line < text.length) {
        const lineEnd = this.#lineEnd(line);
        let content = text.slice(line, lineEnd).replace(/\r$/, "");
        if (stripsTabs) content = content.replace(/^\t+/, "");
        if (content === delimiter) {
          terminator = { start: line, end: lineEnd };
          line = lineEnd + 1;
          break;
        }
        line = lineEnd + 1;
      }
      bodies.push({
        start,
        end: terminator?.start ?? text.length,
        terminator,
      });
    }
    return bodies;
  }

  /**
   * Colors each stretch of shell text with the shell grammar, which reads it
   * as BuildKit hands it to the shell: without the gaps that line
   * continuations leave.
   */
  #colorShell(): void {
    for (const { start, end } of this.#shell) {
      const offsets = this.#offsets(start, end);
      const shell = tokenClasses(shellGrammar, this.#characters(offsets));
      if (shell === undefined) return;
      shell.forEach((cls, index) => {
        if (cls !== undefined) this.classes[offsets[index]] = cls;
      });
    }
  }
}

/** Where the last of `bodies` ends, or `end` when there are none. */
function lastEnd(bodies: readonly Body[], end: number): number {
  const last = bodies.at(-1);
  return last?.terminator?.end ?? last?.end ?? end;
}

/** The value of the JSON string literal `literal`, or undefined if it is not one. */
function jsonString(literal: string): string | undefined {
  try {
    return JSON.parse(literal);
  } catch {
    return undefined;
  }
}

/** Colors `text`, one display line per source line. */
export function dockerfileLines(text: string): Line[] {
  return linesFromClasses(text, new Scanner(text).classes);
}

/** Colors `text` and lists its build stages and the variables they set. */
export function dockerfileDocument(text: string): Document {
  const scanner = new Scanner(text);
  return scannedDocument(text, scanner.classes, scanner.entries);
}
