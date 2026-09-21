import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callSchemas, parseModule, patternSchemas } from "./transformed-ast.ts";
import { transformSource } from "./utils.ts";

describe("protected cell policy", () => {
  it("preserves a writer binding in a lifted cell's result schema", async () => {
    const source = `
import { Cfc, CurrentPrincipal, handler, pattern, RepresentsCurrentUser, Writable, WriteAuthorizedBy } from "commonfabric";
type Owned<T, Binding> = RepresentsCurrentUser<Cfc<WriteAuthorizedBy<T, Binding>, { ownerPrincipal: CurrentPrincipal }>>;
const setName = handler<{ name: string }, { name: Writable<string> }>((event, { name }) => { name.set(event.name); });
export default pattern<{ initialName: string }>(({ initialName }) => {
  const initial = initialName ?? "";
  const name = new Writable<Owned<string, typeof setName>>(initial).for("name");
  return { name, setName: setName({ name }) };
});`;
    const root = parseModule(
      await transformSource(source, {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
      }),
    );
    const result = callSchemas(root, "lift")[1];
    const expected = {
      ownerPrincipal: { __ctCurrentPrincipal: true },
      writeAuthorizedBy: { __ctWriterIdentityOf: { path: ["setName"] } },
    };
    expect(result?.ifc).toMatchObject(expected);
    expect(patternSchemas(root).output).toMatchObject({
      properties: { name: { ifc: expected } },
    });
  });

  it("resolves a pattern-local value alias in protected cell output schemas", async () => {
    const source = `
import { Cfc, CurrentPrincipal, handler, pattern, RepresentsCurrentUser, Writable, WriteAuthorizedBy } from "commonfabric";
type Owned<T, Binding> = RepresentsCurrentUser<Cfc<WriteAuthorizedBy<T, Binding>, { ownerPrincipal: CurrentPrincipal }>>;
const setName = handler<{ text: string }, { name: Writable<{ text: string; extra?: number }> }>((event, { name }) => { name.set({ text: event.text }); });
export default pattern<{ initialName: string }>(({ initialName }) => {
  type Value = { text: string; extra?: number };
  const initial = initialName ?? "";
  const name = new Writable<Owned<Value, typeof setName>>({ text: initial }).for("name");
  return { name, setName: setName({ name }) };
});`;
    const root = parseModule(
      await transformSource(source, {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
      }),
    );
    const policy = {
      ownerPrincipal: { __ctCurrentPrincipal: true },
      writeAuthorizedBy: { __ctWriterIdentityOf: { path: ["setName"] } },
    };
    const definitions = {
      Value: {
        type: "object",
        properties: { text: { type: "string" }, extra: { type: "number" } },
        required: ["text"],
      },
    };
    expect(callSchemas(root, "lift")[1]).toMatchObject({
      $ref: "#/$defs/Value",
      ifc: policy,
      $defs: definitions,
    });
    expect(patternSchemas(root).output).toMatchObject({
      properties: { name: { $ref: "#/$defs/Value", ifc: policy } },
      $defs: definitions,
    });
  });

  // A writer binding reads the same however its author spelled it. Each of
  // these once produced a schema with the owner's policy and no writer.
  const prelude = `
import { Cfc, CurrentPrincipal, handler, pattern, RepresentsCurrentUser, Writable, WriteAuthorizedBy } from "commonfabric";
type Owned<T, Binding> = RepresentsCurrentUser<Cfc<WriteAuthorizedBy<T, Binding>, { ownerPrincipal: CurrentPrincipal }>>;
const setName = handler<{ name: string }, { name: Writable<string> }>((event, { name }) => { name.set(event.name); });
`;
  const policy = {
    ownerPrincipal: { __ctCurrentPrincipal: true },
    writeAuthorizedBy: { __ctWriterIdentityOf: { path: ["setName"] } },
  };
  // deno-lint-ignore no-explicit-any
  const resolved = (schema: any, root: any = schema) =>
    typeof schema?.$ref === "string"
      ? root?.$defs?.[schema.$ref.split("/").pop()!]
      : schema;

  for (
    const [spelling, aliases, local, argument] of [
      [
        "an alias of the binding",
        "type Binding = typeof setName;",
        "",
        "Owned<string, Binding>",
      ],
      [
        "a pattern-local alias of the whole policy",
        "",
        "type ProtectedName = Owned<string, typeof setName>;",
        "ProtectedName",
      ],
      [
        "a module-level alias of the whole policy",
        "type ProtectedName = Owned<string, typeof setName>;",
        "",
        "ProtectedName",
      ],
    ] as const
  ) {
    it(`keeps a constructed cell's writer through ${spelling}`, async () => {
      const root = parseModule(
        await transformSource(
          `${prelude}${aliases}
export default pattern<{ initialName: string }>(({ initialName }) => {
  ${local}
  const name = new Writable<${argument}>(initialName ?? "").for("name");
  return { name, setName: setName({ name }) };
});`,
          { types: COMMONFABRIC_TYPES, typeCheck: true },
        ),
      );
      const lift = callSchemas(root, "lift")[1];
      expect(resolved(lift)?.ifc).toMatchObject(policy);
      const output = patternSchemas(root).output;
      // deno-lint-ignore no-explicit-any
      expect(resolved((output as any).properties.name, output)?.ifc)
        .toMatchObject(policy);
    });
  }

  it("keeps a declared field's writer through an alias of the binding", async () => {
    const root = parseModule(
      await transformSource(
        `${prelude}type Binding = typeof setName;
export default pattern<{ name: string }, { name: Owned<string, Binding> }>(({ name }) => ({ name }));`,
        { types: COMMONFABRIC_TYPES, typeCheck: true },
      ),
    );
    expect(patternSchemas(root).output).toMatchObject({
      properties: { name: { ifc: policy } },
    });
  });
});
