/**
 * Pins that a value a `computed()` captures reaches the input of the lift it
 * lowers to when the body tests the value's truthiness, whatever else the body
 * reads. A capture the lift's input schema leaves out reads `undefined` at run
 * time, so the test it was captured for always comes out falsy.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callSchemas, parseModule } from "./transformed-ast.ts";
import { transformSource } from "./utils.ts";

/**
 * The property names of the input schema of the lift that `body` lowers to,
 * in a pattern where `x` is a computed value of type `type` and `other` is a
 * writable cell.
 */
async function guardInputNames(type: string, body: string): Promise<string[]> {
  const source =
    `import { computed, pattern, type PerSession, type PerSpace, type PerUser, Writable } from "commonfabric";
    export default pattern(() => {
      const other = new Writable<number | undefined>(1);
      // deno-lint-ignore no-explicit-any
      const x = computed((): ${type} => other.get() as any);
      const guarded = computed(() => ${body});
      return { guarded };
    });`;
  const output = await transformSource(source, { types: COMMONFABRIC_TYPES });
  const input = callSchemas(parseModule(output), "lift")[0]!;
  return Object.keys(input.properties as Record<string, unknown>).sort();
}

describe("guard-capture-schema", () => {
  const AND_GUARD = "x && other.get() !== undefined ? 1 : 2";

  describe("a guard on a value of each type", () => {
    for (
      const type of [
        "PerSession<boolean>",
        "PerUser<boolean>",
        "PerSpace<boolean>",
        "string | undefined",
        "{ a: number } | undefined",
        "any",
        "boolean",
        "number",
      ]
    ) {
      it(`keeps a \`${type}\` value guarding a read of another input`, async () => {
        expect(await guardInputNames(type, AND_GUARD)).toEqual(["other", "x"]);
      });
    }
  });

  describe("each form of guard", () => {
    const forms = [
      "!x && other.get() !== undefined ? 1 : 2",
      "x ? other.get() : 2",
      "{ if (x) return other.get(); return 0; }",
      "(x && other.get() !== undefined) ? 1 : 2",
      "[x && other.get() !== undefined ? 1 : 2]",
      "({ ...(x && other.get() !== undefined ? { a: 1 } : {}) })",
      "x || other.get() !== undefined ? 1 : 2",
      "(x ?? other.get()) !== undefined ? 1 : 2",
      "x === true && other.get() !== undefined ? 1 : 2",
      "other.get() !== undefined && x ? 1 : 2",
    ];

    for (const form of forms) {
      it(`keeps the value guarding \`${form}\``, async () => {
        expect(await guardInputNames("PerSession<boolean>", form)).toEqual([
          "other",
          "x",
        ]);
      });
    }

    it("keeps an `any` value negated beside another input's negation", async () => {
      // The shape `fetchAndRunPattern()` in `system/common-fabric.tsx` uses.
      expect(
        await guardInputNames(
          "any",
          "other.get() === 0 || (!x && !other.get())",
        ),
      ).toEqual(["other", "x"]);
    });

    it("keeps a value guarding nothing but constants", async () => {
      expect(await guardInputNames("PerSession<boolean>", "x ? 1 : 2"))
        .toEqual(["x"]);
    });
  });
});
