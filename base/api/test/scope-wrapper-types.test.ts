import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { PerSpace, PerUser } from "../index.ts";

describe("scope-wrapper-types", () => {
  // These cases are type-checked by `deno task check`; each also runs, so a
  // value the wrapper holds reads back as written.

  it("holds the `null` and `undefined` its payload holds", () => {
    const missing: PerUser<string | null> = null;
    const absent: PerSpace<{ title: string } | undefined> = undefined;
    const present: PerUser<string | null> = "alpha";

    expect([missing, absent, present]).toEqual([null, undefined, "alpha"]);
  });

  it("reads a generic payload's members through the wrapper", () => {
    const titleOf = <T extends { title: string }>(value: PerUser<T>): string =>
      value.title;

    expect(titleOf({ title: "gamma" })).toBe("gamma");
  });

  it("returns a value of a generic payload's type as the wrapped type", () => {
    const scope = <T extends { title: string }>(value: T): PerUser<T> => value;
    const scopeWithin = <T extends { title: string }>(
      value: T,
    ): { value: PerSpace<T> } => ({ value });

    expect(scope({ title: "delta" }).title).toBe("delta");
    expect(scopeWithin({ title: "epsilon" }).value.title).toBe("epsilon");
  });
});
