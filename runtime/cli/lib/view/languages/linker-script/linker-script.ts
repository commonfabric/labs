/**
 * GNU linker scripts for the pager: the files that tell `ld` how to lay the
 * sections of its input files out in its output. A script is a series of
 * commands built from names, numbers, double-quoted strings, operators, and
 * brackets, with `/* … *\/` comments between them. `SECTIONS`, `MEMORY`,
 * `PHDRS`, and `VERSION` each open a block with a grammar of its own, whose
 * declarations are output sections, memory regions, program headers, and
 * version nodes. `ld` reads a `#` as the start of a comment that runs to the
 * end of its line. A script whose name ends in `.S`, as `.lds.S` does, or that
 * has a line opening with `#include`, `#include_next`, or `#import` followed by
 * `<` or `"`, or with `#define`, `#undef`, `#ifdef`, or `#ifndef`, or with
 * `#else` or `#endif` and nothing after it but a comment, passes through the C
 * preprocessor before `ld` reads it, so in such a script the `#` and name that
 * open a preprocessor directive line are colored as a directive, each branch of
 * a conditional directive is read from the blocks open at its `#if`, with only
 * the first branch's declarations listed in the structure tree, and `//` starts
 * a comment that runs to the end of its line. The rest of a directive line, and
 * the lines it continues onto with a trailing backslash, are colored as script,
 * except that a `#` there is the preprocessor's operator. A `//` comment
 * continues onto the next line after a trailing backslash. In a script `ld`
 * reads directly, a `/*` right after a file name pattern inside an output
 * section's braces is part of the pattern, as in `lib/*.o` and `*\/*crtend.o`.
 * Anywhere else, including in an expression, it is read as opening a comment,
 * though `ld` would take a `/` right after a name as part of the name and then
 * read the `*` as an operator. In a preprocessed script, a `#` comment runs on
 * through a block comment and over a trailing backslash, which the preprocessor
 * removes first, ends at a `//` comment, and opens nothing at a `/*` inside a
 * quoted string. A section name may hold hyphens, as `.note.gnu.build-id` does.
 * A quoted string is read as a name, as `ld` reads one. A string may span lines
 * in a script `ld` reads directly, as it does for `ld`, and in a preprocessed
 * one ends with its line unless a backslash continues it, as it does for the
 * preprocessor. The argument of `INCLUDE`, and of a command such as
 * `OUTPUT_ARCH` whose argument is a file or format name, is read as `ld` reads
 * such a name, so `i386:x86-64` and `-lc` are each one name, except that `,`
 * and `=` end it.
 */

import type { Document, Line, TokenClass } from "../../model.ts";
import { linesFromClasses } from "../classes.ts";
import { type LocatedEntry, scannedDocument } from "../structure.ts";

const DIRECTIVES =
  "include|include_next|import|define|undef|if|ifdef|ifndef|elif|elifdef|elifndef|else|endif|error|warning|pragma|line|ident|sccs|assert|unassert";

/** A string in `quote`s as C reads one, which ends with its line unless a
 * backslash continues it onto the next. */
function cString(quote: string): string {
  return String
    .raw`${quote}[^${quote}\\\n]*(?:\\(?:\r\n|[\s\S])[^${quote}\\\n]*)*${quote}?`;
}

/** A `#` comment in a script the C preprocessor reads first. It runs on
 * through block comments, `//` comments, and line continuations, which the
 * preprocessor removes before `ld` reads it, and over strings, which it leaves
 * as they are. Each loop reads a run of ordinary characters at a time, so that
 * a long comment costs the regular expression engine no stack. */
const PREPROCESSED_HASH_COMMENT = new RegExp(
  [
    String.raw`#[^\n/\\"']*(?:(?:`,
    [
      String.raw`\\(?:\r?\n)?`,
      cString('"'),
      cString("'"),
      String.raw`\/(?![*/])`,
      String.raw`\/\*[\s\S]*?(?:\*\/|$)`,
    ].join("|"),
    String.raw`)[^\n/\\"']*)*(?:\/\/(?:[^\n]*\\\r?\n)*[^\n]*)?`,
  ].join(""),
  "y",
);

/**
 * One alternative per token shape, tried in order: comment, the `#` and name
 * that open a preprocessor directive line, any other `#`, string, number,
 * name, operator, bracket, punctuation. A number is written in any of the
 * forms `ld` reads, with an optional `K` or `M` multiplier. `comment`,
 * `directive`, and `string` are what those are in the script.
 */
function tokenPattern(
  comment: string,
  directive: string,
  string: string,
): RegExp {
  return new RegExp(
    [
      `(?<comment>${comment})`,
      `(?<directive>${directive})`,
      "(?<hash>#)",
      `(?<string>${string})`,
      String
        .raw`(?<number>0[xX][0-9A-Fa-f]+[KkMm]?|\$[0-9A-Fa-f]+[KkMm]?(?![\w.$])|[0-9][0-9A-Fa-f]*[HhOoXx]?[KkMm]?)`,
      String
        .raw`(?<name>\/DISCARD\/|\.[A-Za-z_][\w.$]*(?:-[\w.$]+)*|[A-Za-z_.$][\w.$]*)`,
      String
        .raw`(?<operator><<=|>>=|[-+*/%&|^<>!=]=|<<|>>|&&|\|\||[-+*/%&|^~!<>=?:\\])`,
      String.raw`(?<bracket>[(){}\[\]])`,
      "[;,]",
    ].join("|"),
    "g",
  );
}

/** The tokens of a script that `ld` reads directly, where `#` starts a comment
 * and a string may span lines. */
const SCRIPT_TOKENS = tokenPattern(
  String.raw`\/\*[\s\S]*?(?:\*\/|$)|#[^\n]*`,
  "(?!)",
  String.raw`"[^"]*"?`,
);

/** The tokens of a script that passes through the C preprocessor first, where
 * a `//` comment continues onto the next line after a trailing backslash, and
 * a string is read as C reads one. */
const PREPROCESSED_TOKENS = tokenPattern(
  String.raw`\/\*[\s\S]*?(?:\*\/|$)|\/\/(?:[^\n]*\\\r?\n)*[^\n]*`,
  String.raw`(?<=(?<![^\n])[ \t]*)#[ \t]*(?:${DIRECTIVES})\b`,
  cString('"'),
);

/** A character of a file or format name other than `/`: any `ld` reads in
 * one, except `,` and `=`, which separate the names in a list here. */
const FILE_CHAR = String.raw`[\w.\\$~\-+:[\]]`;

/** A file or format name, which may hold characters such as `:` and `-` that
 * end any other name, or a library named with `-l`, after optional white
 * space. A comment, in any form `comment` matches the start of after its `/`,
 * ends the name. */
function fileName(comment: string): RegExp {
  return new RegExp(
    String
      .raw`\s*(?!\/${comment})(-l${FILE_CHAR}+|[A-Za-z_\/.\\$~=]${FILE_CHAR}*(?:\/(?!${comment})${FILE_CHAR}*)*)`,
    "y",
  );
}

/** A file or format name in a script `ld` reads directly. */
const SCRIPT_FILE_NAME = fileName(String.raw`\*`);

/** A file or format name in a script that passes through the C preprocessor,
 * which a `//` comment ends too. */
const PREPROCESSED_FILE_NAME = fileName("[*/]");

/** The rest of a directive line, and the lines it continues onto. */
const DIRECTIVE_REST = /(?:[^\n]*\\\r?\n)*[^\n]*/y;

/** A parenthesis after optional white space, which makes a name a call,
 * unless it holds a section type, as `(NOLOAD)` after an output section's
 * address does. */
const CALL = /\s*\((?!\s*(?:COPY|DSECT|INFO|NOLOAD|OVERLAY|READONLY|TYPE)\b)/y;

/** An assignment operator, which makes the name before it a symbol. */
const ASSIGNMENT = /^(?:[-+*/&|^]|<<|>>)?=$/;

/** The names `ld` reserves for commands, section types, and attributes,
 * which are keywords even where a parenthesis follows them, as in
 * `ORIGIN(ram)` and `ASSERT(…)`. Any other name that a parenthesis follows,
 * such as `ALIGN`, is colored as a call. */
const KEYWORDS = new Set([
  "AFTER",
  "ALIGN_WITH_INPUT",
  "AS_NEEDED",
  "ASCIZ",
  "ASSERT",
  "AT",
  "BEFORE",
  "BYTE",
  "COMMONPAGESIZE",
  "CONSTRUCTORS",
  "COPY",
  "CREATE_OBJECT_SYMBOLS",
  "DSECT",
  "ENTRY",
  "EXCLUDE_FILE",
  "EXTERN",
  "FILEHDR",
  "FILL",
  "FLAGS",
  "FORCE_COMMON_ALLOCATION",
  "FORCE_GROUP_ALLOCATION",
  "GROUP",
  "HIDDEN",
  "INCLUDE",
  "INFO",
  "INHIBIT_COMMON_ALLOCATION",
  "INPUT",
  "INPUT_SECTION_FLAGS",
  "INSERT",
  "KEEP",
  "LD_FEATURE",
  "LENGTH",
  "LINKER_VERSION",
  "LONG",
  "MAXPAGESIZE",
  "MEMORY",
  "NOCROSSREFS",
  "NOCROSSREFS_TO",
  "NOLOAD",
  "ONLY_IF_RO",
  "ONLY_IF_RW",
  "ORIGIN",
  "OUTPUT",
  "OUTPUT_ARCH",
  "OUTPUT_FORMAT",
  "OVERLAY",
  "PHDRS",
  "PROVIDE",
  "PROVIDE_HIDDEN",
  "QUAD",
  "READONLY",
  "REGION_ALIAS",
  "REVERSE",
  "SEARCH_DIR",
  "SECTIONS",
  "SHORT",
  "SIZEOF_HEADERS",
  "SORT",
  "SORT_BY_ALIGNMENT",
  "SORT_BY_INIT_PRIORITY",
  "SORT_BY_NAME",
  "SORT_NONE",
  "SPECIAL",
  "SQUAD",
  "STARTUP",
  "SUBALIGN",
  "TARGET",
  "TYPE",
  "VERSION",
]);

/** A program header type, such as `PT_LOAD`, which is a keyword in `PHDRS`. */
const PROGRAM_HEADER_TYPE = /^PT_[A-Z_]+$/;

/** The grammar a block's statements follow. */
type BlockKind =
  | "script"
  | "sections"
  | "overlay"
  | "output"
  | "memory"
  | "phdrs"
  | "version"
  | "node";

/** The commands that open a block, and the grammar of the block each opens. */
const BLOCK_COMMANDS: ReadonlyMap<string, BlockKind> = new Map([
  ["SECTIONS", "sections"],
  ["MEMORY", "memory"],
  ["PHDRS", "phdrs"],
  ["VERSION", "version"],
]);

/** The blocks whose statements can assign a symbol. */
const ASSIGNING_BLOCKS: ReadonlySet<BlockKind> = new Set<BlockKind>([
  "script",
  "sections",
  "overlay",
  "output",
]);

/** The commands whose argument is a symbol assignment. */
const PROVIDERS: ReadonlySet<string> = new Set([
  "PROVIDE",
  "PROVIDE_HIDDEN",
  "HIDDEN",
]);

/** A token that ends with a character `ld` reads as part of a file name
 * pattern, which a `/*` right after it continues, as in `lib[0-9]/*.o`. */
const PATTERN_END = /[\w.\/\\$~\-+:[\],=?*^!]$/;

/** The commands whose argument is a list of file or format names. */
const FILE_COMMANDS: ReadonlySet<string> = new Set([
  "GROUP",
  "INPUT",
  "OUTPUT",
  "OUTPUT_ARCH",
  "OUTPUT_FORMAT",
  "SEARCH_DIR",
  "STARTUP",
  "TARGET",
]);

/** The commands whose argument is an expression. */
const EXPRESSION_COMMANDS: ReadonlySet<string> = new Set([
  "ASSERT",
  "BYTE",
  "FILL",
  "LONG",
  "QUAD",
  "SHORT",
  "SQUAD",
]);

/** A line that opens with a preprocessor directive written as C source writes
 * one, which marks a script that the C preprocessor reads first whatever its
 * name: with no space after the `#`, an inclusion followed by `<` or `"`, a
 * definition or an `#ifdef`, or an `#else` or `#endif` with nothing after it
 * but a comment. A comment in a script `ld` reads directly can start with
 * `#if`, `#else`, or the like followed by words. */
const PREPROCESSOR_LINE =
  /^[ \t]*#(?:(?:include|include_next|import)[ \t]*[<"]|(?:define|undef|ifdef|ifndef)\b|(?:else|endif)[ \t\r]*(?:\/[*/]|$))/m;

/** The tokens that end a statement. */
const STATEMENT_STOPS: ReadonlySet<string> = new Set([";", "{", "}"]);

/** The lowercase spellings of a memory region's attributes, which are names
 * anywhere else. */
const MEMORY_ATTRIBUTES: ReadonlySet<string> = new Set([
  "org",
  "o",
  "len",
  "l",
]);

/** The labels that open a version node's lists of global and local symbols. */
const VERSION_SCOPES: ReadonlySet<string> = new Set(["global", "local"]);

/** A token outside comments and preprocessor directive lines, or a mark
 * where a conditional directive divides the script. */
interface Token {
  readonly text: string;
  readonly start: number;
  readonly end: number;

  /** Whether the token is a name, as opposed to any other kind of token. */
  readonly name: boolean;

  /** How many parentheses its statement leaves open before the token. */
  readonly depth: number;

  /** Whether the token ends an operand: a name, number, or string, or a `)`
   * or `]`. A name right after one starts another statement, since no
   * expression puts two operands side by side; a keyword such as
   * `CONSTRUCTORS` is a whole statement. */
  readonly operand: boolean;

  /** For a conditional directive, which part of it the token marks: its
   * `#if`, a later branch, or its `#endif`. */
  readonly branch?: "if" | "else" | "endif";
}

/** A structure entry, whose end is set once the block it opens closes. */
interface Entry extends LocatedEntry {
  endOffset: number;
  readonly children: Entry[];
}

/** An open block, and the entry whose block it is, when it has one. */
interface Block {
  readonly kind: BlockKind;
  readonly children: Entry[];
  readonly entry?: Entry;
}

/** An open block, and the blocks around it. */
interface Frame {
  readonly block: Block;
  readonly outer?: Frame;
}

/** A conditional directive being walked, with the blocks that were open at
 * its `#if`, and those its first branch left once a later branch begins. */
interface Branches {
  readonly at: Frame;
  first?: Frame;
}

/** The class of a name, from its spelling and whether a parenthesis follows
 * it. A name holding a `.` names a file or a section, which a parenthesis
 * after it does not make a call. */
function nameClass(name: string, called: boolean): TokenClass {
  if (name === "." || name === "/DISCARD/" || KEYWORDS.has(name)) {
    return "keyword";
  }
  if (called && !name.includes(".")) return "callName";
  return name.startsWith(".") ? "typeName" : "identifier";
}

/**
 * Colors every token of `text` from its own spelling, and returns the tokens
 * outside comments and directive lines, which carry the script's grammar.
 */
function tokenize(
  text: string,
  classes: (TokenClass | undefined)[],
  preprocessed: boolean,
): Token[] {
  const pattern = preprocessed ? PREPROCESSED_TOKENS : SCRIPT_TOKENS;
  const fileNamePattern = preprocessed
    ? PREPROCESSED_FILE_NAME
    : SCRIPT_FILE_NAME;
  const tokens: Token[] = [];
  let directiveEnd = 0;
  // For each open brace, whether it holds input section descriptions, where
  // file name patterns are read.
  const braces: boolean[] = [];
  let inVersion = false;
  let overlay = false;
  // Whether an assignment's value is being read, and how deep the parentheses
  // of a command whose argument is an expression begin, or -1 outside one.
  // An expression holds no file name patterns.
  let expression = false;
  let parens = 0;
  let argument = -1;
  // How deep the parentheses of a command whose argument is a file or format
  // name begin, or -1 outside one.
  let fileArgument = -1;
  let patternEnd = -1;
  // For each conditional directive being read, the parenthesis depth and file
  // list open at its `#if`, and those its first branch left once a later
  // branch begins.
  const conditionals: { at: [number, number]; first?: [number, number] }[] = [];
  pattern.lastIndex = 0;
  for (;;) {
    const position = pattern.lastIndex;
    if (
      !preprocessed && braces.at(-1) === true && !expression &&
      argument < 0 && position === patternEnd && text.startsWith("/*", position)
    ) {
      // Inside an output section, a `/*` that continues a file name pattern
      // is part of it, as in `lib/*.o`.
      classes.fill("operator", position, position + 2);
      const end = position + 2;
      tokens.push({
        text: "/*",
        start: position,
        end,
        name: false,
        depth: parens,
        operand: false,
      });
      patternEnd = pattern.lastIndex = end;
      continue;
    }
    fileNamePattern.lastIndex = position;
    const file = fileArgument >= 0 || tokens.at(-1)?.text === "INCLUDE"
      ? fileNamePattern.exec(text)
      : null;
    const fileEnd = fileNamePattern.lastIndex;
    if (file !== null && fileEnd - file[1].length >= directiveEnd) {
      const end = fileEnd;
      const start = end - file[1].length;
      classes.fill(
        KEYWORDS.has(file[1]) ? "keyword" : "identifier",
        start,
        end,
      );
      tokens.push({
        text: file[1],
        start,
        end,
        name: true,
        depth: parens,
        operand: true,
      });
      patternEnd = -1;
      pattern.lastIndex = end;
      continue;
    }
    const match = pattern.exec(text);
    if (match === null) return tokens;
    const {
      comment,
      directive,
      hash,
      string,
      number,
      name,
      operator,
      bracket,
    }: Partial<Record<string, string>> = match.groups ?? {};
    const start = match.index;
    let end = start + match[0].length;
    if ((directive ?? hash) !== undefined && start < directiveEnd) {
      // In a directive line and the lines it continues onto, `#` and `##` are
      // the preprocessor's operators.
      classes[start] = "operator";
      pattern.lastIndex = start + 1;
      continue;
    }
    if (directive !== undefined) {
      classes.fill("keyword", start, end);
      DIRECTIVE_REST.lastIndex = end;
      DIRECTIVE_REST.test(text);
      directiveEnd = DIRECTIVE_REST.lastIndex;
      const word = directive.replace(/^#[ \t]*/, "");
      const branch = word.startsWith("if")
        ? "if"
        : word.startsWith("el")
        ? "else"
        : word === "endif"
        ? "endif"
        : undefined;
      if (branch === undefined) continue;
      // Each branch reads from the parentheses open at the `#if`, and the
      // script goes on from those the first branch left.
      const open = conditionals.at(-1);
      if (branch === "if") {
        conditionals.push({ at: [parens, fileArgument] });
      } else if (open !== undefined && branch === "else") {
        open.first ??= [parens, fileArgument];
        [parens, fileArgument] = open.at;
      } else if (open !== undefined) {
        conditionals.pop();
        [parens, fileArgument] = open.first ?? [parens, fileArgument];
      }
      tokens.push({
        text: word,
        start,
        end,
        name: false,
        depth: 0,
        operand: false,
        branch,
      });
      continue;
    }
    if (hash !== undefined) {
      PREPROCESSED_HASH_COMMENT.lastIndex = start;
      PREPROCESSED_HASH_COMMENT.test(text);
      end = pattern.lastIndex = PREPROCESSED_HASH_COMMENT.lastIndex;
    }
    if (comment !== undefined || hash !== undefined) {
      classes.fill("comment", start, end);
      if (start < directiveEnd && end > directiveEnd) {
        // A directive runs on past a comment that ends on a later line.
        DIRECTIVE_REST.lastIndex = end;
        DIRECTIVE_REST.test(text);
        directiveEnd = DIRECTIVE_REST.lastIndex;
      }
      continue;
    }
    let spelling = match[0];
    if (name !== undefined && (expression || argument >= 0)) {
      // In an expression, `ld` ends a name at a `-`.
      const hyphen = spelling.indexOf("-");
      if (hyphen > 0) {
        spelling = spelling.slice(0, hyphen);
        end = pattern.lastIndex = start + hyphen;
      }
    }
    let cls: TokenClass;
    if (string !== undefined) {
      cls = "string";
    } else if (number !== undefined) {
      cls = "number";
    } else if (name !== undefined) {
      CALL.lastIndex = end;
      cls = nameClass(spelling, CALL.test(text));
    } else {
      cls = operator !== undefined
        ? "operator"
        : bracket !== undefined
        ? "bracket"
        : "punctuation";
    }
    classes.fill(cls, start, end);
    patternEnd = !expression && PATTERN_END.test(spelling) ? end : -1;
    if (start < directiveEnd) continue;
    const depth = parens;
    if (STATEMENT_STOPS.has(spelling)) {
      expression = false;
      parens = 0;
      argument = fileArgument = -1;
    }
    if (spelling === "{") {
      // Within a block such as `SECTIONS`, braces hold input section
      // descriptions, except within `VERSION` and in `OVERLAY`'s own braces.
      if (braces.length === 0) inVersion = tokens.at(-1)?.text === "VERSION";
      braces.push(braces.length > 0 && !inVersion && !overlay);
      overlay = false;
    } else if (spelling === "}") {
      braces.pop();
    } else if (spelling === "(") {
      const command = tokens.at(-1)?.text ?? "";
      if (argument < 0 && EXPRESSION_COMMANDS.has(command)) argument = parens;
      if (fileArgument < 0 && FILE_COMMANDS.has(command)) fileArgument = parens;
      parens++;
    } else if (spelling === ")") {
      parens = Math.max(0, parens - 1);
      if (parens === argument) argument = -1;
      if (parens === fileArgument) fileArgument = -1;
    } else if (spelling === "," && parens === 0) {
      // A `,` ends an assignment, as a `;` does.
      expression = false;
    } else if (spelling === "OVERLAY" && depth === 0) {
      overlay = true;
    } else if (ASSIGNMENT.test(spelling)) {
      // An assignment's value is an expression, which holds no patterns.
      expression = true;
    }
    tokens.push({
      text: spelling,
      start,
      end,
      // `ld` reads a quoted string as a name, as in `"with space" = 1;`.
      name: name !== undefined || string !== undefined,
      depth,
      operand: name !== undefined || string !== undefined ||
        number !== undefined || spelling === ")" || spelling === "]",
    });
  }
}

/**
 * Reads the grammar of a script's tokens, recoloring the names that its
 * declarations declare and collecting those declarations as structure. Blocks
 * are tracked on an explicit stack, so their nesting depth costs no recursion.
 */
class Walker {
  /** The declarations at the top of the script, in order. */
  readonly entries: Entry[] = [];

  #tokens: readonly Token[];
  #classes: (TokenClass | undefined)[];

  /** For each token, the index of the first `;`, `{`, or `}` at or after it,
   * reading past each later branch of a conditional directive, or the token
   * count when none follows. No statement runs past it. */
  #stops: Int32Array;

  /** For each later branch of a conditional directive, the index of its
   * `#endif`. */
  #skip: Int32Array;

  /** Whether the script passes through the C preprocessor, so that a bare
   * name can be a macro that stands for whole statements. */
  #preprocessed: boolean;

  /** How many of the conditional directives being walked are in a later
   * branch, whose declarations are colored but not listed as structure. */
  #discarding = 0;

  /** The conditional directives being walked, innermost last. */
  #conditionals: Branches[] = [];

  #at = 0;

  /** Constructs an instance which walks `tokens`, those of a script that
   * passes through the C preprocessor when `preprocessed`, and recolors
   * `classes`. */
  constructor(
    tokens: readonly Token[],
    classes: (TokenClass | undefined)[],
    preprocessed: boolean,
  ) {
    this.#tokens = tokens;
    this.#classes = classes;
    this.#preprocessed = preprocessed;
    this.#stops = new Int32Array(tokens.length);
    this.#skip = new Int32Array(tokens.length);
    // A statement that starts before a conditional directive reads on through
    // its first branch, skipping each later one to its `#endif`.
    const after: number[] = [];
    const ends: number[] = [];
    for (
      let index = tokens.length - 1, stop = tokens.length;
      index >= 0;
      index--
    ) {
      const { text, branch } = tokens[index];
      if (branch === "endif") {
        after.push(stop);
        ends.push(index);
      } else if (branch === "else") {
        stop = after.at(-1) ?? stop;
        this.#skip[index] = ends.at(-1) ?? index;
      } else if (branch === "if") {
        after.pop();
        ends.pop();
      }
      if (STATEMENT_STOPS.has(text)) stop = index;
      this.#stops[index] = stop;
    }
    let frame: Frame = { block: { kind: "script", children: this.entries } };
    while (this.#at < tokens.length) {
      const { block } = frame;
      const token = tokens[this.#at];
      if (token.branch !== undefined) {
        this.#at++;
        frame = this.#branch(token.branch, frame);
      } else if (token.text === "}" && frame.outer !== undefined) {
        this.#at++;
        frame = frame.outer;
        if (block.entry !== undefined && this.#discarding === 0) {
          block.entry.endOffset = token.end;
        }
      } else if (token.text === "{") {
        this.#at++;
        frame = {
          block: {
            kind: block.kind === "version" ? "node" : block.kind,
            children: block.children,
          },
          outer: frame,
        };
      } else {
        const opened = token.name ? this.#name(frame, token) : undefined;
        if (opened !== undefined) frame = opened;
        else this.#at++;
      }
    }
    // A block that the source leaves open, in the branch being walked or in
    // the first branch of a conditional directive it leaves open, runs to its
    // last token.
    const closed = new Set<Frame>();
    for (
      const last of [
        frame,
        ...this.#conditionals.map(({ first }) => first),
      ]
    ) {
      for (let open = last; open && !closed.has(open); open = open.outer) {
        closed.add(open);
        const { entry } = open.block;
        if (entry !== undefined) {
          entry.endOffset = tokens[tokens.length - 1].end;
        }
      }
    }
  }

  /**
   * Walks the part `branch` of a conditional directive, from the blocks open
   * in `frame`, and returns the blocks open after it. Each branch is walked
   * from the blocks open at the `#if`, and the script goes on from those the
   * first branch left.
   */
  #branch(branch: "if" | "else" | "endif", frame: Frame): Frame {
    const conditional = this.#conditionals.at(-1);
    if (branch === "if") {
      this.#conditionals.push({ at: frame });
    } else if (conditional !== undefined && branch === "else") {
      if (conditional.first === undefined) {
        conditional.first = frame;
        this.#discarding++;
      }
      return conditional.at;
    } else if (conditional !== undefined) {
      this.#conditionals.pop();
      if (conditional.first !== undefined) {
        this.#discarding--;
        return conditional.first;
      }
    }
    return frame;
  }

  /**
   * Helper for the constructor, which reads the statement that the name
   * `token` starts, or is inside, in the block open in `frame`. Returns the
   * blocks open once a declaration opened one, with every token through its
   * `{` consumed, and otherwise consumes nothing.
   */
  #name(frame: Frame, token: Token): Frame | undefined {
    const { block } = frame;
    const next = this.#tokens[this.#at + 1];
    const statementStart = this.#startsStatement(this.#at);
    const { kind } = block;
    const declarable = !KEYWORDS.has(token.text);
    if (
      ASSIGNING_BLOCKS.has(kind) && token.text !== "." &&
      next !== undefined && ASSIGNMENT.test(next.text) &&
      (statementStart || this.#insideProvide())
    ) {
      this.#classes.fill("binding", token.start, token.end);
      this.#add(
        block,
        this.#entry("variable", token, this.#statementEnd(this.#at)),
      );
      return undefined;
    }
    const command = kind === "script" && next?.text === "{"
      ? BLOCK_COMMANDS.get(token.text)
      : undefined;
    if (command !== undefined) {
      return this.#open(frame, command, token, false);
    }
    if (kind === "sections" && token.text === "OVERLAY") {
      return this.#open(frame, "overlay", token, false);
    }
    if (
      statementStart && declarable &&
      this.#tokens[this.#at - 1]?.text !== "INCLUDE" &&
      (kind === "sections" && token.depth === 0 &&
          this.#outputSectionAhead() ||
        kind === "overlay" && next?.text === "{")
    ) {
      return this.#open(frame, "output", token, true);
    }
    if (kind === "version" && next?.text === "{") {
      return this.#open(frame, "node", token, true);
    }
    if (kind === "memory" && declarable && this.#regionAt(this.#at)) {
      let end = this.#at + 1;
      while (
        end < this.#tokens.length && this.#tokens[end].text !== "}" &&
        this.#tokens[end].branch === undefined &&
        this.#tokens[end].text !== "INCLUDE" && !this.#regionAt(end)
      ) {
        end++;
      }
      this.#declare(block, token, this.#tokens[end - 1].end);
    } else if (kind === "phdrs" && PROGRAM_HEADER_TYPE.test(token.text)) {
      this.#classes.fill("keyword", token.start, token.end);
    } else if (kind === "phdrs" && statementStart && declarable) {
      this.#declare(block, token, this.#statementEnd(this.#at));
    } else if (
      kind === "memory" && MEMORY_ATTRIBUTES.has(token.text) &&
        next?.text === "=" ||
      kind === "node" &&
        (VERSION_SCOPES.has(token.text) && next?.text === ":" &&
            this.#tokens[this.#at + 2]?.text !== ":" &&
            this.#tokens[this.#at - 1]?.text !== ":" ||
          token.text === "extern")
    ) {
      this.#classes.fill("keyword", token.start, token.end);
    }
    return undefined;
  }

  /**
   * A structure entry for `token`, which runs to `endOffset`. When `named`,
   * `token` is the name the entry declares, which is indexed for definition
   * peeks; otherwise it is the command the entry is for.
   */
  #entry(
    kind: "object" | "variable",
    token: Token,
    endOffset: number,
    named = true,
  ): Entry {
    const label = token.text.replace(/^"([^]*)"$/, "$1");
    return {
      kind,
      label,
      ...(named ? { name: label, nameOffset: token.start } : {}),
      startOffset: token.start,
      endOffset,
      astKind: named ? "declaration" : "command",
      children: [],
    };
  }

  /** Records a memory region or program header that `token` declares. */
  #declare(block: Block, token: Token, endOffset: number): void {
    this.#classes.fill("interfaceName", token.start, token.end);
    this.#add(block, this.#entry("variable", token, endOffset));
  }

  /** Adds `entry` to `block`'s structure, unless a later branch of a
   * conditional directive declares it. */
  #add(block: Block, entry: Entry): void {
    if (this.#discarding === 0) block.children.push(entry);
  }

  /**
   * Opens a block of grammar `kind` for the statement that `token` starts,
   * and records the statement as an entry in the block open in `frame`. When
   * `named`, `token` is the name the statement declares; otherwise it is the
   * command that opens the block. Returns the blocks open with the new one,
   * having walked any conditional directive before its `{`, or undefined,
   * having consumed nothing, when no `{` follows before the statement ends.
   */
  #open(
    frame: Frame,
    kind: BlockKind,
    token: Token,
    named: boolean,
  ): Frame | undefined {
    const brace = this.#stops[this.#at];
    if (this.#tokens[brace]?.text !== "{") return undefined;
    let outer = frame;
    for (let index = this.#at + 1; index < brace; index++) {
      const { branch } = this.#tokens[index];
      if (branch !== undefined) outer = this.#branch(branch, outer);
    }
    const entry = this.#entry("object", token, token.end, named);
    if (named) this.#classes.fill("interfaceName", token.start, token.end);
    this.#add(outer.block, entry);
    this.#at = brace + 1;
    return { block: { kind, children: entry.children, entry }, outer };
  }

  /**
   * Whether the token at `index` starts a statement: it comes first, or after
   * a `;`, a brace, or a `,` outside parentheses, or it is a name right after
   * an operand. Several
   * statements end without a `;`, such as `ENTRY(_start)`, an input section
   * description, `INCLUDE` and its file, and an output section and the
   * regions, program headers, and fill value after its closing brace.
   */
  #startsStatement(index: number): boolean {
    const previous = this.#tokens[index - 1];
    return previous === undefined || STATEMENT_STOPS.has(previous.text) ||
      previous.branch !== undefined ||
      previous.text === "," && this.#tokens[index].depth === 0 ||
      this.#tokens[index].name && previous.operand;
  }

  /** Whether the current token opens the argument of a command that assigns
   * a symbol only when the link refers to it, or hides it once assigned. */
  #insideProvide(): boolean {
    const command = this.#tokens[this.#at - 2];
    return this.#tokens[this.#at - 1]?.text === "(" && command !== undefined &&
      PROVIDERS.has(command.text);
  }

  /**
   * Whether the name at the current token heads an output section: a `:`
   * follows it, outside parentheses, before the statement ends or another
   * statement starts, and only attributes such as `AT(…)` and `ONLY_IF_RO`
   * come after the `:`. The token right after the name may be its address.
   * In a preprocessed script, though, a bare name there after a name that does
   * not start with `.` starts a statement of its own, as `/DISCARD/` does
   * after a macro such as `DISCARDS`.
   */
  #outputSectionAhead(): boolean {
    const head = this.#tokens[this.#at];
    let colon = false;
    let questions = 0;
    for (let index = this.#at + 1; index < this.#stops[this.#at]; index++) {
      const { text, depth, branch } = this.#tokens[index];
      if (branch === "else") index = this.#skip[index];
      if (
        text === "(" || text === ")" || depth !== 0 || branch !== undefined
      ) {
        continue;
      }
      if (colon) {
        if (
          text === ":" ||
          !KEYWORDS.has(text) && this.#tokens[index + 1]?.text !== "("
        ) {
          return false;
        }
      } else if (text === "?") questions++;
      else if (text === ":" && questions > 0) questions--;
      else if (text === ":") colon = true;
      else if (
        this.#startsStatement(index) &&
        (index > this.#at + 1 ||
          this.#preprocessed && !head.text.startsWith(".") &&
            (this.#tokens[index].text.includes(".") ||
              this.#tokens[index + 1]?.text !== "("))
      ) {
        return false;
      }
    }
    return colon;
  }

  /** Whether a memory region's name is at `index`: it starts a statement, and
   * a `:` follows it, after an optional parenthesized list of attributes such
   * as `(rx)` or `(!w)`. */
  #regionAt(index: number): boolean {
    const tokens = this.#tokens;
    if (!tokens[index].name || !this.#startsStatement(index)) return false;
    let next = index + 1;
    if (tokens[next]?.text === "(") {
      do next++; while (tokens[next]?.name || tokens[next]?.text === "!");
      if (tokens[next]?.text !== ")") return false;
      next++;
    }
    return tokens[next]?.text === ":";
  }

  /** The end of the statement that the token at `from` is in: through its
   * `;`, or up to the brace that ends it. */
  #statementEnd(from: number): number {
    const stop = this.#stops[from];
    return this.#tokens[stop]?.text === ";"
      ? this.#tokens[stop].end
      : this.#tokens[stop - 1].end;
  }
}

/** The classes and declarations of `text`, from one pass over it. */
function scan(text: string, fileName: string | undefined): {
  classes: (TokenClass | undefined)[];
  entries: Entry[];
} {
  const classes = new Array<TokenClass | undefined>(text.length);
  const preprocessed = fileName?.endsWith(".S") === true ||
    PREPROCESSOR_LINE.test(text);
  const walker = new Walker(
    tokenize(text, classes, preprocessed),
    classes,
    preprocessed,
  );
  return { classes, entries: walker.entries };
}

/** Color `text`, one display line per source line, as a script that passes
 * through the C preprocessor when `fileName` ends in `.S`. */
export function linkerScriptLines(text: string, fileName?: string): Line[] {
  return linesFromClasses(text, scan(text, fileName).classes);
}

/**
 * Color `text` as {@link linkerScriptLines} does, and list its commands'
 * blocks, the output sections, memory regions, program headers, and version
 * nodes they declare, and the symbols the script assigns.
 */
export function linkerScriptDocument(
  text: string,
  fileName?: string,
): Document {
  const { classes, entries } = scan(text, fileName);
  return scannedDocument(text, classes, entries);
}
