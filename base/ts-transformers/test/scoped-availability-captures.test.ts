import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callsNamed, literalToValue, parseModule } from "./transformed-ast.ts";
import { transformSource } from "./utils.ts";

type Schema = Record<string, unknown>;

describe("scoped availability captures", () => {
  for (
    const [wrapper, scope] of [["PerUser", "user"], ["PerSession", "session"]]
  ) {
    it(`preserves ${scope} scope when reading an optional projected cell`, async () => {
      const output = await transformSource(
        `import { computed, pattern, wish, resultOf, Writable, type ${wrapper} } from "commonfabric";
interface Named { name: string; }
export default pattern(() => {
  const found = wish<Writable<${wrapper}<Named>>>({ query: "#named", headless: true });
  return { name: computed(() => resultOf(found.result)?.get()?.name) };
});`,
        { types: COMMONFABRIC_TYPES, typeCheck: true },
      );
      const root = parseModule(output);
      const lifts = callsNamed(root, "lift").filter((call) =>
        callsNamed(call.arguments[0], "resultOf").length === 1
      );
      expect(lifts).toHaveLength(1);
      const capture = literalToValue(lifts[0]!.arguments[1]) as Schema;
      const found = capture.properties as Record<string, Schema>;
      const slot = (found.found!.properties as Record<string, Schema>).result!;
      expect(slot.scope).toBe(scope);
      expect(slot.asCell).toBeUndefined();
      expect(slot.anyOf).toContainEqual({
        $ref: "#/$defs/Named",
        asCell: ["readonly"],
      });
    });

    it(`preserves a ${scope}-scoped profile when a guard forwards its cell`, async () => {
      const output = await transformSource(
        `import { Cell, computed, hasError, pattern, wish, resultOf, type ${wrapper} } from "commonfabric";
interface Named { name: string; }
const Core = pattern<{ profile?: Cell<Named> }>((input) => ({
  name: computed(() => input.profile?.get()?.name ?? "No profile"),
}));
export default pattern(() => {
  const found = wish<Cell<${wrapper}<Named>>>({ query: "#profile", headless: true });
  const profile = computed(() => hasError(found.result) ? undefined : resultOf(found.result));
  return Core({ profile });
});`,
        { types: COMMONFABRIC_TYPES, typeCheck: true },
      );
      const root = parseModule(output);
      const lifts = callsNamed(root, "lift").filter((call) =>
        callsNamed(call.arguments[0], "hasError").length === 1
      );
      expect(lifts).toHaveLength(1);
      const capture = literalToValue(lifts[0]!.arguments[1]) as Schema;
      const found = capture.properties as Record<string, Schema>;
      const slot = (found.found!.properties as Record<string, Schema>).result!;
      expect(slot.scope).toBe(scope);
      expect(slot.asCell).toBeUndefined();
      const alternatives = slot.anyOf as Schema[];
      expect(alternatives.some((arm) => Array.isArray(arm.asCell))).toBe(true);
      for (const name of ["IsPending", "IsSyncing", "HasError", "IsObsolete"]) {
        expect(alternatives).toContainEqual({ $ref: `#/$defs/${name}` });
      }
      expect(alternatives.every((arm) => arm.scope === undefined)).toBe(true);
    });

    it(`rejects authored ${scope}-scoped handle unions in availability captures`, async () => {
      await expect(transformSource(
        `import { Cell, computed, hasError, pattern, wish, resultOf, type ${wrapper} } from "commonfabric";
interface Named { name: string; }
export default pattern(() => {
  const found = wish<${wrapper}<Cell<Named>>>({ query: "#profile", headless: true });
  const profile = computed(() => hasError(found.result) ? undefined : resultOf(found.result));
  return { profile };
});`,
        { types: COMMONFABRIC_TYPES, typeCheck: true },
      )).rejects.toThrow(/scope wrapper.*(?:cell|member of a union)/i);
    });
  }
});
