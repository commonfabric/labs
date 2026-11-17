/**
 * SQL for the pager, in PostgreSQL's lexical syntax, which SQLite's follows, or
 * in MySQL's, for a source that, read in PostgreSQL's, holds syntax only MySQL
 * reads outside its strings, comments, and bodies, such as a statement that
 * starts with a `#` comment or a `DELIMITER` command, or an executed comment
 * such as `/*!40101 … *\/`, or whose strings PostgreSQL's syntax leaves open at
 * its end and MySQL's closes, as it does for `'it\'s'`.
 *
 * In both, `--` starts a comment that runs to the end of its line (in MySQL,
 * when white space follows it), `/* … *\/` is a comment, a string is quoted
 * with `'` and a doubled quote stands for one, `` `…` `` quotes an identifier,
 * and `$1`, SQLite's `$name`, `:name`, and `@name` are parameters. Any other
 * run of operator characters is one operator, which ends before a comment
 * inside it.
 * A statement ends at a `;`.
 *
 * In PostgreSQL's syntax, comments nest, `"…"` quotes an identifier, and the
 * prefix `E` lets a backslash in a string escape the character after it. A
 * dollar quote, such as `$$…$$` or `$body$…$body$`, ends at the first copy of
 * its opening tag. One that follows `AS`, `DO`, or a `LANGUAGE` clause holds a
 * function's or a block's body, which is colored as SQL when the statement
 * names no language or names `sql` or `plpgsql`; any other dollar quote is a
 * string. The lines of data that follow a `COPY … FROM stdin` statement, up to
 * a line that holds `\.`, are one string, and a line that starts with `\` is
 * a psql command, which ends at the end of its line.
 *
 * In MySQL's syntax, `#` starts a comment, comments do not nest, `"…"` is a
 * string, a backslash in a string escapes the character after it, and
 * `/*!…*\/` holds statements that MySQL runs. A `DELIMITER` command sets the
 * text that ends a statement from the next line on.
 *
 * Every `create` statement and every `alter table` statement outside a body is
 * a structure entry, except an `alter table` statement inside a MySQL executed
 * comment that adds no columns, and the columns a statement defines are entries
 * inside it. The name a `create` statement declares and each column it defines
 * are colored as declarations, as are the variables a body's `declare` section
 * names, and a column's or variable's type that SQL does not define is colored
 * as a type name.
 */

import type { Document, Line, StructureNode, TokenClass } from "../../model.ts";
import { linesFromClasses } from "../classes.ts";
import { type LocatedEntry, scannedDocument } from "../structure.ts";

type TokenKind =
  | "word"
  | "quoted"
  | "string"
  | "comment"
  | "number"
  | "parameter"
  | "operator"
  | "punctuation"
  | "bracket"
  | "end"
  | "body"
  | "bodyEnd"
  | "executed"
  | "command"
  | "other";

interface Token {
  readonly kind: TokenKind;
  readonly start: number;
  readonly end: number;

  /** How many bodies the token is inside. */
  readonly body: number;
}

const KIND_CLASSES: Readonly<Record<TokenKind, TokenClass | undefined>> = {
  word: "identifier",
  quoted: "identifier",
  string: "string",
  comment: "comment",
  number: "number",
  parameter: "parameter",
  operator: "operator",
  punctuation: "punctuation",
  bracket: "bracket",
  end: "punctuation",
  body: "punctuation",
  bodyEnd: "punctuation",
  executed: "punctuation",
  command: "keyword",
  other: undefined,
};

const COPY_DATA_END = /\\\.(?=[ \t]*(?:\r?\n|$))/y;
const SPACE = /\s+/y;
const WORD = /[\p{L}_][\p{L}\p{N}_$]*/uy;
const STRING_PREFIX = /(?:[ebxn]|u&|_[a-z\d]+)'/iy;
const NUMBER = new RegExp(
  String.raw`0x[\da-f_]+|0b[01_]+|0o[0-7_]+|` +
    String.raw`(?:\d[\d_]*(?:\.(?!\.)[\d_]*)?|\.\d[\d_]*)(?:e[+-]?\d+)?`,
  "iy",
);
const PARAMETER = new RegExp(
  String.raw`\$\d+|\$[\p{L}_][\p{L}\p{N}_]*|\?\d+|:'[^'\n]*'|:"[^"\n]*"|` +
    String.raw`(?::|@@?)[\p{L}_][\p{L}\p{N}_$]*`,
  "uy",
);
const NAME_CHARACTER = /[\p{L}\p{N}_$)\]"'`]/u;
const DOLLAR_QUOTE = /\$(?:[\p{L}_][\p{L}\p{N}_]*)?\$/uy;
const OPERATOR = /::|:=|(?:[+*<>=~!@#%^&|?]|-(?!-)|\/(?!\*))+/y;
const MYSQL_OPERATOR = /:=|(?:[+*<>=~!%^&|?]|-(?!-(?:\s|$))|\/(?!\*))+/y;
const MYSQL_LINE_COMMENT = /#|--(?:\s|$)/y;
const MYSQL_EXECUTED_COMMENT = /\/\*!\d*/y;
const DELIMITER = /delimiter[ \t]+([^\w\s'"(]+)(?=[ \t]*(?:\r?\n|$))/iy;

/** The match `pattern` makes at `offset` in `text`, if any. */
function matchAt(
  pattern: RegExp,
  text: string,
  offset: number,
): RegExpExecArray | null {
  pattern.lastIndex = offset;
  return pattern.exec(text);
}

/** The end of the match `pattern` makes at `offset` in `text`, or -1. */
function matchEnd(pattern: RegExp, text: string, offset: number): number {
  return matchAt(pattern, text, offset) === null ? -1 : pattern.lastIndex;
}

/**
 * The end of the text quoted by the quote character at `open`, or -1 when no
 * quote before `limit` closes it.
 */
function quotedEnd(
  text: string,
  open: number,
  escapes: boolean,
  limit: number,
): number {
  const quote = text[open];
  for (let at = open + 1; at < limit; at++) {
    const char = text[at];
    if (escapes && char === "\\") at++;
    else if (char === quote) {
      if (text[at + 1] !== quote || at + 1 >= limit) return at + 1;
      at++;
    }
  }
  return -1;
}

/**
 * The end of the block comment that opens at `open`, at the latest `limit`,
 * which nests when `nests` is set.
 */
function blockCommentEnd(
  text: string,
  open: number,
  nests: boolean,
  limit: number,
): number {
  let depth = 0;
  for (let at = open; at < limit - 1; at++) {
    if (text[at] === "/" && text[at + 1] === "*" && (nests || depth === 0)) {
      depth++;
      at++;
    } else if (text[at] === "*" && text[at + 1] === "/") {
      at++;
      if (--depth === 0) return at + 1;
    }
  }
  return limit;
}

/**
 * A function that gives the position of the first copy of a dollar-quote tag
 * in `text` at or after a position, or -1, for positions that do not decrease
 * from one call for a tag to the next. It reads each `$` in `text` once.
 */
function dollarTagFinder(text: string): (tag: string, from: number) => number {
  const positions = new Map<string, number[]>();
  for (let at = text.indexOf("$"); at >= 0; at = text.indexOf("$", at + 1)) {
    const end = matchEnd(DOLLAR_QUOTE, text, at);
    if (end < 0) continue;
    const tag = text.slice(at, end);
    const found = positions.get(tag);
    if (found === undefined) positions.set(tag, [at]);
    else found.push(at);
  }
  const passed = new Map<string, number>();
  return (tag, from) => {
    const found = positions.get(tag) ?? [];
    let index = passed.get(tag) ?? 0;
    while (index < found.length && found[index] < from) index++;
    passed.set(tag, index);
    return found[index] ?? -1;
  };
}

interface Lexed {
  /** The tokens other than comments, in order. */
  readonly tokens: Token[];

  readonly comments: Token[];

  /** Whether the tokens are read in MySQL's syntax. */
  readonly mysql: boolean;

  /** Whether a string or quoted identifier runs unclosed to the text's end. */
  readonly unclosed: boolean;
}

/**
 * The source, or a body or MySQL executed comment inside it, being split into
 * tokens.
 */
interface Level {
  /** Where the level's text ends. */
  readonly end: number;

  /** The delimiter that closes the level, which starts at {@link end}. */
  readonly closer?: { readonly kind: TokenKind; readonly length: number };

  /** How many bodies the level is inside. */
  readonly body: number;
}

/**
 * Split `text` into its comments and its other tokens; white space belongs to
 * neither. The text is read in MySQL's syntax when, read in PostgreSQL's, it
 * holds syntax only MySQL reads, or leaves a string open at its end that
 * MySQL's syntax closes, as `'it\'s'` does.
 */
function tokenize(text: string): Lexed {
  const postgresql = lex(text, false);
  if (holdsMysql(text, postgresql)) return lex(text, true);
  if (!postgresql.unclosed) return postgresql;
  const mysql = lex(text, true);
  return mysql.unclosed ? postgresql : mysql;
}

/**
 * The position of the token that ends each body in `tokens`, by the position
 * of the delimiter that opens it: the body's closing delimiter, or, for a body
 * left open inside another, the delimiter that closes that other. A body left
 * open at the end of the text has none.
 */
function bodyClosers(tokens: readonly Token[]): Map<number, number> {
  const closers = new Map<number, number>();
  const open: number[] = [];
  tokens.forEach((token, index) => {
    if (token.kind === "body") open.push(index);
    else if (token.kind === "bodyEnd") {
      for (let opener = open.pop(); opener !== undefined; opener = open.pop()) {
        closers.set(opener, index);
        if (tokens[opener].body === token.body) break;
      }
    }
  });
  return closers;
}

/**
 * The start and end of each outermost body in `tokens`, delimiters included,
 * whose statement names a language other than `sql` or `plpgsql` in a
 * `LANGUAGE` clause outside brackets, before or after the body; `closers` is
 * {@link bodyClosers} of `tokens`.
 */
function foreignBodies(
  text: string,
  tokens: readonly Token[],
  closers: ReadonlyMap<number, number>,
): [number, number][] {
  interface Statement {
    readonly bodies: number[];
    brackets: number;
    language?: string;
  }
  // The statement being read inside each number of bodies, and the positions
  // of the tokens that open the bodies that become strings.
  const statements: Statement[] = [];
  const foreign = new Set<number>();
  const finish = (depth: number) => {
    for (const { bodies, language } of statements.splice(depth)) {
      if (
        language !== undefined && language !== "sql" && language !== "plpgsql"
      ) {
        for (const body of bodies) foreign.add(body);
      }
    }
  };
  tokens.forEach((token, index) => {
    finish(token.body + 1);
    if (token.kind === "end") {
      finish(token.body);
      return;
    }
    const statement = statements[token.body] ??= { bodies: [], brackets: 0 };
    const previous = tokens[index - 1];
    if (token.kind === "bracket") {
      statement.brackets += "([{".includes(text[token.start]) ? 1 : -1;
    } else if (token.kind === "body") statement.bodies.push(index);
    else if (
      statement.brackets <= 0 && previous?.body === token.body &&
      previous.kind === "word" &&
      /^language$/i.test(text.slice(previous.start, previous.end))
    ) {
      statement.language = text.slice(token.start, token.end)
        .replace(/['"]/g, "").toLowerCase();
    }
  });
  finish(0);
  // A body runs to its closing delimiter, or, unclosed, to the end of the text
  // it is in.
  const ranges: [number, number][] = [];
  for (const index of [...foreign].sort((a, b) => a - b)) {
    const token = tokens[index];
    if (token.start < (ranges.at(-1)?.[1] ?? 0)) continue;
    const closer = tokens[closers.get(index) ?? tokens.length];
    const end = closer === undefined
      ? text.length
      : closer.body === token.body
      ? closer.end
      : closer.start;
    ranges.push([token.start, end]);
  }
  return ranges;
}

/**
 * Whether `lexed`, which is `text` read in PostgreSQL's syntax, holds syntax
 * only MySQL reads outside its strings, comments, and bodies: a statement that
 * starts with a `#` comment or a `DELIMITER` command, neither of which starts a
 * PostgreSQL statement, or an executed comment, `/*!` and a version number.
 */
function holdsMysql(text: string, { tokens, comments }: Lexed): boolean {
  const word = (at: number) =>
    tokens[at]?.kind === "word"
      ? text.slice(tokens[at].start, tokens[at].end).toLowerCase()
      : "";
  return comments.some((comment) =>
    comment.body === 0 &&
    /^\/\*!\d/.test(text.slice(comment.start, comment.start + 4))
  ) || tokens.some((token, index) => {
    const previous = tokens[index - 1];
    return token.body === 0 &&
      (previous === undefined || previous.kind === "end") &&
      (text[token.start] === "#" ||
        (word(index) === "delimiter" &&
          matchAt(DELIMITER, text, token.start) !== null));
  });
}

/** Split `text` into tokens, in MySQL's syntax when `mysql` is set. */
function lex(text: string, mysql: boolean): Lexed {
  const tokens: Token[] = [];
  const comments: Token[] = [];
  const levels: Level[] = [{
    end: text.length,
    body: 0,
  }];
  let level = levels[0];
  let terminator = ";";
  let nextTerminator = text.length;
  let lineStart = true;
  let findTag: ReturnType<typeof dollarTagFinder> | undefined;

  /** The last token added, or the one `back` places before it. */
  const before = (back: number): Token | undefined => tokens.at(-1 - back);

  /** The lowercase spelling of `token` when it is a word at this level. */
  const wordOf = (token: Token | undefined): string =>
    token === undefined || token.body !== level.body || token.kind !== "word"
      ? ""
      : text.slice(token.start, token.end).toLowerCase();

  /**
   * Whether the statement being read is a `COPY … FROM stdin`, which psql
   * follows with lines of data.
   */
  let copying = false;

  /** Whether the lines after the current one are a `COPY` statement's data. */
  let copyPending = false;

  /** Whether a string or quoted identifier runs unclosed to the text's end. */
  let unclosed = false;

  /** Add a string or quoted identifier from `start`, quoted at `quote`. */
  const quoted = (
    kind: TokenKind,
    start: number,
    quote: number,
    escapes: boolean,
  ): number => {
    const end = quotedEnd(text, quote, escapes, level.end);
    unclosed ||= end < 0 && level.end === text.length;
    return push(kind, start, end < 0 ? level.end : end);
  };

  const push = (kind: TokenKind, start: number, end: number): number => {
    if (kind === "end") copying = false;
    else if (kind === "word" && !mysql && levels.length === 1) {
      copying ||= wordOf(before(0)) === "from" &&
        /^stdin$/i.test(text.slice(start, end));
    }
    const token = { kind, start, end, body: level.body };
    (kind === "comment" ? comments : tokens).push(token);
    return end;
  };

  /** Start reading a body or an executed comment from `open` to `end`. */
  const enter = (
    open: number,
    end: number,
    closer: Level["closer"],
    body: number,
  ): number => {
    level = {
      end,
      ...(closer === undefined ? {} : { closer }),
      body,
    };
    levels.push(level);
    return open;
  };

  /** The end of the line that `from` is on, at the latest the level's end. */
  const lineEnd = (from: number): number => {
    let end = from;
    while (end < level.end && text[end] !== "\n") end++;
    return end;
  };

  /**
   * Add the lines of data from `from`, up to a line that holds `\.`, and return
   * where they end.
   */
  const copyData = (from: number): number => {
    let line = from;
    while (line < level.end && !matches(COPY_DATA_END, line)) {
      line = Math.min(lineEnd(line) + 1, level.end);
    }
    if (line > from) push("string", from, line);
    return line < level.end ? push("end", line, line + 2) : line;
  };

  /** The end of the token `matches` last found. */
  let matched = 0;

  /**
   * Whether `pattern` matches at `at`, setting `matched` to the end of
   * the match, cut at the level's end and at the statement terminator a
   * `DELIMITER` command set.
   */
  const matches = (pattern: RegExp, at: number): boolean => {
    const end = matchEnd(pattern, text, at);
    if (end < 0) return false;
    if (terminator !== ";" && nextTerminator <= at) {
      const found = text.indexOf(terminator, at + 1);
      nextTerminator = found < 0 ? text.length : found;
    }
    matched = Math.min(end, level.end, nextTerminator);
    return true;
  };
  for (let at = 0; at < text.length || levels.length > 1;) {
    if (at >= level.end) {
      const { end, closer } = level;
      levels.pop();
      level = levels[levels.length - 1];
      if (closer !== undefined) {
        at = push(closer.kind, end, end + closer.length);
      }
      continue;
    }
    if (matches(SPACE, at)) {
      const feed = text.slice(at, matched).indexOf("\n");
      lineStart ||= feed >= 0;
      if (copyPending && feed >= 0) {
        copyPending = false;
        at = copyData(at + feed + 1);
      } else at = matched;
      continue;
    }
    const char = text[at];
    const delimiter = mysql && lineStart && levels.length === 1
      ? matchAt(DELIMITER, text, at)
      : null;
    // psql runs a line that starts with `\` as one of its own commands.
    const command = !mysql && lineStart && levels.length === 1 && char === "\\";
    lineStart = false;
    if (terminator !== ";" && text.startsWith(terminator, at)) {
      at = push("end", at, at + terminator.length);
    } else if (command) {
      const end = lineEnd(at);
      const name = text.slice(at, end).search(/\s|$/) + at;
      push("command", at, name);
      // psql's `\copy … from stdin` reads the lines after it as data.
      copyPending = /^\\copy\b.*\bfrom\s+p?stdin\b/i.test(text.slice(at, end));
      if (end > name) push("other", name, end);
      at = push("end", end, end);
    } else if (delimiter !== null) {
      terminator = delimiter[1];
      nextTerminator = terminator === ";" ? text.length : DELIMITER.lastIndex;
      push("word", at, at + "delimiter".length);
      at = push(
        "end",
        DELIMITER.lastIndex - terminator.length,
        DELIMITER.lastIndex,
      );
    } else if (
      mysql ? matches(MYSQL_LINE_COMMENT, at) : text.startsWith("--", at)
    ) {
      at = push("comment", at, lineEnd(at));
    } else if (
      mysql && levels.length === 1 && matches(MYSQL_EXECUTED_COMMENT, at)
    ) {
      const open = push("executed", at, matched);
      const close = text.indexOf("*/", open);
      at = close < 0 || close + 2 > level.end
        ? enter(open, level.end, undefined, level.body)
        : enter(open, close, { kind: "executed", length: 2 }, level.body);
    } else if (text.startsWith("/*", at)) {
      at = push("comment", at, blockCommentEnd(text, at, !mysql, level.end));
    } else if ("()[]{}".includes(char)) {
      at = push("bracket", at, at + 1);
    } else if (char === ";") {
      // The lines after the one that ends a `COPY … FROM stdin` statement are
      // its data.
      copyPending = copying;
      at = push(terminator === ";" ? "end" : "punctuation", at, at + 1);
    } else if (text.startsWith("..", at)) {
      at = push("punctuation", at, at + 2);
    } else if (
      char === "," || (char === "." && !/\d/.test(text[at + 1] ?? ""))
    ) {
      at = push("punctuation", at, at + 1);
    } else if (char === "'" || char === '"' || char === "`") {
      const kind = char === "'" || (mysql && char === '"')
        ? "string"
        : "quoted";
      const escapes = mysql && kind === "string";
      at = quoted(kind, at, at, escapes);
    } else if (
      // A prefixed string's quote, or a dollar quote's closing `$`, that the
      // level's end or the terminator cut off does not count.
      matches(STRING_PREFIX, at) && matched === STRING_PREFIX.lastIndex
    ) {
      const quote = STRING_PREFIX.lastIndex - 1;
      const escapes = mysql || char === "e" || char === "E";
      at = quoted("string", at, quote, escapes);
    } else if (matches(WORD, at)) {
      at = push("word", at, matched);
    } else if (matches(NUMBER, at)) {
      at = push("number", at, matched);
    } else if (
      !mysql && matches(DOLLAR_QUOTE, at) &&
      matched === DOLLAR_QUOTE.lastIndex
    ) {
      const open = DOLLAR_QUOTE.lastIndex;
      const tag = text.slice(at, open);
      findTag ??= dollarTagFinder(text);
      const found = findTag(tag, open);
      const close = found < 0 || found + tag.length > level.end ? -1 : found;
      const end = close < 0 ? level.end : close + tag.length;
      if (
        wordOf(before(0)) === "as" || wordOf(before(0)) === "do" ||
        wordOf(before(1)) === "language"
      ) {
        push("body", at, open);
        at = close < 0
          ? enter(open, level.end, undefined, level.body + 1)
          : enter(
            open,
            close,
            { kind: "bodyEnd", length: tag.length },
            level.body + 1,
          );
      } else {
        at = push("string", at, end);
      }
    } else if (
      matches(PARAMETER, at) &&
      !(char === ":" && NAME_CHARACTER.test(text[at - 1] ?? ""))
    ) {
      at = push("parameter", at, matched);
    } else if (matches(mysql ? MYSQL_OPERATOR : OPERATOR, at)) {
      at = push("operator", at, matched);
    } else {
      at = push(
        char === ":" || char === "@" ? "operator" : "other",
        at,
        at + 1,
      );
    }
  }
  return { tokens, comments, mysql, unclosed };
}

const KEYWORD_CLASSES = new Map<string, TokenClass>();
for (
  const [cls, words] of ([
    [
      "storageKeyword",
      `
      create alter drop truncate table view function procedure trigger index
      type schema sequence extension database domain policy role rule
    `,
    ],
    [
      "controlKeyword",
      `
      if then else elsif elseif case when end loop while for foreach return
      exit continue raise
    `,
    ],
    [
      "typeKeyword",
      `
      bigint bigserial bit blob bool boolean bytea char character cidr
      citext clob date datetime decimal double float float4 float8 inet int
      int2 int4 int8 integer interval json jsonb longtext macaddr mediumint
      mediumtext money nchar numeric nvarchar oid precision real record
      refcursor regclass regtype serial serial4 serial8 smallint smallserial
      text time timestamp timestamptz timetz tinyint tinytext tsquery
      tsvector uuid varbinary varchar varying void xml
    `,
    ],
    [
      "boolean",
      `
      true false
    `,
    ],
    [
      "keyword",
      `
      abort action add after all also always analyze and any array as asc
      attach authorization auto_increment autoincrement before begin between
      both by called cascade cast check collate column comment commit
      concurrently conflict constant constraint copy cost cross current
      current_date current_time current_timestamp current_user cursor
      declare default deferrable deferred definer delete delimiter desc
      detach distinct do each enum escape except exclude exception execute
      exists explain extract filter first following foreign from full
      generated get global grant group having identity ilike immediate
      immutable in inherits initially inner insert instead intersect into
      invoker is isnull join key language last lateral leading leakproof
      left like limit local lock materialized natural new no not nothing
      notnull null nulls of off offset old on only or order outer over owner
      parallel partition perform pragma preceding primary privileges range
      recursive references referencing refresh rename replace restrict
      returning returns revoke right rollback row rows savepoint security
      select set setof show signed similar some stable start statement
      stored strict temp temporary to trailing transaction unbounded union
      unique unlogged unsigned until update use user using vacuum values
      variadic virtual volatile where window with within without zerofill
      zone
    `,
    ],
  ] as const)
) {
  for (const word of words.trim().split(/\s+/)) KEYWORD_CLASSES.set(word, cls);
}

/** Words after which a name followed by `(` names a relation. */
const RELATION_KEYWORDS = new Set([
  "exists",
  "from",
  "into",
  "join",
  "on",
  "only",
  "references",
  "table",
  "update",
]);

/** Words a `create` statement may hold before the kind of thing it creates. */
const CREATE_MODIFIERS = new Set([
  "constraint",
  "default",
  "event",
  "foreign",
  "fulltext",
  "global",
  "local",
  "materialized",
  "or",
  "procedural",
  "recursive",
  "replace",
  "spatial",
  "temp",
  "temporary",
  "trusted",
  "unique",
  "unlogged",
  "virtual",
]);

/**
 * The kinds of thing a `create` statement makes that more than one word names.
 */
const CREATE_PHRASES = new Set([
  "access method",
  "data wrapper",
  "operator class",
  "operator family",
  "text search configuration",
  "text search dictionary",
  "text search parser",
  "text search template",
  "user mapping",
]);

/**
 * The structure kind of each thing a `create` statement makes, where it is not
 * an object.
 */
const CREATE_KINDS: ReadonlyMap<string, StructureNode["kind"]> = new Map([
  ["aggregate", "function"],
  ["domain", "typeAlias"],
  ["function", "function"],
  ["procedure", "function"],
  ["type", "typeAlias"],
]);

/**
 * Words that open a table constraint, an index, or a partition rather than a
 * column definition, and `generated`, which follows `add` in an `alter column`
 * action.
 */
const NOT_COLUMNS = new Set([
  "check",
  "constraint",
  "exclude",
  "foreign",
  "fulltext",
  "generated",
  "like",
  "partition",
  "primary",
  "spatial",
  "unique",
]);

/** The words that give a function parameter's mode. */
const PARAMETER_MODES = new Set(["in", "inout", "out", "variadic"]);

/** The kinds of thing whose `create` statement can hold a `begin` block. */
const BLOCK_KINDS = new Set(["function", "procedure", "trigger"]);

/**
 * The words that follow an `end` that closes something other than a `begin`
 * block or a `case`.
 */
const BLOCK_ENDINGS = new Set(["for", "if", "loop", "repeat", "while"]);

/** Words that follow the kind in a `create` statement in place of a name. */
const NOT_NAMES = new Set(["as", "authorization", "for", "on", "using"]);

interface Entry extends LocatedEntry {
  readonly children: Entry[];
}

/** The token classes and structure of one source, from one pass over it. */
class Scanner {
  readonly #text: string;

  /** Whether the source is read in MySQL's syntax. */
  readonly #mysql: boolean;

  /** The tokens, other than comments. */
  readonly #tokens: Token[];

  /** The class of each token in {@link #tokens}. */
  readonly #classes: (TokenClass | undefined)[];

  /** The token class of each character. */
  readonly classes: (TokenClass | undefined)[];

  /** The `create` and `alter table` statements, in order. */
  readonly entries: Entry[] = [];

  constructor(text: string) {
    this.#text = text;
    const { tokens, comments, mysql } = tokenize(text);
    const closers = bodyClosers(tokens);
    const strings = mysql ? [] : foreignBodies(text, tokens, closers);
    this.#mysql = mysql;
    this.#tokens = tokens;
    this.#classes = tokens.map((token, index) =>
      token.kind === "word" ? this.#wordClass(index) : KIND_CLASSES[token.kind]
    );
    // A statement's tokens leave out those in a body, which still extend it.
    // In a statement that creates a trigger, a function, or a procedure, a `;`
    // inside a `begin` or `case` block, as in an SQLite trigger, is part of
    // the statement, as is one inside the brackets that hold a rule's actions.
    // Inside brackets, `begin` and `case` name columns and parameters.
    let statement: number[] = [];
    let end = 0;
    let blocks = 0;
    let brackets = 0;
    let created: string | undefined;
    const kind = () => created ??= this.#createKind(statement)?.[0] ?? "";
    tokens.forEach((token, index) => {
      end = token.end;
      if (token.body > 0 || token.kind === "executed") return;
      statement.push(index);
      const word = this.#word(index);
      if (this.#is(index, "(") || this.#is(index, "[")) brackets++;
      else if (this.#is(index, ")") || this.#is(index, "]")) {
        brackets = Math.max(0, brackets - 1);
      } else if (brackets === 0 && (word === "begin" || word === "case")) {
        const ends = word === "case" &&
          this.#word(statement.at(-2) ?? -1) === "end";
        if (!ends && BLOCK_KINDS.has(kind())) blocks++;
      } else if (brackets === 0 && word === "end") {
        if (
          blocks > 0 && BLOCK_KINDS.has(kind()) &&
          !BLOCK_ENDINGS.has(this.#word(index + 1))
        ) blocks--;
      }
      // A terminator a `DELIMITER` command set ends any statement.
      if (
        token.kind === "end" &&
        (this.#source(index) !== ";" ||
          (blocks === 0 && (brackets === 0 || kind() !== "rule")))
      ) {
        this.#statement(statement, end);
        statement = [];
        blocks = 0;
        brackets = 0;
        created = undefined;
      }
    });
    this.#statement(statement, end);
    this.#declarations(closers);
    this.classes = new Array<TokenClass | undefined>(text.length).fill(
      undefined,
    );
    for (const [index, token] of tokens.entries()) {
      const cls = this.#classes[index];
      for (let at = token.start; at < token.end; at++) this.classes[at] = cls;
    }
    for (const { start, end } of comments) {
      for (let at = start; at < end; at++) this.classes[at] = "comment";
    }
    for (const [start, end] of strings) {
      for (let at = start; at < end; at++) this.classes[at] = "string";
    }
  }

  #source(index: number): string {
    const token = this.#tokens[index];
    return token === undefined ? "" : this.#text.slice(token.start, token.end);
  }

  /**
   * Whether the token at `index` is punctuation, a bracket, or an operator
   * spelled `text`.
   */
  #is(index: number, text: string): boolean {
    const token = this.#tokens[index];
    return token !== undefined && token.end - token.start === text.length &&
      (token.kind === "punctuation" || token.kind === "bracket" ||
        token.kind === "operator") &&
      this.#text.startsWith(text, token.start);
  }

  /** The lowercase spelling of the word at `index`, or "" for another token. */
  #word(index: number): string {
    return this.#tokens[index]?.kind === "word"
      ? this.#source(index).toLowerCase()
      : "";
  }

  #wordClass(index: number): TokenClass {
    const token = this.#tokens[index];
    const next = this.#tokens[index + 1];
    const call = this.#is(index + 1, "(") && next.start === token.end;
    if (this.#is(index + 1, ".")) return call ? "callName" : "identifier";
    const word = this.#word(index);
    if (
      this.#is(index - 1, "::") ||
      (this.#is(index - 1, ".") && this.#is(index - 3, "::"))
    ) {
      return KEYWORD_CLASSES.get(word) === "typeKeyword"
        ? "typeKeyword"
        : "typeName";
    }
    if (this.#is(index - 1, ".")) return call ? "callName" : "identifier";
    // The type a function returns, as in `returns setof subscription_status`.
    const returning = this.#word(index - 1) === "setof" ? index - 2 : index - 1;
    if (
      this.#word(returning) === "returns" &&
      !["null", "setof", "table"].includes(word)
    ) {
      return KEYWORD_CLASSES.get(word) === "typeKeyword" || word === "trigger"
        ? "typeKeyword"
        : "typeName";
    }
    const keyword = KEYWORD_CLASSES.get(word);
    if (keyword !== undefined) return keyword;
    return call && !RELATION_KEYWORDS.has(this.#word(index - 1))
      ? "callName"
      : "identifier";
  }

  /** Whether the token at `index` is a word or a quoted identifier. */
  #isWordOrQuoted(index: number): boolean {
    const kind = this.#tokens[index]?.kind;
    return kind === "word" || kind === "quoted";
  }

  /**
   * Whether the token at `index` is a quoted identifier or a word that SQL does
   * not define.
   */
  #isName(index: number): boolean {
    return this.#tokens[index]?.kind === "quoted" ||
      (this.#tokens[index]?.kind === "word" &&
        !KEYWORD_CLASSES.has(this.#word(index)));
  }

  /**
   * The last part of the possibly qualified name that starts at `at` in
   * `statement`, and the position after the name.
   */
  #name(statement: number[], at: number): [number | undefined, number] {
    if (
      !this.#isWordOrQuoted(statement[at]) ||
      NOT_NAMES.has(this.#word(statement[at]))
    ) return [undefined, at];
    let last = at;
    while (
      this.#is(statement[last + 1], ".") &&
      this.#isWordOrQuoted(statement[last + 2])
    ) last += 2;
    return [statement[last], last + 1];
  }

  /**
   * The kind of thing that the `create` statement made of the tokens at
   * `statement` makes, and the position after the words that name it.
   */
  #createKind(statement: number[]): [string, number] | undefined {
    const word = (at: number) => this.#word(statement[at]);
    if (word(0) !== "create") return undefined;
    let at = 1;
    for (;;) {
      // PostgreSQL's `event trigger` is a trigger; MySQL's `event` an event.
      if (
        CREATE_MODIFIERS.has(word(at)) &&
        (word(at) !== "event" || word(at + 1) === "trigger")
      ) at++;
      else if (word(at) === "sql" && word(at + 1) === "security") at += 3;
      else if (
        (word(at) === "algorithm" || word(at) === "definer") &&
        this.#is(statement[at + 1], "=")
      ) {
        // A MySQL definer's user may be `CURRENT_USER()`, and its host follows
        // the user as `@host` or `@'host'`.
        at += 3;
        if (this.#is(statement[at], "(") && this.#is(statement[at + 1], ")")) {
          at += 2;
        }
        const account = this.#tokens[statement[at]];
        if (this.#source(statement[at]).startsWith("@")) {
          at += account.kind === "parameter" ? 1 : 2;
        }
      } else break;
    }
    const phrase = (length: number) =>
      Array.from({ length }, (_, index) => word(at + index)).join(" ");
    const length =
      [3, 2].find((length) => CREATE_PHRASES.has(phrase(length))) ??
        1;
    return word(at) === "" ? undefined : [phrase(length), at + length];
  }

  /**
   * Read the statement made of the tokens at `statement`, which ends at `end`.
   */
  #statement(statement: number[], end: number): void {
    if (statement.length === 0) return;
    const word = (at: number) => this.#word(statement[at]);
    const start = this.#tokens[statement[0]].start;
    const created = this.#createKind(statement);
    if (created !== undefined) {
      const kind = created[0];
      let at = created[1];
      for (;;) {
        if (word(at) === "concurrently") at++;
        else if (word(at) === "if" && word(at + 1) === "not") at += 3;
        else break;
      }
      const [name, after] = this.#name(statement, at);
      const structureKind = CREATE_KINDS.get(kind) ?? "object";
      const entry: Entry = {
        kind: structureKind,
        label: name === undefined ? kind : `${kind} ${this.#source(name)}`,
        ...(name === undefined ? {} : {
          name: this.#source(name),
          nameOffset: this.#tokens[name].start,
        }),
        startOffset: start,
        endOffset: end,
        astKind: `create ${kind}`,
        children: [],
      };
      if (name !== undefined) {
        this.#classes[name] = structureKind === "function"
          ? "functionName"
          : "interfaceName";
      }
      if (structureKind === "function" && this.#is(statement[after], "(")) {
        this.#parameters(statement, after);
      }
      if (kind === "table" && this.#is(statement[after], "(")) {
        this.#columns(statement, after, entry.children);
      }
      this.entries.push(entry);
    } else if (word(0) === "alter" && word(1) === "table") {
      let at = 2;
      if (word(at) === "if") at += 2;
      if (word(at) === "only") at++;
      const [name, after] = this.#name(statement, at);
      if (name === undefined) return;
      const entry: Entry = {
        kind: "statement",
        label: `alter table ${this.#source(name)}`,
        startOffset: start,
        endOffset: end,
        astKind: "alter table",
        children: [],
      };
      for (let index = after; index < statement.length; index++) {
        if (word(index) !== "add") continue;
        let column = index + 1;
        if (this.#is(statement[column], "(")) {
          index = this.#columns(statement, column, entry.children);
          continue;
        }
        if (word(column) === "column") {
          column++;
          if (word(column) === "if") column += 3;
        } else if (this.#isNotColumn(statement, column)) continue;
        index = this.#elementEnd(statement, column);
        this.#column(statement, column, index, entry.children);
      }
      // mysqldump wraps each table's data in `ALTER TABLE … DISABLE KEYS` and
      // `ENABLE KEYS` statements inside executed comments.
      const executed = this.#tokens[statement[0] - 1]?.kind === "executed";
      if (executed && entry.children.length === 0) return;
      this.entries.push(entry);
    }
  }

  /**
   * Whether the element that starts at `at` in `statement` is a table
   * constraint or an index, such as MySQL's `KEY name (columns)`, rather than a
   * column definition.
   */
  #isNotColumn(statement: number[], at: number): boolean {
    const word = this.#word(statement[at]);
    if (NOT_COLUMNS.has(word)) return true;
    if (word !== "key" && word !== "index") return false;
    const next = statement[at + 1];
    return this.#is(next, "(") || this.#word(next) === "using" ||
      (this.#isName(next) && this.#is(statement[at + 2], "("));
  }

  /**
   * Mark the variables declared by the `declare` section that opens a body,
   * each declaration a name, an optional `constant`, and a type, up to the
   * section's `begin` or the body's end, and in MySQL's syntax, the one that
   * each `DECLARE` statement declares. A scan steps over each body inside the
   * one it reads, to the token `closers` gives.
   */
  #declarations(closers: ReadonlyMap<number, number>): void {
    const tokens = this.#tokens;
    tokens.forEach((token, index) => {
      if (
        this.#mysql && this.#word(index) === "declare" &&
        (this.#word(index - 1) === "begin" || this.#source(index - 1) === ";")
      ) {
        if (this.#isName(index + 1)) {
          this.#classes[index + 1] = "binding";
          if (this.#isName(index + 2)) this.#classes[index + 2] = "typeName";
        }
        return;
      }
      // A block label, such as `<<outer>>`, may come before the section.
      const labeled = this.#is(index - 1, ">>") && this.#is(index - 3, "<<");
      if (
        this.#word(index) !== "declare" ||
        tokens[index - (labeled ? 4 : 1)]?.kind !== "body"
      ) return;
      const inside = (at: number) => tokens[at]?.body === token.body;
      for (
        let at = index + 1;
        inside(at) && this.#word(at) !== "begin";
        at++
      ) {
        if (this.#isWordOrQuoted(at)) {
          this.#classes[at] = "binding";
          const type = this.#word(at + 1) === "constant" ? at + 2 : at + 1;
          if (this.#isName(type)) this.#classes[type] = "typeName";
        }
        while (inside(at) && tokens[at].kind !== "end") {
          at = tokens[at].kind === "body"
            ? closers.get(at) ?? tokens.length
            : at + 1;
        }
      }
    });
  }

  /**
   * The position in `statement` after the element that starts at `at`: that of
   * the `,` or `)` that ends it, or the statement's end.
   */
  #elementEnd(statement: number[], at: number): number {
    let depth = 0;
    for (let index = at; index < statement.length; index++) {
      const token = statement[index];
      if (this.#is(token, "(") || this.#is(token, "[")) depth++;
      else if (this.#is(token, ")") || this.#is(token, "]")) {
        if (depth-- === 0) return index;
      } else if (
        depth === 0 &&
        (this.#is(token, ",") || this.#tokens[token].kind === "end")
      ) {
        return index;
      }
    }
    return statement.length;
  }

  /**
   * Mark the parameters in the list that opens at `open`: each element is an
   * optional mode, a name, and a type, or a type alone.
   */
  #parameters(statement: number[], open: number): void {
    for (let at = open + 1;;) {
      const end = this.#elementEnd(statement, at);
      const mode = PARAMETER_MODES.has(this.#word(statement[at])) ? 1 : 0;
      const name = at + mode;
      if (name + 1 < end && this.#isName(statement[name])) {
        this.#classes[statement[name]] = "parameter";
        if (this.#isName(statement[name + 1])) {
          this.#classes[statement[name + 1]] = "typeName";
        }
      }
      if (!this.#is(statement[end], ",")) return;
      at = end + 1;
    }
  }

  /**
   * Read the column definitions in the list that opens at `open`, and return
   * the position of the token that ends the list.
   */
  #columns(statement: number[], open: number, columns: Entry[]): number {
    for (let at = open + 1;;) {
      const end = this.#elementEnd(statement, at);
      if (!this.#isNotColumn(statement, at)) {
        this.#column(statement, at, end, columns);
      }
      if (!this.#is(statement[end], ",")) return end;
      at = end + 1;
    }
  }

  /** Record the column defined by the element from `at` to `end`. */
  #column(
    statement: number[],
    at: number,
    end: number,
    columns: Entry[],
  ): void {
    const name = statement[at];
    const type = statement[at + 1];
    if (at >= end || !this.#isWordOrQuoted(name)) return;
    this.#classes[name] = "binding";
    if (at + 1 < end && this.#isName(type)) this.#classes[type] = "typeName";
    const text = this.#source(name);
    columns.push({
      kind: "variable",
      label: text,
      name: text,
      nameOffset: this.#tokens[name].start,
      startOffset: this.#tokens[name].start,
      endOffset: this.#tokens[statement[end - 1]].end,
      astKind: "column",
      children: [],
    });
  }
}

/** Color `text`, one display line per source line. */
export function sqlLines(text: string): Line[] {
  return linesFromClasses(text, new Scanner(text).classes);
}

/**
 * Color `text` and list the statements that create things or alter tables, with
 * the columns each defines.
 */
export function sqlDocument(text: string): Document {
  const scanner = new Scanner(text);
  return scannedDocument(text, scanner.classes, scanner.entries);
}
