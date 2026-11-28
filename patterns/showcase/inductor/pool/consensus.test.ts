import { expect } from "@std/expect";

import { checkRule, MAX_RULES } from "../shared/rule-grammar.ts";
import {
  agreedSeal,
  type CanonicalRule,
  canonicalSet,
  type Contribution,
  hmacSha256,
  isSealed,
  MIN_SEALED_THRESHOLD,
  MIN_THRESHOLD,
  mintSeal,
  mintSecret,
  releaseFrom,
  releaseSealed,
  ruleIdentity,
  sha256,
  supportOf,
  tallyAll,
  thresholdFor,
  thresholdOffset,
} from "./consensus.ts";
import { describe, it } from "@commonfabric/test-support/test";

const hex = (bytes: number[]) =>
  bytes.map((b) => b.toString(16).padStart(2, "0")).join("");

const utf8 = (text: string) => [...new TextEncoder().encode(text)];

/** HMAC-SHA-256 of `message` under `key` from WebCrypto, as a reference. */
async function webCryptoHmac(key: string, message: string): Promise<number[]> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(message),
  );
  return [...new Uint8Array(signature)];
}

function rule(field: string, pattern: string, predicts = true): CanonicalRule {
  const checked = checkRule({ field, pattern, predicts });
  if (!checked.ok) throw new Error(checked.reason);
  return checked.rule;
}

const INVOICE = rule("subject", "invoice");
const BILL = rule("subject", "bill");
const LUNCH = rule("subject", "lunch", false);

/** `n` contributors, each under their own pseudonym, contributing `rules`. */
const many = (prefix: string, n: number, rules: CanonicalRule[]) =>
  Array.from({ length: n }, (_, i): Contribution => ({
    contributor: `${prefix}-${i}`,
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

  it("encodes a key and message beyond ASCII as UTF-8", async () => {
    // One character of each UTF-8 length, then an unpaired surrogate, which
    // both this hash and TextEncoder read as U+FFFD.
    const key = "clé €";
    const message = "naïve ☃ 😀 \ud800 end";
    expect(hmacSha256(key, message)).toEqual(await webCryptoHmac(key, message));
    expect(hmacSha256(key, "\ufffd")).toEqual(hmacSha256(key, "\udfff"));
    expect(hmacSha256(key, "é")).not.toEqual(hmacSha256(key, "e"));
    expect(hmacSha256("☃", message)).not.toEqual(hmacSha256("😀", message));
  });

  it("hashes a key longer than the block before using it", async () => {
    const long = "k".repeat(65);
    expect(hmacSha256(long, "message")).toEqual(
      await webCryptoHmac(long, "message"),
    );
    expect(hmacSha256(long, "message")).not.toEqual(
      hmacSha256(long.slice(0, 64), "message"),
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
  it("counts distinct contributors, not contributions or repeats", () => {
    const support = supportOf([
      { contributor: "a", pseudonym: "a", rules: [INVOICE, INVOICE] },
      { contributor: "b", pseudonym: "b", rules: [INVOICE] },
    ]);
    expect(support.get(ruleIdentity(INVOICE))?.contributors.size).toBe(2);
  });

  it("counts one contributor once across pseudonyms and old entries", () => {
    const support = supportOf([
      { contributor: "mallory", pseudonym: "m-1", rules: [INVOICE] },
      { contributor: "mallory", pseudonym: "m-2", rules: [INVOICE] },
      { contributor: "mallory", pseudonym: "m-3", rules: [INVOICE] },
      { contributor: "alice", pseudonym: "a", rules: [INVOICE] },
    ]);
    expect(support.get(ruleIdentity(INVOICE))?.contributors.size).toBe(2);
  });

  it("keeps only a contributor's latest set: a resubmission replaces", () => {
    const support = supportOf([
      { contributor: "a", pseudonym: "a", rules: [INVOICE, BILL] },
      { contributor: "b", pseudonym: "b", rules: [BILL] },
      { contributor: "a", pseudonym: "a", rules: [LUNCH] },
    ]);
    expect(support.get(ruleIdentity(INVOICE))).toBeUndefined();
    expect(support.get(ruleIdentity(BILL))?.contributors.size).toBe(1);
    expect(support.get(ruleIdentity(LUNCH))?.contributors.size).toBe(1);
  });

  it("counts spellings of one rule together, and labels apart", () => {
    const support = supportOf([
      { contributor: "a", pseudonym: "a", rules: [rule("subject", "INVOICE")] },
      {
        contributor: "b",
        pseudonym: "b",
        rules: [rule("subject", "[iI]nvoice")],
      },
      {
        contributor: "c",
        pseudonym: "c",
        rules: [rule("subject", "invoice", false)],
      },
    ]);
    expect(support.get(ruleIdentity(INVOICE))?.contributors.size).toBe(2);
    expect(support.get(ruleIdentity(rule("subject", "invoice", false))))
      .toBeDefined();
  });

  it("counts a stored rule by its text, not a key it claims", () => {
    const forged = { ...BILL, key: INVOICE.key };
    const support = supportOf([
      { contributor: "a", pseudonym: "a", rules: [INVOICE] },
      { contributor: "b", pseudonym: "b", rules: [forged] },
    ]);
    expect(support.get(ruleIdentity(INVOICE))?.contributors.size).toBe(1);
    expect(support.get(ruleIdentity(BILL))?.contributors.size).toBe(1);
  });

  it("skips entries with no contributor and rules out of grammar", () => {
    const support = supportOf([
      { contributor: "", pseudonym: "", rules: [INVOICE] },
      undefined,
      {
        contributor: "a",
        pseudonym: "a",
        rules: [{ ...INVOICE, pattern: "(a)\\1" }],
      },
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
      (): Contribution => ({
        contributor: "same",
        pseudonym: "same",
        rules: [INVOICE],
      }),
    );
    expect(releaseFrom(repeated, SECRET, FIXED)).toEqual([]);
  });

  it("withdraws a rule whose holder resubmits without it", () => {
    const before = many("p", 3, [INVOICE]);
    const after = [...before, {
      contributor: "p-0",
      pseudonym: "p-0",
      rules: [BILL],
    }];
    expect(releaseFrom(before, SECRET, FIXED)).toHaveLength(1);
    expect(releaseFrom(after, SECRET, FIXED)).toEqual([]);
  });

  it("releases each rule only at its own jittered threshold", () => {
    const config = { thresholdCenter: 6, jitter: 3 };
    const rules = Array.from(
      { length: 40 },
      (_, i) => rule("subject", `w${i}`),
    );
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

describe("canonicalSet", () => {
  it("canonicalizes and keeps a rule given twice once", () => {
    const set = canonicalSet([
      { field: "subject", pattern: "INVOICE", predicts: true },
      { field: "subject", pattern: "[iI]nvoice", predicts: true },
      { field: "subject", pattern: "bill", predicts: true },
    ]);
    expect(set).toEqual([INVOICE, BILL]);
  });

  it("refuses the whole set for one rule out of grammar, or no list", () => {
    expect(() => canonicalSet([INVOICE, { ...BILL, pattern: "(a)\\1" }]))
      .toThrow("Refused a rule");
    expect(() => canonicalSet(undefined)).toThrow();
  });

  it("refuses a rule that could backtrack too long, and too many rules", () => {
    expect(() => canonicalSet([{ ...BILL, pattern: ".*.*.*.*.*!" }]))
      .toThrow("backtrack too long");
    const tooMany = Array.from(
      { length: MAX_RULES + 1 },
      (_, i) => ({ field: "subject", pattern: `word${i}`, predicts: true }),
    );
    expect(() => canonicalSet(tooMany)).toThrow(`at most ${MAX_RULES}`);
    expect(canonicalSet(tooMany.slice(0, MAX_RULES))).toHaveLength(MAX_RULES);
  });

  it("refuses a set whose rules together could backtrack too long", () => {
    const costly = Array.from({ length: 5 }, (_, i) => ({
      field: "subject",
      pattern: `\\s{0,88}\\s{0,88}${String.fromCharCode(97 + i)}`,
      predicts: true,
    }));
    expect(() => canonicalSet(costly)).toThrow("Refused the set");
    expect(canonicalSet(costly.slice(0, 4))).toHaveLength(4);
  });
});

describe("tallyAll", () => {
  it("counts every rule, below threshold too", () => {
    expect(tallyAll([{ contributor: "a", pseudonym: "a", rules: [INVOICE] }]))
      .toEqual([
        { ...INVOICE, count: 1 },
      ]);
  });
});

describe("sealed release", () => {
  const SEAL = {
    secret: SECRET,
    thresholdCenter: MIN_SEALED_THRESHOLD,
    jitter: 0,
  };
  const sealed = (
    prefix: string,
    n: number,
    rules: CanonicalRule[],
    seal: { secret: string; thresholdCenter: number; jitter: number } = SEAL,
  ) => many(prefix, n, rules).map((c) => ({ ...c, seal: { ...seal } }));

  it("releases with the threshold the contributions carry", () => {
    expect(
      releaseSealed(sealed("p", MIN_SEALED_THRESHOLD, [INVOICE])).map((r) =>
        r.count
      ),
    ).toEqual([MIN_SEALED_THRESHOLD]);
    expect(releaseSealed(sealed("p", MIN_SEALED_THRESHOLD - 1, [INVOICE])))
      .toEqual([]);
  });

  it("releases nothing when a contribution has no seal or the seals differ", () => {
    const honest = sealed("p", MIN_SEALED_THRESHOLD + 1, [INVOICE]);
    expect(releaseSealed([...honest, ...many("q", 1, [INVOICE])])).toEqual(
      [],
    );
    const raised = {
      ...honest[0],
      seal: { ...SEAL, thresholdCenter: MIN_SEALED_THRESHOLD + 1 },
    };
    expect(agreedSeal([raised, ...honest.slice(1)])).toBeUndefined();
    expect(releaseSealed([raised, ...honest.slice(1)])).toEqual([]);
    expect(releaseSealed(many("p", 3, [INVOICE]))).toEqual([]);
    expect(releaseSealed([])).toEqual([]);
  });

  it("releases nothing from a list sealed below the module's floor", () => {
    // A list someone bound `submitContribution` to, configured as low as it
    // goes: every seal agrees, and the contributions hold the rule well past
    // that list's own threshold, but not past the module's.
    for (
      const low of [
        { secret: SECRET, thresholdCenter: 1, jitter: 0 },
        {
          secret: SECRET,
          thresholdCenter: MIN_SEALED_THRESHOLD - 1,
          jitter: 0,
        },
        {
          secret: SECRET,
          thresholdCenter: MIN_SEALED_THRESHOLD + 2,
          jitter: 3,
        },
        { secret: SECRET, thresholdCenter: 15, jitter: 1e9 },
      ]
    ) {
      expect(isSealed(low)).toBe(false);
      const list = sealed("p", MIN_SEALED_THRESHOLD - 1, [INVOICE], low);
      expect(agreedSeal(list)).toBeUndefined();
      expect(releaseSealed(list)).toEqual([]);
    }
    expect(isSealed(SEAL)).toBe(true);
    expect(isSealed(null)).toBe(false);
    expect(isSealed(undefined)).toBe(false);
  });

  it("mints a seal from a valid config and refuses an invalid one", () => {
    const seal = mintSeal(() => 0, { thresholdCenter: 15, jitter: 5 });
    expect(seal).toEqual({
      secret: "0".repeat(32),
      thresholdCenter: 15,
      jitter: 5,
    });
    expect(isSealed(seal)).toBe(true);
    expect(() => mintSeal(() => 0, { thresholdCenter: 0, jitter: 5 }))
      .toThrow();
    expect(() => mintSeal(() => 0, { thresholdCenter: 15, jitter: -1 }))
      .toThrow();
  });

  it("refuses a centre below the module's floor and narrows the jitter", () => {
    for (const thresholdCenter of [1, 2, MIN_SEALED_THRESHOLD - 1]) {
      expect(() => mintSeal(() => 0, { thresholdCenter, jitter: 0 }))
        .toThrow(`at least ${MIN_SEALED_THRESHOLD}`);
    }
    // The low end, centre less jitter, never goes under the floor.
    expect(mintSeal(() => 0, { thresholdCenter: 15, jitter: 1e9 }).jitter)
      .toBe(15 - MIN_SEALED_THRESHOLD);
    expect(
      mintSeal(() => 0, { thresholdCenter: MIN_SEALED_THRESHOLD, jitter: 3 })
        .jitter,
    ).toBe(0);
    for (let i = 0; i < 50; i++) {
      const seal = mintSeal(Math.random, { thresholdCenter: 7, jitter: 5 });
      expect(seal.jitter).toBe(2);
      expect(
        thresholdFor(seal.secret, `rule-${i}`, seal),
      ).toBeGreaterThanOrEqual(MIN_SEALED_THRESHOLD);
    }
  });
});
