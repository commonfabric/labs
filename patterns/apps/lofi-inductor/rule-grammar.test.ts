import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  canonicalizePattern,
  checkRule,
  describeRule,
  MAX_PATTERN_LENGTH,
  stableHash,
} from "./rule-grammar.ts";

/** The canonical form of `pattern`, failing the test when it is refused. */
function canon(pattern: string): string {
  const result = canonicalizePattern(pattern);
  if (!result.ok) throw new Error(`${pattern} was refused: ${result.reason}`);
  return result.pattern;
}

/** Why `pattern` is refused, failing the test when it is accepted. */
function refusal(pattern: string): string {
  const result = canonicalizePattern(pattern);
  if (result.ok) {
    throw new Error(`${pattern} was accepted as ${result.pattern}`);
  }
  return result.reason;
}

/** Strings that tell apart the patterns below. */
const PROBES = [
  "",
  "a",
  "A",
  "ab",
  "AB",
  "ba",
  "abc",
  "aaa",
  "invoice",
  "INVOICE #123",
  "Your Invoice is due",
  "payment due",
  "statement",
  "re: hello",
  "hello world",
  "x-y",
  "a.b",
  "a b",
  "a\tb",
  "a\nb",
  "123",
  "1a",
  "_",
  "-",
  "[]",
  "\\",
  "é",
  "É",
  "word.",
  "no reply",
  "noreply@example.org",
  "unsubscribe here",
  "Total: $42.00",
];

/** Spellings that must each canonicalize to one form. */
const SAME: string[][] = [
  ["invoice", "INVOICE", "Invoice", "[i]nvoice", "(?:invoice)", "(invoice)"],
  ["a|b", "b|a", "[ab]", "[ba]", "(?:a|b)", "[aAbB]", "(a)|(b)", "[a-b]"],
  ["invoice|statement", "statement|invoice", "(?:statement)|invoice"],
  ["a+", "a{1,}", "a+?", "(?:a)+", "(a)+", "a{1,}?"],
  ["a*", "a{0,}", "a*?"],
  ["a?", "a{0,1}", "a??"],
  ["ab", "a{1}b", "a{1,1}b", "(?:a)(?:b)", "\\x61b", "\\u0061b"],
  ["\\.", "[.]", "\\x2e"],
  ["\\d", "[0-9]", "[\\d]", "[0123456789]"],
  ["\\w", "[a-z0-9_]", "[A-Za-z0-9_]", "[\\w]"],
  ["\\D", "[^0-9]", "[^\\d]"],
  ["\\W", "[^\\w]"],
  ["\\S", "[^\\s]"],
  [".", "[^\\n\\r\\u2028\\u2029]"],
  ["[a-z]", "[A-Z]", "[a-zA-Z]"],
  ["x-y", "x\\-y", "x[-]y"],
  ["pay(?:ment)? due", "pay(ment)? due", "pay(?:ment)?? due"],
  ["a|a", "a"],
  ["(?:ab|cd)|ef", "ef|cd|ab", "ab|(?:cd|ef)"],
];

/** Pairs that mean different things and must stay apart. */
const DIFFERENT: Array<[string, string]> = [
  ["invoice", "invoices"],
  ["^invoice", "invoice"],
  ["invoice$", "invoice"],
  ["\\binvoice", "invoice"],
  ["a+", "a*"],
  ["ab", "ba"],
  ["a|bc", "ab|c"],
  ["[a-z]", "\\w"],
  ["\\d", "\\D"],
  ["[^a]", "[a]"],
  [".", "[\\s\\S]"],
  ["a{2}", "a{2,}"],
  ["(?:ab)+", "ab+"],
  ["x\\.y", "x.y"],
  ["[A-z]", "[a-z]"],
];

const OUT_OF_GRAMMAR: Array<[string, RegExp]> = [
  ["(a)\\1", /backreference/],
  ["(?<word>a)\\k<word>", /named groups/],
  ["\\k<word>", /named backreference/],
  ["(?<word>a)", /named groups/],
  ["a(?=b)", /lookaround/],
  ["a(?!b)", /lookaround/],
  ["(?<=a)b", /lookaround/],
  ["(?<!a)b", /lookaround/],
  ["(?i)a", /inline modifiers/],
  ["\\p{L}", /property/],
  ["\\u{61}", /u flag/],
  ["\\a", /not an escape/],
  ["\\012", /octal/],
  ["[]", /empty character class/],
  ["[abc", /not closed/],
  ["(ab", /not closed/],
  ["ab)", /never opened/],
  ["a{2,1}", /reversed/],
  ["a{1000}", /above/],
  ["a{", /needs a count/],
  ["*a", /nothing to repeat/],
  ["^*", /cannot be repeated/],
  ["a]", /escaped/],
  ["[z-a]", /out of order/],
  ["[\\d-z]", /cannot start a range/],
  ["/invoice/i", /without slashes/],
  ["", /empty/],
  ["()", /match something/],
  ["a".repeat(MAX_PATTERN_LENGTH + 1), /longer/],
];

describe("canonicalizePattern", () => {
  it("gives every spelling of one rule the same form", () => {
    for (const group of SAME) {
      const forms = group.map(canon);
      expect({ group, forms: new Set(forms).size }).toEqual({
        group,
        forms: 1,
      });
    }
  });

  it("keeps patterns that mean different things apart", () => {
    for (const [a, b] of DIFFERENT) {
      expect({ a, b, same: canon(a) === canon(b) }).toEqual({
        a,
        b,
        same: false,
      });
    }
  });

  it("writes the shortest, lowercase spelling", () => {
    expect(canon("INVOICE|Statement")).toBe("invoice|statement");
    expect(canon("(a|b)+")).toBe("[ab]+");
    expect(canon("[A-Za-z0-9_]+")).toBe("\\w+");
    expect(canon("(ab|cd)+")).toBe("(?:ab|cd)+");
    expect(canon("pay(ment)? due")).toBe("pay(?:ment)? due");
    expect(canon("a{0,}b{1,}c{0,1}d{3,}e{2,4}")).toBe("a*b+c?d{3,}e{2,4}");
    expect(canon("x/y")).toBe("x\\/y");
    expect(canon("\\t")).toBe("\\u0009");
  });

  it("is idempotent", () => {
    for (const pattern of [...SAME.flat(), ...DIFFERENT.flat()]) {
      const once = canon(pattern);
      expect({ pattern, twice: canon(once) }).toEqual({ pattern, twice: once });
    }
  });

  it("never changes what a pattern matches", () => {
    for (const pattern of [...SAME.flat(), ...DIFFERENT.flat()]) {
      const original = new RegExp(pattern, "i");
      const canonical = new RegExp(canon(pattern), "i");
      for (const probe of PROBES) {
        expect({ pattern, probe, matches: canonical.test(probe) }).toEqual({
          pattern,
          probe,
          matches: original.test(probe),
        });
      }
    }
  });

  it("never changes what a generated pattern matches", () => {
    // A seeded generator over the grammar, so a failure reproduces
    let seed = 1;
    const next = (n: number) => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return (seed >>> 8) % n;
    };
    const atoms = [
      "a",
      "B",
      "c",
      ".",
      "\\d",
      "\\w",
      "\\s",
      "[a-c]",
      "[^b]",
      "\\.",
      "-",
      " ",
      "\\W",
      "[A-B1]",
    ];
    const quantifiers = ["", "", "", "*", "+", "?", "{2}", "{1,2}", "*?"];
    const anchors = ["", "", "", "^", "\\b"];
    const gen = (depth: number): string => {
      const parts = Array.from({ length: 1 + next(3) }, () => {
        if (depth > 0 && next(4) === 0) {
          const inner = Array.from(
            { length: 1 + next(3) },
            () => gen(depth - 1),
          )
            .join("|");
          return `(${inner})${quantifiers[next(quantifiers.length)]}`;
        }
        return atoms[next(atoms.length)] +
          quantifiers[next(quantifiers.length)];
      });
      return anchors[next(anchors.length)] + parts.join("");
    };
    const alphabet = ["a", "A", "b", "B", "c", "1", " ", ".", "-", "\n", "_"];
    const probes = Array.from(
      { length: 60 },
      () =>
        Array.from({ length: next(7) }, () => alphabet[next(alphabet.length)])
          .join(""),
    );
    let checked = 0;
    for (let i = 0; i < 400; i++) {
      const pattern = gen(2);
      const result = canonicalizePattern(pattern);
      if (!result.ok) continue;
      checked++;
      const original = new RegExp(pattern, "i");
      const canonical = new RegExp(result.pattern, "i");
      for (const probe of probes) {
        if (original.test(probe) !== canonical.test(probe)) {
          throw new Error(
            `${pattern} → ${result.pattern} disagrees on ${
              JSON.stringify(probe)
            }`,
          );
        }
      }
      expect(canon(result.pattern)).toBe(result.pattern);
    }
    // The generator mostly stays inside the grammar
    expect(checked).toBeGreaterThan(300);
  });

  it("refuses what the grammar excludes, saying why", () => {
    for (const [pattern, why] of OUT_OF_GRAMMAR) {
      expect({ pattern, reason: refusal(pattern) }).toEqual({
        pattern,
        reason: expect.stringMatching(why),
      });
    }
  });

  it("refuses a value that is not a string", () => {
    // Model output reaches this untyped
    const untyped: unknown = 42;
    expect(canonicalizePattern(untyped as string).ok).toBe(false);
  });
});

describe("checkRule", () => {
  it("puts a rule in canonical form with a key", () => {
    const check = checkRule({
      field: " subject ",
      pattern: "Invoice|Statement",
      predicts: true,
    });
    expect(check).toEqual({
      ok: true,
      rule: {
        field: "subject",
        pattern: "invoice|statement",
        predicts: true,
        key: expect.stringMatching(/^[0-9a-f]{16}$/),
      },
    });
  });

  it("gives equal rules equal keys and different rules different keys", () => {
    const key = (draft: unknown) => {
      const check = checkRule(draft);
      if (!check.ok) throw new Error(check.reason);
      return check.rule.key;
    };
    const base = { field: "subject", pattern: "invoice|bill", predicts: true };
    expect(key({ ...base, pattern: "BILL|(invoice)", flags: "i" })).toBe(
      key(base),
    );
    expect(key({ ...base, predicts: false })).not.toBe(key(base));
    expect(key({ ...base, field: "body" })).not.toBe(key(base));
    expect(key({ ...base, pattern: "invoice" })).not.toBe(key(base));
  });

  it("refuses malformed rules and other flags", () => {
    const refused = (draft: unknown) => checkRule(draft).ok === false;
    expect(refused(null)).toBe(true);
    expect(refused("invoice")).toBe(true);
    expect(refused({ field: "", pattern: "a", predicts: true })).toBe(true);
    expect(refused({ field: "s", pattern: "a", predicts: "yes" })).toBe(true);
    expect(refused({ field: "s", pattern: 3, predicts: true })).toBe(true);
    expect(refused({ field: "s", pattern: "a", predicts: true, flags: "g" }))
      .toBe(true);
    expect(refused({ field: "s", pattern: "a", predicts: true, flags: "im" }))
      .toBe(true);
    expect(refused({ field: "s", pattern: "(a)\\1", predicts: true })).toBe(
      true,
    );
  });
});

describe("stableHash", () => {
  it("is deterministic and spreads nearby inputs", () => {
    expect(stableHash("a")).toBe(stableHash("a"));
    expect(stableHash("a")).not.toBe(stableHash("b"));
    expect(stableHash("ab")).not.toBe(stableHash("ba"));
    expect(stableHash("")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("describeRule", () => {
  it("shows field, pattern, and label", () => {
    expect(
      describeRule({ field: "subject", pattern: "invoice", predicts: false }),
    ).toBe("subject: /invoice/i → NO");
  });
});
