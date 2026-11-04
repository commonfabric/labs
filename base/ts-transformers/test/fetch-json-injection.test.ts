import { assert, assertEquals } from "@std/assert";
import ts from "typescript";
import { transformSource } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callsNamed, emittedSchemas, parseModule } from "./transformed-ast.ts";

// The Repo schema the transformer derives from `fetchJson<Repo>(...)`.
const REPO_SCHEMA = {
  type: "object",
  properties: { name: { type: "string" }, stars: { type: "number" } },
  required: ["name", "stars"],
};

/** The object-literal argument passed to the single emitted `fetchJson` call. */
function fetchJsonArg(output: string): ts.ObjectLiteralExpression {
  const call = callsNamed(parseModule(output), "fetchJson").at(-1);
  assert(call, "expected an emitted fetchJson call");
  const arg = call.arguments[0];
  assert(arg && ts.isObjectLiteralExpression(arg));
  return arg;
}

const REPO = `
interface Repo {
  name: string;
  stars: number;
}
`;

//
// fetchJson<T> lowers T into an injected `schema` property. The object-literal
// argument form is covered by the schema-injection fixture; these cases reach
// the other two emission branches: a non-object-literal argument (spread) and
// no argument at all.
//

Deno.test("fetchJson injects a schema by spreading a non-literal argument", async () => {
  const source = `
    import { fetchJson } from "commonfabric";
    ${REPO}
    const opts = { url: "https://example.com/repo.json" };
    export default function T() {
      return fetchJson<Repo>(opts);
    }
  `;

  const output = await transformSource(source, { types: COMMONFABRIC_TYPES });

  // The derived schema is emitted as the `schema` property, and the original
  // argument is spread in alongside it.
  const root = parseModule(output);
  assertEquals(emittedSchemas(root), [REPO_SCHEMA]);
  const arg = fetchJsonArg(output);
  const hasSchemaProp = arg.properties.some((property) =>
    ts.isPropertyAssignment(property) &&
    ts.isIdentifier(property.name) && property.name.text === "schema"
  );
  assert(hasSchemaProp, "expected an injected `schema` property");
  const spreadsOpts = arg.properties.some((property) =>
    ts.isSpreadAssignment(property) &&
    ts.isIdentifier(property.expression) && property.expression.text === "opts"
  );
  assert(spreadsOpts, "expected the original argument spread as `...opts`");
});

Deno.test("fetchJson injects a schema when called with no argument", async () => {
  const source = `
    import { fetchJson } from "commonfabric";
    ${REPO}
    export default function T() {
      return fetchJson<Repo>();
    }
  `;

  const output = await transformSource(source, { types: COMMONFABRIC_TYPES });

  // With no argument, the injected schema becomes the sole property of a fresh
  // params object.
  const root = parseModule(output);
  assertEquals(emittedSchemas(root), [REPO_SCHEMA]);
  const arg = fetchJsonArg(output);
  assertEquals(arg.properties.length, 1);
  const [only] = arg.properties;
  assert(
    ts.isPropertyAssignment(only) && ts.isIdentifier(only.name) &&
      only.name.text === "schema",
    "expected `schema` to be the sole property",
  );
});
