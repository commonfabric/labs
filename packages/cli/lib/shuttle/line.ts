/**
 * How a shuttle line splits into tokens, how a value prints as one of them,
 * and where the token a half-typed line ends in begins.
 *
 * `cf` never does either: it is handed `Deno.args`, split for it already by
 * the operating system's shell. Shuttle reads its own line, so the split is
 * shuttle's, and so is the printing that inverts it.
 *
 * The two halves live in one module because they are one decision: what
 * {@link quoteToken} writes, {@link splitLine} reads back as the one value it
 * was given. That is what lets a value print bare where nothing in it needs
 * more, which is the common case and the point.
 *
 * {@link tailOfLine} is the third, and it is here for the same reason: where
 * a token ends is this module's question whether the line is whole or still
 * being typed, and a completion that answered it for itself would be a
 * second grammar to keep in step with this one.
 *
 * What a token then means is decided elsewhere — `place.ts` reads an operand
 * as a reference or as one of the navigation spellings, and a verb reads its
 * own. This module bounds where a token ends and says nothing past that.
 *
 * `packages/cli` splits a line too, in `tokenizeLine` under `lib/completion/`,
 * and this is not a second copy of it. That one reconstructs what bash would
 * have done to a *partial* line: it reads up to a cursor offset and always
 * pushes a last word for the cursor to sit in, so its list is never empty
 * where this one's is; it separates on the space and the tab alone; and it
 * refuses nothing, a half-typed line being its normal input. It is also not an
 * export entry of that package, so nothing here could call it.
 */

/**
 * The characters shuttle's line grammar spends on structure rather than on
 * data: the pipe, the local-program escape, the two redirection operators,
 * the `#` a wish target and a member are written with, and the `%`
 * a numbered handle is (`docs/plans/shuttle/grammar.md`).
 *
 * A value holding one of these is printed quoted wherever in the value it
 * sits. {@link quoteToken} is handed a value and no position, so it quotes on
 * the character rather than on the reading — which quotes values whose
 * position would have left the character ordinary, and is the price of a
 * printer that needs to know nothing about where its output lands.
 *
 * The characters an operand writes an address with are not here, the `:` of a
 * scheme and of a handle among them. Those are read inside a token by the
 * reference grammar rather than by the split, and a quote reaches no reading
 * (`docs/plans/shuttle/grammar.md`), so quoting them would change nothing a
 * reading does and would cost the bare printing of every address. A value
 * whose own characters a reading would take is named behind the `.` head
 * instead, which reads none of them.
 */
export const RESERVED_CHARACTERS = "!#%<>|";

/**
 * The characters {@link splitLine} reads as syntax rather than as data: the
 * two quotes it groups with, and the backslash it escapes with. A value
 * holding one is printed quoted too, and this is the half of that rule the
 * split itself forces.
 */
const SYNTAX_CHARACTERS = "\"'\\";

/**
 * What a backslash escapes between double quotes: a double quote, and another
 * backslash. Every other character there is literal, so a path or a JSON
 * escape written between double quotes arrives as it was typed.
 */
const DOUBLE_QUOTE_ESCAPES = '"\\';

/**
 * What separates two tokens. The definition is JavaScript's own — what
 * `String.prototype.trim` removes — so a token this module split and an
 * operand a caller trimmed agree about where a value's edges are.
 */
const SEPARATOR = /\s/;

/** What splitting a line produced. */
export type LineSplit =
  /** The line split, and `tokens` are its tokens in the order written. */
  | { readonly kind: "split"; readonly tokens: readonly string[] }
  /** The line is refused, for the reason given. */
  | { readonly kind: "refused"; readonly reason: string };

/**
 * Splits `line` into the tokens it is written as, or refuses it with the
 * reason.
 *
 * Whitespace separates tokens, and a run of it separates no more than one.
 * Single quotes are literal, so what sits between them is the token's own
 * whatever it is. Double quotes group, and between them a backslash escapes
 * one of {@link DOUBLE_QUOTE_ESCAPES} and is otherwise a character of the
 * token; outside quotes it escapes whatever follows it. Runs that touch are
 * one token, so `a"b c"d` is the single token `ab cd`, and an empty pair of
 * quotes is a token that is the empty string.
 *
 * A line is refused for one of two reasons, both of them a token with no end:
 * a quote that never closes, and a trailing backslash with nothing to escape.
 * Nothing else refuses a line here, so a line that splits says only that; it
 * says nothing about whether its tokens name anything.
 *
 * `line` is one line, and a terminator on it is whoever read it to strip. The
 * separator class holds the line terminators, so text carrying one splits
 * across the break into a single run of tokens rather than into two commands.
 * That is a choice and not a necessity: every value {@link quoteToken} writes
 * that holds a line break lands inside quotes, so a rule refusing an unquoted
 * one would leave the round trip whole. What the round trip settles is that
 * the choice is safe, not that it was forced.
 */
export function splitLine(line: string): LineSplit {
  const scanned = scanLine(line);
  return scanned.kind === "refused"
    ? scanned
    : { kind: "split", tokens: scanned.tokens };
}

/** What a completion at the end of a line is completing. */
export interface LineTail {
  /**
   * The whole tokens written before the one being completed, which is what
   * says where on the line that token stands.
   */
  readonly before: readonly string[];

  /**
   * The line up to where that token opens, which a completion keeps and
   * writes the token it chose after.
   */
  readonly head: string;

  /**
   * The value of the token being completed — what the split reads it as,
   * rather than how it is spelled. It is the empty string where the line ends
   * in a separator, a completion there opening a token rather than continuing
   * one.
   */
  readonly prefix: string;
}

/**
 * What a completion at the end of `line` is completing, and nothing where the
 * line is one the split refuses.
 *
 * The token is the last one {@link splitLine} reads, and `head` is the line up
 * to where that token opened. Both come off the one scan the split itself
 * runs, which is what makes this a projection of the grammar rather than a
 * second reading of it — and the difference is not academic. A separator
 * inside quotes or behind a backslash is a character of its token, so the run
 * of characters after the last separator is not the token at all: on
 * `get --select a\ sl` it is `sl`, where the token is the option's value
 * `a sl`, and a completion working from the run would offer an operand where
 * the line has none and rewrite the value to reach it.
 *
 * A line the split refuses is not completed. Both its refusals are a token
 * with no end — an unclosed quote, a trailing backslash — so where the token
 * being typed opens is exactly what such a line does not yet say.
 *
 * The prefix is a value rather than a spelling, so a caller matches candidates
 * against it and writes its choice back as a token of its own
 * ({@link quoteToken}); `head` ends where a token may open, so writing one
 * after it puts it where this one was.
 */
export function tailOfLine(line: string): LineTail | undefined {
  const scanned = scanLine(line);
  if (scanned.kind === "refused") return undefined;
  const { tokens, starts, unterminated } = scanned;
  return unterminated
    ? {
      before: tokens.slice(0, -1),
      head: line.slice(0, starts[starts.length - 1]),
      prefix: tokens[tokens.length - 1],
    }
    : { before: tokens, head: line, prefix: "" };
}

/**
 * Whether `character` separates two tokens, which is the one question the
 * split asks of a character before any other.
 *
 * The class is exported as a predicate rather than as the expression, so a
 * caller asks about a character and cannot come to depend on how the class is
 * written. What it is for is a caller that has to enumerate the class rather
 * than test one member of it.
 */
export function separatesTokens(character: string): boolean {
  return SEPARATOR.test(character);
}

/** What one scan of a line found. */
type LineScan =
  | {
    readonly kind: "scanned";
    /** The tokens, in the order written. */
    readonly tokens: readonly string[];
    /** Where each of them opened on the line, in the same order. */
    readonly starts: readonly number[];
    /**
     * Whether the last token was still open when the line ended — which is
     * what tells a token being typed from one a separator finished.
     */
    readonly unterminated: boolean;
  }
  | { readonly kind: "refused"; readonly reason: string };

/**
 * Helper for {@link splitLine} and {@link tailOfLine}, which reads `line` as
 * the grammar above describes and reports everything either of them needs.
 *
 * One scan rather than two, because there is one grammar: where a token ends
 * is the same question whether the line is whole or still being typed, and a
 * second traversal answering it would be a second grammar to keep in step.
 * What the two projections differ in is which of the answers they carry.
 */
function scanLine(line: string): LineScan {
  const tokens: string[] = [];
  const starts: number[] = [];
  let current = "";
  let started = false;
  let openedTokenAt = 0;
  let quote: string | undefined;
  let openedAt = 0;

  for (let index = 0; index < line.length; index++) {
    const character = line[index];
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined;
      } else if (
        character === "\\" && quote === '"' && index + 1 < line.length &&
        DOUBLE_QUOTE_ESCAPES.includes(line[index + 1])
      ) {
        current += line[++index];
      } else {
        // A backslash escaping nothing lands here and is a character of the
        // token like any other. Where it is the line's last character, the
        // line then ends with the quote still open, so what the caller reads
        // is the unterminated-quote refusal below rather than a second reason
        // for one fault.
        current += character;
      }
      continue;
    }
    if (SEPARATOR.test(character)) {
      if (started) {
        tokens.push(current);
        starts.push(openedTokenAt);
        current = "";
        started = false;
      }
      continue;
    }
    // Set before the branches rather than in each of them, so that an empty
    // pair of quotes opens a token the way a character does. Where the token
    // opened is recorded only as it opens, so that it names the token's first
    // character rather than its last.
    if (!started) {
      started = true;
      openedTokenAt = index;
    }
    if (character === "'" || character === '"') {
      quote = character;
      openedAt = index;
      continue;
    }
    if (character === "\\") {
      if (index + 1 === line.length) {
        return refuse("The line ends in a `\\`, which has nothing to escape.");
      }
      current += line[++index];
      continue;
    }
    current += character;
  }

  if (quote !== undefined) {
    return refuse(
      `The \`${quote}\` opened at column ${columnOf(line, openedAt)} is ` +
        `never closed.`,
    );
  }
  if (started) {
    tokens.push(current);
    starts.push(openedTokenAt);
  }
  return { kind: "scanned", tokens, starts, unterminated: started };
}

/**
 * Returns `value` written as one token of a line: bare where it holds
 * nothing that ends a token and nothing the grammar reserves, and quoted
 * where it holds one of those. {@link splitLine} reads what this returns back
 * as exactly `value`, whatever `value` holds.
 *
 * That round trip is the whole of the guarantee. What an operand reading then
 * does with the token is decided where the operand is read, and nothing here
 * tells a reading that a quote delivered its token.
 *
 * Single quotes are the first choice, since nothing between them needs an
 * escape. A value holding one is written in double quotes instead, with its
 * own quotes and backslashes escaped.
 */
export function quoteToken(value: string): string {
  if (!needsQuoting(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replaceAll(/["\\]/g, "\\$&")}"`;
}

/**
 * Helper for {@link splitLine}, which is the 1-based column of the character
 * at `index`, counted in code points. The number is there for a person to find
 * that character with, and a code point is the unit this can count: it is
 * neither the code unit the string is stored in, nor the grapheme cluster a
 * reader sees as one character.
 */
function columnOf(line: string, index: number): number {
  return [...line.slice(0, index)].length + 1;
}

/**
 * Helper for {@link scanLine}, which builds the refusal carrying `reason`.
 *
 * The one shape serves both projections: a refused scan and a refused split
 * are the same fact about the line, so the caller that splits hands it
 * straight back and the caller that completes reads it as a line it cannot
 * answer for.
 */
function refuse(reason: string): LineScan & { kind: "refused" } {
  return { kind: "refused", reason };
}

/**
 * Helper for {@link quoteToken}, which is whether `value` needs quoting to
 * come back as itself: it is empty, or it holds a separator, a syntax
 * character, or one of {@link RESERVED_CHARACTERS}.
 *
 * The empty value is in that list for a reason the others are not: a token
 * written bare cannot be empty, so quoting is what makes it a token at all.
 */
function needsQuoting(value: string): boolean {
  if (value === "") return true;
  for (const character of value) {
    if (
      SEPARATOR.test(character) || SYNTAX_CHARACTERS.includes(character) ||
      RESERVED_CHARACTERS.includes(character)
    ) {
      return true;
    }
  }
  return false;
}
