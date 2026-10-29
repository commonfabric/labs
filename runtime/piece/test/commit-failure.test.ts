import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { commitFailure } from "../src/ops/utils.ts";

describe("commitFailure", () => {
  it("throws the reason when the commit carried an Error one", () => {
    const reason = new RangeError("the underlying cause");
    expect(commitFailure({ name: "Whatever", message: "outer", reason }))
      .toBe(reason);
  });

  it("passes an Error through, so its own fields stay reachable", () => {
    // A precondition failure arrives as an Error carrying `precondition`.
    // Wrapping it would put that behind `cause`, where a caller checking the
    // field would no longer find it.
    const precondition = Object.assign(new Error("stale basis"), {
      name: "PreconditionFailed",
      precondition: { seq: 12 },
    });
    expect(commitFailure(precondition)).toBe(precondition);
  });

  it("wraps a Result error so it is an Error at all", () => {
    const result = commitFailure({
      name: "ConflictError",
      message: "stale confirmed read: of:fid1:abc at seq 0 conflicted with 12",
    });
    expect(result).toBeInstanceOf(Error);
    expect(result.name).toBe("ConflictError");
    expect(result.message).toContain("stale confirmed read");
    // The stack is what a plain Result object cannot carry, and what a
    // rendered failure needs.
    expect(typeof result.stack).toBe("string");
  });

  it("keeps the Result on cause, so the conflict's own fields survive", () => {
    const conflict = {
      name: "ConflictError",
      message: "stale confirmed read",
      transaction: { localSeq: 6 },
    };
    expect(commitFailure(conflict).cause).toBe(conflict);
  });

  it("renders a Result with no message rather than losing it", () => {
    const result = commitFailure({ name: "Odd", code: 17 });
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toContain("17");
  });

  it("renders a Result whose fields refer to each other", () => {
    // The fallback path runs inside error handling, so it has to survive what
    // a commit error actually carries: a transaction whose reads and writes
    // refer back to it. `JSON.stringify` throws on that.
    const conflict: Record<string, unknown> = { name: "ConflictError" };
    conflict.transaction = { of: conflict };
    const result = commitFailure(conflict);
    expect(result).toBeInstanceOf(Error);
    expect(result.name).toBe("ConflictError");
    expect(result.message.length).toBeGreaterThan(0);
  });

  it("keeps a CFC refusal's message when its reason is only a marker", () => {
    // The refusal names what refused in its message; its `reason` classifies
    // the refusal and says nothing an operator can act on.
    const marker = new Error("cfc-refusal-not-a-verdict");
    const refusal = {
      name: "StorageTransactionAborted",
      message: "CFC enforcement rejected commit: relevant transaction was " +
        "not prepared: a policy check refused the write",
      reason: marker,
    };
    const result = commitFailure(refusal);
    expect(result).not.toBe(marker);
    expect(result.name).toBe("StorageTransactionAborted");
    expect(result.message).toBe(refusal.message);
    expect(result.cause).toBe(refusal);
  });

  it("ignores a non-Error reason and still produces an Error", () => {
    const result = commitFailure({
      name: "ConflictError",
      message: "refused",
      reason: "a string, not an Error",
    });
    expect(result).toBeInstanceOf(Error);
    expect(result.name).toBe("ConflictError");
    expect(result.message).toBe("refused");
  });
});
