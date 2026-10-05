import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import type ts from "typescript";

import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import {
  bindingIdentities,
  callSchemas,
  emittedSchemas,
  parseModule,
  patternSchemas,
} from "./transformed-ast.ts";
import type { TransformationDiagnostic } from "../src/mod.ts";
import { transformFiles, transformSource } from "./utils.ts";

describe("protected cell policy", () => {
  it("accepts a computed read of a wished profile's defaulted owner-protected field", async () => {
    const diagnostics: TransformationDiagnostic[] = [];
    const output = await transformSource(
      `import { Cfc, CurrentPrincipal, Default, RepresentsCurrentUser, WriteAuthorizedBy, computed, handler, pattern, wish } from "commonfabric";
const setBio = handler<void, {}>(() => {});
type OwnerProtected<T, Binding> = RepresentsCurrentUser<
  Cfc<WriteAuthorizedBy<T, Binding>, { ownerPrincipal: CurrentPrincipal }>
>;
export type ProfileOut = { bio: Default<OwnerProtected<string, typeof setBio>, ""> };
export default pattern<{}>(() => {
  const profileWish = wish<ProfileOut>({ query: "#profile" });
  const bio = computed(() => String(profileWish.result?.bio as string).trim());
  return { bio };
});`,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        pipelineDiagnostics: diagnostics,
      },
    );

    expect(diagnostics.filter(isError)).toEqual([]);
    // The capture reads the field whole, out of a result that may be missing.
    expect(callSchemas(parseModule(output), "lift")[0]).toMatchObject({
      properties: {
        profileWish: {
          properties: {
            result: {
              properties: {
                bio: {
                  ifc: {
                    ownerPrincipal: { __ctCurrentPrincipal: true },
                    writeAuthorizedBy: {
                      __ctWriterIdentityOf: { path: ["setBio"] },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
  });

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
      [
        "a pattern-local generic alias with a fixed writer",
        "",
        "type ProtectedName<T> = Owned<T, typeof setName>;",
        "ProtectedName<string>",
      ],
      [
        "a pattern-local generic alias with a writer argument",
        "",
        "type ProtectedName<T, Writer> = Owned<T, Writer>;",
        "ProtectedName<string, typeof setName>",
      ],
      [
        "a chain of pattern-local generic aliases",
        "",
        "type Inner<T> = Owned<T, typeof setName>;\ntype ProtectedName<T> = Inner<T>;",
        "ProtectedName<string>",
      ],
      [
        "a pattern-local generic alias with a default value type",
        "",
        "type ProtectedName<T = string> = Owned<T, typeof setName>;",
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
      expect(resolved(lift)).toMatchObject({ type: "string", ifc: policy });
      const output = patternSchemas(root).output;
      // deno-lint-ignore no-explicit-any
      expect(resolved((output as any).properties.name, output))
        .toMatchObject({ type: "string", ifc: policy });
    });
  }

  for (
    const [spelling, aliases, local, expectedPolicy] of [
      [
        "a module-level generic alias",
        "type ProtectedName<T> = cf.WriteAuthorizedBy<T, typeof setName>;",
        "",
        { writeAuthorizedBy: policy.writeAuthorizedBy },
      ],
      [
        "a pattern-local generic alias",
        "",
        "type ProtectedName<T> = cf.WriteAuthorizedBy<T, typeof setName>;",
        { writeAuthorizedBy: policy.writeAuthorizedBy },
      ],
      [
        "a generic alias chain",
        "type Inner<T, Writer> = cf.WriteAuthorizedBy<T, Writer>;",
        "type ProtectedName<T> = Inner<T, typeof setName>;",
        { writeAuthorizedBy: policy.writeAuthorizedBy },
      ],
      [
        "nested policy aliases",
        "",
        "type ProtectedName<T> = cf.Cfc<cf.WriteAuthorizedBy<T, typeof setName>, { ownerPrincipal: cf.CurrentPrincipal }>;",
        policy,
      ],
    ] as const
  ) {
    it(`keeps a namespace-qualified writer policy through ${spelling}`, async () => {
      const diagnostics: TransformationDiagnostic[] = [];
      const root = parseModule(
        await transformSource(
          `${prelude}import * as cf from "commonfabric";
${aliases}
export default pattern<{ initialName: string }>(({ initialName }) => {
  ${local}
  const name = new Writable<ProtectedName<string>>(initialName ?? "").for("name");
  return { name, setName: setName({ name }) };
});`,
          {
            types: COMMONFABRIC_TYPES,
            typeCheck: true,
            pipelineDiagnostics: diagnostics,
          },
        ),
      );
      expect(diagnostics.filter(isError)).toEqual([]);
      const expected = {
        type: "string",
        ifc: expectedPolicy,
      };
      expect(resolved(callSchemas(root, "lift")[1])).toMatchObject(expected);
      const output = patternSchemas(root).output;
      // deno-lint-ignore no-explicit-any
      expect(resolved((output as any).properties.name, output))
        .toMatchObject(expected);
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
      }, {
        type: "cfc-write-authorized-by:unread",
        message: expect.stringContaining(
          "schema would carry no write restriction",
        ),
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
      message: expect.stringContaining("only supports handler()"),
    }]);
    expect(await report("setName")).toEqual([]);
  });

  // A writer imported from another authored module, through a re-export, is
  // as sound a claim as a local one: the schema carries the DECLARING module,
  // which is what the runtime verifies the writer against. The validator once
  // refused it by name, while the shipped `cfc-spec-gallery` relied on the
  // refusal never running.
  const importedWriterFiles = (writer: string) => ({
    "/main.tsx": `import { pattern, Writable } from "commonfabric";
import { type Owned, setName } from "./writers/mod.ts";
export default pattern<{ initialName: string }>(({ initialName }) => {
  const name = new Writable<Owned<string, typeof setName>>(initialName ?? "").for("name");
  return { name };
});`,
    "/writers/mod.ts": `export * from "./set-name.ts";`,
    "/writers/set-name.ts":
      `import { Cfc, CurrentPrincipal, handler, RepresentsCurrentUser, Writable, WriteAuthorizedBy } from "commonfabric";
export type Owned<T, Binding> = RepresentsCurrentUser<Cfc<WriteAuthorizedBy<T, Binding>, { ownerPrincipal: CurrentPrincipal }>>;
export const setName = ${writer};`,
  });

  // The policy alias is imported too. The validator once followed only this
  // file's aliases, so a policy an imported alias carried was never checked,
  // while the generator resolved it and emitted the claim.
  it("refuses an imported binding that is not a writer", async () => {
    const diagnostics: TransformationDiagnostic[] = [];
    await transformFiles(importedWriterFiles("123"), {
      types: COMMONFABRIC_TYPES,
      typeCheck: true,
      pipelineDiagnostics: diagnostics,
    });
    expect(diagnostics.filter(isError)).toMatchObject([{
      type: "cfc-write-authorized-by",
      message: expect.stringContaining("only supports handler()"),
    }]);
  });

  it("accepts an imported writer and names its declaring module", async () => {
    const diagnostics: TransformationDiagnostic[] = [];
    const files = await transformFiles(
      importedWriterFiles(
        `handler<{ name: string }, { name: Writable<string> }>((event, { name }) => { name.set(event.name); })`,
      ),
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        pipelineDiagnostics: diagnostics,
      },
    );
    expect(diagnostics.filter(isError)).toEqual([]);
    const root = parseModule(files["/main.tsx"]);
    const writer = {
      __ctWriterIdentityOf: { file: "/writers/set-name.ts", path: ["setName"] },
    };
    expect(resolved(callSchemas(root, "lift")[1])?.ifc?.writeAuthorizedBy)
      .toEqual(writer);
    const output = patternSchemas(root).output;
    // deno-lint-ignore no-explicit-any
    expect(resolved((output as any).properties.name, output)?.ifc)
      .toMatchObject({ writeAuthorizedBy: writer });
  });

  it("keeps an imported writer through a pattern-local generic alias", async () => {
    const diagnostics: TransformationDiagnostic[] = [];
    const files = await transformFiles({
      ...importedWriterFiles(
        `handler<{ name: string }, { name: Writable<string> }>((event, { name }) => { name.set(event.name); })`,
      ),
      "/main.tsx": `import { pattern, Writable } from "commonfabric";
import { type Owned, setName as save } from "./writers/mod.ts";
export default pattern<{ initialName: string }>(({ initialName }) => {
  type ProtectedName<T> = Owned<T, typeof save>;
  const name = new Writable<ProtectedName<string>>(initialName ?? "").for("name");
  return { name };
});`,
    }, {
      types: COMMONFABRIC_TYPES,
      typeCheck: true,
      pipelineDiagnostics: diagnostics,
    });
    expect(diagnostics.filter(isError)).toEqual([]);
    const root = parseModule(files["/main.tsx"]);
    const expected = {
      type: "string",
      ifc: {
        ...policy,
        writeAuthorizedBy: {
          __ctWriterIdentityOf: {
            file: "/writers/set-name.ts",
            path: ["setName"],
          },
        },
      },
    };
    expect(resolved(callSchemas(root, "lift")[1])).toMatchObject(expected);
    const output = patternSchemas(root).output;
    // deno-lint-ignore no-explicit-any
    expect(resolved((output as any).properties.name, output))
      .toMatchObject(expected);
    expect(bindingIdentities(parseModule(files["/writers/set-name.ts"])))
      .toEqual([{
        sourceFile: "/writers/set-name.ts",
        bindingPath: ["setName"],
      }]);
  });

  for (const scope of ["module", "pattern"] as const) {
    it(`keeps a writer through same-named aliases at ${scope} scope`, async () => {
      const alias = "type Owned<T> = ns.Owned<T, typeof save>;";
      const diagnostics: TransformationDiagnostic[] = [];
      const files = await transformFiles({
        ...importedWriterFiles(
          `handler<{ name: string }, { name: Writable<string> }>((event, { name }) => { name.set(event.name); })`,
        ),
        "/main.tsx": `import { pattern, Writable } from "commonfabric";
import * as ns from "./writers/mod.ts";
import { setName as save } from "./writers/mod.ts";
${scope === "module" ? alias : ""}
export default pattern<{ initialName: string }>(({ initialName }) => {
  ${scope === "pattern" ? alias : ""}
  const name = new Writable<Owned<string>>(initialName ?? "").for("name");
  return { name };
});`,
      }, {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        pipelineDiagnostics: diagnostics,
      });
      expect(diagnostics.filter(isError)).toEqual([]);
      const root = parseModule(files["/main.tsx"]);
      const expected = {
        type: "string",
        ifc: {
          ...policy,
          writeAuthorizedBy: {
            __ctWriterIdentityOf: {
              file: "/writers/set-name.ts",
              path: ["setName"],
            },
          },
        },
      };
      expect(resolved(callSchemas(root, "lift")[1])).toMatchObject(expected);
      const output = patternSchemas(root).output;
      // deno-lint-ignore no-explicit-any
      expect(resolved((output as any).properties.name, output))
        .toMatchObject(expected);
    });
  }

  // The claim is the importer's; the binding identity the runtime verifies it
  // against is minted where the writer is DECLARED. The hardening stage once
  // read each file's own claims only, so a writer cited from another module
  // was never given its identity, and the claim could not be satisfied.
  it("gives an imported writer its binding identity in its own module", async () => {
    const diagnostics: TransformationDiagnostic[] = [];
    const files = await transformFiles(
      {
        "/main.tsx":
          `import { pattern, Stream, Writable, WriteAuthorizedBy } from "commonfabric";
import { writer as save } from "./barrel.ts";
export default pattern<Record<string, never>, { name: WriteAuthorizedBy<string, typeof save>; save: Stream<void> }>(() => {
  const name = new Writable<string>("").for("name");
  return { name, save: save({ name }) };
});`,
        "/barrel.ts": `export * from "./writer.ts";`,
        "/writer.ts": `import { handler, Writable } from "commonfabric";
export const writer = handler<void, { name: Writable<string> }>((_event, { name }) => { name.set("updated"); });
export const bystander = handler<void, { name: Writable<string> }>((_event, { name }) => { name.set("no"); });`,
      },
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        pipelineDiagnostics: diagnostics,
      },
    );
    expect(diagnostics.filter(isError)).toEqual([]);
    expect(bindingIdentities(parseModule(files["/writer.ts"]))).toEqual([{
      sourceFile: "/writer.ts",
      bindingPath: ["writer"],
    }]);
    expect(patternSchemas(parseModule(files["/main.tsx"])).output)
      .toMatchObject({
        properties: {
          name: {
            ifc: {
              writeAuthorizedBy: {
                __ctWriterIdentityOf: { file: "/writer.ts", path: ["writer"] },
              },
            },
          },
        },
      });
  });

  // A policy type is the library's by declaration, not by spelling: an
  // authored alias that borrows the name `WriteAuthorizedBy` names no writer,
  // and the hardening index must not trust the binding it cites.
  it("does not trust a binding cited by an authored alias that borrows a policy name", async () => {
    const files = await transformFiles(
      {
        "/main.tsx": `import { pattern, Stream, Writable } from "commonfabric";
import { writer } from "./writer.ts";
type WriteAuthorizedBy<T, Binding> = { value: T; by?: Binding };
export default pattern<Record<string, never>, { name: WriteAuthorizedBy<string, typeof writer>; save: Stream<void> }>(() => {
  const name = new Writable<{ value: string }>({ value: "" }).for("name");
  return { name, save: writer({ name }) };
});`,
        "/writer.ts": `import { handler, Writable } from "commonfabric";
export const writer = handler<void, { name: Writable<{ value: string }> }>((_event, { name }) => { name.set({ value: "updated" }); });`,
      },
      { types: COMMONFABRIC_TYPES, typeCheck: true },
    );
    expect(bindingIdentities(parseModule(files["/writer.ts"]))).toEqual([]);
  });

  it("trusts a writer cited through a namespace-qualified policy reference", async () => {
    const files = await transformFiles(
      {
        "/main.tsx": `import * as cf from "commonfabric";
import { writer } from "./writer.ts";
export default cf.pattern<Record<string, never>, { name: cf.WriteAuthorizedBy<string, typeof writer>; save: cf.Stream<void> }>(() => {
  const name = new cf.Writable<string>("").for("name");
  return { name, save: writer({ name }) };
});`,
        "/writer.ts": `import { handler, Writable } from "commonfabric";
export const writer = handler<void, { name: Writable<string> }>((_event, { name }) => { name.set("updated"); });`,
      },
      { types: COMMONFABRIC_TYPES, typeCheck: true },
    );
    expect(bindingIdentities(parseModule(files["/writer.ts"]))).toEqual([{
      sourceFile: "/writer.ts",
      bindingPath: ["writer"],
    }]);
    expect(patternSchemas(parseModule(files["/main.tsx"])).output)
      .toMatchObject({
        properties: {
          name: {
            ifc: {
              writeAuthorizedBy: {
                __ctWriterIdentityOf: { file: "/writer.ts", path: ["writer"] },
              },
            },
          },
        },
      });
  });

  // The library's policy type is known by its declared name, however a
  // reference spells it. The index once read the local spelling, so a
  // renamed import produced the claim with no identity behind it.
  for (
    const [spelling, imports, barrel] of [
      [
        "a renamed import",
        `import { pattern, Stream, Writable, WriteAuthorizedBy as Guarded } from "commonfabric";`,
        "",
      ],
      [
        "a renamed re-export through an authored module",
        `import { pattern, Stream, Writable } from "commonfabric";\nimport { Guarded } from "./policy.ts";`,
        `export { WriteAuthorizedBy as Guarded } from "commonfabric";`,
      ],
    ] as const
  ) {
    it(`trusts a writer cited through ${spelling} of the policy type`, async () => {
      const files = await transformFiles(
        {
          "/main.tsx": `${imports}
import { writer as save } from "./writer.ts";
export default pattern<Record<string, never>, { name: Guarded<string, typeof save>; save: Stream<void> }>(() => {
  const name = new Writable<string>("").for("name");
  return { name, save: save({ name }) };
});`,
          ...(barrel ? { "/policy.ts": barrel } : {}),
          "/writer.ts": `import { handler, Writable } from "commonfabric";
export const writer = handler<void, { name: Writable<string> }>((_event, { name }) => { name.set("updated"); });`,
        },
        { types: COMMONFABRIC_TYPES, typeCheck: true },
      );
      expect(bindingIdentities(parseModule(files["/writer.ts"]))).toEqual([{
        sourceFile: "/writer.ts",
        bindingPath: ["writer"],
      }]);
      expect(patternSchemas(parseModule(files["/main.tsx"])).output)
        .toMatchObject({
          properties: {
            name: {
              ifc: {
                writeAuthorizedBy: {
                  __ctWriterIdentityOf: {
                    file: "/writer.ts",
                    path: ["writer"],
                  },
                },
              },
            },
          },
        });
    });
  }

  it("validates a claim written through a renamed import of the policy type", async () => {
    const diagnostics: TransformationDiagnostic[] = [];
    await transformSource(
      `import { handler, pattern, Writable, WriteAuthorizedBy as Guarded } from "commonfabric";
const setName = handler<{ name: string }, { name: Writable<string> }>((event, { name }) => { name.set(event.name); });
type Binding = typeof setName;
export default pattern<{ name: string }, { name: Guarded<string, Binding> }>(({ name }) => ({ name }));`,
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        pipelineDiagnostics: diagnostics,
      },
    );
    expect(diagnostics.filter(isError)).toMatchObject([{
      type: "cfc-write-authorized-by",
      message: expect.stringContaining("direct typeof binding"),
    }, {
      type: "cfc-write-authorized-by:unread",
      message: expect.stringContaining(
        "schema would carry no write restriction",
      ),
    }]);
  });

  // An alias body in parentheses names the policy it holds. `deno fmt`
  // removes such parentheses in this repository, but pattern source the
  // runtime compiles need not have been formatted, and the schema generator
  // once read the body raw: the field lost its policy AND its type, emitted
  // as an open object with no diagnostic.
  for (
    const [spelling, aliases] of [
      [
        "a parenthesized alias body",
        "type ProtectedName = (Owned<string, typeof setName>);",
      ],
      [
        "a parenthesized generic alias body",
        "type OwnedBySetName<T> = (Owned<T, typeof setName>);\ntype ProtectedName = OwnedBySetName<string>;",
      ],
      [
        "parenthesized bodies on an alias of an alias",
        "type Inner = (Owned<string, typeof setName>);\ntype ProtectedName = (Inner);",
      ],
    ] as const
  ) {
    for (
      const [position, body] of [
        [
          "a constructed cell",
          `export default pattern<{ initialName: string }>(({ initialName }) => {
  const name = new Writable<ProtectedName>(initialName ?? "").for("name");
  return { name, setName: setName({ name }) };
});`,
        ],
        [
          "a declared field",
          `export default pattern<{ name: string }, { name: ProtectedName }>(({ name }) => ({ name }));`,
        ],
      ] as const
    ) {
      it(`keeps the policy of ${position} through ${spelling}`, async () => {
        const diagnostics: TransformationDiagnostic[] = [];
        const root = parseModule(
          await transformSource(
            `${prelude}// deno-fmt-ignore\n${aliases}\n${body}`,
            {
              types: COMMONFABRIC_TYPES,
              typeCheck: true,
              pipelineDiagnostics: diagnostics,
            },
          ),
        );
        expect(diagnostics.filter(isError)).toEqual([]);
        const output = patternSchemas(root).output;
        // deno-lint-ignore no-explicit-any
        const name = resolved((output as any).properties.name, output);
        expect(name).toMatchObject({ type: "string", ifc: policy });
      });
    }
  }

  // An alias chain may pass through two different aliases of one name; the
  // second is part of the chain, not a cycle, and the policy it holds
  // reaches the schema.
  it("follows a policy alias chain through two aliases of the same name", async () => {
    const diagnostics: TransformationDiagnostic[] = [];
    const files = await transformFiles(
      {
        "/main.tsx": `import { pattern, Writable } from "commonfabric";
import { type Wrapped, setName } from "./shared.ts";
type Owned<T> = Wrapped<T>;
export default pattern<{ initialName: string }>(({ initialName }) => {
  const name = new Writable<Owned<string>>(initialName ?? "").for("name");
  return { name, setName: setName({ name }) };
});`,
        "/shared.ts":
          `import { Cfc, CurrentPrincipal, handler, RepresentsCurrentUser, Writable, WriteAuthorizedBy } from "commonfabric";
type Owned<T, Binding> = RepresentsCurrentUser<Cfc<WriteAuthorizedBy<T, Binding>, { ownerPrincipal: CurrentPrincipal }>>;
export const setName = handler<{ name: string }, { name: Writable<string> }>((event, { name }) => { name.set(event.name); });
export type Wrapped<T> = Owned<T, typeof setName>;`,
      },
      {
        types: COMMONFABRIC_TYPES,
        typeCheck: true,
        pipelineDiagnostics: diagnostics,
      },
    );
    expect(diagnostics.filter(isError)).toEqual([]);
    const expected = {
      type: "string",
      ifc: {
        ownerPrincipal: { __ctCurrentPrincipal: true },
        writeAuthorizedBy: {
          __ctWriterIdentityOf: { file: "/shared.ts", path: ["setName"] },
        },
      },
    };
    const root = parseModule(files["/main.tsx"]);
    expect(resolved(callSchemas(root, "lift")[1])).toMatchObject(expected);
  });

  // A conditional alias the checker resolves to the policy holds the writer in
  // its own arguments, in whatever order its parameters take.
  const conditionalPrelude =
    `import { handler, pattern, Writable, WriteAuthorizedBy } from "commonfabric";
const setName = handler<{ name: string }, { name: Writable<string> }>((event, { name }) => { name.set(event.name); });
const other = handler<{ name: string }, { name: Writable<string> }>((event, { name }) => { name.set(event.name); });
type Guarded<X, B> = X extends string ? WriteAuthorizedBy<X, B> : never;
type Crossed<A, B> = B extends unknown ? WriteAuthorizedBy<string, A> : never;
type Checked<B> = B extends unknown ? WriteAuthorizedBy<string, B> : never;
`;

  it("keeps the writer a conditional alias passes to the policy", async () => {
    const diagnostics: TransformationDiagnostic[] = [];
    const root = parseModule(
      await transformSource(
        `${conditionalPrelude}export default pattern<{ name: string }, { guarded: Guarded<string, typeof setName>; crossed: Crossed<typeof setName, typeof other> }>(
  ({ name }) => ({ guarded: name, crossed: name }),
);`,
        {
          types: COMMONFABRIC_TYPES,
          typeCheck: true,
          pipelineDiagnostics: diagnostics,
        },
      ),
    );

    expect(diagnostics.filter(isError)).toEqual([]);
    const writer = {
      writeAuthorizedBy: { __ctWriterIdentityOf: { path: ["setName"] } },
    };
    expect(patternSchemas(root).output).toMatchObject({
      properties: { guarded: { ifc: writer }, crossed: { ifc: writer } },
    });
  });

  it("reports nothing for a policy written directly, whose claim the transformer mints", async () => {
    // The direct `WriteAuthorizedBy` path hands the schema generator the
    // payload's node and mints the claim itself, so the generator has no
    // binding to read there, and no alias it was written through.
    const diagnostics: TransformationDiagnostic[] = [];
    const root = parseModule(
      await transformSource(
        `${conditionalPrelude}interface Named { name: string }
export default pattern(() => {
  const plain = new Writable<WriteAuthorizedBy<string, typeof setName>>("").for("plain");
  const named = new Writable<WriteAuthorizedBy<Named, typeof setName>>({ name: "" }).for("named");
  return { plain, named, setName: setName({ name: plain }) };
});`,
        {
          types: COMMONFABRIC_TYPES,
          typeCheck: true,
          pipelineDiagnostics: diagnostics,
        },
      ),
    );

    expect(diagnostics.filter(isError)).toEqual([]);
    expect(
      diagnostics.filter((diagnostic) =>
        diagnostic.type === "cfc-write-authorized-by:unread"
      ),
    ).toEqual([]);
    const writer = {
      writeAuthorizedBy: { __ctWriterIdentityOf: { path: ["setName"] } },
    };
    expect(patternSchemas(root).output).toMatchObject({
      properties: { plain: { ifc: writer }, named: { ifc: writer } },
    });
  });

  it("refuses a writer it cannot read, stored source included", async () => {
    // A reload of stored source is refused too: the error guards a write
    // restriction, which a pattern does not run without.
    const severities = async (storedSource: boolean) => {
      const diagnostics: TransformationDiagnostic[] = [];
      await transformSource(
        `${conditionalPrelude}export default pattern<{ name: string }, { name: Checked<typeof setName> }>(
  ({ name }) => ({ name }),
);`,
        {
          types: COMMONFABRIC_TYPES,
          typeCheck: true,
          pipelineDiagnostics: diagnostics,
          storedSource,
        },
      );
      return diagnostics
        .filter((diagnostic) =>
          diagnostic.type === "cfc-write-authorized-by:unread"
        )
        .map((diagnostic) => diagnostic.severity);
    };

    expect(await severities(false)).toEqual(["error"]);
    expect(await severities(true)).toEqual(["error"]);
  });

  describe("a capture of an owner-protected cell", () => {
    // A closure narrows its capture of the cell to what it does with it, and
    // the narrowed capture is rebuilt from the cell's type, whose print spells
    // `typeof removeItem` as the handler's structural type. Two writers of the
    // same signature have the same policy type, so only the syntax the value
    // was declared with names the writer.

    const constructed =
      `const items = new Writable<Owned<Item[], typeof removeItem>>([]).for("items");`;
    const transform = async (result: string, declaration = constructed) =>
      parseModule(
        await transformSource(
          `import { Cfc, CurrentPrincipal, cell, computed, Default, handler, pattern, RepresentsCurrentUser, UI, wish, Writable, WriteAuthorizedBy } from "commonfabric";
import * as CF from "commonfabric";
type Owned<T, Binding> = RepresentsCurrentUser<Cfc<WriteAuthorizedBy<T, Binding>, { ownerPrincipal: CurrentPrincipal }>>;
interface Item { id: string }
const removeItem = handler<void, { items: Writable<Item[]>; id: string }>((_, { items, id }) => {
  items.set(items.get().filter((item) => item.id !== id));
});
export type Listed = { items: Default<Owned<Item[], typeof removeItem>, []> };
export default pattern(() => {
  ${declaration}
  return ${result};
});`,
          { types: COMMONFABRIC_TYPES, typeCheck: true },
        ),
      );
    // Each item's button hands the captured list to its handler as a
    // shorthand property.
    const list = `{
    [UI]: <ul>{items.map((item) => <li><button type="button" onClick={removeItem({ items, id: item.id })}>Remove</button></li>)}</ul>,
  }`;
    const count = `{ count: computed(() => items.get().length) }`;
    const callbackSchema = (root: ts.SourceFile) =>
      emittedSchemas(root).find(({ properties }) =>
        typeof properties === "object" && properties !== null &&
        "params" in properties
      );
    const ownerPolicy = {
      writeAuthorizedBy: { __ctWriterIdentityOf: { path: ["removeItem"] } },
      ownerPrincipal: { __ctCurrentPrincipal: true },
      addIntegrity: [{
        kind: "represents-principal",
        subject: { __ctCurrentPrincipal: true },
      }],
    };
    const callbackKeepsPolicy = (root: ts.SourceFile) =>
      expect(callbackSchema(root)).toMatchObject({
        properties: {
          params: { properties: { items: { ifc: ownerPolicy } } },
        },
      });
    const computedKeepsPolicy = (root: ts.SourceFile) =>
      expect(callSchemas(root, "lift")[0]).toMatchObject({
        properties: { items: { ifc: ownerPolicy } },
      });

    it("keeps the cell's writer beside its owner in a list callback's parameters", async () => {
      callbackKeepsPolicy(await transform(list));
    });

    it("keeps the cell's writer beside its owner in a computed value's input", async () => {
      computedKeepsPolicy(await transform(count));
    });

    it("keeps the writer a declaration's annotation names on a capture written as a shorthand property", async () => {
      callbackKeepsPolicy(
        await transform(
          list,
          `const items: Writable<Owned<Item[], typeof removeItem>> = new Writable<Owned<Item[], typeof removeItem>>([]).for("items");`,
        ),
      );
    });

    describe("a cell a constructor's `of()` makes", () => {
      const made =
        `const items = Writable.of<Owned<Item[], typeof removeItem>>([]);`;

      it("keeps the cell's writer in a list callback's parameters", async () => {
        callbackKeepsPolicy(await transform(list, made));
      });

      it("keeps the cell's writer in a computed value's input", async () => {
        computedKeepsPolicy(await transform(count, made));
      });

      it("keeps the cell's writer in the pattern's result", async () => {
        expect(
          patternSchemas(await transform(`{ items }`, made)).output,
        ).toMatchObject({ properties: { items: { ifc: ownerPolicy } } });
      });
    });

    describe("a cell the `cell<T>()` function makes", () => {
      const made = `const items = cell<Owned<Item[], typeof removeItem>>([]);`;

      it("keeps the cell's writer in a list callback's parameters", async () => {
        callbackKeepsPolicy(await transform(list, made));
      });

      it("keeps the cell's writer in a computed value's input", async () => {
        computedKeepsPolicy(await transform(count, made));
      });

      it("keeps the cell's writer where the function is named through a namespace import", async () => {
        computedKeepsPolicy(
          await transform(
            count,
            `const items = CF.cell<Owned<Item[], typeof removeItem>>([]);`,
          ),
        );
      });

      it("keeps the writer of a cell its writer alone protects", async () => {
        const root = await transform(
          count,
          `const items = cell<WriteAuthorizedBy<Item[], typeof removeItem>>([]);`,
        );
        expect(callSchemas(root, "lift")[0]).toMatchObject({
          properties: {
            items: {
              ifc: {
                writeAuthorizedBy: {
                  __ctWriterIdentityOf: { path: ["removeItem"] },
                },
              },
            },
          },
        });
      });
    });

    it("does not follow a property of an object literal that a later spread may replace", async () => {
      // The spread can supply another `items`, so the property is not the
      // value the binding receives, and its writer is not the binding's.
      const root = await transform(
        count,
        `const { items } = { items: new Writable<Owned<Item[], typeof removeItem>>([]).for("items"), ...{} };`,
      );
      const items = (callSchemas(root, "lift")[0] as {
        properties?: { items?: { ifc?: Record<string, unknown> } };
      }).properties?.items;
      expect(items?.ifc?.writeAuthorizedBy).toBeUndefined();
    });

    it("keeps the writer of a cell whose value may be missing on its value member", async () => {
      const root = await transform(
        `{ count: computed(() => items.get()?.length ?? 0) }`,
        `const items = new Writable<Owned<Item[], typeof removeItem> | undefined>(undefined).for("items");`,
      );
      expect(callSchemas(root, "lift")[0]).toMatchObject({
        properties: {
          items: {
            anyOf: expect.arrayContaining([
              expect.objectContaining({
                ifc: {
                  ...ownerPolicy,
                  writeAuthorizedBy: {
                    __ctWriterIdentityOf: {
                      file: "/test.tsx",
                      path: ["removeItem"],
                    },
                  },
                },
              }),
            ]),
          },
        },
      });
    });

    it("keeps the writer of a cell destructured straight out of an object literal", async () => {
      computedKeepsPolicy(
        await transform(
          count,
          `const { items } = { items: new Writable<Owned<Item[], typeof removeItem>>([]).for("items") };`,
        ),
      );
    });

    it("keeps the writer a declared member names on a value read from a wished result", async () => {
      const root = await transform(
        `{ count: computed(() => listed.result?.items.length ?? 0) }`,
        `const listed = wish<Listed>({ query: "#listed" });`,
      );
      // The result may be missing, so its schema is a union with `undefined`.
      expect(callSchemas(root, "lift")[0]).toMatchObject({
        properties: {
          listed: {
            properties: {
              result: {
                anyOf: expect.arrayContaining([
                  expect.objectContaining({
                    properties: {
                      items: expect.objectContaining({
                        ifc: {
                          ...ownerPolicy,
                          writeAuthorizedBy: {
                            __ctWriterIdentityOf: {
                              file: "/test.tsx",
                              path: ["removeItem"],
                            },
                          },
                        },
                      }),
                    },
                  }),
                ]),
              },
            },
          },
        },
      });
    });
  });
});
