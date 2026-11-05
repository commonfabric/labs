import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import {
  deterministicCompileError,
  isDeterministicCompileFailure,
  markDeterministicCompileFailure,
} from "../src/harness/compile-failure.ts";

describe("markDeterministicCompileFailure", () => {
  it("stamps and returns the same Error", () => {
    const error = new Error("guard throw");
    const marked = markDeterministicCompileFailure(error);
    expect(marked).toBe(error);
    expect(marked.message).toBe("guard throw");
    expect(isDeterministicCompileFailure(marked)).toBe(true);
  });

  it("classifies frozen errors", () => {
    const frozen = Object.freeze(new Error("frozen"));
    expect(markDeterministicCompileFailure(frozen)).toBe(frozen);
    expect(isDeterministicCompileFailure(frozen)).toBe(true);
  });

  it("fails open for non-object throwables", () => {
    expect(markDeterministicCompileFailure("boom")).toBe("boom");
    expect(isDeterministicCompileFailure("boom")).toBe(false);
    expect(markDeterministicCompileFailure(undefined)).toBe(undefined);
    expect(isDeterministicCompileFailure(undefined)).toBe(false);
  });

  it("fails open for allocation failures", () => {
    const v8Style = new RangeError("Array buffer allocation failed");
    expect(markDeterministicCompileFailure(v8Style)).toBe(v8Style);
    expect(isDeterministicCompileFailure(v8Style)).toBe(false);
    const jscStyle = new Error("Out of memory");
    expect(markDeterministicCompileFailure(jscStyle)).toBe(jscStyle);
    expect(isDeterministicCompileFailure(jscStyle)).toBe(false);
  });

  it("constructs a pre-classified deterministic error", () => {
    const error = deterministicCompileError("no body emitted");
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("no body emitted");
    expect(isDeterministicCompileFailure(error)).toBe(true);
  });

  it("still marks a stack overflow", () => {
    const overflow = new RangeError("Maximum call stack size exceeded");
    markDeterministicCompileFailure(overflow);
    expect(isDeterministicCompileFailure(overflow)).toBe(true);
  });

  it("fails open when an exotic throwable rejects property access", () => {
    const throwingProxy = new Proxy({}, {
      get() {
        throw new Error("no property access");
      },
    });
    markDeterministicCompileFailure(throwingProxy);
    expect(isDeterministicCompileFailure(throwingProxy)).toBe(false);
  });

  it("cannot be forged by a proxy that affirms every property", () => {
    const lyingProxy = new Proxy({}, { get: () => true });
    expect(isDeterministicCompileFailure(lyingProxy)).toBe(false);
  });

  it("does not classify an object inheriting from a marked error", () => {
    const marked = markDeterministicCompileFailure(new Error("root cause"));
    expect(isDeterministicCompileFailure(Object.create(marked))).toBe(false);
  });

  it("cannot be forged with a same-named registry symbol or property", () => {
    const forged = Object.assign(new Error("transient"), {
      [Symbol.for("cf.deterministicCompileFailure")]: true,
      deterministicCompileFailure: true,
      "cf.deterministicCompileFailure": true,
    });
    expect(isDeterministicCompileFailure(forged)).toBe(false);
  });
});
