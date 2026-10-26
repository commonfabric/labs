import { assert, assertEquals } from "@std/assert";
// Runtime import: the `commonfabric` entrypoint (base/api/index.ts) is
// almost entirely type declarations. Importing a runtime value forces the
// module to actually load, so its public surface is exercised under coverage.
import { CFC_CANONICAL_ALIAS_NAMES } from "commonfabric";
import type { FrameworkProvided, PatternToolResult } from "commonfabric";

Deno.test("FrameworkProvided is a compile-time brand, transparent at runtime", () => {
  // A `FrameworkProvided<T>` value carries no runtime brand — it is just a `T`,
  // so a tool body (e.g. the bash tool reading `sandboxId`) can use it as the
  // bare value. The annotation below compiles only if the brand stays
  // assignable to its base type.
  const id = "sandbox-abc";
  const branded = id as unknown as FrameworkProvided<string>;
  const asString: string = branded;
  assertEquals(asString, id);
  assertEquals(typeof branded, "string");
});

Deno.test("commonfabric exposes its runtime surface", () => {
  // Smoke-check the public entrypoint's one runtime export.
  assert(Array.isArray(CFC_CANONICAL_ALIAS_NAMES));
  assert(CFC_CANONICAL_ALIAS_NAMES.length > 0);
});

Deno.test("PatternToolResult carries pattern + extraParams", () => {
  // The shape patternTool() returns; referenced as a type so the public export
  // is part of the checked surface.
  const result: Pick<PatternToolResult<{ a: number }>, "extraParams"> = {
    extraParams: { a: 1 },
  };
  assertEquals(result.extraParams.a, 1);
});
