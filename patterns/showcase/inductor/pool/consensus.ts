/**
 * The inductor pool's release decision, apart from the pattern that stores and
 * shows it: which rules enough distinct contributors hold, and each rule's
 * threshold.
 *
 * Every function here is pure. `releaseConsensus` in `pool-policy.tsx`, the
 * one function the pool's policy releases, is a call of `releaseSealed`; this
 * module is part of that function's code, and the runtime's module identity
 * for `pool-policy.tsx` covers it, since a module's identity is sensitive to
 * the modules it imports.
 */

import {
  type CanonicalRule,
  checkRule,
  MAX_RULES,
  ruleSetCostRefusal,
} from "../shared/rule-grammar.ts";

export type { CanonicalRule } from "../shared/rule-grammar.ts";

//
// Types
//

/** What one contributor contributes: their whole current rule set. */
export interface Contribution {
  /**
   * The principal who wrote this contribution, as the pool's one writer read
   * it from the runtime. Counting is by contributor, so one principal's
   * contributions count once however many pseudonyms or old entries they hold.
   */
  contributor: string;
  /** The contributor's one stable pseudonym for this pool's goal. */
  pseudonym: string;
  rules: CanonicalRule[];
  /**
   * The pool's secret and threshold, as the first contribution fixed them.
   * Every contribution carries the same seal, so the release reads its secret
   * and threshold from the witnessed contributions alone (README.md, "The
   * seal"). Absent on a bare rule set given to `supportOf` or `releaseFrom`.
   */
  seal?: PoolSeal;
}

/** The secret and threshold the release uses, fixed by the first contribution. */
export interface PoolSeal extends PoolConfig {
  /** The key of each rule's threshold offset. */
  secret: string;
}

/** A rule enough distinct contributors hold, and how many hold it. */
export interface ReleasedRule {
  field: string;
  pattern: string;
  predicts: boolean;
  key: string;
  count: number;
}

/** The release threshold's centre and spread. */
export interface PoolConfig {
  /** The threshold a rule has before its offset. */
  thresholdCenter: number;
  /** The offset's bound `k`: each rule's offset is in `[-k, +k]`. */
  jitter: number;
}

/** The pool's defaults (README.md). */
export const DEFAULT_THRESHOLD_CENTER = 15;
export const DEFAULT_JITTER = 5;

/**
 * The lowest threshold any rule has, whatever the centre and offset say. One
 * pseudonym's rule released alone would publish that person's rule, which is
 * exactly what the pool exists to prevent, so the floor is two.
 */
export const MIN_THRESHOLD = 2;

/**
 * The lowest threshold a pool may seal: no rule of a sealed pool is released
 * with fewer than five contributors holding it, whatever its configured
 * centre and jitter say. `mintSeal` refuses a centre below it and narrows the
 * jitter so the centre less the jitter is never below it, and the release
 * refuses a seal that breaks it.
 *
 * Why a module constant and why five: `submitContribution` is exported, so
 * code of anyone's can bind it to a contribution list of its own and choose
 * that list's configuration, and the release over that list is witnessed like
 * the pool's own. What it cannot choose is this number, which is part of the
 * policy module. So the cheapest public release of a rule, a rule read from
 * someone else's contribution included, takes this many principals. Two (the
 * bare `MIN_THRESHOLD`) made that one accomplice; five makes it a handful of
 * accounts while keeping a small pool for a team usable, and a released count
 * of at least five says less about any one holder.
 */
export const MIN_SEALED_THRESHOLD = 5;

//
// Rule identity
//

/**
 * What two rules must share to count as one: field, label, and canonical
 * pattern, written out. A rule's `key` is a 64-bit FNV hash of this same text,
 * which identifies but does not protect: anyone can search for a rule whose
 * key collides with someone else's. Counting by the text itself means a
 * crafted collision is a different rule.
 */
export function ruleIdentity(
  rule: Pick<CanonicalRule, "field" | "pattern" | "predicts">,
): string {
  return `${rule.field}\u0000${rule.predicts ? "1" : "0"}\u0000${rule.pattern}`;
}

//
// Keyed hash
//

const K = [
  0x428a2f98,
  0x71374491,
  0xb5c0fbcf,
  0xe9b5dba5,
  0x3956c25b,
  0x59f111f1,
  0x923f82a4,
  0xab1c5ed5,
  0xd807aa98,
  0x12835b01,
  0x243185be,
  0x550c7dc3,
  0x72be5d74,
  0x80deb1fe,
  0x9bdc06a7,
  0xc19bf174,
  0xe49b69c1,
  0xefbe4786,
  0x0fc19dc6,
  0x240ca1cc,
  0x2de92c6f,
  0x4a7484aa,
  0x5cb0a9dc,
  0x76f988da,
  0x983e5152,
  0xa831c66d,
  0xb00327c8,
  0xbf597fc7,
  0xc6e00bf3,
  0xd5a79147,
  0x06ca6351,
  0x14292967,
  0x27b70a85,
  0x2e1b2138,
  0x4d2c6dfc,
  0x53380d13,
  0x650a7354,
  0x766a0abb,
  0x81c2c92e,
  0x92722c85,
  0xa2bfe8a1,
  0xa81a664b,
  0xc24b8b70,
  0xc76c51a3,
  0xd192e819,
  0xd6990624,
  0xf40e3585,
  0x106aa070,
  0x19a4c116,
  0x1e376c08,
  0x2748774c,
  0x34b0bcb5,
  0x391c0cb3,
  0x4ed8aa4a,
  0x5b9cca4f,
  0x682e6ff3,
  0x748f82ee,
  0x78a5636f,
  0x84c87814,
  0x8cc70208,
  0x90befffa,
  0xa4506ceb,
  0xbef9a3f7,
  0xc67178f2,
];

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** `text` as UTF-8 bytes; an unpaired surrogate becomes U+FFFD. */
function utf8(text: string): number[] {
  const out: number[] = [];
  for (const char of text) {
    let c = char.codePointAt(0)!;
    if (c >= 0xd800 && c <= 0xdfff) c = 0xfffd;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    } else {
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 63),
        0x80 | ((c >> 6) & 63),
        0x80 | (c & 63),
      );
    }
  }
  return out;
}

/** SHA-256 of `bytes` (FIPS 180-4). */
export function sha256(bytes: readonly number[]): number[] {
  const h = [
    0x6a09e667,
    0xbb67ae85,
    0x3c6ef372,
    0xa54ff53a,
    0x510e527f,
    0x9b05688c,
    0x1f83d9ab,
    0x5be0cd19,
  ];
  const bitLength = bytes.length * 8;
  const padded = [...bytes, 0x80];
  while (padded.length % 64 !== 56) padded.push(0);
  const high = Math.floor(bitLength / 0x100000000);
  for (const word of [high, bitLength >>> 0]) {
    padded.push(
      word >>> 24,
      (word >>> 16) & 255,
      (word >>> 8) & 255,
      word & 255,
    );
  }
  const w = new Array<number>(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) {
      const j = offset + i * 4;
      w[i] = (padded[j] << 24) | (padded[j + 1] << 16) | (padded[j + 2] << 8) |
        padded[j + 3];
    }
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + s1 + ch + K[i] + w[i]) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) | 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) | 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) | 0;
    }
    h[0] = (h[0] + a) | 0;
    h[1] = (h[1] + b) | 0;
    h[2] = (h[2] + c) | 0;
    h[3] = (h[3] + d) | 0;
    h[4] = (h[4] + e) | 0;
    h[5] = (h[5] + f) | 0;
    h[6] = (h[6] + g) | 0;
    h[7] = (h[7] + hh) | 0;
  }
  const out: number[] = [];
  for (const word of h) {
    out.push(word >>> 24, (word >>> 16) & 255, (word >>> 8) & 255, word & 255);
  }
  return out;
}

/** HMAC-SHA-256 (RFC 2104) of `message` under `key`, both as UTF-8. */
export function hmacSha256(key: string, message: string): number[] {
  let keyBytes = utf8(key);
  if (keyBytes.length > 64) keyBytes = sha256(keyBytes);
  const block = [...keyBytes];
  while (block.length < 64) block.push(0);
  const inner = sha256([...block.map((b) => b ^ 0x36), ...utf8(message)]);
  return sha256([...block.map((b) => b ^ 0x5c), ...inner]);
}

//
// Threshold
//

/** `value` as a whole number at least `min`, or a thrown error naming it. */
function wholeAtLeast(name: string, value: number, min: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min) {
    throw new Error(`${name} must be a whole number of at least ${min}`);
  }
  return value;
}

/**
 * The rule's offset from the threshold's centre, in `[-jitter, +jitter]`: the
 * first 32 bits of HMAC-SHA-256(secret, rule identity), reduced to the range.
 * The same secret and rule always give the same offset, so a rule's threshold
 * never moves; without the secret it cannot be predicted. The reduction's bias
 * is under `(2k + 1) / 2^32`.
 */
export function thresholdOffset(
  secret: string,
  identity: string,
  jitter: number,
): number {
  const k = wholeAtLeast("jitter", jitter, 0);
  if (secret === "") throw new Error("the pool has no secret yet");
  if (k === 0) return 0;
  const [a, b, c, d] = hmacSha256(secret, identity);
  const word = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  return (word % (2 * k + 1)) - k;
}

/**
 * How many distinct contributors must hold the rule before it is released: the
 * centre plus the rule's offset, and never under `MIN_THRESHOLD`.
 */
export function thresholdFor(
  secret: string,
  identity: string,
  config: PoolConfig,
): number {
  const center = wholeAtLeast("thresholdCenter", config.thresholdCenter, 1);
  return Math.max(
    MIN_THRESHOLD,
    center + thresholdOffset(secret, identity, config.jitter),
  );
}

//
// Counting
//

/** One rule and the distinct contributors that hold it. */
export interface Support {
  rule: CanonicalRule;
  contributors: Set<string>;
}

/**
 * Each rule and the distinct contributors holding it. A contributor's later
 * contribution replaces their earlier one, so only their latest rule set
 * counts, whatever pseudonym it is under,
 * and a rule a set holds twice counts once. Rules are checked against the
 * grammar again and counted by their canonical form, so a stored rule whose
 * pattern is not canonical, or whose key does not match its text, cannot
 * stand apart from or in for another; one that fails the check is skipped.
 * An entry without a contributor is skipped too.
 */
export function supportOf(
  contributions: readonly (Contribution | undefined)[] | undefined,
): Map<string, Support> {
  const latest = new Map<string, readonly CanonicalRule[]>();
  for (const contribution of contributions ?? []) {
    const contributor = contribution?.contributor;
    if (typeof contributor !== "string" || contributor === "") continue;
    latest.set(
      contributor,
      Array.isArray(contribution?.rules) ? contribution.rules : [],
    );
  }
  const support = new Map<string, Support>();
  for (const [contributor, rules] of latest) {
    for (const stored of rules) {
      const checked = checkRule(stored);
      if (!checked.ok) continue;
      const identity = ruleIdentity(checked.rule);
      const entry = support.get(identity) ??
        { rule: checked.rule, contributors: new Set<string>() };
      entry.contributors.add(contributor);
      support.set(identity, entry);
    }
  }
  return support;
}

/**
 * The rules at or above their threshold, each with its count, most-held
 * first. Nothing is said of any other rule: not the rule, not its count, not
 * that it exists, and not how many there are. With no secret yet, nothing is
 * released.
 */
export function releaseFrom(
  contributions: readonly (Contribution | undefined)[] | undefined,
  secret: string | undefined,
  config: PoolConfig,
): ReleasedRule[] {
  if (typeof secret !== "string" || secret === "") return [];
  const released: ReleasedRule[] = [];
  for (const [identity, { rule, contributors }] of supportOf(contributions)) {
    if (contributors.size < thresholdFor(secret, identity, config)) continue;
    released.push({
      field: rule.field,
      pattern: rule.pattern,
      predicts: rule.predicts,
      key: rule.key,
      count: contributors.size,
    });
  }
  return released.sort((a, b) =>
    b.count - a.count ||
    (ruleIdentity(a) < ruleIdentity(b) ? -1 : 1)
  );
}

/**
 * The one seal every contribution carries, or undefined when there is none,
 * two disagree, or one is not a seal `mintSeal` could mint (`isSealed`). The
 * submit handler copies the first contribution's seal into every later one,
 * so honest contributions always agree; a disagreement means a list the
 * handler did not write, and it releases nothing.
 */
export function agreedSeal(
  contributions: readonly (Contribution | undefined)[] | undefined,
): PoolSeal | undefined {
  let agreed: PoolSeal | undefined;
  for (const contribution of contributions ?? []) {
    const seal = contribution?.seal;
    if (seal === undefined || !isSealed(seal)) return undefined;
    if (agreed === undefined) {
      agreed = {
        secret: seal.secret,
        thresholdCenter: seal.thresholdCenter,
        jitter: seal.jitter,
      };
    } else if (
      agreed.secret !== seal.secret ||
      agreed.thresholdCenter !== seal.thresholdCenter ||
      agreed.jitter !== seal.jitter
    ) {
      return undefined;
    }
  }
  return agreed;
}

/**
 * The release over sealed contributions: `releaseFrom` with the secret and
 * threshold the contributions themselves carry. Nothing else chooses them, so
 * a caller cannot pick a lower threshold or a secret of its own. With no
 * agreed seal, nothing is released.
 */
export function releaseSealed(
  contributions: readonly (Contribution | undefined)[] | undefined,
): ReleasedRule[] {
  const seal = agreedSeal(contributions);
  if (seal === undefined) return [];
  return releaseFrom(contributions, seal.secret, seal);
}

/**
 * Whether `seal` is one `mintSeal` could have minted: a secret, a whole
 * centre of at least `MIN_SEALED_THRESHOLD`, and a whole jitter that keeps
 * the centre less the jitter at or above it. The release refuses any other,
 * so a list whose first entry carried a lower seal, which the submit handler
 * would copy, releases nothing.
 */
export function isSealed(seal: PoolSeal | null | undefined): boolean {
  if (typeof seal !== "object" || seal === null) return false;
  const { secret, thresholdCenter, jitter } = seal;
  return typeof secret === "string" && secret !== "" &&
    Number.isInteger(thresholdCenter) &&
    thresholdCenter >= MIN_SEALED_THRESHOLD &&
    Number.isInteger(jitter) && jitter >= 0 &&
    thresholdCenter - jitter >= MIN_SEALED_THRESHOLD;
}

/**
 * The seal a pool's first contribution fixes: a fresh secret from `random`,
 * and the configured threshold, checked. The centre must be a whole number of
 * at least `MIN_SEALED_THRESHOLD`, and the jitter is narrowed so that no
 * rule's threshold falls below it. Throws on a configuration the release
 * could never use, so a bad one refuses the first contribution rather than
 * sealing a pool that can release nothing.
 */
export function mintSeal(
  random: () => number,
  config: PoolConfig,
): PoolSeal {
  const thresholdCenter = wholeAtLeast(
    "thresholdCenter",
    config.thresholdCenter,
    MIN_SEALED_THRESHOLD,
  );
  const jitter = Math.min(
    wholeAtLeast("jitter", config.jitter, 0),
    thresholdCenter - MIN_SEALED_THRESHOLD,
  );
  return { secret: mintSecret(random), thresholdCenter, jitter };
}

/**
 * `drafts` as one contribution's rule set: at most `MAX_RULES`, each checked
 * against the grammar, which refuses a pattern that could backtrack past its
 * budget, and put in canonical form, a rule given twice kept once; a set whose
 * rules together could backtrack past the set's budget is refused. A rule out of
 * grammar refuses the whole set, so a contributor learns their set was not
 * taken rather than having part of it silently dropped.
 */
export function canonicalSet(drafts: unknown): CanonicalRule[] {
  if (!Array.isArray(drafts)) {
    throw new Error("A contribution needs a list of rules.");
  }
  if (drafts.length > MAX_RULES) {
    throw new Error(`A contribution holds at most ${MAX_RULES} rules.`);
  }
  const rules = new Map<string, CanonicalRule>();
  for (const draft of drafts) {
    const checked = checkRule(draft);
    if (!checked.ok) throw new Error(`Refused a rule: ${checked.reason}.`);
    const identity = ruleIdentity(checked.rule);
    if (!rules.has(identity)) rules.set(identity, checked.rule);
  }
  const kept = [...rules.values()];
  const tooCostly = ruleSetCostRefusal(kept);
  if (tooCostly !== null) throw new Error(`Refused the set: ${tooCostly}.`);
  return kept;
}

/**
 * Every rule any pseudonym holds, with its count, threshold or not. Only for
 * showing what the release withholds; the pool's policy does not release it.
 */
export function tallyAll(
  contributions: readonly (Contribution | undefined)[] | undefined,
): ReleasedRule[] {
  return [...supportOf(contributions).values()].map((
    { rule, contributors },
  ) => ({
    field: rule.field,
    pattern: rule.pattern,
    predicts: rule.predicts,
    key: rule.key,
    count: contributors.size,
  }));
}

/**
 * A fresh pool secret: 128 bits from `random`, which must return values in
 * `[0, 1)` (in a handler, the sandbox's `Math.random`). Callable only where
 * randomness is allowed, which is why the pool mints it in a handler.
 */
export function mintSecret(random: () => number): string {
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += Math.floor(random() * 0x10000).toString(16).padStart(4, "0");
  }
  return out;
}
