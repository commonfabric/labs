import { assert, assertEquals } from "@std/assert";
import { transformSource } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { emittedSchemas, parseModule } from "./transformed-ast.ts";

//
// Targeted coverage for schema-injection branches that ran in CI only through
// patterns: the per-session scope on a `new` cell constructor, and the schema-
// argument detection that skips injection when two schemas are already present.
//

Deno.test("schema injection reads the session scope from a `new X.perSession(...)` constructor", async () => {
  const source = [
    'import { Writable as WritableConstructor } from "commonfabric";',
    "export default function Test() {",
    '  const value = new WritableConstructor.perSession("seed");',
    "  return { value };",
    "}",
  ].join("\n");

  const output = await transformSource(source, { types: COMMONFABRIC_TYPES });
  const root = parseModule(output);
  // The injected cell schema carries the per-session scope read off the
  // `.perSession` constructor.
  const scoped = emittedSchemas(root).find((schema) =>
    schema.scope === "session"
  );
  assert(scoped, "expected an emitted schema with a session scope");
  assertEquals(scoped.type, "string");
});

Deno.test("schema injection skips a pattern that already supplies input and result schemas", async () => {
  const source = [
    'import { pattern } from "commonfabric";',
    "export default pattern(",
    "  (state: { count: number }) => ({ doubled: state.count * 2 }),",
    '  { type: "object" } as const,',
    '  { type: "object" } as const,',
    ");",
  ].join("\n");

  const output = await transformSource(source, { types: COMMONFABRIC_TYPES });
  const root = parseModule(output);
  // Injection is skipped, so the pattern keeps exactly the two author-supplied
  // schema literals — no inferred input/result schema is added.
  assertEquals(emittedSchemas(root).length, 2);
});
