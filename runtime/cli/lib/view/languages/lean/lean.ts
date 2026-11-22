/**
 * Lean 4 source for the pager. Lean lets a file extend its own grammar with
 * notation, macros, and syntax declarations, so this scanner reads the lexical
 * syntax that every Lean file shares rather than any one grammar: comments,
 * which nest; strings, with the interpolations of `s!`, `m!`, and `f!`
 * strings and of `throwError` and `dbg_trace` messages; character, name, and number literals; identifiers, which may
 * contain Greek letters, letter-like symbols, subscripts, and `«…»` escapes;
 * keywords; and attributes. The structure tree lists namespaces, sections, and
 * `mutual` blocks, each closed by an `end`, and the declarations inside them:
 * definitions, theorems, instances, structures, classes, inductive types, and
 * the rest. A declaration ends at its last token before the next command.
 */

import type { Document, Line, TokenClass } from "../../model.ts";
import { flattenStructure } from "../../model.ts";
import { linesFromClasses, OPENING_BRACKETS } from "../classes.ts";
import {
  type LocatedEntry,
  structureSource,
  structureTree,
} from "../structure.ts";

// Lean's letter-like characters: Latin letters and `_`, Greek letters other
// than λ, Π, and Σ, Coptic, polytonic Greek, the letter-like symbols such as
// ℕ, and the script, double-struck, and Fraktur mathematical letters.
const LETTER = String.raw`A-Za-z_Α-ΟΡΤ-Ω` +
  String.raw`α-κμ-ωϊ-ϻἀ-῾` +
  String.raw`℀-⅏\u{1D49C}-\u{1D59F}`;
const REST = LETTER +
  String.raw`0-9'!?₀-₉ₐ-ₜᵢ-ᵪⱼ`;
const ATOM = `(?:[${LETTER}][${REST}]*|«[^»\\n]*»?)`;
const IDENTIFIER = `${ATOM}(?:\\.${ATOM})*`;
const NAME = new RegExp(`^${IDENTIFIER}$`, "u");

const TOKEN = new RegExp(
  [
    String.raw`(?<space>\s+)`,
    String.raw`(?<lineComment>--.*)`,
    String.raw`(?<blockComment>/-)`,
    String.raw`(?<rawString>r#*")`,
    String.raw`(?<word>${IDENTIFIER})`,
    String
      .raw`(?<number>0[xX][\da-fA-F_]+|0[bB][01_]+|0[oO][0-7_]+|(?<!\.)\d[\d_]*(?:\.\d+)?(?:[eE][+-]?\d+)?|\d+)`,
    String.raw`(?<string>")`,
    String.raw`(?<char>'(?:\\(?:x[\da-fA-F]{2}|u[\da-fA-F]{4}|.)|[^\\'\n])')`,
    String.raw`(?<name>${"`"}{1,2}${IDENTIFIER})`,
    String.raw`(?<hashCommand>#[a-z_]+!?)`,
    String.raw`(?<attribute>@\[)`,
    String.raw`(?<bracket>[()[\]{}⟨⟩⦃⦄⟦⟧])`,
    String.raw`(?<punctuation>[,;])`,
    String.raw`(?<operator>.)`,
  ].join("|"),
  "uy",
);

/** Operators that cannot end a term, such as the last character of `:=`. */
const UNFINISHED = new Set([..."=:|>←→↦↔∧∨<$"]);

/** Commands that take an interpolated string after them. */
const INTERPOLATING = new Set(["throwError", "dbg_trace"]);

/** The words of `list`, separated by spaces. */
const words = (list: string) => list.split(" ");

const VALUE_DECLARATIONS = new Set(
  words(
    "def theorem lemma abbrev instance example axiom opaque irreducible_def",
  ),
);
const TYPE_DECLARATIONS = new Set(
  words("structure class inductive coinductive"),
);
const SCOPES = new Set(words("namespace section mutual"));
const MODIFIERS = new Set(
  words(
    "private protected public noncomputable partial unsafe nonrec meta local " +
      "scoped",
  ),
);

/** Commands that end the declaration before them without starting one. */
const COMMANDS = new Set(
  words(
    "import open export universe variable set_option attribute notation " +
      "infix infixl infixr prefix postfix macro macro_rules syntax elab " +
      "elab_rules declare_syntax_cat initialize builtin_initialize omit " +
      "include alias run_cmd run_elab run_meta add_decl_doc register_option " +
      "seal unseal",
  ),
);

/** The keywords of `cls`, as entries of {@link KEYWORDS}. */
const keywords = (cls: TokenClass, list: Iterable<string>) =>
  [...list].map((word): [string, TokenClass] => [word, cls]);

const KEYWORDS = new Map<string, TokenClass>([
  ...keywords("storageKeyword", [
    ...VALUE_DECLARATIONS,
    ...TYPE_DECLARATIONS,
    ...SCOPES,
    ...MODIFIERS,
    ...COMMANDS,
    ...words("end where extends deriving termination_by decreasing_by"),
  ]),
  ...keywords(
    "controlKeyword",
    words(
      "fun let have show from by calc suffices at in if then else match " +
        "with do for unless return break continue try catch finally mut using",
    ),
  ),
  ...keywords("typeKeyword", words("Type Sort Prop")),
  ...keywords("boolean", words("true false True False")),
  ["sorry", "keyword"],
]);

/** A token other than white space and comments. */
interface Token {
  readonly start: number;
  readonly end: number;
  readonly text: string;

  /**
   * The column the token starts at, when no other token precedes it on its
   * line.
   */
  readonly indent?: number;
}

/** The token classes and tokens of one source, from one pass over it. */
class Scanner {
  /** The token class of each character. */
  readonly classes: (TokenClass | undefined)[];

  /** The tokens other than white space and comments, in order. */
  readonly tokens: Token[] = [];

  /** The index of the bracket token that closes each opening bracket token. */
  readonly closers: (number | undefined)[] = [];

  #text: string;

  /** The indexes of the bracket tokens still open, innermost last. */
  #openBrackets: number[] = [];

  /** The brace depth inside each interpolation still open, innermost last. */
  #interpolations: number[] = [];

  /** The bracket depth inside the attribute list being read, or 0. */
  #attributeDepth = 0;

  /** Whether the next identifier names an attribute. */
  #attributeName = false;

  /** The indent of the line the attribute list being read starts on. */
  #attributeIndent = 0;

  /** The offset the current line starts at. */
  #lineBegin = 0;

  /**
   * The column of the first token or comment on the current line, or -1
   * before one is read. A comment that spans lines keeps the column of the
   * line it starts on.
   */
  #lead = -1;

  /** Constructs an instance which scans `text`. */
  constructor(text: string) {
    this.#text = text;
    this.classes = new Array<TokenClass | undefined>(text.length);
    for (let at = 0; at < text.length;) at = this.#next(at);
  }

  /** Scans the token at `at` and returns the offset after it. */
  #next(at: number): number {
    TOKEN.lastIndex = at;
    const match = TOKEN.exec(this.#text);
    if (match?.groups === undefined) {
      throw new Error(`No Lean token matches at offset ${at}`);
    }
    const { groups, 0: text } = match;
    const end = at + text.length;
    if (groups.space !== undefined) {
      const feed = text.lastIndexOf("\n");
      if (feed >= 0) {
        this.#lineBegin = at + feed + 1;
        this.#lead = -1;
      }
      return end;
    }
    if (this.#lead < 0) this.#lead = at - this.#lineBegin;
    if (groups.lineComment !== undefined) {
      this.classes.fill("comment", at, end);
      return end;
    }
    if (groups.blockComment !== undefined) return this.#blockComment(at);
    const previous = this.tokens.at(-1);
    const indent = previous === undefined ||
        this.#text.slice(previous.end, at).includes("\n")
      ? this.#lead
      : undefined;
    // An attribute list ends at its `]`, or before a line indented no further
    // than the line it starts on.
    if (indent !== undefined && indent <= this.#attributeIndent) {
      this.#attributeDepth = 0;
      this.#attributeName = false;
    }
    const tokenEnd = this.#literal(groups, at, end, previous) ??
      this.#code(groups, text, at, end, previous, indent);
    if (groups.attribute !== undefined || this.classes[at] === "bracket") {
      if (groups.attribute !== undefined || OPENING_BRACKETS.has(text)) {
        this.#openBrackets.push(this.tokens.length);
      } else {
        const opener = this.#openBrackets.pop();
        if (opener !== undefined) this.closers[opener] = this.tokens.length;
      }
    }
    this.tokens.push({
      start: at,
      end: tokenEnd,
      text: this.#text.slice(at, tokenEnd),
      indent,
    });
    return tokenEnd;
  }

  /**
   * Scans a string literal, or the rest of a string after the `}` that closes
   * one of its interpolations, and returns its end, or undefined for any other
   * token.
   */
  #literal(
    groups: Record<string, string | undefined>,
    at: number,
    end: number,
    previous: Token | undefined,
  ): number | undefined {
    if (groups.rawString !== undefined) return this.#rawString(at, end);
    if (groups.string !== undefined) {
      const prefixed = previous?.end === at &&
        /^[smf]!$/.test(previous.text);
      if (prefixed) this.classes.fill("string", previous.start, at);
      const interpolated = prefixed ||
        (previous !== undefined && INTERPOLATING.has(previous.text));
      this.classes[at] = "string";
      return this.#stringBody(end, interpolated);
    }
    if (
      groups.bracket !== undefined && this.#closesInterpolation(groups.bracket)
    ) {
      this.classes[at] = "punctuation";
      return this.#stringBody(end, true);
    }
    return undefined;
  }

  /** Colors a token that is not a comment or a string, and returns its end. */
  #code(
    groups: Record<string, string | undefined>,
    text: string,
    at: number,
    end: number,
    previous: Token | undefined,
    indent: number | undefined,
  ): number {
    if (groups.attribute !== undefined) {
      this.#attributeIndent = this.#lead;
      this.#attributeDepth = 1;
      this.#attributeName = true;
      this.classes[at] = "punctuation";
      this.classes[at + 1] = "bracket";
      return end;
    }
    if (
      groups.hashCommand !== undefined && indent !== 0 &&
      previous?.text !== "in"
    ) {
      // Outside a command's position, `#` is notation, such as Mathlib's `#s`
      // for the size of `s`.
      this.classes[at] = "operator";
      return at + 1;
    }
    this.classes.fill(this.#classOf(groups, text, previous, indent), at, end);
    return end;
  }

  /**
   * Returns the class of a token that is not a comment, a string, or an
   * attribute list's opening `@[`.
   */
  #classOf(
    groups: Record<string, string | undefined>,
    text: string,
    previous: Token | undefined,
    indent: number | undefined,
  ): TokenClass {
    if (groups.word !== undefined) {
      return this.#wordClass(text, previous, indent);
    }
    if (groups.number !== undefined) return "number";
    if (groups.char !== undefined || groups.name !== undefined) {
      return "string";
    }
    if (groups.hashCommand !== undefined) return "keyword";
    if (groups.punctuation !== undefined) {
      this.#attributeName = this.#attributeDepth === 1 && text === ",";
      return "punctuation";
    }
    if (groups.bracket !== undefined) return this.#bracketClass(text, previous);
    return text === "λ" ? "controlKeyword" : "operator";
  }

  /** Returns the class of an identifier or keyword. */
  #wordClass(
    word: string,
    previous: Token | undefined,
    indent: number | undefined,
  ): TokenClass {
    if (this.#attributeName && !MODIFIERS.has(word)) {
      this.#attributeName = false;
      return "callName";
    }
    const keyword = KEYWORDS.get(word);
    if (keyword !== undefined) return keyword;
    if (previous !== undefined && indent === undefined) {
      if (
        VALUE_DECLARATIONS.has(previous.text) &&
        this.tokens.at(-2)?.text !== "deriving"
      ) {
        return "functionName";
      }
      if (
        TYPE_DECLARATIONS.has(previous.text) || SCOPES.has(previous.text) ||
        previous.text === "end"
      ) {
        return "interfaceName";
      }
    }
    return "identifier";
  }

  /**
   * Returns the class of a bracket, and opens an attribute list at the `[`
   * after an `attribute` command.
   */
  #bracketClass(bracket: string, previous: Token | undefined): TokenClass {
    this.#attributeName = false;
    if (this.#attributeDepth > 0) {
      if (bracket === "[") this.#attributeDepth++;
      if (bracket === "]") this.#attributeDepth--;
    } else if (bracket === "[" && previous?.text === "attribute") {
      this.#attributeIndent = this.#lead;
      this.#attributeDepth = 1;
      this.#attributeName = true;
    }
    return "bracket";
  }

  /**
   * Counts the braces inside the innermost open interpolation, and returns
   * whether `bracket` closes that interpolation.
   */
  #closesInterpolation(bracket: string): boolean {
    const depth = this.#interpolations.length - 1;
    if (depth < 0) return false;
    if (bracket === "{") this.#interpolations[depth]++;
    if (bracket !== "}" || this.#interpolations[depth]-- > 0) return false;
    this.#interpolations.pop();
    return true;
  }

  /**
   * Scans a block comment, which may nest, from its `/-` at `start`, and
   * returns its end.
   */
  #blockComment(start: number): number {
    const text = this.#text;
    const doc = text[start + 2] === "-" || text[start + 2] === "!";
    let depth = 1;
    let at = start + (doc ? 3 : 2);
    let open = text.indexOf("/-", at);
    let close = text.indexOf("-/", at);
    while (depth > 0 && close >= 0) {
      if (open >= 0 && open < close) {
        depth++;
        at = open + 2;
      } else {
        depth--;
        at = close + 2;
      }
      if (open >= 0 && open < at) open = text.indexOf("/-", at);
      if (close < at) close = text.indexOf("-/", at);
    }
    if (depth > 0) at = text.length;
    this.classes.fill(doc ? "docComment" : "comment", start, at);
    return at;
  }

  /**
   * Scans a raw string, whose opening `r#…"` runs from `start` to `from`, and
   * returns its end.
   */
  #rawString(start: number, from: number): number {
    const close = this.#text.indexOf(`"${"#".repeat(from - start - 2)}`, from);
    const end = close < 0 ? this.#text.length : close + from - start - 1;
    this.classes.fill("string", start, end);
    return end;
  }

  /**
   * Scans a string from `from`, just after its opening quote or after the `}`
   * that closes one of its interpolations, to its closing quote. In an
   * interpolated string a `{` opens an interpolation, whose tokens are code,
   * and scanning resumes after the `}` that closes it.
   */
  #stringBody(from: number, interpolated: boolean): number {
    const text = this.#text;
    let at = from;
    while (at < text.length && text[at] !== '"') {
      if (interpolated && text[at] === "{") {
        this.classes.fill("string", from, at);
        this.classes[at] = "punctuation";
        this.#interpolations.push(0);
        return at + 1;
      }
      at += text[at] === "\\" ? 2 : 1;
    }
    const end = Math.min(at + 1, text.length);
    this.classes.fill("string", from, end);
    return end;
  }
}

/**
 * A namespace, section, `mutual` block, or declaration, whose end is set when
 * the command after it is read.
 */
interface Entry extends LocatedEntry {
  label: string;
  endOffset: number;
  readonly children: Entry[];
}

/**
 * A namespace, section, or `mutual` block, which closes when `end` has closed
 * each of the {@link remaining} components of its name.
 */
interface Scope extends Entry {
  remaining: number;
}

/**
 * Returns the namespaces, sections, `mutual` blocks, and declarations in the
 * tokens `scanner` read from `text`. A command keyword starts a command at
 * the start of a line indented no further than the open declaration's first
 * line, and a declaration keyword also starts one after a modifier, an
 * attribute, or `in` on the same line. Any other word at the start of such a
 * line starts a command too, unless the token before it leaves the
 * declaration unfinished, as `:=`, `by`, `where`, and operators do.
 */
function structureEntries(text: string, scanner: Scanner): Entry[] {
  const { tokens, classes, closers } = scanner;
  const roots: Entry[] = [];
  const scopes: Scope[] = [];
  let declaration: Entry | undefined;
  // The keyword of an open declaration that names nothing.
  let anonymous: number | undefined;
  let prefixStart: number | undefined;
  let lastEnd = 0;
  // The indent of the latest line, and of the line the open declaration
  // starts on.
  let lineIndent = 0;
  let declarationIndent = 0;
  // The index of the last token on each token's line.
  const lineLast = new Array<number>(tokens.length);
  for (let at = tokens.length - 1; at >= 0; at--) {
    lineLast[at] =
      tokens[at + 1]?.indent === undefined && at + 1 < tokens.length
        ? lineLast[at + 1]
        : at;
  }
  // The bracket that closes the one at `index`, or else its line's last token.
  const closing = (index: number) => closers[index] ?? lineLast[index];
  const parent = () => scopes.at(-1)?.children ?? roots;
  // The label of the open declaration that names nothing: its keyword and its
  // signature, up to its first `:=` or `where` outside brackets or its line's
  // end.
  const anonymousLabel = (keyword: number, label: string) => {
    const last = lineLast[keyword];
    let end = keyword;
    for (let at = keyword + 1; at <= last && tokens[at].end <= lastEnd; at++) {
      const token = tokens[at];
      if (
        token.text === "where" ||
        (token.text === ":" && tokens[at + 1]?.text === "=" &&
          tokens[at + 1].start === token.end)
      ) {
        break;
      }
      end = at = Math.min(closers[at] ?? at, last);
    }
    const signature = text.slice(tokens[keyword].end, tokens[end].end)
      .replace(/\s+/g, " ").replace(/:$/, "").trim();
    return signature === "" ? label : `${label} ${signature}`;
  };
  const close = () => {
    if (declaration === undefined) return;
    declaration.endOffset = lastEnd;
    if (anonymous !== undefined) {
      declaration.label = anonymousLabel(anonymous, declaration.astKind);
    }
    declaration = undefined;
  };
  // The name a command gives on its own line after its keyword at `index`,
  // after an instance's priority.
  const nameAfter = (index: number) => {
    let at = index + 1;
    if (tokens[at]?.text === "(" && tokens[at + 1]?.text === "priority") {
      at = closing(at) + 1;
    }
    const next = tokens[at];
    return next !== undefined && next.indent === undefined && isName(next)
      ? next
      : undefined;
  };
  // Whether the token at `index` cannot end a term, so that the source
  // before the next line is unfinished. A postfix operator such as `⊢` or
  // `⁻¹` can end one.
  const unfinished = (index: number) => {
    const token = tokens[index];
    if (token === undefined) return false;
    const cls = classes[token.end - 1];
    return cls === "controlKeyword" || token.text === "where" ||
      (cls === "operator" && UNFINISHED.has(token.text)) ||
      (cls === "punctuation" && token.text === ",") ||
      (cls === "bracket" && OPENING_BRACKETS.has(token.text));
  };
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const { text: word } = token;
    lineIndent = token.indent ?? lineIndent;
    const startsCommandLine = token.indent !== undefined &&
      (declaration === undefined || token.indent <= declarationIndent);
    const commanding = startsCommandLine || prefixStart !== undefined ||
      (token.indent === undefined && tokens[index - 1]?.text === "in");
    if (commanding && (MODIFIERS.has(word) || word === "@[")) {
      if (prefixStart === undefined) close();
      prefixStart ??= token.start;
      if (word === "@[") index = closing(index);
      continue;
    }
    const start = prefixStart ?? token.start;
    prefixStart = undefined;
    if (VALUE_DECLARATIONS.has(word) || TYPE_DECLARATIONS.has(word)) {
      if (!commanding || tokens[index - 1]?.text === "deriving") {
        lastEnd = token.end;
        continue;
      }
      close();
      let keyword = word;
      const second = tokens[index + 1]?.text;
      if (word === "class" && (second === "inductive" || second === "abbrev")) {
        keyword += ` ${second}`;
        index++;
      }
      const name = word === "example" ? undefined : nameAfter(index);
      anonymous = name === undefined ? index : undefined;
      declaration = {
        kind: TYPE_DECLARATIONS.has(word) ? "class" : "function",
        label: name === undefined ? keyword : `${keyword} ${name.text}`,
        ...declaredName(name),
        startOffset: start,
        endOffset: (name ?? tokens[index]).end,
        astKind: keyword,
        children: [],
      };
      declarationIndent = lineIndent;
      parent().push(declaration);
    } else if (commanding && SCOPES.has(word)) {
      close();
      const name = word === "mutual" ? undefined : nameAfter(index);
      const scope: Scope = {
        kind: "object",
        label: name === undefined ? word : `${word} ${name.text}`,
        ...declaredName(name),
        startOffset: start,
        endOffset: (name ?? token).end,
        astKind: word,
        children: [],
        remaining: name === undefined ? 1 : components(name.text),
      };
      parent().push(scope);
      scopes.push(scope);
      if (name !== undefined) index++;
      lastEnd = scope.endOffset;
      continue;
    } else if (commanding && word === "end") {
      close();
      const name = nameAfter(index);
      const end = (name ?? token).end;
      for (
        let count = name === undefined ? 1 : components(name.text);
        count > 0;
        count--
      ) {
        const scope = scopes.at(-1);
        if (scope === undefined) break;
        if (--scope.remaining === 0) {
          scope.endOffset = end;
          scopes.pop();
        }
      }
      if (name !== undefined) index++;
      lastEnd = end;
      continue;
    } else if (
      startsCommandLine &&
      (COMMANDS.has(word) || /^#[a-z_]/.test(word) ||
        (word === "deriving" && tokens[index + 1]?.text === "instance") ||
        (isName(token) && !unfinished(index - 1)))
    ) {
      // Any other command, such as `open` or a command a file defines.
      close();
    }
    lastEnd = token.end;
  }
  close();
  for (const scope of scopes) scope.endOffset = lastEnd;
  return roots;
}

/** Returns whether `token` is an identifier that can name a declaration. */
function isName(token: Token): boolean {
  return NAME.test(token.text) && !KEYWORDS.has(token.text);
}

/** Returns the name an entry declares, from the token that names it, if any. */
function declaredName(token: Token | undefined) {
  return token === undefined
    ? {}
    : { name: token.text, nameOffset: token.start };
}

/**
 * Returns how many components a dotted name has, counting a `«…»` escape as
 * one.
 */
function components(name: string): number {
  return name.replace(/«[^»]*»?/g, "x").split(".").length;
}

/** Colors `text`, one display line per source line. */
export function leanLines(text: string): Line[] {
  return linesFromClasses(text, new Scanner(text).classes);
}

/** Colors `text` and lists its namespaces, sections, and declarations. */
export function leanDocument(text: string): Document {
  const scanner = new Scanner(text);
  const source = structureSource(text);
  const structure = structureTree(
    source,
    structureEntries(text, scanner),
    (entry) => entry,
    (entry) => entry.children,
  );
  return {
    text,
    lines: linesFromClasses(text, scanner.classes, source.lineStarts),
    structure,
    flatStructure: flattenStructure(structure),
    definitions: source.definitions,
  };
}
