import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callSchemas, parseModule, patternSchemas } from "./transformed-ast.ts";
import type { TransformationDiagnostic } from "../src/mod.ts";
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

  // A policy reads the same through an alias of the whole policy. The binding
  // inside it stays a direct `typeof` (cfc_authoring_contract.md).
  const prelude = `
import { Cfc, CurrentPrincipal, handler, pattern, RepresentsCurrentUser, Writable, WriteAuthorizedBy } from "commonfabric";
type Owned<T, Binding> = RepresentsCurrentUser<Cfc<WriteAuthorizedBy<T, Binding>, { ownerPrincipal: CurrentPrincipal }>>;
const setName = handler<{ name: string }, { name: Writable<string> }>((event, { name }) => { name.set(event.name); });
`;
  const policy = {
    ownerPrincipal: { __ctCurrentPrincipal: true },
    writeAuthorizedBy: { __ctWriterIdentityOf: { path: ["setName"] } },
  };
  const isError = (diagnostic: TransformationDiagnostic) =>
    diagnostic.severity === "error";
  // deno-lint-ignore no-explicit-any
  const resolved = (schema: any, root: any = schema) =>
    typeof schema?.$ref === "string"
      ? root?.$defs?.[schema.$ref.split("/").pop()!]
      : schema;

  for (
    const [spelling, aliases, local, argument] of [
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
      const diagnostics: TransformationDiagnostic[] = [];
      const root = parseModule(
        await transformSource(
          `${prelude}${aliases}
export default pattern<{ initialName: string }>(({ initialName }) => {
  ${local}
  const name = new Writable<${argument}>(initialName ?? "").for("name");
  return { name, setName: setName({ name }) };
});`,
          {
            types: COMMONFABRIC_TYPES,
            typeCheck: true,
            pipelineDiagnostics: diagnostics,
          },
        ),
      );
      // The compiler refuses a program whose transform reports an error, so a
      // schema alone does not show the spelling is usable.
      expect(diagnostics.filter(isError)).toEqual([]);
      const lift = callSchemas(root, "lift")[1];
      expect(resolved(lift)?.ifc).toMatchObject(policy);
      const output = patternSchemas(root).output;
      // deno-lint-ignore no-explicit-any
      expect(resolved((output as any).properties.name, output)?.ifc)
        .toMatchObject(policy);
    });
  }

  // `type Binding = typeof setName` is not a direct `typeof`. The generator
  // reads no writer from it, so the transform must refuse it wherever a policy
  // can be written. A constructor's type arguments once went unvalidated, and
  // the cell's schemas came out with the owner's policy and no writer.
  for (
    const [position, body] of [
      [
        "a declared field",
        `export default pattern<{ name: string }, { name: Owned<string, Binding> }>(({ name }) => ({ name }));`,
      ],
      [
        "a constructed cell",
        `export default pattern<{ initialName: string }>(({ initialName }) => {
  const name = new Writable<Owned<string, Binding>>(initialName ?? "").for("name");
  return { name, setName: setName({ name }) };
});`,
      ],
    ] as const
  ) {
    it(`refuses an alias of the binding on ${position}`, async () => {
      const diagnostics: TransformationDiagnostic[] = [];
      await transformSource(
        `${prelude}type Binding = typeof setName;\n${body}`,
        {
          types: COMMONFABRIC_TYPES,
          typeCheck: true,
          pipelineDiagnostics: diagnostics,
        },
      );
      expect(diagnostics.filter(isError)).toMatchObject([{
        type: "cfc-write-authorized-by",
        message: expect.stringContaining("direct typeof binding"),
      }]);
    });
  }

  // The validator runs after the stages that lower expressions. It once
  // compared declarations against the rewritten file by identity, matched
  // none, and so reported nothing in any file those stages had touched.
  it("validates a policy in a file an earlier stage has rewritten", async () => {
    const report = async (binding: string) => {
      const diagnostics: TransformationDiagnostic[] = [];
      await transformSource(
        `${prelude}const arbitrary = 123;
export default pattern<{ name: string }, { name: Owned<string, typeof ${binding}>; shout: string }>(
  ({ name }) => ({ name, shout: name + "!" }),
);`,
        {
          types: COMMONFABRIC_TYPES,
          typeCheck: true,
          pipelineDiagnostics: diagnostics,
        },
      );
      return diagnostics.filter(isError);
    };
    expect(await report("arbitrary")).toMatchObject([{
      type: "cfc-write-authorized-by",
      message: expect.stringContaining("only supports local handler()"),
    }]);
    expect(await report("setName")).toEqual([]);
  });
});
