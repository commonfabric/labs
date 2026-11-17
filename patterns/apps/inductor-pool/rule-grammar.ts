/**
 * The restricted regular-expression grammar a lo-fi rule is written in, and the
 * canonical form two rules are compared by.
 *
 * Rules are compared so that two people who learned the same rule in different
 * spellings count as proposing one rule. A false "different" only costs a
 * missed match; a false "same" would merge two rules that mean different
 * things, so every rewrite here preserves meaning exactly and anything it is
 * unsure of is left as written.
 *
 * Meaning here is what `RegExp.prototype.test` answers with the `i` flag and no
 * other: whether some substring matches. The grammar excludes everything whose
 * meaning depends on more than that (backreferences, lookaround, named groups,
 * Unicode property escapes, other flags), and within it:
 *
 * - alternation order and greediness cannot change whether a match exists, so
 *   branches are sorted and deduplicated and lazy quantifiers become greedy;
 * - capturing groups capture nothing anyone reads, so every group becomes
 *   `(?:…)`, and a group that needs no brackets loses them;
 * - every single character is a set of code units, closed under ASCII case
 *   because of the `i` flag, so `a`, `A`, `[a]`, `[aA]`, and `\x61` are one
 *   atom, and branches that are each one character merge into one class;
 * - quantifiers are written in their shortest form (`{0,}` is `*`).
 */

// =============================================================================
// TYPES
// =============================================================================

/** A rule as a proposal or a person writes it, before it is checked. */
export interface RuleDraft {
  /** The item field the pattern is tested against. */
  field: string;
  /** The pattern, without slashes. */
  pattern: string;
  /** The label a match votes for. */
  predicts: boolean;
  /** Absent, or `"i"`: rules are always case-insensitive. */
  flags?: string;
}

/** A rule in canonical form: the only form a rule is stored or run in. */
export interface CanonicalRule {
  field: string;
  /** The canonical pattern, run with the `i` flag. */
  pattern: string;
  predicts: boolean;
  /** A hash of field, label, and canonical pattern: equal keys, equal rules. */
  key: string;
}

/** A rule draft checked against the grammar: the rule, or why it is refused. */
export type RuleCheck =
  | { ok: true; rule: CanonicalRule }
  | { ok: false; reason: string };

/** A set of UTF-16 code units, as sorted, disjoint, non-adjacent ranges. */
type Ranges = Array<[number, number]>;

/** A parsed pattern. */
type Node =
  | { kind: "alt"; branches: Node[] }
  | { kind: "seq"; items: Node[] }
  | { kind: "set"; negated: boolean; ranges: Ranges }
  | { kind: "assert"; which: "^" | "$" | "\\b" | "\\B" }
  | { kind: "repeat"; body: Node; min: number; max: number | null };

// =============================================================================
// LIMITS
// =============================================================================

/** The longest pattern accepted, in code units. */
export const MAX_PATTERN_LENGTH = 300;

/** The largest count a `{n,m}` quantifier may name. */
export const MAX_REPEAT_COUNT = 100;

/** The longest field name accepted. */
const MAX_FIELD_LENGTH = 64;

/** The most rules one set (a proposal, or a contribution to a pool) holds. */
export const MAX_RULES = 20;

/**
 * How much of a field a rule is tested against, in code units: a rule tests
 * only the field's first `MAX_TESTED_LENGTH` code units. A subject or a
 * snippet fits whole; a long body is cut. The bound is what makes the
 * backtracking budget below a bound on time.
 */
export const MAX_TESTED_LENGTH = 1000;

/**
 * The most ways a pattern, all its top-level alternatives together, may match
 * a single span, as `backtrackCost` counts them, with an unbounded quantifier
 * counting as `MAX_TESTED_LENGTH` ways. `RegExp.test` tries every alternative
 * at every start position, so its work is at most about this times the tested
 * length: eight million steps, about fifteen milliseconds per rule and field
 * at worst, measured. One unbounded quantifier with up to eight ways around it
 * fits (`invoice.*due`, `.*bills?`); two do not (`.*.*!` takes seconds on a
 * thousand characters).
 */
export const MAX_BACKTRACK_COST = 8 * MAX_TESTED_LENGTH;

/**
 * The most a whole rule set's patterns may cost together, since each runs on
 * every item: four patterns at the budget, so a set at its worst takes about
 * sixty milliseconds per item.
 */
export const MAX_SET_BACKTRACK_COST = 4 * MAX_BACKTRACK_COST;

// =============================================================================
// CHARACTER SETS
// =============================================================================

const MAX_CODE_UNIT = 0xffff;

const DIGIT: Ranges = [[0x30, 0x39]];
const WORD: Ranges = [[0x30, 0x39], [0x41, 0x5a], [0x5f, 0x5f], [0x61, 0x7a]];
/** `\s`: WhiteSpace and LineTerminator, as ECMAScript defines them. */
const SPACE: Ranges = [
  [0x09, 0x0d],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
];
/** What `.` excludes without the `s` flag: the line terminators. */
const LINE_TERMINATORS: Ranges = [
  [0x0a, 0x0a],
  [0x0d, 0x0d],
  [0x2028, 0x2029],
];

/** `ranges` sorted, with overlapping and adjacent ranges merged. */
function normalizeRanges(ranges: Ranges): Ranges {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Ranges = [];
  for (const [lo, hi] of sorted) {
    const last = merged[merged.length - 1];
    if (last && lo <= last[1] + 1) {
      last[1] = Math.max(last[1], hi);
    } else {
      merged.push([lo, hi]);
    }
  }
  return merged;
}

/**
 * `ranges` with each ASCII letter's other case added. Under the `i` flag
 * without `u`, a character matches a set when its case-folded form is the
 * folded form of a member, and no character outside ASCII folds into ASCII, so
 * adding ASCII case partners never changes what a set (or its negation)
 * matches. Non-ASCII letters are left alone, which can only make two equal
 * sets look different.
 */
function caseClose(ranges: Ranges): Ranges {
  const extra: Ranges = [];
  for (const [lo, hi] of ranges) {
    const upLo = Math.max(lo, 0x41);
    const upHi = Math.min(hi, 0x5a);
    if (upLo <= upHi) extra.push([upLo + 32, upHi + 32]);
    const downLo = Math.max(lo, 0x61);
    const downHi = Math.min(hi, 0x7a);
    if (downLo <= downHi) extra.push([downLo - 32, downHi - 32]);
  }
  return normalizeRanges([...ranges, ...extra]);
}

function sameRanges(a: Ranges, b: Ranges): boolean {
  return a.length === b.length &&
    a.every(([lo, hi], i) => lo === b[i][0] && hi === b[i][1]);
}

/** The complement of `ranges` within the code units. */
function complement(ranges: Ranges): Ranges {
  const out: Ranges = [];
  let next = 0;
  for (const [lo, hi] of ranges) {
    if (lo > next) out.push([next, lo - 1]);
    next = hi + 1;
  }
  if (next <= MAX_CODE_UNIT) out.push([next, MAX_CODE_UNIT]);
  return out;
}

const CLOSED_DIGIT = caseClose(DIGIT);
const CLOSED_WORD = caseClose(WORD);
const CLOSED_SPACE = caseClose(SPACE);
const CLOSED_LINE_TERMINATORS = caseClose(LINE_TERMINATORS);

function setNode(ranges: Ranges, negated = false): Node {
  return { kind: "set", negated, ranges: caseClose(ranges) };
}

// =============================================================================
// PARSER
// =============================================================================

/** The name of the error the parser throws; `canonicalizePattern` turns it
 * into a refusal. */
const GRAMMAR_ERROR = "RuleGrammarError";

function fail(message: string): never {
  const error = new Error(message);
  error.name = GRAMMAR_ERROR;
  throw error;
}

/** Punctuation that may follow a backslash to stand for itself. */
const IDENTITY_ESCAPES = "^$\\.*+?()[]{}|/-";

const HEX = /^[0-9a-fA-F]+$/;

/** A recursive-descent parser over one pattern. */
function parse(source: string): Node {
  let pos = 0;

  const peek = () => source[pos];
  const more = () => pos < source.length;

  function hexEscape(length: number): number {
    const digits = source.slice(pos, pos + length);
    if (digits.length !== length || !HEX.test(digits)) {
      fail(`a \\x or \\u escape needs ${length} hex digits at ${pos}`);
    }
    pos += length;
    return parseInt(digits, 16);
  }

  /**
   * The escape after a backslash, `pos` past the backslash: a set, an
   * assertion, or a single code unit.
   */
  function escape(inClass: boolean): Node | number {
    if (!more()) fail("a pattern cannot end with a backslash");
    const c = source[pos++];
    switch (c) {
      case "d":
        return setNode(DIGIT);
      case "D":
        return setNode(DIGIT, true);
      case "w":
        return setNode(WORD);
      case "W":
        return setNode(WORD, true);
      case "s":
        return setNode(SPACE);
      case "S":
        return setNode(SPACE, true);
      case "b":
        // Inside a class \b is the backspace character
        return inClass ? 0x08 : { kind: "assert", which: "\\b" };
      case "B":
        if (inClass) fail("\\B cannot appear inside a character class");
        return { kind: "assert", which: "\\B" };
      case "t":
        return 0x09;
      case "n":
        return 0x0a;
      case "v":
        return 0x0b;
      case "f":
        return 0x0c;
      case "r":
        return 0x0d;
      case "x":
        return hexEscape(2);
      case "u":
        if (peek() === "{") fail("\\u{…} needs the u flag, which rules lack");
        return hexEscape(4);
      case "0":
        if (more() && /[0-9]/.test(peek())) {
          fail("octal escapes are not allowed");
        }
        return 0;
    }
    if (/[1-9]/.test(c)) fail("backreferences are not allowed");
    if (c === "k") fail("named backreferences are not allowed");
    if (c === "p" || c === "P") {
      fail("Unicode property escapes are not allowed");
    }
    if (IDENTITY_ESCAPES.includes(c)) return c.charCodeAt(0);
    fail(`\\${c} is not an escape the rule grammar allows`);
  }

  function classAtom(): number | Node {
    const c = source[pos++];
    return c === "\\" ? escape(true) : c.charCodeAt(0);
  }

  /** A character class, `pos` past its `[`. */
  function charClass(): Node {
    const negated = peek() === "^";
    if (negated) pos++;
    const ranges: Ranges = [];
    let empty = true;
    while (more() && peek() !== "]") {
      empty = false;
      const lo = classAtom();
      if (typeof lo !== "number") {
        if (lo.kind !== "set") {
          fail("an assertion cannot appear inside a character class");
        }
        // \D, \W, and \S inside a class stand for their complements
        const members = lo.negated ? complement(lo.ranges) : lo.ranges;
        for (const range of members) ranges.push(range);
        if (peek() === "-" && source[pos + 1] !== "]" && more()) {
          fail("a class escape cannot start a range");
        }
        continue;
      }
      if (
        peek() === "-" && source[pos + 1] !== undefined &&
        source[pos + 1] !== "]"
      ) {
        pos++;
        const hi = classAtom();
        if (typeof hi !== "number") fail("a class escape cannot end a range");
        if (hi < lo) fail("a character range is out of order");
        ranges.push([lo, hi]);
      } else {
        ranges.push([lo, lo]);
      }
    }
    if (!more()) fail("a character class is not closed");
    pos++; // ]
    if (empty) fail("an empty character class is not allowed");
    return setNode(ranges, negated);
  }

  function count(): number {
    const start = pos;
    while (more() && /[0-9]/.test(peek())) pos++;
    if (pos === start) fail(`a {…} quantifier needs a count at ${start}`);
    const n = parseInt(source.slice(start, pos), 10);
    if (n > MAX_REPEAT_COUNT) {
      fail(`a quantifier count above ${MAX_REPEAT_COUNT} is not allowed`);
    }
    return n;
  }

  /** The quantifier at `pos`, if any, as bounds. */
  function quantifier(): { min: number; max: number | null } | null {
    const c = peek();
    let bounds: { min: number; max: number | null } | null = null;
    if (c === "*") bounds = { min: 0, max: null };
    else if (c === "+") bounds = { min: 1, max: null };
    else if (c === "?") bounds = { min: 0, max: 1 };
    if (bounds) {
      pos++;
    } else if (c === "{") {
      pos++;
      const min = count();
      let max: number | null = min;
      if (peek() === ",") {
        pos++;
        max = peek() === "}" ? null : count();
      }
      if (peek() !== "}") fail("a {…} quantifier is not closed");
      pos++;
      if (max !== null && max < min) fail("a quantifier's bounds are reversed");
      bounds = { min, max };
    } else {
      return null;
    }
    // A lazy quantifier matches exactly when the greedy one does
    if (peek() === "?") pos++;
    return bounds;
  }

  function atom(): Node {
    const c = source[pos++];
    switch (c) {
      case "(": {
        if (peek() === "?") {
          if (source[pos + 1] !== ":") {
            const next = source[pos + 1];
            fail(
              next === "=" || next === "!" ||
                (next === "<" && /[=!]/.test(source[pos + 2] ?? ""))
                ? "lookaround is not allowed"
                : next === "<"
                ? "named groups are not allowed"
                : "inline modifiers are not allowed",
            );
          }
          pos += 2;
        }
        const inner = alternation();
        if (peek() !== ")") fail("a group is not closed");
        pos++;
        return inner;
      }
      case "[":
        return charClass();
      case ".":
        return setNode(LINE_TERMINATORS, true);
      case "^":
        return { kind: "assert", which: "^" };
      case "$":
        return { kind: "assert", which: "$" };
      case "\\": {
        const e = escape(false);
        return typeof e === "number" ? setNode([[e, e]]) : e;
      }
      case ")":
        return fail("a group is closed that was never opened");
      case "]":
      case "{":
      case "}":
        return fail(`a literal ${c} must be escaped`);
      case "*":
      case "+":
      case "?":
        return fail(`${c} has nothing to repeat`);
    }
    const code = c.charCodeAt(0);
    return setNode([[code, code]]);
  }

  function sequence(): Node {
    const items: Node[] = [];
    while (more() && peek() !== "|" && peek() !== ")") {
      const body = atom();
      const bounds = quantifier();
      if (bounds) {
        if (body.kind === "assert") fail("an assertion cannot be repeated");
        items.push({ kind: "repeat", body, ...bounds });
      } else {
        items.push(body);
      }
    }
    return { kind: "seq", items };
  }

  function alternation(): Node {
    const branches = [sequence()];
    while (peek() === "|") {
      pos++;
      branches.push(sequence());
    }
    return { kind: "alt", branches };
  }

  const tree = alternation();
  if (more()) fail("a group is closed that was never opened");
  return tree;
}

// =============================================================================
// CANONICAL FORM
// =============================================================================

/** Whether `node` is one positive set: a single character position. */
function isPositiveSet(
  node: Node,
): node is { kind: "set"; negated: false; ranges: Ranges } {
  return node.kind === "set" && !node.negated;
}

/**
 * `node` with its meaning-preserving rewrites applied, children first:
 * nesting flattened, single-member wrappers removed, identity repeats removed,
 * alternation branches merged, deduplicated, and sorted by their printed form.
 */
function simplify(node: Node): Node {
  switch (node.kind) {
    case "seq": {
      const items = node.items.map(simplify).flatMap((item) =>
        item.kind === "seq" ? item.items : [item]
      );
      return items.length === 1 ? items[0] : { kind: "seq", items };
    }
    case "alt": {
      const branches = node.branches.map(simplify).flatMap((branch) =>
        branch.kind === "alt" ? branch.branches : [branch]
      );
      // Branches that are each one character are one class
      const singles = branches.filter(isPositiveSet);
      const others = branches.filter((branch) => !isPositiveSet(branch));
      const merged = singles.length > 0
        ? [{
          kind: "set" as const,
          negated: false,
          ranges: normalizeRanges(singles.flatMap((s) => s.ranges)),
        }, ...others]
        : others;
      const byText = new Map<string, Node>();
      for (const branch of merged) byText.set(print(branch), branch);
      const unique = [...byText.keys()].sort().map((key) => byText.get(key)!);
      return unique.length === 1
        ? unique[0]
        : { kind: "alt", branches: unique };
    }
    case "repeat": {
      const body = simplify(node.body);
      if (node.min === 1 && node.max === 1) return body;
      // A repeated assertion (only reachable through a group, `(?:^)?`)
      // matches nothing wider than itself: optional, it always holds;
      // required, once is as many times as any. Printed bare, `^?` would not
      // compile.
      if (body.kind === "assert") {
        return node.min === 0 ? { kind: "seq", items: [] } : body;
      }
      return { ...node, body };
    }
    default:
      return node;
  }
}

/** A code unit as printed outside a class. */
function printLiteral(code: number): string {
  const c = String.fromCharCode(code);
  if ("\\^$.|?*+()[]{}/".includes(c)) return `\\${c}`;
  if (code >= 0x20 && code <= 0x7e) return c;
  return `\\u${code.toString(16).padStart(4, "0")}`;
}

/** A code unit as printed inside a class. */
function printClassChar(code: number): string {
  const c = String.fromCharCode(code);
  if ("\\]^-[".includes(c)) return `\\${c}`;
  if (code >= 0x20 && code <= 0x7e) return c;
  return `\\u${code.toString(16).padStart(4, "0")}`;
}

/**
 * A case-closed set's ranges without their uppercase ASCII letters, which the
 * `i` flag implies from the lowercase ones.
 */
function withoutUppercase(ranges: Ranges): Ranges {
  const out: Ranges = [];
  for (const [lo, hi] of ranges) {
    if (hi < 0x41 || lo > 0x5a) {
      out.push([lo, hi]);
      continue;
    }
    if (lo < 0x41) out.push([lo, 0x40]);
    if (hi > 0x5a) out.push([0x5b, hi]);
  }
  return normalizeRanges(out);
}

function printSet(negated: boolean, ranges: Ranges): string {
  if (sameRanges(ranges, CLOSED_DIGIT)) return negated ? "\\D" : "\\d";
  if (sameRanges(ranges, CLOSED_WORD)) return negated ? "\\W" : "\\w";
  if (sameRanges(ranges, CLOSED_SPACE)) return negated ? "\\S" : "\\s";
  if (negated && sameRanges(ranges, CLOSED_LINE_TERMINATORS)) return ".";
  const shown = withoutUppercase(ranges);
  if (!negated && shown.length === 1 && shown[0][0] === shown[0][1]) {
    return printLiteral(shown[0][0]);
  }
  const body = shown.map(([lo, hi]) =>
    lo === hi
      ? printClassChar(lo)
      : hi === lo + 1
      ? printClassChar(lo) + printClassChar(hi)
      : `${printClassChar(lo)}-${printClassChar(hi)}`
  ).join("");
  return `[${negated ? "^" : ""}${body}]`;
}

function printQuantifier(min: number, max: number | null): string {
  if (max === null) {
    return min === 0 ? "*" : min === 1 ? "+" : `{${min},}`;
  }
  if (min === 0 && max === 1) return "?";
  return min === max ? `{${min}}` : `{${min},${max}}`;
}

function print(node: Node): string {
  switch (node.kind) {
    case "set":
      return printSet(node.negated, node.ranges);
    case "assert":
      return node.which;
    case "seq":
      return node.items.map((item) =>
        item.kind === "alt" ? `(?:${print(item)})` : print(item)
      ).join("");
    case "alt":
      return node.branches.map(print).join("|");
    case "repeat": {
      const body = node.body;
      const atomic = body.kind === "set" || body.kind === "assert";
      const text = atomic ? print(body) : `(?:${print(body)})`;
      return text + printQuantifier(node.min, node.max);
    }
  }
}

// =============================================================================
// BACKTRACKING
// =============================================================================

/** Whether `node` holds a quantifier or an alternation anywhere inside it. */
function holdsChoice(node: Node): boolean {
  switch (node.kind) {
    case "alt":
      return node.branches.length > 1 || node.branches.some(holdsChoice);
    case "repeat":
      return node.min !== node.max || holdsChoice(node.body);
    case "seq":
      return node.items.some(holdsChoice);
    default:
      return false;
  }
}

/** The code units a set matches. */
function membersOf(node: { negated: boolean; ranges: Ranges }): Ranges {
  return node.negated ? complement(node.ranges) : node.ranges;
}

/** Whether two sorted range lists share a code unit. */
function intersects(a: Ranges, b: Ranges): boolean {
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i][1] < b[j][0]) i++;
    else if (b[j][1] < a[i][0]) j++;
    else return true;
  }
  return false;
}

/** Whether `node` can match without consuming anything. */
function nullable(node: Node): boolean {
  switch (node.kind) {
    case "set":
      return false;
    case "assert":
      return true;
    case "seq":
      return node.items.every(nullable);
    case "alt":
      return node.branches.some(nullable);
    case "repeat":
      return node.min === 0 || nullable(node.body);
  }
}

/** The code units `items`, in sequence, can consume first. */
function firstOf(items: readonly Node[]): Ranges {
  const out: Ranges = [];
  for (const item of items) {
    for (const range of firstSet(item)) out.push(range);
    if (!nullable(item)) break;
  }
  return normalizeRanges(out);
}

function firstSet(node: Node): Ranges {
  switch (node.kind) {
    case "set":
      return membersOf(node);
    case "assert":
      return [];
    case "seq":
      return firstOf(node.items);
    case "alt":
      return normalizeRanges(node.branches.flatMap(firstSet));
    case "repeat":
      return firstSet(node.body);
  }
}

/** Every code unit `node` can consume anywhere. */
function consumable(node: Node): Ranges {
  switch (node.kind) {
    case "set":
      return membersOf(node);
    case "assert":
      return [];
    case "seq":
      return normalizeRanges(node.items.flatMap(consumable));
    case "alt":
      return normalizeRanges(node.branches.flatMap(consumable));
    case "repeat":
      return consumable(node.body);
  }
}

/**
 * Whether no two of `branches` can start on the same code unit, and each must
 * consume one: at any position, at most one of them gets past its first.
 */
function exclusive(branches: readonly Node[]): boolean {
  if (branches.some(nullable)) return false;
  const firsts = branches.map(firstSet);
  return firsts.every((a, i) =>
    firsts.every((b, j) => j <= i || !intersects(a, b))
  );
}

/**
 * The paths `node` takes at a position where it cannot consume the next code
 * unit: how many die there (`fails`), and how many pass it by matching
 * nothing (`passes`).
 */
function stuckPaths(node: Node): { fails: number; passes: number } {
  switch (node.kind) {
    case "set":
      return { fails: 1, passes: 0 };
    case "assert":
      return { fails: 1, passes: 1 };
    case "seq":
      return node.items.reduce(
        (acc, item) => {
          const next = stuckPaths(item);
          return {
            fails: acc.fails + acc.passes * next.fails,
            passes: acc.passes * next.passes,
          };
        },
        { fails: 0, passes: 1 },
      );
    case "alt":
      return node.branches.map(stuckPaths).reduce(
        (acc, next) => ({
          fails: acc.fails + next.fails,
          passes: acc.passes + next.passes,
        }),
        { fails: 0, passes: 0 },
      );
    case "repeat": {
      // The body holds no choice when it may repeat (else it is refused), so
      // one attempt at a further iteration, or none
      const body = stuckPaths(node.body);
      return node.min === 0
        ? { fails: body.fails, passes: 1 + body.passes }
        : body;
    }
  }
}

/**
 * The attempts `items` make at a position where none of them can consume the
 * next code unit, each dying there or passing them all by matching nothing.
 */
function leadOf(items: readonly Node[]): number {
  const { fails, passes } = stuckPaths({ kind: "seq", items: [...items] });
  return fails + passes;
}

/**
 * An upper bound on how many ways `node` can match one span of `span` code
 * units, with an unbounded quantifier counted as `span` ways: a sequence
 * multiplies its items' ways, an alternation adds its branches', and a
 * quantifier adds its body's ways at each count it allows. `tail` says
 * nothing follows `node` in the pattern.
 *
 * One exception makes ordinary rules fit: an unbounded quantifier of one
 * character set whose set shares no code unit with what must come next
 * (`\s*\$`, `\d+\s*items`), or that ends the pattern, behaves
 * possessively. Giving back a character can never let what follows match,
 * since what follows would have to start on a character of the set, so it
 * scans its run once and what follows is tried in full once: `span` attempts
 * of what follows's lead, plus what follows, rather than `span` times what
 * follows.
 *
 * Likewise, an alternation in a sequence whose branches each must consume and
 * no two can start on the same character (`(?:invoice|receipt)`) sends at
 * most one branch on to what follows, so it costs its dearest branch times
 * what follows, plus one attempt at each other branch, rather than the sum.
 *
 * Throws a grammar error on a group that holds a choice repeated more than
 * once (`(a|aa)+`, `(a+)+`, `(?:ab?){3}`), which backtracks exponentially, as
 * `isRegexSafe` in the self-improving classifier refuses it.
 */
function backtrackCost(node: Node, span: number, tail: boolean): number {
  switch (node.kind) {
    case "set":
    case "assert":
      return 1;
    case "seq": {
      let rest = 1;
      for (let i = node.items.length - 1; i >= 0; i--) {
        const item = node.items[i];
        const after = node.items.slice(i + 1);
        const last = after.length === 0;
        if (
          item.kind === "repeat" && item.max === null &&
          item.body.kind === "set" &&
          (last ? tail : !after.every(nullable) &&
            !intersects(membersOf(item.body), firstOf(after)))
        ) {
          rest = span * leadOf(after) + rest;
        } else if (item.kind === "alt" && exclusive(item.branches)) {
          // At most one branch gets past its first code unit, so only one
          // goes on to what follows; the others die at once
          const ways = item.branches.reduce(
            (most, branch) =>
              Math.max(most, backtrackCost(branch, span, tail && last)),
            0,
          );
          const dying = item.branches.reduce(
            (sum, branch) => sum + leadOf([branch]),
            0,
          );
          rest = ways * rest + dying;
        } else {
          rest *= backtrackCost(item, span, tail && last);
        }
      }
      return rest;
    }
    case "alt":
      return node.branches.reduce(
        (ways, branch) => ways + backtrackCost(branch, span, tail),
        0,
      );
    case "repeat": {
      if (node.max !== 1 && holdsChoice(node.body)) {
        fail(
          "a repeated group holding a quantifier or an alternation could backtrack exponentially",
        );
      }
      if (node.max === null) return span;
      // With no choice inside, the body matches one way at each count
      const body = backtrackCost(node.body, span, false);
      return body === 1 ? node.max - node.min + 1 : 1 + body;
    }
  }
}

/**
 * Whether `alternative` is gated: it starts, after any assertions, with one
 * character set that nothing after it can consume (`order\s*#?\s*\d+`
 * starts with `o`). A start position where it does more than fail at once
 * holds a character of that set, and what it consumes from there stops
 * before the next such character, so the spans its starts scan do not
 * overlap: together they cost about what one start over the whole text
 * would, not that times the text's length.
 */
function gated(alternative: Node): boolean {
  const items = alternative.kind === "seq" ? alternative.items : [alternative];
  const first = items.findIndex((item) => item.kind !== "assert");
  const gate = items[first];
  if (gate === undefined || gate.kind !== "set") return false;
  const rest = normalizeRanges(items.slice(first + 1).flatMap(consumable));
  return !intersects(membersOf(gate), rest);
}

/**
 * The pattern's backtracking cost in the budget's units, ways per start
 * position: the sum over its top-level alternatives, since `RegExp.test`
 * tries every one at every position. A gated alternative's starts scan
 * disjoint spans, so its cost is its ways over the whole tested length
 * shared among the positions, plus one way's worth at each.
 */
function patternCostOf(tree: Node): number {
  const alternatives = tree.kind === "alt" ? tree.branches : [tree];
  return alternatives.reduce((sum, alternative) => {
    const whole = backtrackCost(alternative, MAX_TESTED_LENGTH, true);
    return sum +
      (gated(alternative)
        ? whole / MAX_TESTED_LENGTH + backtrackCost(alternative, 1, true)
        : whole);
  }, 0);
}

/**
 * Refuses `tree` when it could backtrack past the budget. `RegExp.test` tries
 * every top-level alternative at every start position, so the budget is for
 * their sum, not for each: sixteen alternatives each just under it took a
 * quarter of a second on a thousand spaces.
 */
function checkBacktracking(tree: Node): void {
  if (patternCostOf(tree) > MAX_BACKTRACK_COST) {
    fail(
      "the pattern could backtrack too long: it may hold one unbounded " +
        "quantifier (*, + or {n,}), with few other choices beside it, " +
        "across all its alternatives",
    );
  }
}

/**
 * `pattern`'s backtracking cost, as the budget counts it, or `Infinity` for a
 * pattern outside the grammar.
 */
export function patternCost(pattern: string): number {
  try {
    return patternCostOf(simplify(parse(pattern)));
  } catch (e) {
    if (e instanceof Error && e.name === GRAMMAR_ERROR) return Infinity;
    throw e;
  }
}

/**
 * Why a rule set as a whole could backtrack too long, or null when it fits.
 * Every rule of a set runs on every item, so their costs add: this holds a
 * set to `MAX_SET_BACKTRACK_COST`, which a few rules at the per-pattern
 * budget fill and ordinary rules (literals, one `.*` each) never do.
 */
export function ruleSetCostRefusal(
  rules: ReadonlyArray<Pick<CanonicalRule, "pattern">>,
): string | null {
  const total = rules.reduce((sum, rule) => sum + patternCost(rule.pattern), 0);
  return total > MAX_SET_BACKTRACK_COST
    ? "the rule set could backtrack too long: together its rules hold too " +
      "many unbounded quantifiers or choices"
    : null;
}

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * The canonical form of `pattern`, or a refusal saying why it is outside the
 * grammar. Canonicalizing a canonical pattern returns it unchanged.
 */
export function canonicalizePattern(
  pattern: string,
): { ok: true; pattern: string } | { ok: false; reason: string } {
  if (typeof pattern !== "string" || pattern.length === 0) {
    return { ok: false, reason: "a pattern cannot be empty" };
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return {
      ok: false,
      reason: `a pattern cannot be longer than ${MAX_PATTERN_LENGTH}`,
    };
  }
  if (/^\/.*\/[a-z]*$/s.test(pattern)) {
    return { ok: false, reason: "write the pattern without slashes or flags" };
  }
  try {
    const tree = simplify(parse(pattern));
    checkBacktracking(tree);
    const canonical = print(tree);
    if (canonical === "") {
      return { ok: false, reason: "a pattern must match something" };
    }
    // What is accepted must run: a canonical form that does not compile is a
    // canonicalizer bug, refused here rather than dropped where rules run.
    try {
      new RegExp(canonical, "i");
    } catch {
      return {
        ok: false,
        reason: `the canonical form /${canonical}/ does not compile`,
      };
    }
    return { ok: true, pattern: canonical };
  } catch (e) {
    if (e instanceof Error && e.name === GRAMMAR_ERROR) {
      return { ok: false, reason: e.message };
    }
    throw e;
  }
}

/**
 * A stable 64-bit hash of `text`, as 16 hex digits: two FNV-1a passes with
 * different offsets. It identifies, it does not protect; the pool's
 * unguessable per-rule offset needs a keyed hash of its own.
 */
export function stableHash(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x01000193) >>> 0;
    b = (b ^ (b >>> 15)) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

/**
 * `draft` checked against the grammar and put in canonical form, or why it is
 * refused. The value is untrusted (model output), so no field is assumed to
 * have its declared type.
 */
export function checkRule(draft: unknown): RuleCheck {
  if (typeof draft !== "object" || draft === null) {
    return { ok: false, reason: "a rule must be an object" };
  }
  const field = "field" in draft ? draft.field : undefined;
  const pattern = "pattern" in draft ? draft.pattern : undefined;
  const predicts = "predicts" in draft ? draft.predicts : undefined;
  const flags = "flags" in draft ? draft.flags : undefined;
  if (typeof field !== "string" || field.trim() === "") {
    return { ok: false, reason: "a rule needs a field" };
  }
  if (field.trim().length > MAX_FIELD_LENGTH) {
    return { ok: false, reason: "a rule's field name is too long" };
  }
  if (typeof predicts !== "boolean") {
    return { ok: false, reason: "a rule must say which label it predicts" };
  }
  if (flags !== undefined && flags !== "" && flags !== "i") {
    return {
      ok: false,
      reason: "only the case-insensitive flag is allowed",
    };
  }
  if (typeof pattern !== "string") {
    return { ok: false, reason: "a rule needs a pattern" };
  }
  const canonical = canonicalizePattern(pattern);
  if (!canonical.ok) return canonical;
  const trimmedField = field.trim();
  return {
    ok: true,
    rule: {
      field: trimmedField,
      pattern: canonical.pattern,
      predicts,
      key: stableHash(
        `${trimmedField}\u0000${
          predicts ? "1" : "0"
        }\u0000${canonical.pattern}`,
      ),
    },
  };
}

/** A rule as one line of text: `field: /pattern/i → YES`. */
export function describeRule(
  rule: Pick<CanonicalRule, "field" | "pattern" | "predicts">,
): string {
  return `${rule.field}: /${rule.pattern}/i → ${rule.predicts ? "YES" : "NO"}`;
}
