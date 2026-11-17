import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { checkRule } from "../lofi-inductor/rule-grammar.ts";
import {
  type CanonicalRule,
  type Contribution,
  hmacSha256,
  MIN_THRESHOLD,
  mintSecret,
  releaseFrom,
  ruleIdentity,
  sha256,
  supportOf,
  thresholdFor,
  thresholdOffset,
} from "./consensus.ts";

const hex = (bytes: number[]) =>
  bytes.map((b) => b.toString(16).padStart(2, "0")).join("");

const utf8 = (text: string) => [...new TextEncoder().encode(text)];

function rule(field: string, pattern: string, predicts = true): CanonicalRule {
  const checked = checkRule({ field, pattern, predicts });
  if (!checked.ok) throw new Error(checked.reason);
  return checked.rule;
}

const INVOICE = rule("subject", "invoice");
const BILL = rule("subject", "bill");
const LUNCH = rule("subject", "lunch", false);

/** `n` pseudonyms that each contribute `rules`. */
const many = (prefix: string, n: number, rules: CanonicalRule[]) =>
  Array.from({ length: n }, (_, i): Contribution => ({
    pseudonym: `${prefix}-${i}`,
    rules,
  }));

const SECRET = "0123456789abcdef0123456789abcdef";
const FIXED = { thresholdCenter: 3, jitter: 0 };

describe("keyed hash", () => {
  it("matches the SHA-256 and HMAC-SHA-256 test vectors", () => {
    expect(hex(sha256(utf8("abc")))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(hex(sha256([]))).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    // 56 bytes: the padding spills into a second block.
    expect(
      hex(sha256(utf8(
        "abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq",
      ))),
    ).toBe(
      "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
    );
    // RFC 4231, test case 2.
    expect(hex(hmacSha256("Jefe", "what do ya want for nothing?"))).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });
});

describe("thresholdOffset", () => {
  it("is deterministic for one secret and rule", () => {
    const id = ruleIdentity(INVOICE);
    expect(thresholdOffset(SECRET, id, 5)).toBe(thresholdOffset(SECRET, id, 5));
  });

  it("stays in [-k, +k] and reaches both ends", () => {
    const seen = new Set<number>();
    for (let i = 0; i < 2000; i++) {
      const offset = thresholdOffset(SECRET, `rule-${i}`, 5);
      expect(offset).toBeGreaterThanOrEqual(-5);
      expect(offset).toBeLessThanOrEqual(5);
      seen.add(offset);
    }
    expect([...seen].sort((a, b) => a - b)).toEqual([
      -5,
      -4,
      -3,
      -2,
      -1,
      0,
      1,
      2,
      3,
      4,
      5,
    ]);
  });

  it("depends on the secret, so it cannot be computed without it", () => {
    const differing = Array.from({ length: 50 }, (_, i) => `rule-${i}`)
      .filter((id) =>
        thresholdOffset(SECRET, id, 5) !== thresholdOffset("other", id, 5)
      );
    expect(differing.length).toBeGreaterThan(30);
  });

  it("is zero with no jitter, and refuses a bad jitter or no secret", () => {
    expect(thresholdOffset(SECRET, "x", 0)).toBe(0);
    expect(() => thresholdOffset(SECRET, "x", -1)).toThrow();
    expect(() => thresholdOffset(SECRET, "x", 1.5)).toThrow();
    expect(() => thresholdOffset("", "x", 5)).toThrow();
  });
});

describe("thresholdFor", () => {
  it("is the centre plus the offset", () => {
    const id = ruleIdentity(BILL);
    expect(thresholdFor(SECRET, id, { thresholdCenter: 15, jitter: 5 })).toBe(
      15 + thresholdOffset(SECRET, id, 5),
    );
  });

  it("never falls under the floor of two", () => {
    for (let i = 0; i < 200; i++) {
      expect(
        thresholdFor(SECRET, `rule-${i}`, { thresholdCenter: 1, jitter: 5 }),
      ).toBeGreaterThanOrEqual(MIN_THRESHOLD);
    }
    expect(thresholdFor(SECRET, "x", { thresholdCenter: 1, jitter: 0 }))
      .toBe(2);
  });

  it("refuses a centre that is not a whole number of at least one", () => {
    expect(() => thresholdFor(SECRET, "x", { thresholdCenter: 0, jitter: 0 }))
      .toThrow();
    expect(() =>
      thresholdFor(SECRET, "x", { thresholdCenter: Number.NaN, jitter: 0 })
    ).toThrow();
  });
});

describe("supportOf", () => {
  it("counts distinct pseudonyms, not contributions or repeats", () => {
    const support = supportOf([
      { pseudonym: "a", rules: [INVOICE, INVOICE] },
      { pseudonym: "b", rules: [INVOICE] },
    ]);
    expect(support.get(ruleIdentity(INVOICE))?.pseudonyms.size).toBe(2);
  });

  it("keeps only a pseudonym's latest set: a resubmission replaces", () => {
    const support = supportOf([
      { pseudonym: "a", rules: [INVOICE, BILL] },
      { pseudonym: "b", rules: [BILL] },
      { pseudonym: "a", rules: [LUNCH] },
    ]);
    expect(support.get(ruleIdentity(INVOICE))).toBeUndefined();
    expect(support.get(ruleIdentity(BILL))?.pseudonyms.size).toBe(1);
    expect(support.get(ruleIdentity(LUNCH))?.pseudonyms.size).toBe(1);
  });

  it("counts spellings of one rule together, and labels apart", () => {
    const support = supportOf([
      { pseudonym: "a", rules: [rule("subject", "INVOICE")] },
      { pseudonym: "b", rules: [rule("subject", "[iI]nvoice")] },
      { pseudonym: "c", rules: [rule("subject", "invoice", false)] },
    ]);
    expect(support.get(ruleIdentity(INVOICE))?.pseudonyms.size).toBe(2);
    expect(support.get(ruleIdentity(rule("subject", "invoice", false))))
      .toBeDefined();
  });

  it("counts a stored rule by its text, not a key it claims", () => {
    const forged = { ...BILL, key: INVOICE.key };
    const support = supportOf([
      { pseudonym: "a", rules: [INVOICE] },
      { pseudonym: "b", rules: [forged] },
    ]);
    expect(support.get(ruleIdentity(INVOICE))?.pseudonyms.size).toBe(1);
    expect(support.get(ruleIdentity(BILL))?.pseudonyms.size).toBe(1);
  });

  it("skips entries with no pseudonym and rules out of grammar", () => {
    const support = supportOf([
      { pseudonym: "", rules: [INVOICE] },
      undefined,
      { pseudonym: "a", rules: [{ ...INVOICE, pattern: "(a)\\1" }] },
    ]);
    expect(support.size).toBe(0);
  });
});

describe("releaseFrom", () => {
  it("releases a rule at its threshold with its count", () => {
    expect(releaseFrom(many("p", 3, [INVOICE]), SECRET, FIXED)).toEqual([
      { ...INVOICE, count: 3 },
    ]);
  });

  it("emits nothing at all for a rule below its threshold", () => {
    const contributions = [
      ...many("p", 3, [INVOICE]),
      ...many("q", 2, [BILL]),
    ];
    const released = releaseFrom(contributions, SECRET, FIXED);
    expect(released).toEqual([{ ...INVOICE, count: 3 }]);
    expect(JSON.stringify(released)).not.toContain("bill");
    expect(releaseFrom(many("q", 2, [BILL]), SECRET, FIXED)).toEqual([]);
  });

  it("does not count one pseudonym's repeated contributions", () => {
    const repeated = Array.from(
      { length: 5 },
      (): Contribution => ({ pseudonym: "same", rules: [INVOICE] }),
    );
    expect(releaseFrom(repeated, SECRET, FIXED)).toEqual([]);
  });

  it("withdraws a rule whose holder resubmits without it", () => {
    const before = many("p", 3, [INVOICE]);
    const after = [...before, { pseudonym: "p-0", rules: [BILL] }];
    expect(releaseFrom(before, SECRET, FIXED)).toHaveLength(1);
    expect(releaseFrom(after, SECRET, FIXED)).toEqual([]);
  });

  it("releases each rule only at its own jittered threshold", () => {
    const config = { thresholdCenter: 6, jitter: 3 };
    const rules = Array.from({ length: 40 }, (_, i) => rule("subject", `w${i}`));
    for (let n = 1; n <= 10; n++) {
      const released = releaseFrom(many("p", n, rules), SECRET, config);
      const expected = rules.filter((r) =>
        n >= thresholdFor(SECRET, ruleIdentity(r), config)
      );
      expect(released.map((r) => r.key).sort()).toEqual(
        expected.map((r) => r.key).sort(),
      );
    }
  });

  it("releases nothing without a secret", () => {
    expect(releaseFrom(many("p", 30, [INVOICE]), "", FIXED)).toEqual([]);
    expect(releaseFrom(many("p", 30, [INVOICE]), undefined, FIXED)).toEqual(
      [],
    );
  });

  it("orders the most-held rule first", () => {
    const contributions = [
      ...many("p", 4, [BILL, INVOICE]),
      ...many("q", 2, [INVOICE]),
    ];
    expect(releaseFrom(contributions, SECRET, FIXED).map((r) => r.count))
      .toEqual([6, 4]);
  });
});

describe("mintSecret", () => {
  it("is 32 hex digits drawn from the random source", () => {
    const secret = mintSecret(Math.random);
    expect(secret).toMatch(/^[0-9a-f]{32}$/);
    expect(mintSecret(Math.random)).not.toBe(secret);
    expect(mintSecret(() => 0)).toBe("0".repeat(32));
  });
});
