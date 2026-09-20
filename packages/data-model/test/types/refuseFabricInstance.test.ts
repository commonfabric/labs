/**
 * The refusal a `FabricInstance` gets from a walk that cannot descend one.
 * Several walks share it so that they refuse in one wording; these pin that
 * wording, since a caller asserting on the message has no other guarantee of
 * it -- and pin that reaching for it throws, rather than handing back
 * something a caller could drop.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { type FabricInstance, refuseFabricInstance } from "@";
import { UnknownValue } from "@/codec-common";
import { FabricError, FabricMap } from "@/fabric-instances";

const FABRIC_ERROR = FabricError.fromNativeError(new Error("boom"));

describe("refuseFabricInstance()", () => {
  /** Runs the refusal and hands back the `Error` it threw. */
  function thrownBy(
    situation: string,
    value: FabricInstance = FABRIC_ERROR,
  ): Error {
    try {
      refuseFabricInstance(value, situation);
    } catch (e) {
      return e as Error;
    }
    // Reached only if it returned instead of throwing, which is the one
    // thing its `never` type promises it cannot do.
    throw new Error("refuseFabricInstance returned instead of throwing");
  }

  it("throws an `Error` rather than returning one", () => {
    // Typed `never` for this reason: a caller cannot reach for the refusal
    // and get a value it might then drop unthrown.
    expect(() =>
      refuseFabricInstance(FABRIC_ERROR, "when converting cells to links")
    ).toThrow(Error);
  });

  it("throws a message naming the class and the situation", () => {
    expect(thrownBy("when converting cells to links").message).toBe(
      "Cannot yet handle `FabricError` (a `FabricInstance`) when " +
        "converting cells to links.",
    );
  });

  it("names each subclass by its own constructor", () => {
    // The discriminating case: a message with the class name hard-coded, or
    // one reading a base class off the prototype chain, would pass the single
    // `FabricError` test above and fail here.
    const named = (value: FabricInstance) =>
      thrownBy("in a pattern binding", value).message;

    expect(named(new FabricMap(new Map()))).toContain("`FabricMap`");
    expect(named(new UnknownValue("Zzz@1", { a: 1 }))).toContain(
      "`UnknownValue`",
    );
  });

  it("ends the sentence once, with the situation's own words", () => {
    // The situation is a phrase, not a sentence: the period belongs to this
    // function, so a caller passing one would read as `...links..`.
    const { message } = thrownBy("while walking something entirely made up");

    expect(message).toMatch(/ while walking something entirely made up\.$/);
  });
});
