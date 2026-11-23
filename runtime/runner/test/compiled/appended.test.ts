import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type { FabricValue } from "@commonfabric/data-model";

import {
  appendedBehind,
  appendedBySplice,
} from "../../src/compiled/appended.ts";

const encode = (member: unknown) => member as FabricValue;

describe("appendedBehind()", () => {
  it("returns the splice of the members added behind the stored array", () => {
    expect(appendedBehind([{ a: 1 }], [{ a: 1 }, { a: 2 }, { a: 3 }], encode))
      .toEqual({ start: 1, removed: 0, inserted: 2 });
  });

  it("returns a splice from the first position where nothing is stored", () => {
    expect(appendedBehind(undefined, ["x"], encode))
      .toEqual({ start: 0, removed: 0, inserted: 1 });
  });

  it("returns `undefined` where a member the two arrays share differs", () => {
    expect(appendedBehind([{ a: 1 }], [{ a: 9 }, { a: 2 }], encode))
      .toBeUndefined();
  });

  it("returns `undefined` where the new array is no longer than the stored one", () => {
    expect(appendedBehind(["x", "y"], ["x", "y"], encode)).toBeUndefined();
    expect(appendedBehind(["x", "y"], ["x"], encode)).toBeUndefined();
  });

  it("returns `undefined` where the stored value or the new one is no array", () => {
    expect(appendedBehind({ length: 0 }, ["x"], encode)).toBeUndefined();
    expect(appendedBehind([], "x", encode)).toBeUndefined();
  });

  it("compares a stored member with the encoded form of the new one", () => {
    expect(
      appendedBehind(["A"], ["a", "b"], (member) => `${member}`.toUpperCase()),
    )
      .toEqual({ start: 1, removed: 0, inserted: 1 });
  });
});

describe("appendedBySplice()", () => {
  it("returns the splice of the executor that added members behind the last one", () => {
    const made = { start: 2, removed: 0, inserted: 1 };

    expect(appendedBySplice(made, 3)).toBe(made);
  });

  it("returns `undefined` for a splice that removed a member, or added one before the last", () => {
    expect(appendedBySplice({ start: 2, removed: 1, inserted: 1 }, 3))
      .toBeUndefined();
    expect(appendedBySplice({ start: 0, removed: 0, inserted: 1 }, 3))
      .toBeUndefined();
  });

  it("returns `undefined` where the executor made no splice", () => {
    expect(appendedBySplice(undefined, 3)).toBeUndefined();
  });
});
