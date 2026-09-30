/**
 * The verdict / non-verdict split a CFC prepare rejection turns on.
 *
 * A refusal is terminal — never retried, surfaced — only when every reason is
 * a VERDICT on the transaction's data. Anything else can decide differently on
 * a fresh attempt: an input prepare could not evaluate, a resolution that
 * failed, a prepared state a caller disturbed. Collapsing the two strands the
 * write, which is the failure OW50 exists to surface rather than reproduce.
 */

import { describe, it } from "@std/testing/bdd";

import { expect } from "@std/expect";
import {
  CFC_VERDICT_REASON,
  isTerminalRefusal,
  isVerdictReason,
  verdictReason,
} from "../src/cfc/verdict-reason.ts";

describe("cfc-verdict-reason", () => {
  it("keeps the human-readable text after the token", () => {
    // Existing assertions match the prose as a substring; tagging must not
    // rewrite it.
    const tagged = verdictReason("writer-fit confidentiality misfit at /body");
    expect(tagged).toContain("writer-fit confidentiality misfit at /body");
    expect(tagged.startsWith(`${CFC_VERDICT_REASON}: `)).toBe(true);
  });

  it("recognizes a tagged reason and rejects an untagged one", () => {
    expect(isVerdictReason(verdictReason("exact-copy violated"))).toBe(true);
    expect(isVerdictReason("missing schema write-policy input for of:x"))
      .toBe(false);
  });

  it("does not match the token appearing incidentally inside prose", () => {
    // Matched only at the START, the one position the tagger produces, so a
    // value or path that merely contains the word cannot promote itself.
    expect(isVerdictReason(`refused write at /${CFC_VERDICT_REASON}`))
      .toBe(false);
  });

  it("is terminal only when every reason is a verdict", () => {
    expect(isTerminalRefusal([
      verdictReason("writer-fit confidentiality misfit at /body"),
      verdictReason("unprivileged write to protected runtime surface of:z/cfc"),
    ])).toBe(true);
    // Mixed: the transaction was never fully evaluated, and the attempt that
    // resolves the missing input may reach a different set of reasons.
    expect(isTerminalRefusal([
      verdictReason("writer-fit confidentiality misfit at /body"),
      "missing schema write-policy input for of:y",
    ])).toBe(false);
    expect(isTerminalRefusal(["missing schema write-policy input for of:x"]))
      .toBe(false);
    expect(isTerminalRefusal([])).toBe(false);
  });

  it("treats caller-supplied invalidation prose as not a verdict", () => {
    // `invalidateCfc` takes an arbitrary string, so caller prose reaches
    // `reasons`. Under this default that prose can only ever make a refusal
    // RETRYABLE, which is the safe answer for a prepared state a caller just
    // disturbed — and it cannot manufacture a terminal refusal.
    expect(isTerminalRefusal(["read-after-prepare"])).toBe(false);
    expect(isTerminalRefusal([`${CFC_VERDICT_REASON}`])).toBe(false);
  });
});
