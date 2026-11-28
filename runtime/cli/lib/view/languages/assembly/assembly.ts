/**
 * Assembly source for the pager, in the two dialects the surveyed files use:
 * the Go assembler's, and the GNU assembler's run through the C preprocessor.
 * Both write `//` and `/*` comments, preprocessor directives on lines that
 * start with `#`, and statements separated by line breaks and `;`. A statement
 * starts with any number of `name:` labels, then a directive or an instruction
 * mnemonic, then operands separated by commas. A directive is a word that
 * starts with `.`, or one of the Go assembler's `TEXT`, `DATA`, `GLOBL`,
 * `PCDATA`, and `FUNCDATA`.
 *
 * A `#` followed by white space starts a comment that runs to the end of the
 * line, as the GNU assembler reads it on x86, and so does a `#` line that names
 * no preprocessor directive. In a function-like `#define` body, `#` and `##`
 * are the preprocessor's operators, and any other `#` marks an immediate value,
 * as on Arm. A line that ends with `\`, or with `\` and comments as the Go
 * assembler allows, continues on the next line, which is how a `#define`
 * macro's body spans lines; each continued line of a body is a statement of its
 * own, as the Go assembler reads it. A GNU `.macro` runs to its `.endm`, and
 * `\name` inside it names one of its parameters.
 *
 * The structure tree lists the functions the Go assembler's `TEXT` directive
 * declares. A call of a function-like `#define` macro declares a function for
 * each parameter its body passes to `TEXT`, directly or through a call of such
 * a macro defined before it, and the function is listed under the argument the
 * parameter receives. A macro's call of itself adds nothing. The tree also
 * lists the symbols the `GLOBL` directive declares, the macros `#define` and
 * `.macro` declare, and labels. A label that an earlier GNU `.type` directive
 * declares as a function or an object is listed as one, at the top level. Any
 * other label is listed inside the function it follows, and a macro inside the
 * label or function whose code continues after it. Everything else is at the
 * top level. Numeric local labels and the labels and functions in a macro's
 * body are not listed.
 */

import type { Document, Line, TokenClass } from "../../model.ts";
import { linesFromClasses } from "../classes.ts";
import { type LocatedEntry, scannedDocument } from "../structure.ts";

/**
 * A pattern with one alternative per token shape, tried in order at each
 * offset: line continuation, line break, white space, comment to the end of
 * the line (`lineComment`), block comment, string or character, number, word,
 * symbol type or relocation or register written with `@` or `%`, macro
 * parameter, operator, bracket, punctuation. A word takes Go's file-local `<>`
 * when white space and a `(`, `+`, `-`, `,`, or `)` follow, as they follow a
 * symbol, and not when an operand follows, as it follows the GNU assembler's
 * `<>` operator.
 */
function tokenPattern(lineComment: string): RegExp {
  return new RegExp(
    [
      String
        .raw`(\\(?=[^\S\n]*(?:\/\*(?:[^*\n]|\*(?!\/))*\*\/[^\S\n]*)*(?:\/\/[^\n]*)?\n))`,
      String.raw`(\n)`,
      String.raw`([^\S\n]+)`,
      `(${lineComment})`,
      String.raw`(\/\*[\s\S]*?(?:\*\/|$))`,
      String.raw`("(?:[^"\\\n]|\\.)*"?|'(?:\\.|[^\\\n])'?)`,
      String.raw`(\d[\p{L}\p{N}_]*(?:\.\d[\p{L}\p{N}_]*)?)`,
      String.raw`([\p{L}_.·∕][\p{L}\p{N}_.·∕]*(?:<>(?=[^\S\n]*[(+\-,)]))?)`,
      String.raw`([@%][\p{L}_][\p{L}\p{N}_]*)`,
      String.raw`(\\[\p{L}_][\p{L}\p{N}_]*)`,
      String.raw`(<<|>>|->|@>|&&|\|\||[-+*/%&|^~!<>=$#?])`,
      String.raw`([()[\]{}])`,
      String.raw`([,;:])`,
    ].join("|"),
    "uy",
  );
}

/** The tokens of assembly source. */
const TOKEN = tokenPattern(String.raw`\/\/[^\n]*|#(?!\S)[^\n]*`);

/**
 * The tokens of a function-like `#define` body, where `#` and `##` are the
 * preprocessor's operators rather than the start of a comment.
 */
const DEFINE_TOKEN = tokenPattern(String.raw`\/\/[^\n]*`);

/** A preprocessor directive at the start of a line, and its name. */
const PREPROCESSOR = /#[^\S\n]*([A-Za-z_]\w*)?/y;

const PREPROCESSOR_DIRECTIVES = new Set([
  "define",
  "elif",
  "elifdef",
  "elifndef",
  "else",
  "endif",
  "error",
  "if",
  "ifdef",
  "ifndef",
  "import",
  "include",
  "include_next",
  "line",
  "pragma",
  "undef",
  "warning",
]);

/** The header an `#include` names between angle brackets. */
const ANGLE_HEADER = /[^\S\n]*(<[^>\n]*>?)/y;

/** A macro's name, and the parameter list that follows it with no space. */
const MACRO_NAME = /[^\S\n]*([A-Za-z_]\w*)(\((?:[^)\n\\]|\\\r?\n)*\)?)?/y;

/** A token of a `#define` macro's parameter list. */
const PARAMETER_TOKEN = /[A-Za-z_]\w*|\.\.\.|\/\*[\s\S]*?\*\/|[(),\\]/g;

/** A colon after a label's name, which does not start `::`. */
const LABEL_COLON = /[^\S\n]*:(?!:)/y;

/** The preprocessor's `##` after a word, which pastes more onto it. */
const PASTE = /[^\S\n]*##/y;

/** What follows a word naming a Go function's argument by its frame offset. */
const FRAME_OFFSET = /[+-]\d+\(FP\)/y;

/** What follows a word used as a macro call at the start of a statement. */
const CALL = /\(/y;

/** What follows the name of a function-like `#define` called with a space. */
const SPACED_CALL = /[^\S\n]*\(/y;

/**
 * GNU assembler directives that set a symbol's properties, the alignment, or
 * the section, and so extend no structure entry.
 */
const SYMBOL_DIRECTIVES = new Set([
  ".align",
  ".balign",
  ".bss",
  ".data",
  ".file",
  ".global",
  ".globl",
  ".hidden",
  ".ident",
  ".local",
  ".p2align",
  ".popsection",
  ".previous",
  ".pushsection",
  ".section",
  ".size",
  ".text",
  ".type",
  ".weak",
]);

/** The Go assembler's directives, which declare symbols and frame data. */
const GO_DIRECTIVES = new Set(["TEXT", "DATA", "GLOBL", "PCDATA", "FUNCDATA"]);

/**
 * Register names across x86, Arm, and the Go assembler's pseudo-registers,
 * including Arm's system registers, compared without case. A vector register's
 * arrangement suffix after a `.` is not part of the name.
 */
const REGISTER =
  /^(?:[rxyzkfvqdshbw]\d{1,2}[bwdl]?|[re]?[abcd]x|[abcd][lh]|[re]?(?:si|di|bp|sp|ip)|(?:si|di|bp|sp)l|[cdefgs]s|[xw]?zr|wsp|lr|fp|pc|sb|g|tls|[cd]r\d{1,2}|nzcv|fpcr|fpsr|daif(?:set|clr)?|[a-z][a-z0-9_]*_el[0-3])$/i;

/**
 * Symbol and section types that `%` can introduce in a GNU `.type` or
 * `.section` directive, as `@` does, where `%` otherwise introduces an x86
 * register. `@` also introduces a relocation, such as `@PLT`.
 */
const SYMBOL_TYPES = new Set([
  "function",
  "gnu_indirect_function",
  "gnu_unique_object",
  "nobits",
  "note",
  "notype",
  "object",
  "progbits",
  "tls_object",
]);

/** The structure kind of a label, from the type a `.type` directive gives. */
const TYPED_KINDS: ReadonlyMap<string, TypedKind> = new Map([
  ["function", "function"],
  ["object", "variable"],
]);

type TypedKind = "function" | "variable";

/** A structure entry whose end grows as the statements it spans are read. */
interface Entry extends LocatedEntry {
  endOffset: number;
  readonly children: Entry[];
}

/** A `#define` being read. */
interface Define {
  readonly entry: Entry;

  /** Each parameter's position, for a function-like macro. */
  readonly parameters: ReadonlyMap<string, number> | undefined;

  /**
   * The positions of the parameters that name the functions a call of a
   * function-like macro declares, each with its rank in the order the
   * expansion declares them.
   */
  readonly functions: Map<number, number>;
}

/** A symbol at the start of a macro call's argument. */
interface ArgumentSymbol {
  readonly name: string;
  readonly offset: number;
}

/** The token classes and structure of one source, from one pass over it. */
class Scanner {
  /** The token class of each character. */
  readonly classes: (TokenClass | undefined)[];

  /** The top-level structure entries, in order. */
  readonly entries: Entry[] = [];

  readonly #text: string;

  /** The kind each `.type` directive read so far gives a symbol. */
  readonly #typed = new Map<string, TypedKind>();

  /**
   * For each function-like `#define`, the positions of the parameters that
   * name the functions a call of it declares.
   */
  readonly #macroFunctions = new Map<string, ReadonlyMap<number, number>>();

  /** Where the names of functions that macro calls declare are written. */
  readonly #macroFunctionNames: [number, number][] = [];

  /** Whether the next token is the first on its line. */
  #lineStart = true;

  /** Whether the line break ahead is one that a `\` continues. */
  #continued = false;

  /**
   * Whether the statement being read is not code: a preprocessor line other
   * than `#define`, or a directive in {@link SYMBOL_DIRECTIVES}.
   */
  #inert = false;

  /** Whether the next word starts a statement. */
  #statementStart = true;

  /**
   * The directive that starts the current statement, until its first operand
   * is read.
   */
  #directive: string | undefined;

  /** Where {@link #directive} starts. */
  #directiveStart = 0;

  /** The symbol a `.type` directive names, until its type is read. */
  #typing: string | undefined;

  /** Whether the words being read name a `.macro`'s parameters. */
  #macroHeader = false;

  /** The `#define` being read, which ends at a line break. */
  #define: Define | undefined;

  /** The GNU `.macro` being read, which ends at its `.endm`. */
  #gnuMacro: Entry | undefined;

  /** How many `.macro` definitions inside {@link #gnuMacro} are open. */
  #innerMacros = 0;

  /**
   * The macros defined since the open label's or function's last code, which
   * join it if its code continues, and the top level otherwise.
   */
  #pendingMacros: Entry[] = [];

  /** The function that code read now belongs to. */
  #function: Entry | undefined;

  /** The label or object that code read now follows. */
  #openLabel: Entry | undefined;

  /** Scans `text`. */
  constructor(text: string) {
    this.#text = text;
    this.classes = new Array<TokenClass | undefined>(text.length);
    for (let offset = 0; offset < text.length;) {
      offset = this.#token(offset);
    }
    this.#closeTopLevel();
    for (const [start, end] of this.#macroFunctionNames) {
      this.#mark("functionName", start, end);
    }
  }

  /** The pattern that reads the tokens of the source being read. */
  get #tokens(): RegExp {
    return this.#define?.parameters === undefined ? TOKEN : DEFINE_TOKEN;
  }

  /** Whether the source being read is a macro's body. */
  get #inMacro(): boolean {
    return this.#define !== undefined || this.#gnuMacro !== undefined;
  }

  /** Scan the token at `offset`, and return the offset after it. */
  #token(offset: number): number {
    const text = this.#text;
    if (this.#lineStart && text[offset] === "#") return this.#hash(offset);
    const tokens = this.#tokens;
    tokens.lastIndex = offset;
    const match = tokens.exec(text);
    if (match === null) {
      this.#code(offset + 1);
      return offset + 1;
    }
    const end = offset + match[0].length;
    if (match[3] !== undefined) return end;
    this.#lineStart = false;
    if (match[1] !== undefined) {
      this.classes[offset] = "punctuation";
      this.#continued = true;
      return end;
    }
    if (match[2] !== undefined) {
      this.#lineBreak();
      return end;
    }
    if (match[4] !== undefined || match[5] !== undefined) {
      this.#mark("comment", offset, end);
      return end;
    }
    if (match[8] !== undefined) return this.#word(match[8], offset, end);
    if (match[7] !== undefined && this.#statementStart) {
      const colon = this.#label(match[7], offset, end);
      if (colon !== undefined) return colon;
    }
    if (match[13] === ";") {
      this.#mark("punctuation", offset, end);
      this.#code(end);
      this.#endStatement();
      return end;
    }
    this.#statementStart = false;
    this.#directive = undefined;
    this.#code(end);
    const isType = this.#readType(match[6] ?? match[9]);
    this.#mark(
      match[6] !== undefined
        ? "string"
        : match[7] !== undefined
        ? "number"
        : match[9] !== undefined
        ? (isType || match[9][0] === "@" || SYMBOL_TYPES.has(match[9].slice(1))
          ? "keyword"
          : "typeKeyword")
        : match[10] !== undefined
        ? "parameter"
        : match[11] !== undefined
        ? "operator"
        : match[12] !== undefined
        ? "bracket"
        : "punctuation",
      offset,
      end,
    );
    return end;
  }

  /**
   * Read a line break. A `\` before it joins the next line to this one, and
   * otherwise it ends the `#define` being read. Either way, it ends the
   * statement, apart from a joined line outside a `#define`.
   */
  #lineBreak(): void {
    if (this.#continued) {
      // In a `#define` body, each continued line is a statement of its own,
      // as the Go assembler reads it.
      this.#continued = false;
      if (this.#define !== undefined) this.#endStatement();
      return;
    }
    this.#lineStart = true;
    this.#endStatement();
    this.#define = undefined;
  }

  /**
   * Scan a line that starts with `#`: a preprocessor directive, or else a
   * comment.
   */
  #hash(offset: number): number {
    const text = this.#text;
    PREPROCESSOR.lastIndex = offset;
    const name = PREPROCESSOR.exec(text)?.[1];
    if (name === undefined || !PREPROCESSOR_DIRECTIVES.has(name)) {
      const feed = text.indexOf("\n", offset);
      const end = feed < 0 ? text.length : feed;
      this.#mark("comment", offset, end);
      return end;
    }
    let end = PREPROCESSOR.lastIndex;
    this.#mark("storageKeyword", offset, end);
    this.#lineStart = false;
    this.#statementStart = false;
    if (name === "include" || name === "include_next" || name === "import") {
      ANGLE_HEADER.lastIndex = end;
      const header = ANGLE_HEADER.exec(text);
      if (header !== null) {
        end = ANGLE_HEADER.lastIndex;
        this.#mark("string", end - header[1].length, end);
      }
    } else if (name === "define") {
      end = this.#readDefine(offset, end);
    } else if (name === "undef") {
      MACRO_NAME.lastIndex = end;
      const macro = MACRO_NAME.exec(text);
      if (macro !== null) this.#macroFunctions.delete(macro[1]);
    }
    this.#inert = name !== "define";
    return end;
  }

  /**
   * Scan the name and parameters of the macro whose `#define` runs from
   * `start` to `from`. A function-like macro's body starts a statement. An
   * object-like macro's body is an operand on the `#define` line, and starts a
   * statement on the line after a `\`.
   */
  #readDefine(start: number, from: number): number {
    MACRO_NAME.lastIndex = from;
    const macro = MACRO_NAME.exec(this.#text);
    if (macro === null) return from;
    const list = macro[2] ?? "";
    const nameEnd = MACRO_NAME.lastIndex - list.length;
    const parameters = new Map<string, number>();
    for (const { 0: token, index } of list.matchAll(PARAMETER_TOKEN)) {
      const isParameter = /^[A-Za-z_.]/.test(token);
      if (isParameter) {
        parameters.set(
          token === "..." ? "__VA_ARGS__" : token,
          parameters.size,
        );
      }
      this.#mark(
        token === "(" || token === ")"
          ? "bracket"
          : isParameter
          ? "parameter"
          : token.startsWith("/*")
          ? "comment"
          : "punctuation",
        nameEnd + index,
        nameEnd + index + token.length,
      );
    }
    this.#define = {
      entry: this.#listMacro(`#define ${macro[1]}`, macro[1], start, nameEnd),
      parameters: list === "" ? undefined : parameters,
      functions: new Map(),
    };
    if (list === "") this.#macroFunctions.delete(macro[1]);
    else this.#macroFunctions.set(macro[1], this.#define.functions);
    this.#code(MACRO_NAME.lastIndex);
    this.#statementStart = list !== "";
    return MACRO_NAME.lastIndex;
  }

  /** Scan a word from `start` to `end`, classed by its place in a statement. */
  #word(word: string, start: number, end: number): number {
    const text = this.#text;
    const isParameter = this.#parameterOf(word) !== undefined;
    if (this.#statementStart) {
      const colon = this.#label(word, start, end);
      if (colon !== undefined) return colon;
      this.#statementStart = false;
      if (isParameter) {
        this.#code(end);
        this.#mark("parameter", start, end);
        return end;
      }
      return this.#statementWord(word, start, end);
    }
    const directive = this.#directive;
    this.#directive = undefined;
    const declared = directive !== undefined &&
      this.#declareSymbol(directive, word, start, end);
    this.#code(end);
    if (declared) return end;
    FRAME_OFFSET.lastIndex = end;
    this.#mark(
      this.#readType(word)
        ? "keyword"
        : (this.#macroHeader && !followsValueMarker(text, start)) ||
            isParameter || FRAME_OFFSET.test(text)
        ? "parameter"
        : REGISTER.test(word.split(".")[0])
        ? "typeKeyword"
        : "identifier",
      start,
      end,
    );
    return end;
  }

  /**
   * The position of the parameter of the function-like `#define` being read
   * that `word` names, apart from a Go vector arrangement after a `.` or a
   * file-local `<>` after it, or undefined when it names none.
   */
  #parameterOf(word: string): number | undefined {
    return this.#define?.parameters?.get(word.replace(/<>$/, "").split(".")[0]);
  }

  /** Record that the macro being read names a function by its parameter. */
  #addFunction(position: number): void {
    const functions = this.#define?.functions;
    if (functions?.has(position) === false) {
      functions.set(position, functions.size);
    }
  }

  /**
   * The position of the parameter of the function-like `#define` being read
   * that `word`, which ends at `end`, passes on as a function's name: written
   * alone or with Go's file-local `<>`, and not pasted onto with `##`.
   */
  #passedParameter(word: string, end: number): number | undefined {
    PASTE.lastIndex = end;
    if (PASTE.test(this.#text)) return undefined;
    return this.#define?.parameters?.get(word.replace(/<>$/, ""));
  }

  /**
   * Scan the word from `start` to `end` that starts a statement: a directive,
   * a mnemonic, or a macro call.
   */
  #statementWord(word: string, start: number, end: number): number {
    // The GNU assembler reads its directives' names without regard to case.
    const name = word.startsWith(".") ? word.toLowerCase() : word;
    const directive = name.startsWith(".") || GO_DIRECTIVES.has(name);
    if (
      (word === "TEXT" || word === "GLOBL" || word === "DATA") && !this.#inMacro
    ) {
      this.#closeTopLevel();
    }
    const inGnuBody = this.#define === undefined &&
      this.#gnuMacro !== undefined;
    if (name === ".macro" && inGnuBody) this.#innerMacros++;
    const open = this.#callOpen(word, end);
    if (open !== undefined) this.#macroCall(word, start, open);
    this.#inert = SYMBOL_DIRECTIVES.has(name);
    if (name !== ".macro") this.#code(end);
    if (name === ".endm" && inGnuBody) {
      if (this.#innerMacros > 0) this.#innerMacros--;
      else this.#gnuMacro = undefined;
    }
    if (open !== undefined) {
      this.#mark("callName", start, end);
      return end;
    }
    this.#mark(directive ? "storageKeyword" : "keyword", start, end);
    this.#directive = directive ? name : undefined;
    this.#directiveStart = start;
    return end;
  }

  /**
   * The offset of the `(` that makes `word`, which ends at `end`, a macro
   * call, or undefined when none does. The `(` follows the name directly, or
   * after white space for a function-like `#define` read earlier.
   */
  #callOpen(word: string, end: number): number | undefined {
    const pattern = this.#macroFunctions.has(word) ? SPACED_CALL : CALL;
    pattern.lastIndex = end;
    return pattern.test(this.#text) ? pattern.lastIndex - 1 : undefined;
  }

  /**
   * Color the name from `start` to `end` and the colon after it as a label,
   * and list it, when a colon follows. Returns the offset after the colon, or
   * undefined when none follows.
   */
  #label(name: string, start: number, end: number): number | undefined {
    LABEL_COLON.lastIndex = end;
    if (!LABEL_COLON.test(this.#text)) return undefined;
    const colon = LABEL_COLON.lastIndex;
    const isParameter = this.#parameterOf(name) !== undefined;
    this.#mark(isParameter ? "parameter" : "functionName", start, end);
    this.classes[colon - 1] = "punctuation";
    this.#addLabel(name, start, colon);
    this.#code(colon);
    return colon;
  }

  /**
   * Read `word`, the first operand of `directive`. Colors and lists the symbol
   * it names, and returns true, when the directive declares one. A `.size`
   * directive for the open function closes it, and a `.type` directive's
   * symbol waits for its type.
   */
  #declareSymbol(
    directive: string,
    word: string,
    start: number,
    end: number,
  ): boolean {
    if (directive === ".size") {
      if (word === this.#function?.name || word === this.#openLabel?.name) {
        this.#closeTopLevel();
      }
      return false;
    }
    if (
      this.#define !== undefined &&
      (directive === ".type" || directive === ".macro")
    ) {
      return false;
    }
    if (directive === ".type") {
      this.#mark("identifier", start, end);
      this.#typing = word;
      return true;
    }
    if (directive === ".macro") {
      this.#macroHeader = true;
      if (this.#gnuMacro !== undefined) {
        this.#mark("binding", start, end);
      } else {
        this.#gnuMacro = this.#listMacro(
          `.macro ${word}`,
          word,
          this.#directiveStart,
          end,
        );
      }
      return true;
    }
    if (directive !== "TEXT" && directive !== "GLOBL" && directive !== "DATA") {
      return false;
    }
    const isFunction = directive === "TEXT";
    const parameter = this.#parameterOf(word);
    this.#mark(
      parameter !== undefined
        ? "parameter"
        : isFunction
        ? "functionName"
        : "binding",
      start,
      end,
    );
    const passed = isFunction ? this.#passedParameter(word, end) : undefined;
    if (passed !== undefined) this.#addFunction(passed);
    if (directive === "DATA" || this.#inMacro) return true;
    const entry = entryOf({
      kind: isFunction ? "function" : "variable",
      label: `${directive} ${word}`,
      name: word,
      nameOffset: start,
      startOffset: this.#directiveStart,
      endOffset: end,
      astKind: directive,
    });
    this.entries.push(entry);
    if (isFunction) this.#function = entry;
    else this.#openLabel = entry;
    return true;
  }

  /**
   * Record the type `token` gives the symbol a `.type` directive names, when
   * it names one. Returns whether it does.
   */
  #readType(token: string | undefined): boolean {
    if (this.#typing === undefined || token === undefined) return false;
    const kind = TYPED_KINDS.get(token.replace(/^["@%]|"$/g, ""));
    if (kind === undefined) return false;
    this.#typed.set(this.#typing, kind);
    this.#typing = undefined;
    return true;
  }

  /** List the label `name`, written from `start` to `end`. */
  #addLabel(name: string, start: number, end: number): void {
    if (/^\d/.test(name) || this.#inMacro) return;
    const kind = this.#typed.get(name) ?? "statement";
    const entry = entryOf({
      kind,
      label: `${name}:`,
      name,
      nameOffset: start,
      startOffset: start,
      endOffset: end,
      astKind: "label",
    });
    if (kind === "statement") {
      const parent = this.#function?.children ?? this.entries;
      this.#settleMacros(parent);
      parent.push(entry);
      this.#openLabel = entry;
      return;
    }
    this.#closeTopLevel();
    this.entries.push(entry);
    if (kind === "function") this.#function = entry;
    else this.#openLabel = entry;
  }

  /**
   * Read a call of `macro`, written from `start`, whose `(` is at `open`. In a
   * function-like `#define` body, a parameter passed where the called macro
   * names a function names a function of the body's macro too. At the top
   * level, a call lists each function it declares under the argument that
   * names it, and code after the call belongs to the last.
   */
  #macroCall(macro: string, start: number, open: number): void {
    const ranks = this.#macroFunctions.get(macro);
    // The preprocessor does not expand a macro's call of itself again.
    if (
      ranks === undefined || ranks.size === 0 ||
      ranks === this.#define?.functions
    ) {
      return;
    }
    const { symbols, end } = argumentSymbols(
      this.#text,
      open,
      this.#tokens,
      this.#define === undefined,
    );
    const named = symbols.flatMap((symbol, position) => {
      const rank = ranks.get(position);
      return symbol === undefined || rank === undefined
        ? []
        : [{ symbol, rank }];
    }).sort((a, b) => a.rank - b.rank).map(({ symbol }) => symbol);
    if (this.#inMacro) {
      for (const { name, offset } of named) {
        const passed = this.#passedParameter(name, offset + name.length);
        if (passed !== undefined) this.#addFunction(passed);
      }
      return;
    }
    if (named.length > 0) this.#closeTopLevel();
    for (const { name, offset } of named) {
      this.#macroFunctionNames.push([offset, offset + name.length]);
      this.#function = entryOf({
        kind: "function",
        label: `${macro} ${name}`,
        name,
        nameOffset: offset,
        startOffset: start,
        endOffset: end,
        astKind: macro,
      });
      this.entries.push(this.#function);
    }
  }

  /**
   * List the macro `name`, whose definition runs from `start` to `end`, in the
   * open label or function if its code continues after the definition, and at
   * the top level otherwise.
   */
  #listMacro(
    label: string,
    name: string,
    start: number,
    end: number,
  ): Entry {
    this.#mark("binding", end - name.length, end);
    const entry = entryOf({
      kind: "variable",
      label,
      name,
      nameOffset: end - name.length,
      startOffset: start,
      endOffset: end,
      astKind: "macro",
    });
    const open = this.#openLabel ?? this.#function;
    (open === undefined ? this.entries : this.#pendingMacros).push(entry);
    return entry;
  }

  /** Close the open function and label, so later code is outside them. */
  #closeTopLevel(): void {
    this.#settleMacros(this.entries);
    this.#function = undefined;
    this.#openLabel = undefined;
  }

  /** Move the macros waiting for a place in the structure tree to `into`. */
  #settleMacros(into: Entry[]): void {
    for (const macro of this.#pendingMacros) into.push(macro);
    this.#pendingMacros = [];
  }

  /**
   * Record code that ends at `end`, which extends the macro being defined, or
   * else the open entries.
   */
  #code(end: number): void {
    const macro = this.#define?.entry ?? this.#gnuMacro;
    if (macro !== undefined) {
      macro.endOffset = end;
      return;
    }
    if (this.#inert) return;
    const open = this.#openLabel ?? this.#function;
    if (open !== undefined) this.#settleMacros(open.children);
    if (this.#function !== undefined) this.#function.endOffset = end;
    if (this.#openLabel !== undefined) this.#openLabel.endOffset = end;
  }

  /** End the current statement, so the next word starts another. */
  #endStatement(): void {
    this.#inert = false;
    this.#statementStart = true;
    this.#directive = undefined;
    this.#typing = undefined;
    this.#macroHeader = false;
  }

  /** Give `cls` to the characters from `from` to `to`. */
  #mark(cls: TokenClass, from: number, to: number): void {
    this.classes.fill(cls, from, to);
  }
}

/**
 * The symbol at the start of each argument of the macro call whose `(` is at
 * `open`, by the argument's position, and the offset after the call. The call
 * ends at its `)`, or else at the end of its statement or line, where a `\`
 * continues the line when `continues` says it may: in a `#define` body, each
 * continued line is a statement of its own. It is read in `tokens`, the tokens
 * of the source the call is in.
 */
function argumentSymbols(
  text: string,
  open: number,
  tokens: RegExp,
  continues: boolean,
): { symbols: (ArgumentSymbol | undefined)[]; end: number } {
  const symbols: (ArgumentSymbol | undefined)[] = [];
  let depth = 0;
  let argumentStart = false;
  let continued = false;
  let offset = open;
  while (offset < text.length) {
    const start = offset;
    tokens.lastIndex = offset;
    const match = tokens.exec(text);
    const token = match?.[0] ?? text[offset];
    offset += token.length;
    if (match?.[1] !== undefined) {
      continued = true;
      continue;
    }
    if (match?.[2] !== undefined) {
      if (!continued || !continues) break;
      continued = false;
      continue;
    }
    // White space and comments.
    if ((match?.[3] ?? match?.[4] ?? match?.[5]) !== undefined) continue;
    if (token === ";") break;
    if (token === ")" && --depth === 0) return { symbols, end: offset };
    if (token === "(") depth++;
    if (depth === 1 && (token === "(" || token === ",")) {
      symbols.push(undefined);
      argumentStart = true;
      continue;
    }
    if (argumentStart && match?.[8] !== undefined) {
      symbols[symbols.length - 1] = { name: match[8], offset: start };
    }
    argumentStart = false;
  }
  return { symbols, end: offset };
}

/**
 * Whether the first character before `offset` other than white space is the
 * `=` or `:` that introduces a GNU macro parameter's default or qualifier.
 */
function followsValueMarker(text: string, offset: number): boolean {
  let before = offset - 1;
  while (text[before] === " " || text[before] === "\t") before--;
  return text[before] === "=" || text[before] === ":";
}

/** A structure entry located at `location`, with no entries nested in it. */
function entryOf(location: Omit<Entry, "children">): Entry {
  return { ...location, children: [] };
}

/** Color `text`, one display line per source line. */
export function assemblyLines(text: string): Line[] {
  return linesFromClasses(text, new Scanner(text).classes);
}

/** Color `text` and list its functions, symbols, macros, and labels. */
export function assemblyDocument(text: string): Document {
  const scanner = new Scanner(text);
  return scannedDocument(text, scanner.classes, scanner.entries);
}
