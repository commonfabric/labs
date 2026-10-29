import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { FabricValue } from "@commonfabric/api";
import { hasValueAtPath, readValueAtPath } from "../src/storage/v2-path.ts";

describe("memory v2 path helpers", () => {
  // `cloneWithValueAtPath` / `cloneWithoutValueAtPath` now live in
  // `@commonfabric/data-model` (`value-clone.ts`); their tests are in
  // `base/data-model/test/value-clone.test.ts`. This file covers the
  // path-traversal readers that remain in `v2-path.ts`.

  it("ignores inherited object properties during traversal", () => {
    const root = Object.create({
      inherited: 7,
    }) as Record<string, unknown>;

    expect(hasValueAtPath(root as FabricValue, ["inherited"])).toBe(false);
    expect(readValueAtPath(root as FabricValue, ["inherited"])).toBeUndefined();
  });

  it("ignores inherited array indices during traversal", () => {
    const prototype = ["ghost"];
    const root: unknown[] = [];
    Object.setPrototypeOf(root, prototype);

    expect(hasValueAtPath(root as FabricValue, ["0"])).toBe(false);
    expect(readValueAtPath(root as FabricValue, ["0"])).toBeUndefined();
  });
});
