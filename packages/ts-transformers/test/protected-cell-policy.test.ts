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
});
