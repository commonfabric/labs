/**
 * What `fabric-instances/impl.ts` derives from its set of classes. Nothing here
 * names a class, so a class added to the package is covered without an edit
 * here.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { codecClasses, fabricInstanceClassesByName } from "@/fabric-instances";

describe("fabric-instances/impl", () => {
  describe("fabricInstanceClassesByName()", () => {
    it("returns exactly the classes `codecClasses()` lists", () => {
      const named = Object.values(fabricInstanceClassesByName());
      expect(new Set<unknown>(named)).toEqual(new Set<unknown>(codecClasses()));
      expect(named.length).toBe(codecClasses().length);
    });

    it("returns a frozen record", () => {
      expect(Object.isFrozen(fabricInstanceClassesByName())).toBe(true);
    });

    it("keys each class by the class's own `.name`", () => {
      // The record's keys are written by hand, and this is the run-time check
      // of them. It holds where tests run, which is unminified.

      for (
        const [name, cls] of Object.entries(fabricInstanceClassesByName())
      ) {
        expect(cls.name).toBe(name);
      }
    });
  });
});
