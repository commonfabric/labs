import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { validateSource } from "./utils.ts";
import type { TransformationDiagnostic } from "../src/mod.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";

// End-to-end pipeline regression for the compute-wrap invariant conversion:
// a reactive computation written inline in a builder call's arguments (e.g. a
// bound-handler binding object) used to crash the whole compile with
// "Internal Common Fabric compiler error: binary expression compute-wrap
// decision disagreed with reactive-context classification" (found via
// lunch-poll's `joinAs({ ..., profile: profile ?? profileWish.result })`,
// PR #4928 rework). It must instead surface the author-facing
// `reactive:call-argument-computation` diagnostic advising the hoist, and the
// hoisted form must compile clean.

const DIAGNOSTIC_TYPE = "reactive:call-argument-computation";

function getCallArgumentComputationErrors(
  diagnostics: readonly TransformationDiagnostic[],
): readonly TransformationDiagnostic[] {
  return diagnostics.filter((d) =>
    d.type === DIAGNOSTIC_TYPE && d.severity === "error"
  );
}

Deno.test("Builder-argument computation diagnostic", async (t) => {
  await t.step(
    "reports the hoist diagnostic for `??` over a wish read in bound-handler builder args",
    async () => {
      const source = [
        'import { type Cell, Default, handler, pattern, UI, Writable, wish } from "commonfabric";',
        "",
        "interface Profile { name: string; }",
        "",
        "const join = handler<",
        "  { name: string },",
        "  { myName: Writable<string>; profile: Cell<Profile> | undefined }",
        ">((event, { myName, profile }) => {",
        "  const resolved = profile?.get();",
        "  myName.set(resolved ? resolved.name : event.name);",
        "});",
        "",
        'interface CardState { myName: Default<string, "">; profile?: Cell<Profile>; }',
        "",
        "export default pattern<CardState>(({ myName, profile }) => {",
        '  const profileWish = wish<Profile>({ query: "#profile" });',
        "  const boundJoin = join({",
        "    myName,",
        "    profile: profile ?? profileWish.result,",
        "  });",
        "  return {",
        "    [UI]: (",
        "      <div>",
        '        <cf-button onClick={() => boundJoin.send({ name: "guest" })}>',
        "          Join",
        "        </cf-button>",
        "      </div>",
        "    ),",
        "  };",
        "});",
      ].join("\n");

      const { diagnostics, output } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getCallArgumentComputationErrors(diagnostics);
      assertEquals(errors.length, 1);
      assertStringIncludes(
        errors[0]!.message,
        "Reactive computation `profile ?? profileWish.result`",
      );
      assertStringIncludes(
        errors[0]!.message,
        "cannot be compiled inline in the arguments of `join(...)`",
      );
      assertStringIncludes(
        errors[0]!.message,
        "Hoist it to a body-level const or computed(...)",
      );
      // The pipeline completed instead of crashing on the internal invariant.
      assert(output.length > 0);
    },
  );

  await t.step(
    "reports the hoist diagnostic for a comparison in builder args",
    async () => {
      const source = [
        'import { Default, handler, pattern, Writable } from "commonfabric";',
        "",
        "const join = handler<",
        "  { name: string },",
        "  { myName: Writable<string>; isFirst: boolean }",
        ">((event, { myName }) => {",
        "  myName.set(event.name);",
        "});",
        "",
        'interface CardState { myName: Default<string, "">; users: Default<string[], []>; }',
        "",
        "export default pattern<CardState>(({ myName, users }) => {",
        "  const boundJoin = join({",
        "    myName,",
        "    isFirst: users.length === 0,",
        "  });",
        "  return { boundJoin };",
        "});",
      ].join("\n");

      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      const errors = getCallArgumentComputationErrors(diagnostics);
      assertEquals(errors.length, 1);
      assertStringIncludes(
        errors[0]!.message,
        "Reactive computation `users.length === 0`",
      );
    },
  );

  await t.step(
    "the advised hoisted form compiles without the diagnostic",
    async () => {
      const source = [
        'import { type Cell, Default, handler, pattern, Writable, wish } from "commonfabric";',
        "",
        "interface Profile { name: string; }",
        "",
        "const join = handler<",
        "  { name: string },",
        "  { myName: Writable<string>; profile: Cell<Profile> | undefined }",
        ">((event, { myName }) => {",
        "  myName.set(event.name);",
        "});",
        "",
        'interface CardState { myName: Default<string, "">; profile?: Cell<Profile>; }',
        "",
        "export default pattern<CardState>(({ myName, profile }) => {",
        '  const profileWish = wish<Profile>({ query: "#profile" });',
        "  const activeProfile = profile ?? profileWish.result;",
        "  const boundJoin = join({",
        "    myName,",
        "    profile: activeProfile,",
        "  });",
        "  return { boundJoin };",
        "});",
      ].join("\n");

      const { diagnostics } = await validateSource(source, {
        types: COMMONFABRIC_TYPES,
      });
      assertEquals(getCallArgumentComputationErrors(diagnostics).length, 0);
      assertEquals(
        diagnostics.filter((d) => d.severity === "error").length,
        0,
      );
    },
  );
});
