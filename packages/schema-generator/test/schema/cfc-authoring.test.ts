import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";
import type { SchemaGenerationDiagnostic } from "../../src/interface.ts";
import { SchemaGenerator } from "../../src/schema-generator.ts";
import {
  asObjectSchema,
  createTestProgram,
  getTypeFromCode,
  getTypeFromFiles,
} from "../utils.ts";

describe("Schema: CFC authoring aliases", () => {
  it("pairs local alias arguments with their declared parameters", async () => {
    const { checker, sourceFile } = await createTestProgram(`
      type WriteAuthorizedBy<T, Writer> = T & { readonly __writer?: Writer };
      const save = () => {};
      function createName() {
        type Protected<T> = WriteAuthorizedBy<T, typeof save>;
        const name: Protected<string> = "";
        return name;
      }
    `);
    const scope = sourceFile.statements.find(ts.isFunctionDeclaration)!;
    const declaration = scope.body!.statements.find(ts.isVariableStatement)!
      .declarationList.declarations[0]!;
    const node = declaration.type!;
    const schema = new SchemaGenerator().generateSchema(
      checker.getTypeFromTypeNode(node),
      checker,
      node,
      { writerIdentityForSourceFile: (file) => ({ file }) },
    );

    expect(schema).toEqual({
      type: "string",
      ifc: {
        writeAuthorizedBy: {
          __ctWriterIdentityOf: { file: sourceFile.fileName, path: ["save"] },
        },
      },
    });
  });

  it("lowers AnyOf as one explicit confidentiality clause", async () => {
    const code = `
      type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
      type Confidential<T, X extends readonly unknown[]> = Cfc<T, { confidentiality: X }>;
      type AnyOf<X extends readonly unknown[]> = { readonly __ct_cfc_any_of__?: X };

      interface SchemaRoot {
        conjunctive: Confidential<string, readonly ["reader-a", "reader-b"]>;
        disjunctive: Confidential<string, readonly [AnyOf<readonly ["reader-a", "reader-b"]>]>;
      }
    `;

    const { type, checker } = await getTypeFromCode(code, "SchemaRoot");
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    expect((schema.properties?.conjunctive as any).ifc?.confidentiality)
      .toEqual(["reader-a", "reader-b"]);
    expect((schema.properties?.disjunctive as any).ifc?.confidentiality)
      .toEqual([{ anyOf: ["reader-a", "reader-b"] }]);
  });

  it("lowers renamed imports of PolicyOf and AnyOf", async () => {
    const { type, checker } = await getTypeFromFiles(
      {
        "/cfc-types.ts": `
          export type PolicyOf<Binding> = {
            readonly __ct_cfc_policy_of__?: Binding;
          };
          export type AnyOf<X extends readonly unknown[]> = {
            readonly __ct_cfc_any_of__?: X;
          };
        `,
        "/entry.ts": `
          import type { AnyOf as Or, PolicyOf as P } from "./cfc-types.ts";
          type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
          type Confidential<T, X extends readonly unknown[]> =
            Cfc<T, { confidentiality: X }>;
          declare const rules: unknown;

          interface SchemaRoot {
            policy: Confidential<string, readonly [P<typeof rules>]>;
            either: Confidential<string, readonly [
              Or<readonly ["reader-a", "reader-b"]>
            ]>;
          }
        `,
      },
      "/entry.ts",
      "SchemaRoot",
    );
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    expect((schema.properties?.policy as any).ifc?.confidentiality).toEqual([{
      type: "https://commonfabric.org/cfc/atom/Policy",
      policyRefKind: "module",
      __ctPolicyIdentityOf: { file: "/entry.ts", path: ["rules"] },
      subject: { __ctOwningSpace: true },
    }]);
    expect((schema.properties?.either as any).ifc?.confidentiality).toEqual([{
      anyOf: ["reader-a", "reader-b"],
    }]);
  });

  it("reads unrelated namespace metadata from its declaration", async () => {
    const { type, checker } = await getTypeFromFiles(
      {
        "/other.ts": `
          export type PolicyOf<T> = { label: "ordinary policy" };
          export type AnyOf<T> = { label: "ordinary choice" };
        `,
        "/entry.ts": `
          import * as other from "./other.ts";
          type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
          declare const rules: unknown;
          interface SchemaRoot {
            policy: Cfc<string, { confidentiality: [other.PolicyOf<typeof rules>] }>;
            choice: Cfc<string, { confidentiality: [other.AnyOf<["reader"]>] }>;
          }
        `,
      },
      "/entry.ts",
      "SchemaRoot",
    );
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );
    expect(schema.properties).toEqual({
      policy: {
        type: "string",
        ifc: { confidentiality: [{ label: "ordinary policy" }] },
      },
      choice: {
        type: "string",
        ifc: { confidentiality: [{ label: "ordinary choice" }] },
      },
    });
  });

  it("lowers qualified Common Fabric metadata through renamed re-exports", async () => {
    const { type, checker } = await getTypeFromFiles(
      {
        "/library/commonfabric.d.ts": `
          export type PolicyOf<T> = { readonly __ct_cfc_policy_of__?: T };
          export type AnyOf<T> = { readonly __ct_cfc_any_of__?: T };
        `,
        "/barrel.ts": `
          export type { PolicyOf as Policy, AnyOf as Choice } from "./library/commonfabric";
        `,
        "/entry.ts": `
          import * as cf from "./barrel.ts";
          type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
          declare const rules: unknown;
          interface SchemaRoot {
            policy: Cfc<string, { confidentiality: [cf.Policy<typeof rules>] }>;
            choice: Cfc<string, { confidentiality: [cf.Choice<["reader"]>] }>;
          }
        `,
      },
      "/entry.ts",
      "SchemaRoot",
    );
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );
    expect(schema.properties).toMatchObject({
      policy: {
        ifc: {
          confidentiality: [{
            type: "https://commonfabric.org/cfc/atom/Policy",
            policyRefKind: "module",
            __ctPolicyIdentityOf: { file: "/entry.ts", path: ["rules"] },
            subject: { __ctOwningSpace: true },
          }],
        },
      },
      choice: { ifc: { confidentiality: [{ anyOf: ["reader"] }] } },
    });
  });

  it("reads a qualified metadata wrapper's fixed policy binding", async () => {
    const { type, checker } = await getTypeFromFiles(
      {
        "/library/commonfabric.d.ts": `
          export type PolicyOf<T> = { readonly __ct_cfc_policy_of__?: T };
        `,
        "/wrapper.ts": `
          import * as cf from "./library/commonfabric";
          export declare const fixedRules: unknown;
          export type PolicyOf<T> = cf.PolicyOf<typeof fixedRules>;
        `,
        "/entry.ts": `
          import * as wrapped from "./wrapper.ts";
          type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
          declare const unrelatedRules: unknown;
          interface SchemaRoot {
            policy: Cfc<string, { confidentiality: [wrapped.PolicyOf<typeof unrelatedRules>] }>;
          }
        `,
      },
      "/entry.ts",
      "SchemaRoot",
    );
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );
    expect(schema.properties).toMatchObject({
      policy: {
        ifc: {
          confidentiality: [{
            __ctPolicyIdentityOf: { file: "/wrapper.ts", path: ["fixedRules"] },
          }],
        },
      },
    });
  });

  it("lowers Confidential and projection aliases through the canonical Cfc carrier", async () => {
    const code = `
      type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
      type Confidential<T, X extends readonly unknown[]> = Cfc<T, { confidentiality: X }>;
      type ProjectionPath<T, From extends string, Path extends readonly unknown[]> = Cfc<T, { projection: { from: From; path: Path } }>;
      type ProjectionOf<Root, PathTuple extends readonly unknown[]> = ProjectionPath<Root, "/", PathTuple>;
      type Ref<Root, Path extends readonly unknown[]> = {
        readonly __ct_ref_root__?: Root;
        readonly __ct_ref_path__?: Path;
      };
      type Projection<SourceRef> = SourceRef extends Ref<
        infer Root,
        infer Path extends readonly unknown[]
      > ? ProjectionOf<Root, Path> : never;

      interface SchemaRoot {
        secret: Confidential<string, readonly ["secret"]>;
        projectionOf: ProjectionOf<{ title: string }, readonly ["title"]>;
        projectionPath: ProjectionPath<{ title: string }, "/source", readonly ["nested", "path"]>;
        projection: Projection<Ref<{ title: string }, readonly ["nested", "path"]>>;
      }
    `;

    const { type, checker } = await getTypeFromCode(code, "SchemaRoot");
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    const secret = schema.properties?.secret as any;
    expect(secret.type).toBe("string");
    expect(secret.ifc?.confidentiality).toEqual(["secret"]);

    const projectionOf = schema.properties?.projectionOf as any;
    expect(projectionOf.type).toBe("object");
    expect(projectionOf.properties?.title?.type).toBe("string");
    expect(projectionOf.ifc?.projection).toEqual({
      from: "/",
      path: "/title",
    });

    const projectionPath = schema.properties?.projectionPath as any;
    expect(projectionPath.type).toBe("object");
    expect(projectionPath.properties?.title?.type).toBe("string");
    expect(projectionPath.ifc?.projection).toEqual({
      from: "/source",
      path: "/nested/path",
    });

    const projection = schema.properties?.projection as any;
    expect(projection.type).toBe("object");
    expect(projection.properties?.title?.type).toBe("string");
    expect(projection.ifc?.projection).toEqual({
      from: "/",
      path: "/nested/path",
    });
  });

  it("lowers a canonical alias a conditional user alias resolves to from its own arguments", async () => {
    const { type, checker } = await getTypeFromCode(
      `
      type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
      type Confidential<T, X extends readonly unknown[]> = Cfc<T, { confidentiality: X }>;
      type Pick2<A, B> = A extends string ? Confidential<B, readonly ["x"]> : never;
      interface SchemaRoot {
        direct: Confidential<{ v: string }, readonly ["x"]>;
        picked: Pick2<"s", { v: string }>;
      }
    `,
      "SchemaRoot",
    );
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    expect(schema.properties?.picked).toEqual(schema.properties?.direct);
  });

  it("reads the writer a conditional alias passes to `WriteAuthorizedBy` as its branch writes it", async () => {
    const { type, checker } = await getTypeFromCode(
      `
      type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
      type WriteAuthorizedBy<T, Binding> = Cfc<T, { writeAuthorizedBy: Binding }>;
      type Guarded<X, B> = X extends string ? WriteAuthorizedBy<X, B> : never;
      type Swapped<B, X> = X extends string ? WriteAuthorizedBy<X, B> : never;
      type Crossed<A, B> = B extends unknown ? WriteAuthorizedBy<string, A> : never;
      function save() {}
      function other() {}
      interface SchemaRoot {
        direct: WriteAuthorizedBy<string, typeof save>;
        guarded: Guarded<string, typeof save>;
        swapped: Swapped<typeof save, string>;
        crossed: Crossed<typeof save, typeof other>;
        directNarrowed: WriteAuthorizedBy<"a", typeof save>;
        distributed: Guarded<"a" | 1, typeof save>;
      }
    `,
      "SchemaRoot",
    );
    const diagnostics: SchemaGenerationDiagnostic[] = [];
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker, undefined, {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    );

    expect(schema.properties?.direct).toEqual({
      type: "string",
      ifc: {
        writeAuthorizedBy: {
          __ctWriterIdentityOf: { file: "test.ts", path: ["save"] },
        },
      },
    });
    for (const alias of ["guarded", "swapped", "crossed"]) {
      expect(schema.properties?.[alias]).toEqual(schema.properties?.direct);
    }
    // The checked `X` reaches the policy one member at a time, so its payload
    // is `"a"`, as the checker distributes it, not the `"a" | 1` written.
    expect(schema.properties?.distributed).toEqual(
      schema.properties?.directNarrowed,
    );
    expect(diagnostics).toEqual([]);
  });

  it("reports a writer binding it cannot read as an error", async () => {
    // `Checked<B>` distributes over `B`, so the binding the policy receives is
    // read from its type, with no node to read a writer from. Which branch of
    // `Either` the checker took is not written anywhere a node could say.
    const { type, checker } = await getTypeFromCode(
      `
      type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
      type WriteAuthorizedBy<T, Binding> = Cfc<T, { writeAuthorizedBy: Binding }>;
      type Checked<B> = B extends unknown ? WriteAuthorizedBy<string, B> : never;
      type Either<X, B, C> = X extends string
        ? WriteAuthorizedBy<X, B>
        : WriteAuthorizedBy<X, C>;
      function save() {}
      function other() {}
      interface SchemaRoot {
        checked: Checked<typeof save>;
        either: Either<number, typeof save, typeof other>;
      }
    `,
      "SchemaRoot",
    );
    const diagnostics: SchemaGenerationDiagnostic[] = [];
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker, undefined, {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      }),
    );

    expect(schema.properties?.checked).toEqual({ type: "string" });
    expect(schema.properties?.either).toEqual({ type: "number" });
    expect(
      diagnostics.map((diagnostic) => [diagnostic.severity, diagnostic.type]),
    ).toEqual([
      ["error", "cfc-write-authorized-by:unread"],
      ["error", "cfc-write-authorized-by:unread"],
    ]);
    expect(diagnostics[0]!.message).toContain("`WriteAuthorizedBy`");
  });

  it("does not treat a type-only argument as an authored indirect writer binding", async () => {
    const { type, checker } = await getTypeFromCode(
      `
      type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
      type WriteAuthorizedBy<T, Binding> = Cfc<T, { writeAuthorizedBy: Binding }>;
      type Protected<T, Binding> = Cfc<
        WriteAuthorizedBy<T, Binding>,
        { confidentiality: readonly ["private"] }
      >;
      function save() {}
      type SchemaRoot = Protected<string, typeof save>;
    `,
      "SchemaRoot",
    );
    const diagnostics: SchemaGenerationDiagnostic[] = [];
    new SchemaGenerator().generateSchema(type, checker, undefined, {
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });

    expect(diagnostics).toEqual([]);
  });

  it("reports nothing for a policy read from a type alone, which has no reference to spell a binding in", async () => {
    const { type, checker } = await getTypeFromCode(
      `
      type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
      type WriteAuthorizedBy<T, Binding> = Cfc<T, { writeAuthorizedBy: Binding }>;
      type Checked<B> = B extends unknown ? WriteAuthorizedBy<string, B> : never;
      function save() {}
      type SchemaRoot = Checked<typeof save>;
    `,
      "SchemaRoot",
    );
    const diagnostics: SchemaGenerationDiagnostic[] = [];
    const schema = new SchemaGenerator().generateSchema(
      type,
      checker,
      undefined,
      {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      },
    );

    expect(schema).toEqual({ type: "string" });
    expect(diagnostics).toEqual([]);
  });

  it("lowers a policy whose reduced type lost its name from the reference that names it", async () => {
    // `null & carrier` is nothing, so the checker reduces each policy below to
    // its other members, `none` to `never`, with no alias name left.
    const { type, checker } = await getTypeFromCode(
      `
      type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
      type Confidential<T, X extends readonly unknown[]> = Cfc<T, { confidentiality: X }>;
      type WriteAuthorizedBy<T, Binding> = Cfc<T, { writeAuthorizedBy: Binding }>;
      function save() {}
      interface SchemaRoot {
        single: Confidential<string | null, readonly ["a"]>;
        several: Confidential<string | number | null, readonly ["a"]>;
        none: Confidential<null, readonly ["a"]>;
        nothing: Confidential<never, readonly ["a"]>;
        impossible: Confidential<string & number, readonly ["a"]>;
        writer: WriteAuthorizedBy<string | null, typeof save>;
      }
    `,
      "SchemaRoot",
    );
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    const ifc = { confidentiality: ["a"] };
    expect(schema.properties?.single).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
      ifc,
    });
    expect(schema.properties?.several).toEqual({
      type: ["null", "number", "string"],
      ifc,
    });
    expect(schema.properties?.none).toEqual({ type: "null", ifc });
    // A payload that is itself `never` accepts nothing, and its `false`
    // becomes `{ not: true }` beside the labels.
    expect(schema.properties?.nothing).toEqual({ not: true, ifc });
    expect(schema.properties?.impossible).toEqual({ not: true, ifc });
    expect(schema.properties?.writer).toEqual({
      anyOf: [{ type: "string" }, { type: "null" }],
      ifc: {
        writeAuthorizedBy: {
          __ctWriterIdentityOf: { file: "test.ts", path: ["save"] },
        },
      },
    });
  });

  it("emits `{ not: true, ifc }` for a generic alias of a policy read at `never`", async () => {
    // `never & carrier` is `never`, so the checker gives the alias the type of
    // its payload. The payload accepts nothing, and its `false` becomes
    // `{ not: true }` beside the labels.
    const { type, checker } = await getTypeFromCode(
      `
      type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
      type Confidential<T, X extends readonly unknown[]> = Cfc<T, { confidentiality: X }>;
      type Sec<T> = Confidential<T, readonly ["a"]>;
      interface SchemaRoot {
        nothing: Sec<never>;
        later: never;
      }
    `,
      "SchemaRoot",
    );

    expect(new SchemaGenerator().generateSchema(type, checker)).toEqual({
      type: "object",
      properties: {
        nothing: { not: true, ifc: { confidentiality: ["a"] } },
        later: false,
      },
      required: ["nothing", "later"],
    });
  });

  it("reads a policy's carriers in full, or not at all, when no reference names it", async () => {
    // Read from a type alone, a policy whose alias name is gone has only its
    // carriers, which hold its metadata as types. A writer binding is a
    // `typeof` no type spells, and an `ownerPrincipal` without its
    // `writeAuthorizedBy` would claim what the author never wrote alone, so
    // such carriers are not read at all. `NonNullable<…>` intersects with
    // `{}`, which drops the name as a reduction does.
    const { type, checker } = await getTypeFromCode(
      `
      type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
      type Confidential<T, X extends readonly unknown[]> = Cfc<T, { confidentiality: X }>;
      type WriteAuthorizedBy<T, Binding> = Cfc<T, { writeAuthorizedBy: Binding }>;
      type CurrentPrincipal = { readonly __ctCurrentPrincipal: true };
      function save() {}
      type Labelled = Cfc<Confidential<string[], readonly ["a"]>, { ownerPrincipal: CurrentPrincipal }>;
      type Owned = Cfc<WriteAuthorizedBy<string[], typeof save>, { ownerPrincipal: CurrentPrincipal }>;
      interface SchemaRoot {
        labelled: NonNullable<Labelled | null>;
        owned: NonNullable<Owned | null>;
      }
    `,
      "SchemaRoot",
    );
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    const payload = { type: "array", items: { type: "string" } };
    expect(schema.properties?.labelled).toEqual({
      ...payload,
      ifc: {
        confidentiality: ["a"],
        ownerPrincipal: { __ctCurrentPrincipal: true },
      },
    });
    expect(schema.properties?.owned).toEqual(payload);
  });

  it("formats a projection reached through a user alias over the root its reference carries", async () => {
    const { type, checker } = await getTypeFromCode(
      `
      type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
      type ProjectionPath<T, From extends string, Path extends readonly unknown[]> = Cfc<T, { projection: { from: From; path: Path } }>;
      type ProjectionOf<Root, PathTuple extends readonly unknown[]> = ProjectionPath<Root, "/", PathTuple>;
      type Ref<Root, Path extends readonly unknown[]> = {
        readonly __ct_ref_root__?: Root;
        readonly __ct_ref_path__?: Path;
      };
      type Projection<SourceRef> = SourceRef extends Ref<
        infer Root,
        infer Path extends readonly unknown[]
      > ? ProjectionOf<Root, Path> : never;
      type MyProjection<R> = Projection<R>;
      type TitleOf<T> = Projection<Ref<T, readonly ["title"]>>;
      declare const ref: Ref<{ title: string }, readonly ["nested", "path"]>;

      interface SchemaRoot {
        direct: Projection<Ref<{ title: string }, readonly ["nested", "path"]>>;
        aliased: MyProjection<Ref<{ title: string }, readonly ["nested", "path"]>>;
        directFromValue: Projection<typeof ref>;
        aliasedFromValue: MyProjection<typeof ref>;
        directWithoutRoot: Projection<{ title: string }>;
        aliasedWithoutRoot: MyProjection<{ title: string }>;
        directBuilt: Projection<Ref<{ title: string }, readonly ["title"]>>;
        aliasedBuilt: TitleOf<{ title: string }>;
        directUnion: Projection<Ref<{ title: string }, readonly ["title"]> | undefined>;
        aliasedUnion: MyProjection<Ref<{ title: string }, readonly ["title"]> | undefined>;
        directNullable: Projection<Ref<{ title: string } | null, readonly []>>;
        aliasedNullable: MyProjection<Ref<{ title: string } | null, readonly []>>;
      }
    `,
      "SchemaRoot",
    );
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    expect(schema.properties?.aliased).toEqual(schema.properties?.direct);
    expect(schema.properties?.aliasedFromValue).toEqual(
      schema.properties?.directFromValue,
    );
    expect(schema.properties?.aliasedWithoutRoot).toEqual(
      schema.properties?.directWithoutRoot,
    );
    expect(schema.properties?.directWithoutRoot).toBe(false);
    for (const form of ["Built", "Union", "Nullable"]) {
      expect(schema.properties?.[`aliased${form}`]).toEqual(
        schema.properties?.[`direct${form}`],
      );
    }
    expect(schema.properties?.aliasedBuilt).toEqual(
      schema.properties?.aliasedUnion,
    );

    expect(schema.properties?.directFromValue).toEqual(
      schema.properties?.direct,
    );
    expect(schema.properties?.direct).toEqual({
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      ifc: { projection: { from: "/", path: "/nested/path" } },
    });
    expect(schema.properties?.directBuilt).toEqual({
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      ifc: { projection: { from: "/", path: "/title" } },
    });
  });

  it("expands nested aliases before lowering canonical Cfc metadata", async () => {
    const code = `
      type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
      type Confidential<T, X extends readonly unknown[]> = Cfc<T, { confidentiality: X }>;
      type SecretText<T> = Confidential<T, readonly ["secret"]>;

      interface SchemaRoot {
        secret: SecretText<{ value: string }>;
      }
    `;

    const { type, checker } = await getTypeFromCode(code, "SchemaRoot");
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    const secret = schema.properties?.secret as any;
    expect(secret.type).toBe("object");
    expect(secret.properties?.value?.type).toBe("string");
    expect(secret.ifc?.confidentiality).toEqual(["secret"]);
  });

  it("preserves CFC metadata under writable cell wrappers", async () => {
    const code = `
      type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
      type Confidential<T, X extends readonly unknown[]> = Cfc<T, { confidentiality: X }>;

      interface SchemaRoot {
        labeled: Writable<Confidential<string, readonly ["prompt-influence"]>>;
      }
    `;

    const { type, checker } = await getTypeFromCode(code, "SchemaRoot");
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    const labeled = schema.properties?.labeled as any;
    expect(labeled.type).toBe("string");
    expect(labeled.asCell).toEqual(["cell"]);
    expect(labeled.ifc?.confidentiality).toEqual(["prompt-influence"]);
  });

  it("lowers the remaining canonical metadata aliases and merges nested Cfc metadata", async () => {
    // The collection/opaque aliases below are NOT canonical (the helpers were
    // removed from @commonfabric/api/cfc because the runner rejects those ifc
    // keys fail-closed) — with explicit type arguments they resolve through
    // the Cfc carrier as plain payload passthrough, which is the structural
    // mechanism this test covers alongside the remaining canonical aliases.

    const code = `
      type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
      type Confidential<T, X extends readonly unknown[]> = Cfc<T, { confidentiality: X }>;
      type Integrity<T, X extends readonly unknown[]> = Cfc<T, { integrity: X }>;
      type AddIntegrity<T, X extends readonly unknown[]> = Cfc<T, { addIntegrity: X }>;
      type RepresentsCurrentUser<T> = Cfc<T, { addIntegrity: readonly [{ kind: "represents-principal"; subject: { __ctCurrentPrincipal: true } }] }>;
      type AuthoredByCurrentUser<T> = Cfc<T, { addIntegrity: readonly [{ kind: "authored-by"; subject: { __ctCurrentPrincipal: true } }] }>;
      type RequiresIntegrity<T, X extends readonly unknown[]> = Cfc<T, { requiredIntegrity: X }>;
      type MaxConfidentiality<T, X extends readonly unknown[]> = Cfc<T, { maxConfidentiality: X }>;
      type ExactCopy<T, P extends string> = Cfc<T, { exactCopyOf: P }>;
      type LengthPreservedFrom<T, P extends string> = Cfc<T, { collection: { sourceCollection: P; lengthPreserved: true } }>;
      type FilteredFrom<T, P extends string> = Cfc<T, { collection: { filteredFrom: P } }>;
      type SubsetOf<T, P extends string> = Cfc<T, { collection: { subsetOf: P } }>;
      type PermutationOf<T, P extends string> = Cfc<T, { collection: { permutationOf: P } }>;
      type OpaqueInput<T, Spec extends true | { schema?: unknown; allowPassThrough?: boolean } = true> = Cfc<T, { opaque: Spec }>;

      interface SchemaRoot {
        confidential: Confidential<string, readonly ["confidential"]>;
        integrity: Integrity<string, readonly ["integrity"]>;
        addIntegrity: AddIntegrity<string, readonly ["add-integrity"]>;
        representsCurrentUser: RepresentsCurrentUser<{ name: string }>;
        authoredByCurrentUser: AuthoredByCurrentUser<{ body: string }>;
        requiresIntegrity: RequiresIntegrity<string, readonly ["required-integrity"]>;
        maxConfidentiality: MaxConfidentiality<string, readonly ["max-confidentiality"]>;
        exactCopy: ExactCopy<string, "/source">;
        lengthPreserved: LengthPreservedFrom<string[], "/collection">;
        filteredFrom: FilteredFrom<string[], "/filtered">;
        subsetOf: SubsetOf<string[], "/subset">;
        permutationOf: PermutationOf<string[], "/permutation">;
        opaque: OpaqueInput<string, { schema: { type: "string" }; allowPassThrough: false }>;
        merged: Cfc<Confidential<{ value: string }, readonly ["nested"]>, { integrity: readonly ["outer"] }>;
      }
    `;

    const { type, checker } = await getTypeFromCode(code, "SchemaRoot");
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    expect((schema.properties?.confidential as any).ifc?.confidentiality)
      .toEqual([
        "confidential",
      ]);
    expect((schema.properties?.integrity as any).ifc?.integrity).toEqual([
      "integrity",
    ]);
    expect((schema.properties?.addIntegrity as any).ifc?.addIntegrity)
      .toEqual(["add-integrity"]);
    expect((schema.properties?.representsCurrentUser as any).ifc?.addIntegrity)
      .toEqual([{
        kind: "represents-principal",
        subject: { __ctCurrentPrincipal: true },
      }]);
    expect((schema.properties?.authoredByCurrentUser as any).ifc?.addIntegrity)
      .toEqual([{
        kind: "authored-by",
        subject: { __ctCurrentPrincipal: true },
      }]);
    expect((schema.properties?.requiresIntegrity as any).ifc?.requiredIntegrity)
      .toEqual(["required-integrity"]);
    expect(
      (schema.properties?.maxConfidentiality as any).ifc?.maxConfidentiality,
    )
      .toEqual(["max-confidentiality"]);
    expect((schema.properties?.exactCopy as any).ifc?.exactCopyOf)
      .toBe("/source");
    expect((schema.properties?.lengthPreserved as any).ifc?.collection).toEqual(
      {
        sourceCollection: "/collection",
        lengthPreserved: true,
      },
    );
    expect((schema.properties?.filteredFrom as any).ifc?.collection).toEqual({
      filteredFrom: "/filtered",
    });
    expect((schema.properties?.subsetOf as any).ifc?.collection).toEqual({
      subsetOf: "/subset",
    });
    expect((schema.properties?.permutationOf as any).ifc?.collection).toEqual({
      permutationOf: "/permutation",
    });
    expect((schema.properties?.opaque as any).ifc?.opaque).toEqual({
      schema: { type: "string" },
      allowPassThrough: false,
    });
    expect((schema.properties?.merged as any).ifc?.confidentiality).toEqual([
      "nested",
    ]);
    expect((schema.properties?.merged as any).ifc?.integrity).toEqual([
      "outer",
    ]);
    expect((schema.properties?.merged as any).properties?.value?.type).toBe(
      "string",
    );
  });

  it("preserves object-shaped integrity atoms authored through Cfc metadata", async () => {
    const code = `
      type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };

      interface Message {
        senderId: string;
        body: string;
      }

      interface SchemaRoot {
        message: Cfc<Message, { integrity: readonly [{ kind: "authored-by"; subject: "alice" }] }>;
      }
    `;

    const { type, checker } = await getTypeFromCode(code, "SchemaRoot");
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    expect((schema.properties?.message as any).ifc?.integrity).toEqual([{
      kind: "authored-by",
      subject: "alice",
    }]);
  });

  it("preserves object-shaped confidentiality atoms authored through canonical aliases", async () => {
    const code = `
      type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
      type Confidential<T, X extends readonly unknown[]> = Cfc<T, { confidentiality: X }>;

      interface SchemaRoot {
        body: Confidential<string, readonly [{
          type: "https://commonfabric.org/cfc/atom/Caveat";
          kind: "prompt-influence";
          source: "of:message";
        }]>;
      }
    `;

    const { type, checker } = await getTypeFromCode(code, "SchemaRoot");
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    expect((schema.properties?.body as any).ifc?.confidentiality).toEqual([{
      type: "https://commonfabric.org/cfc/atom/Caveat",
      kind: "prompt-influence",
      source: "of:message",
    }]);
  });

  it("preserves object-shaped confidentiality atoms referenced with typeof", async () => {
    const code = `
      type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
      type Confidential<T, X extends readonly unknown[]> = Cfc<T, { confidentiality: X }>;

      const HEALTH_RECORD_CONFIDENTIALITY = {
        type: "https://commonfabric.org/cfc/atom/Resource",
        class: "SensitiveHealthRecord",
        subject: "did:example:patient",
      } as const;

      interface SchemaRoot {
        body: Confidential<string, readonly [typeof HEALTH_RECORD_CONFIDENTIALITY]>;
      }
    `;

    const { type, checker } = await getTypeFromCode(code, "SchemaRoot");
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    expect((schema.properties?.body as any).ifc?.confidentiality).toEqual([{
      type: "https://commonfabric.org/cfc/atom/Resource",
      class: "SensitiveHealthRecord",
      subject: "did:example:patient",
    }]);
  });

  it("preserves primitive Cfc metadata through generic aliases", async () => {
    const code = `
      type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };

      type AuthorshipIntegrity<Author extends string> = {
        readonly kind: "authored-by";
        readonly subject: Author;
      };

      type AuthoredMessageBody<Author extends string> = Cfc<
        string,
        { integrity: readonly [AuthorshipIntegrity<Author>] }
      >;

      interface SchemaRoot {
        body: AuthoredMessageBody<"alice">;
      }
    `;

    const { type, checker } = await getTypeFromCode(code, "SchemaRoot");
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    const body = schema.properties?.body as any;
    expect(body.type).toBe("string");
    expect(body.ifc?.integrity).toEqual([{
      kind: "authored-by",
      subject: "alice",
    }]);
  });

  it("preserves tuple metadata through chained generic Cfc aliases", async () => {
    const code = `
      type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
      type WriteAuthorizedBy<T, Binding> = Cfc<T, { writeAuthorizedBy: Binding }>;

      type TrustedActionWriteWithIntegrity<
        T,
        Binding,
        Action extends string,
        Pattern extends string,
        Integrity extends readonly [string, ...string[]],
      > = Cfc<
        WriteAuthorizedBy<T, Binding>,
        {
          uiContract: {
            helper: "UiAction";
            action: Action;
            trustedPattern: Pattern;
            requiredEventIntegrity: Integrity;
          };
        }
      >;

      type TrustedActionWrite<
        T,
        Binding,
        Action extends string,
        Pattern extends string,
      > = TrustedActionWriteWithIntegrity<T, Binding, Action, Pattern, [Pattern]>;

      declare function handler<A, B>(fn: (argument: A, state: B) => void): { readonly __handler: [A, B] };
      interface Writable<T> {
        get(): T;
        set(value: T): void;
      }

      const TRUSTED_SAVE_ACTION = "TrustedSaveTitle";
      const TRUSTED_SAVE_SURFACE = "TrustedSaveSurface";
      const commitTrustedSaveTitle = handler<void, { title: Writable<string> }>(
        (_, { title }) => title.set(title.get().trim()),
      );

      interface SchemaRoot {
        savedTitle: TrustedActionWrite<
          string,
          typeof commitTrustedSaveTitle,
          typeof TRUSTED_SAVE_ACTION,
          typeof TRUSTED_SAVE_SURFACE
        >;
      }
    `;

    const { type, checker } = await getTypeFromCode(code, "SchemaRoot");
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    const savedTitle = schema.properties?.savedTitle as any;
    expect(savedTitle.type).toBe("string");
    expect(savedTitle.ifc?.uiContract).toEqual({
      helper: "UiAction",
      action: "TrustedSaveTitle",
      trustedPattern: "TrustedSaveSurface",
      requiredEventIntegrity: ["TrustedSaveSurface"],
    });
    expect(savedTitle.ifc?.writeAuthorizedBy).toEqual({
      __ctWriterIdentityOf: {
        file: "test.ts",
        path: ["commitTrustedSaveTitle"],
      },
    });
  });

  it("preserves imported writeAuthorizedBy binding declaration identity", async () => {
    const { type, checker } = await getTypeFromFiles(
      {
        "/trusted.ts": `
        export type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
        export type WriteAuthorizedBy<T, Binding> = Cfc<T, { writeAuthorizedBy: Binding }>;

        export type TrustedActionWriteWithIntegrity<
          T,
          Binding,
          Action extends string,
          Pattern extends string,
          Integrity extends readonly [string, ...string[]],
        > = Cfc<
          WriteAuthorizedBy<T, Binding>,
          {
            uiContract: {
              helper: "UiAction";
              action: Action;
              trustedPattern: Pattern;
              requiredEventIntegrity: Integrity;
            };
          }
        >;

        declare function handler<A, B>(fn: (argument: A, state: B) => void): { readonly __handler: [A, B] };
        interface Writable<T> {
          get(): T;
          set(value: T): void;
        }

        export const TRUSTED_SEND_ACTION = "TrustedSend";
        export const TRUSTED_SEND_SURFACE = "TrustedSendSurface";
        export const commitTrustedMessageSend = handler<void, { messages: Writable<string[]> }>(
          (_, { messages }) => messages.set([...messages.get(), "sent"]),
        );

        export type TrustedSentMessage = TrustedActionWriteWithIntegrity<
          { origin: "sent"; body: string },
          typeof commitTrustedMessageSend,
          typeof TRUSTED_SEND_ACTION,
          typeof TRUSTED_SEND_SURFACE,
          [typeof TRUSTED_SEND_SURFACE]
        >;

        export type SharedChatMessage =
          | TrustedSentMessage
          | { origin: "imported"; body: string };
      `,
        "/main.ts": `
        import type { SharedChatMessage } from "./trusted.ts";

        export interface SchemaRoot {
          messages: SharedChatMessage[];
        }
      `,
      },
      "/main.ts",
      "SchemaRoot",
    );
    const seenWriterSources: string[] = [];
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(
        type,
        checker,
        undefined,
        {
          writerIdentityForSourceFile: (fileName) => {
            seenWriterSources.push(fileName);
            return {
              file: `/authored${fileName}`,
              moduleIdentity: `identity:${fileName}`,
            };
          },
        },
      ),
    );

    const writeAuthorizedByClaims: unknown[] = [];
    const collectWriteAuthorizedBy = (value: unknown) => {
      if (!value || typeof value !== "object") {
        return;
      }
      const record = value as Record<string, any>;
      if (record.ifc?.writeAuthorizedBy) {
        writeAuthorizedByClaims.push(record.ifc.writeAuthorizedBy);
      }
      for (const child of Object.values(record)) {
        if (Array.isArray(child)) {
          child.forEach(collectWriteAuthorizedBy);
        } else {
          collectWriteAuthorizedBy(child);
        }
      }
    };
    collectWriteAuthorizedBy(schema);

    expect(writeAuthorizedByClaims).toContainEqual({
      __ctWriterIdentityOf: {
        file: "/authored/trusted.ts",
        path: ["commitTrustedMessageSend"],
        moduleIdentity: "identity:/trusted.ts",
      },
    });
    expect(seenWriterSources).toContain("/trusted.ts");
  });

  it("falls back to ordinary schema generation when a canonical alias expansion cannot be resolved", async () => {
    const code = `
      type OpaqueInput<T, Spec extends true | { schema?: unknown; allowPassThrough?: boolean } = true> = MaybeOpaque<T>;
      type MaybeOpaque<T> = T;

      interface SchemaRoot {
        value: OpaqueInput<{ title: string }>;
      }
    `;

    const { type, checker } = await getTypeFromCode(code, "SchemaRoot");
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    const value = schema.properties?.value as any;
    expect(value.type).toBe("object");
    expect(value.properties?.title?.type).toBe("string");
    expect(value.ifc).toBeUndefined();
  });

  it("reads an alias chain's payload holding an indexed access from the type the chain instantiates", async () => {
    // `Contact` names no parameter, but its expansion reaches `Secret`'s `T`
    // through an indexed access, which no reading of the declaration under
    // bindings reaches; the type `Contact` instantiates holds it.
    const code = `
      type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
      type Confidential<T, X extends readonly unknown[]> = Cfc<T, { confidentiality: X }>;
      type Secret<T extends { name: string }> =
        Confidential<{ name: T["name"] }, readonly ["owner"]>;
      type Contact = Secret<{ name: "Ada" }>;

      interface SchemaRoot {
        contact: Contact;
      }
    `;

    const { type, checker } = await getTypeFromCode(code, "SchemaRoot");
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    expect(schema.properties?.contact).toEqual({ $ref: "#/$defs/Contact" });
    expect(schema.$defs?.Contact).toEqual({
      type: "object",
      properties: { name: { type: "string", enum: ["Ada"] } },
      required: ["name"],
      ifc: { confidentiality: ["owner"] },
    });
  });

  it("keeps the labels of a payload's own alias where the chain is entered without argument nodes", async () => {
    // A type with no node, as a print that expands the alias leaves it, gives
    // the lowering no argument to substitute; the payload's own alias still
    // lowers its label.
    const { checker, sourceFile } = await createTestProgram(`
      type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
      type Confidential<T, X extends readonly unknown[]> = Cfc<T, { confidentiality: X }>;
      type Integrity<T, X extends readonly unknown[]> = Cfc<T, { integrity: X }>;
      type Owned<T> = Confidential<Integrity<T, readonly ["inner"]>, readonly ["outer"]>;
      interface Holder { value: Owned<string> }
    `);
    const holder = checker.getSymbolsInScope(
      sourceFile,
      ts.SymbolFlags.Interface,
    ).find((candidate) => candidate.name === "Holder")!;
    const value = checker.getDeclaredTypeOfSymbol(holder).getProperty(
      "value",
    )!;

    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(
        checker.getTypeOfSymbolAtLocation(value, sourceFile),
        checker,
      ),
    );

    expect(schema.ifc).toEqual({
      confidentiality: ["outer"],
      integrity: ["inner"],
    });
  });

  it("lowers a parenthesized label", async () => {
    const { type, checker } = await getTypeFromCode(
      `
      type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
      type Confidential<T, X extends readonly unknown[]> = Cfc<T, { confidentiality: X }>;
      interface SchemaRoot { t: Confidential<string, (readonly ["x"])> }
    `,
      "SchemaRoot",
    );
    const schema = asObjectSchema(
      new SchemaGenerator().generateSchema(type, checker),
    );

    expect(schema.properties?.t).toEqual({
      type: "string",
      ifc: { confidentiality: ["x"] },
    });
  });

  describe("a canonical alias written as another's payload", () => {
    // A canonical alias reached by its own name reads its payload from the
    // reference's own argument node. Read from its type alone, the payload
    // below loses a generic alias's argument, a label's `AnyOf` clause, and a
    // `WriteAuthorizedBy` binding.

    const ALIASES = `
      type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
      type Confidential<T, X extends readonly unknown[]> = Cfc<T, { confidentiality: X }>;
      type Integrity<T, X extends readonly unknown[]> = Cfc<T, { integrity: X }>;
      type AddIntegrity<T, X extends readonly unknown[]> = Cfc<T, { addIntegrity: X }>;
      type RequiresIntegrity<T, X extends readonly unknown[]> = Cfc<T, { requiredIntegrity: X }>;
      type WriteAuthorizedBy<T, Binding> = Cfc<T, { writeAuthorizedBy: Binding }>;
      type AnyOf<X extends readonly unknown[]> = { readonly __ct_cfc_any_of__?: X };
      type Sec<T> = Confidential<T, readonly ["a"]>;
      declare function handler<A, B>(fn: (argument: A, state: B) => void): { readonly __handler: [A, B] };
      export const toggle = handler<void, {}>(() => {});
    `;

    const generate = async (code: string) => {
      const { type, checker } = await getTypeFromCode(
        ALIASES + code,
        "SchemaRoot",
      );
      return asObjectSchema(
        new SchemaGenerator().generateSchema(type, checker),
      );
    };

    it("keeps the type of a generic alias in the payload", async () => {
      const schema = await generate(`
        interface SchemaRoot { t: Integrity<Sec<string>, readonly ["i"]> }
      `);
      expect(schema.properties?.t).toEqual({
        type: "string",
        ifc: { confidentiality: ["a"], integrity: ["i"] },
      });
    });

    it("keeps the type of a generic alias in the payload of an array's items", async () => {
      const schema = await generate(`
        interface SchemaRoot { t: Integrity<Sec<string>, readonly ["i"]>[] }
      `);
      expect((schema.properties?.t as any).items).toEqual({
        type: "string",
        ifc: { confidentiality: ["a"], integrity: ["i"] },
      });
    });

    it("lowers an `AnyOf` clause of a label in the payload", async () => {
      const schema = await generate(`
        interface SchemaRoot {
          t: Integrity<
            Confidential<string, readonly [AnyOf<readonly ["x", "y"]>]>,
            readonly ["i"]
          >;
        }
      `);
      expect((schema.properties?.t as any).ifc).toEqual({
        confidentiality: [{ anyOf: ["x", "y"] }],
        integrity: ["i"],
      });
    });

    it("keeps the write claim of a \`WriteAuthorizedBy\` in the payload, a union member's included", async () => {
      const schema = await generate(`
        type Flag =
          | AddIntegrity<WriteAuthorizedBy<true, typeof toggle>, readonly ["k"]>
          | WriteAuthorizedBy<false, typeof toggle>;
        interface SchemaRoot {
          t: AddIntegrity<WriteAuthorizedBy<string, typeof toggle>, readonly ["k"]>;
          flag: Flag;
        }
      `);
      const claimPath = (position: unknown) =>
        (position as any)?.ifc?.writeAuthorizedBy?.__ctWriterIdentityOf?.path;
      const flag = schema.$defs?.Flag as any;
      expect(claimPath(schema.properties?.t)).toEqual(["toggle"]);
      expect(flag.anyOf.map(claimPath)).toEqual([["toggle"], ["toggle"]]);
    });

    it("keeps a named type in the payload a reference to its definition", async () => {
      const schema = await generate(`
        type Secret = Confidential<{ v: string }, readonly ["a"]>;
        interface SchemaRoot {
          t: Integrity<Secret, readonly ["i"]>;
          s: Secret;
        }
      `);
      expect((schema.properties?.t as any).$ref).toBe("#/$defs/Secret");
    });

    describe("written inside a generic declaration", () => {
      // The argument nodes written there name the declaration's parameters,
      // which only the instantiation being formatted binds, so the payload's
      // value comes from its type.

      it("keeps the payload's instantiated type beside a nested label", async () => {
        const schema = await generate(`
          interface Box<T> {
            flag: RequiresIntegrity<AddIntegrity<T, readonly ["member"]>, readonly ["admin"]>;
          }
          type SchemaRoot = Box<boolean>;
        `);
        expect(schema.properties?.flag).toEqual({
          type: "boolean",
          ifc: { addIntegrity: ["member"], requiredIntegrity: ["admin"] },
        });
      });

      it("keeps the payload's instantiated type beside a nested write claim", async () => {
        const schema = await generate(`
          interface Box<T> {
            flag: RequiresIntegrity<WriteAuthorizedBy<T, typeof toggle>, readonly ["admin"]>;
          }
          type SchemaRoot = Box<boolean>;
        `);
        expect(schema.properties?.flag).toEqual({
          type: "boolean",
          ifc: {
            writeAuthorizedBy: {
              __ctWriterIdentityOf: { file: "test.ts", path: ["toggle"] },
            },
            requiredIntegrity: ["admin"],
          },
        });
      });

      it("reads a nested label the declaration's parameter names from the instantiation", async () => {
        const schema = await generate(`
          interface Box<T, L extends readonly unknown[]> {
            flag: RequiresIntegrity<AddIntegrity<T, L>, readonly ["admin"]>;
          }
          type SchemaRoot = Box<boolean, readonly ["member"]>;
        `);
        expect(schema.properties?.flag).toEqual({
          type: "boolean",
          ifc: { addIntegrity: ["member"], requiredIntegrity: ["admin"] },
        });
      });
    });
  });

  describe("an alias chain entered without argument nodes", () => {
    // A type whose print expands its alias, as a lift's or a capture's input
    // does, reaches the lowering with the alias's type arguments and no nodes.
    // Each parameter reads as its argument's type, not as the declaration's
    // own reference with the parameter unbound.

    const BASE_ALIASES = `
      type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
      type Confidential<T, X extends readonly unknown[]> = Cfc<T, { confidentiality: X }>;
      type RepresentsCurrentUser<T> = Cfc<T, { addIntegrity: readonly [{ kind: "represents-principal"; subject: { __ctCurrentPrincipal: true } }] }>;
      type Sec<T> = Confidential<T, readonly ["a"]>;
      interface Book { title: string }
    `;
    const ALIASES = BASE_ALIASES + `
      type AnyOf<X extends readonly unknown[]> = { readonly __ct_cfc_any_of__?: X };
    `;

    const generate = async (code: string, aliases = ALIASES) => {
      const { checker, sourceFile } = await createTestProgram(aliases + code);
      const holder = checker.getSymbolsInScope(
        sourceFile,
        ts.SymbolFlags.Interface,
      ).find((candidate) => candidate.name === "Holder")!;
      const value = checker.getDeclaredTypeOfSymbol(holder).getProperty(
        "value",
      )!;
      const diagnostics: SchemaGenerationDiagnostic[] = [];
      const schema = asObjectSchema(
        new SchemaGenerator().generateSchema(
          checker.getTypeOfSymbolAtLocation(value, sourceFile),
          checker,
          undefined,
          { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
        ),
      );
      return { schema, diagnostics };
    };

    it("keeps the type of a generic alias's payload", async () => {
      const { schema } = await generate(`
        interface Holder { value: Sec<Book[]> }
      `);
      expect(schema.type).toBe("array");
      expect(schema.items).toEqual({ $ref: "#/$defs/Book" });
      expect(schema.ifc).toEqual({ confidentiality: ["a"] });
    });

    it("keeps the type of a payload passed down a chain of generic aliases", async () => {
      const { schema } = await generate(`
        type Sec2<U> = Sec<U>;
        interface Holder { value: Sec2<number> }
      `);
      expect(schema).toEqual({
        type: "number",
        ifc: { confidentiality: ["a"] },
      });
    });

    it("keeps the type of a payload a parameter reaches through a nested alias", async () => {
      const { schema } = await generate(`
        type Owned<T> = RepresentsCurrentUser<Cfc<Sec<T>, { ownerPrincipal: "me" }>>;
        interface Holder { value: Owned<string> }
      `);
      expect(schema).toEqual({
        type: "string",
        ifc: {
          confidentiality: ["a"],
          ownerPrincipal: "me",
          addIntegrity: [{
            kind: "represents-principal",
            subject: { __ctCurrentPrincipal: true },
          }],
        },
      });
    });

    it("lowers a label passed as an argument, an `AnyOf` clause included", async () => {
      const { schema } = await generate(`
        type Labeled<L extends readonly unknown[]> = Confidential<string, L>;
        interface Holder {
          value: Labeled<readonly ["x", AnyOf<readonly ["y", "z"]>]>;
        }
      `);
      expect(schema.ifc).toEqual({
        confidentiality: ["x", { anyOf: ["y", "z"] }],
      });
    });

    it("reads an authored type named `AnyOf` in a label as its own", async () => {
      const { schema } = await generate(
        `
        type AnyOf<T> = { label: "ordinary choice" };
        type Labeled<L extends readonly unknown[]> = Confidential<string, L>;
        interface Holder { value: Labeled<readonly [AnyOf<["reader"]>]> }
      `,
        BASE_ALIASES,
      );
      expect(schema.ifc).toEqual({
        confidentiality: [{ label: "ordinary choice" }],
      });
    });

    it("reads a namespace member named `AnyOf` in a label as its own", async () => {
      const { schema } = await generate(`
        namespace Ordinary {
          export type AnyOf<X> = { label: "ordinary" };
        }
        interface Holder {
          value: Confidential<string, [Ordinary.AnyOf<["a", "b"]>]>;
        }
      `);
      expect(schema.ifc).toEqual({ confidentiality: [{ label: "ordinary" }] });
    });

    it("reads a union label element as its authored spelling does", async () => {
      const { schema } = await generate(`
        type Labeled<L extends readonly unknown[]> = Confidential<string, L>;
        interface Holder { value: Labeled<readonly ["a" | "b"]> }
      `);
      const { type, checker } = await getTypeFromCode(
        ALIASES + `
        interface SchemaRoot { t: Confidential<string, readonly ["a" | "b"]> }
      `,
        "SchemaRoot",
      );
      const authored = asObjectSchema(
        new SchemaGenerator().generateSchema(type, checker),
      );
      expect(schema.ifc).toEqual((authored.properties?.t as any)?.ifc);
      expect(schema.ifc).toEqual({ confidentiality: [undefined] });
    });

    it("reads an `AnyOf` brand whose member is required", async () => {
      const { schema } = await generate(
        `
        type AnyOf<X extends readonly unknown[]> = { readonly __ct_cfc_any_of__: X };
        type Labeled<L extends readonly unknown[]> = Confidential<string, L>;
        interface Holder { value: Labeled<readonly [AnyOf<readonly ["x", "y"]>]> }
      `,
        BASE_ALIASES,
      );
      expect(schema.ifc).toEqual({
        confidentiality: [{ anyOf: ["x", "y"] }],
      });
    });

    it("reads a label element that is not a literal as its authored spelling does", async () => {
      const { schema } = await generate(`
        type Labeled<L extends readonly unknown[]> = Confidential<string, L>;
        interface Holder { value: Labeled<readonly [string]> }
      `);
      const { type, checker } = await getTypeFromCode(
        ALIASES + `
        interface SchemaRoot { t: Confidential<string, readonly [string]> }
      `,
        "SchemaRoot",
      );
      const authored = asObjectSchema(
        new SchemaGenerator().generateSchema(type, checker),
      );
      expect(schema.ifc).toEqual(
        (authored.properties?.t as any)?.ifc,
      );
    });

    it("keeps the type of a parenthesized alias payload", async () => {
      const { schema } = await generate(`
        type Outer<T> = Confidential<(Sec<T>), readonly ["b"]>;
        interface Holder { value: Outer<string> }
      `);
      expect(schema).toEqual({
        type: "string",
        ifc: { confidentiality: ["a", "b"] },
      });
    });

    it("lowers a label holding a parameter", async () => {
      const { schema } = await generate(`
        type Tagged<X> = Confidential<string, readonly [X]>;
        interface Holder { value: Tagged<"x"> }
      `);
      expect(schema.ifc).toEqual({ confidentiality: ["x"] });
    });

    it("reads a payload holding a parameter from the type it instantiates", async () => {
      const { schema, diagnostics } = await generate(`
        type Many<T> = Confidential<T[], readonly ["a"]>;
        interface Holder { value: Many<string> }
      `);
      expect(schema).toEqual({
        type: "array",
        items: { type: "string" },
        ifc: { confidentiality: ["a"] },
      });
      expect(diagnostics).toEqual([]);
    });

    it("reads an intersection payload with its parameter bound to its argument", async () => {
      // The instantiation of an intersection payload has two members beside
      // the metadata carrier, so the declaration is read with `T` bound.
      const { schema, diagnostics } = await generate(`
        type Tagged<T> = Confidential<{ value: T } & { tag: string }, readonly ["a"]>;
        interface Holder { value: Tagged<string> }
      `);
      expect(schema).toEqual({
        type: "object",
        properties: { value: { type: "string" }, tag: { type: "string" } },
        required: ["value", "tag"],
        ifc: { confidentiality: ["a"] },
      });
      expect(diagnostics).toEqual([]);
    });

    it("reports a payload holding a parameter it cannot read, and keeps its structure", async () => {
      // `T["name"]` is a type the checker defers, which a bound `T` does not
      // reach.
      const { schema, diagnostics } = await generate(`
        type Named<T extends { name: unknown }> =
          Confidential<{ value: T["name"] } & { tag: string }, readonly ["a"]>;
        interface Holder { value: Named<{ name: string }> }
      `);
      expect(schema).toEqual({
        type: "object",
        properties: { value: {}, tag: { type: "string" } },
        required: ["value", "tag"],
        ifc: { confidentiality: ["a"] },
      });
      expect(diagnostics.map((diagnostic) => diagnostic.type)).toEqual([
        "schema-type:unread",
      ]);
      expect(diagnostics[0]!.message).toContain('`T["name"]`');
    });

    it("keeps the labels nested in a payload that holds a parameter", async () => {
      const { schema } = await generate(`
        type Outer<T> = Confidential<{
          data: T;
          secret: Confidential<string, readonly ["secret"]>;
        }, readonly ["outer"]>;
        interface Holder { value: Outer<number> }
      `);
      expect(schema.properties?.secret).toEqual({
        type: "string",
        ifc: { confidentiality: ["secret"] },
      });
      expect(schema.ifc).toEqual({ confidentiality: ["outer"] });
    });

    it("lowers an empty label passed as an argument, or as a default", async () => {
      const passed = await generate(`
        type Labeled<L extends readonly unknown[]> = Confidential<string, L>;
        interface Holder { value: Labeled<readonly []> }
      `);
      const defaulted = await generate(`
        type Labeled<L extends readonly unknown[] = readonly []> =
          Confidential<string, L>;
        interface Holder { value: Labeled }
      `);
      expect(passed.schema.ifc).toEqual({ confidentiality: [] });
      expect(defaulted.schema.ifc).toEqual({ confidentiality: [] });
    });
  });

  describe("a label the lowering cannot read", () => {
    // A label list the lowering reads only in part lowers as no label, or with
    // a `null` atom; the generator reports it instead of saying nothing.

    const ALIASES = `
      type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
      type Confidential<T, X extends readonly unknown[]> = Cfc<T, { confidentiality: X }>;
      type AnyOf<X extends readonly unknown[]> = { readonly __ct_cfc_any_of__?: X };
    `;

    const unreadLabels = async (code: string) => {
      const { type, checker } = await getTypeFromCode(
        ALIASES + code,
        "SchemaRoot",
      );
      const diagnostics: SchemaGenerationDiagnostic[] = [];
      new SchemaGenerator().generateSchema(type, checker, undefined, {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });
      const unread = diagnostics.filter((diagnostic) =>
        diagnostic.type === "cfc-label:unread"
      );
      // A warning: compilation goes on, with the label as far as it was read.
      expect(unread.map((diagnostic) => diagnostic.severity)).toEqual(
        unread.map(() => "warning"),
      );
      return unread.map((diagnostic) => diagnostic.message);
    };

    it("reports a union element, naming the label as written", async () => {
      const messages = await unreadLabels(`
        interface SchemaRoot { t: Confidential<string, readonly ["a" | "b"]> }
      `);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain(
        'A label of `Confidential` could not be read: `readonly ["a" | "b"]`',
      );
    });

    it("reports a union alternative of an `AnyOf` clause", async () => {
      const messages = await unreadLabels(`
        interface SchemaRoot {
          t: Confidential<string, readonly [AnyOf<readonly ["a" | "b"]>]>;
        }
      `);
      expect(messages).toHaveLength(1);
    });

    it("reports a label argument that is not a tuple", async () => {
      const messages = await unreadLabels(`
        interface SchemaRoot { t: Confidential<string, string[]> }
      `);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("`string[]`");
    });

    it("reports a label list inside a \`Cfc\` payload", async () => {
      const messages = await unreadLabels(`
        interface SchemaRoot {
          t: Cfc<string, { confidentiality: readonly ["a" | "b"] }>;
        }
      `);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("A label of `Cfc` could not be read");
    });

    it("reports a label read from a type alone, naming its type", async () => {
      const { checker, sourceFile } = await createTestProgram(
        ALIASES + `
        type Labeled<L extends readonly unknown[]> = Confidential<string, L>;
        interface Holder { value: Labeled<readonly ["a" | "b"]> }
      `,
      );
      const holder = checker.getSymbolsInScope(
        sourceFile,
        ts.SymbolFlags.Interface,
      ).find((candidate) => candidate.name === "Holder")!;
      const value = checker.getDeclaredTypeOfSymbol(holder).getProperty(
        "value",
      )!;
      const diagnostics: SchemaGenerationDiagnostic[] = [];
      new SchemaGenerator().generateSchema(
        checker.getTypeOfSymbolAtLocation(value, sourceFile),
        checker,
        undefined,
        { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
      );
      expect(
        diagnostics.map((diagnostic) => [diagnostic.severity, diagnostic.type]),
      ).toEqual([["warning", "cfc-label:unread"]]);
      expect(diagnostics[0]!.message).toContain('"a" | "b"');
    });

    it("reports an object atom holding a field it cannot read", async () => {
      const messages = await unreadLabels(`
        interface SchemaRoot {
          t: Confidential<string, readonly [{ kind: "k"; subject: "a" | "b" }]>;
        }
      `);
      expect(messages).toHaveLength(1);
    });

    it("reports a UI contract's event integrity inside a \`Cfc\` payload", async () => {
      const messages = await unreadLabels(`
        interface SchemaRoot {
          t: Cfc<string, {
            uiContract: {
              helper: "UiAction";
              action: "save";
              trustedPattern: "trusted";
              requiredEventIntegrity: readonly ["a" | "b"];
            };
          }>;
        }
      `);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toContain("A label of `Cfc` could not be read");
    });

    it("names a label substituted into an alias with its literals as written", async () => {
      // Substitution builds the label's outer node, which holds the parsed
      // literals of the alias and of the argument, here from two files.
      const { type, checker } = await getTypeFromFiles(
        {
          "/labels.ts": ALIASES.replaceAll("type ", "export type ") + `
            export type Wrapped<L> = Confidential<string, readonly ["fixed", L]>;
          `,
          "/main.ts": `
            import type { Wrapped } from "./labels.ts";
            interface SchemaRoot { t: Wrapped<"a" | "b"> }
          `,
        },
        "/main.ts",
        "SchemaRoot",
      );
      const diagnostics: SchemaGenerationDiagnostic[] = [];
      new SchemaGenerator().generateSchema(type, checker, undefined, {
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });

      expect(diagnostics.map((diagnostic) => diagnostic.severity)).toEqual([
        "warning",
      ]);
      expect(diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
        expect.stringContaining('`readonly ["fixed", "a" | "b"]`'),
      ]);
    });

    it("names a substituted label holding template literals as written", async () => {
      const messages = await unreadLabels(`
        type Wrapped<L> = Confidential<string, readonly ["fixed", L]>;
        interface SchemaRoot {
          plain: Wrapped<\`a\` | \`b\`>;
          spliced: Wrapped<\`prefix-\${"a" | "b"}\`>;
        }
      `);
      expect(messages).toEqual([
        expect.stringContaining('readonly ["fixed", \`a\` | \`b\`]'),
        expect.stringContaining('readonly ["fixed", \`prefix-\${"a" | "b"}\`]'),
      ]);
    });

    it("reports a trusted pattern it cannot read, standing for the event integrity", async () => {
      // With no \`requiredEventIntegrity\` of its own, the contract requires
      // its trusted pattern, whose name here is no literal.
      const messages = await unreadLabels(`
        type WriteAuthorizedBy<T, Binding> = Cfc<T, { writeAuthorizedBy: Binding }>;
        type TrustedActionUiContract<
          T,
          Action extends string,
          Pattern extends string,
        > = Cfc<T, {
          uiContract: {
            helper: "UiAction";
            action: Action;
            trustedPattern: Pattern;
            requiredEventIntegrity: [Pattern];
          };
        }>;
        type TrustedActionWrite<
          T,
          Binding,
          Action extends string,
          Pattern extends string,
        > = Cfc<WriteAuthorizedBy<T, Binding>, {
          uiContract: {
            helper: "UiAction";
            action: Action;
            trustedPattern: Pattern;
            requiredEventIntegrity: [Pattern];
          };
        }>;
        function save() {}
        interface SchemaRoot {
          contract: TrustedActionUiContract<string, "save", string>;
          write: TrustedActionWrite<string, typeof save, "save", string>;
          readable: TrustedActionUiContract<string, "save", "trusted">;
        }
      `);
      expect(messages).toEqual([
        expect.stringContaining("A label of `TrustedActionUiContract`"),
        expect.stringContaining("A label of `TrustedActionWrite`"),
      ]);
    });

    it("reports nothing for labels of every readable kind", async () => {
      const messages = await unreadLabels(`
        interface SchemaRoot {
          strings: Confidential<string, readonly ["a", "b"]>;
          objects: Confidential<string, readonly [{ kind: "k"; subject: "s" }]>;
          clause: Confidential<string, readonly [AnyOf<readonly ["x", "y"]>]>;
          empty: Confidential<string, readonly []>;
          carrier: Cfc<string, { confidentiality: readonly ["c"] }>;
          contract: Cfc<string, {
            uiContract: {
              helper: "UiAction";
              action: "save";
              trustedPattern: "trusted";
              requiredEventIntegrity: readonly ["trusted"];
            };
          }>;
        }
      `);
      expect(messages).toEqual([]);
    });
  });

  describe("a union member that stands for several members", () => {
    /**
     * The schema of `SchemaRoot`'s `field`, declared as `declaration`, and
     * the diagnostics its generation reports.
     */
    const generated = async (declaration: string) => {
      const { type, checker } = await getTypeFromCode(
        `
        type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
        type Confidential<T, X extends readonly unknown[]> =
          Cfc<T, { confidentiality: X }>;
        type PolicyOf<Binding> = { readonly __ct_cfc_policy_of__?: Binding };
        declare const rules: unknown;
        declare const rules2: unknown;
        interface A { a: string }
        interface B { b: number }
        type Both =
          | Confidential<A, readonly [PolicyOf<typeof rules>]>
          | Confidential<B, readonly [PolicyOf<typeof rules>]>;
        type Shape = A | B;
        declare const DEFAULT_MARKER: unique symbol;
        type DefaultMarker<T> = { readonly [DEFAULT_MARKER]: T };
        type Default<T, V extends T = T> = (T & DefaultMarker<V>) | T;
        interface Host { name?: string }
        const DEFAULT_HOST: Host = {};
        type HostValue = Host | Default<typeof DEFAULT_HOST>;
        interface SchemaRoot { field: ${declaration} }
      `,
        "SchemaRoot",
      );
      const diagnostics: SchemaGenerationDiagnostic[] = [];
      const schema = asObjectSchema(
        new SchemaGenerator().generateSchema(type, checker, undefined, {
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        }),
      );
      return { field: schema.properties?.field, diagnostics };
    };

    /** The schema of `SchemaRoot`'s `field`, declared as `declaration`. */
    const fieldSchema = async (declaration: string) =>
      (await generated(declaration)).field;

    const POLICY = {
      type: "https://commonfabric.org/cfc/atom/Policy",
      policyRefKind: "module",
      __ctPolicyIdentityOf: { file: "test.ts", path: ["rules"] },
      subject: { __ctOwningSpace: true },
    };
    const POLICY_2 = {
      ...POLICY,
      __ctPolicyIdentityOf: { file: "test.ts", path: ["rules2"] },
    };

    it("keeps a CFC alias's labels on the members of a union it distributes into", async () => {
      expect(
        await fieldSchema(
          "Confidential<A | B, readonly [PolicyOf<typeof rules>]> | null",
        ),
      ).toEqual({
        anyOf: [
          { type: "null" },
          {
            anyOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }],
            ifc: { confidentiality: [POLICY] },
          },
        ],
      });
    });

    it("reads each of two nodes that stand for the same members as an alternative of its own", async () => {
      // `rules` and `rules2` have one type, so the checker folds both labeled
      // unions into the same members, and only their nodes tell the policies
      // apart.
      const labeled = (binding: string) =>
        `Confidential<A | B, readonly [PolicyOf<typeof ${binding}>]>`;
      const alternative = (policy: typeof POLICY) => ({
        anyOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }],
        ifc: { confidentiality: [policy] },
      });

      expect(
        await fieldSchema(`${labeled("rules")} | ${labeled("rules2")} | null`),
      ).toEqual({
        anyOf: [{ type: "null" }, alternative(POLICY), alternative(POLICY_2)],
      });
      expect(
        await fieldSchema(`${labeled("rules2")} | ${labeled("rules")} | null`),
      ).toEqual({
        anyOf: [{ type: "null" }, alternative(POLICY_2), alternative(POLICY)],
      });
    });

    it("reads each member of a union an alias writes at its own node", async () => {
      expect(await fieldSchema("Both | null")).toEqual({
        anyOf: [
          { type: "null" },
          { $ref: "#/$defs/A", ifc: { confidentiality: [POLICY] } },
          { $ref: "#/$defs/B", ifc: { confidentiality: [POLICY] } },
        ],
      });
    });

    it("reports a label it cannot read once for a member node that stands for several members", async () => {
      const { diagnostics } = await generated(
        'Confidential<A | B, readonly ["a" | "b"]> | null',
      );

      expect(
        diagnostics.filter((diagnostic) =>
          diagnostic.type === "cfc-label:unread"
        ),
      ).toHaveLength(1);
    });

    it("leaves a scope wrapper that stands for several members to the rules for a scope wrapper in a union", async () => {
      // `PerUser<boolean>` distributes over `true` and `false`. Where a scope
      // lands in a union is `scope-placement.ts`'s to decide, so the wrapper
      // is not read whole as one alternative, which would put its scope
      // inside an `anyOf` branch.
      await expect(fieldSchema("PerUser<boolean> | null")).resolves.toEqual({
        anyOf: [{ type: "null" }, { type: "boolean" }],
      });
    });

    it("leaves a `Default` that stands for several members to the rules for `Default` in a union", async () => {
      // `Default<T, V>` is `(T & DefaultMarker<V>) | T`, which the checker
      // folds into the union beside `null`.
      expect(await fieldSchema("HostValue | null")).toEqual({
        anyOf: [{ type: "null" }, { $ref: "#/$defs/Host" }],
      });
    });

    it("keeps the members of a union an alias writes as alternatives of its own", async () => {
      expect(await fieldSchema("Shape | null")).toEqual({
        anyOf: [
          { type: "null" },
          { $ref: "#/$defs/A" },
          { $ref: "#/$defs/B" },
        ],
      });
    });
  });

  describe("an alias chain entered with its arguments as written", () => {
    // A field's annotation reaches the lowering with the reference's argument
    // nodes. The payload is read from the declaration of the last alias along
    // the chain, each parameter bound to the argument written for it.

    const ALIASES = `
      type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
      type Confidential<T, X extends readonly unknown[]> = Cfc<T, { confidentiality: X }>;
      type Integrity<T, X extends readonly unknown[]> = Cfc<T, { integrity: X }>;
      type WriteAuthorizedBy<T, B> = Cfc<T, { writeAuthorizedBy: B }>;
      declare const DEFAULT_MARKER: unique symbol;
      type DefaultMarker<T> = { readonly [DEFAULT_MARKER]: T };
      type IsEmptyTuple<T> = T extends readonly unknown[]
        ? number extends T["length"] ? false
        : T["length"] extends 0 ? true
        : false
        : false;
      type Default<T, V extends T = T> = IsEmptyTuple<T> extends true
        ? T & DefaultMarker<V>
        :
          | ([T] extends [null | undefined] ? DefaultMarker<V>
            : T & DefaultMarker<V>)
          | T;
      interface Box<U> { value: U }
    `;

    const generate = async (code: string) => {
      const { type, checker } = await getTypeFromCode(
        ALIASES + code,
        "Holder",
      );
      const diagnostics: SchemaGenerationDiagnostic[] = [];
      const schema = asObjectSchema(
        new SchemaGenerator().generateSchema(type, checker, undefined, {
          onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
        }),
      );
      return { schema, value: schema.properties?.value, diagnostics };
    };
    const box = (value: unknown) => ({
      type: "object",
      properties: { value },
      required: ["value"],
    });

    it("reads a generic interface the payload holds with the argument", async () => {
      const { value, diagnostics } = await generate(`
        type Sec<T> = Confidential<Box<T> & { tag: string }, readonly ["a"]>;
        interface Holder { value: Sec<string> }
      `);
      expect(value).toEqual({
        type: "object",
        properties: { value: { type: "string" }, tag: { type: "string" } },
        required: ["value", "tag"],
        ifc: { confidentiality: ["a"] },
      });
      expect(diagnostics).toEqual([]);
    });

    it("reads a recursive generic interface apart for each argument", async () => {
      const { schema } = await generate(`
        interface Link<U> { value: U; next?: Link<U> }
        type Sec<T> = Confidential<Link<T>, readonly ["a"]>;
        interface Holder { value: Sec<string>; other: Sec<number> }
      `);
      // Each field refers to the recursive definition its own argument reads.
      const readsOf = (field: string) => {
        const reference = schema.properties?.[field] as { $ref: string };
        const name = reference.$ref.split("/").pop()!;
        const def = schema.$defs?.[name] as {
          properties: { value: unknown; next: { anyOf: { $ref?: string }[] } };
        };
        return {
          value: def.properties.value,
          self: def.properties.next.anyOf.some((arm) =>
            arm.$ref === reference.$ref
          ),
        };
      };
      expect(readsOf("value")).toEqual({
        value: { type: "string" },
        self: true,
      });
      expect(readsOf("other")).toEqual({
        value: { type: "number" },
        self: true,
      });
    });

    it("reads an argument written in the declaration before it under that declaration's bindings", async () => {
      const { value } = await generate(`
        type Sec<T> = Confidential<Box<T>, readonly ["a"]>;
        type Outer<X> = Sec<X[]>;
        interface Holder { value: Outer<string> }
      `);
      expect(value).toEqual({
        ...box({ type: "array", items: { type: "string" } }),
        ifc: { confidentiality: ["a"] },
      });
    });

    it("reads an argument the reference leaves out as its default, read with the arguments before it", async () => {
      const { value, diagnostics } = await generate(`
        type Sec<T, U = Box<T>> = Confidential<U, readonly ["a"]>;
        interface Holder { value: Sec<string> }
      `);
      expect(value).toEqual({
        ...box({ type: "string" }),
        ifc: { confidentiality: ["a"] },
      });
      expect(diagnostics).toEqual([]);
    });

    it("reads a parameter bound to another alias's parameter as that one's argument", async () => {
      // `Box` and `Inner` both name their parameter `U`; each reads as the
      // argument its own reference supplies.
      const { value, diagnostics } = await generate(`
        type Inner<U> = Confidential<Box<U> | number, readonly ["inner"]>;
        type Sec<T> = Confidential<Inner<T> | boolean, readonly ["a"]>;
        interface Holder { value: Sec<string> }
      `);
      expect(value).toEqual({
        anyOf: [
          {
            anyOf: [box({ type: "string" }), { type: "number" }],
            ifc: { confidentiality: ["inner"] },
          },
          { type: "boolean" },
        ],
        ifc: { confidentiality: ["a"] },
      });
      expect(diagnostics).toEqual([]);
    });

    it("keeps a `Default` written as the argument", async () => {
      const { value } = await generate(`
        type Sec<T> = Confidential<{ v: T }, readonly ["a"]>;
        interface Holder { value: Sec<Default<string, "x">> }
      `);
      expect(value).toEqual({
        type: "object",
        properties: { v: { type: "string", default: "x" } },
        required: ["v"],
        ifc: { confidentiality: ["a"] },
      });
    });

    it("keeps the default a `Default` over a parameter writes", async () => {
      const { value } = await generate(`
        type Sec<T, D extends T> = Confidential<{ v: Default<T, D> }, readonly ["a"]>;
        interface Holder { value: Sec<string, "x"> }
      `);
      expect(value).toEqual({
        type: "object",
        properties: { v: { type: "string", default: "x" } },
        required: ["v"],
        ifc: { confidentiality: ["a"] },
      });
    });

    it("keeps a label passed as an argument to an alias the payload holds", async () => {
      const { value } = await generate(`
        type Sec<T, L extends string> =
          Confidential<Integrity<Box<T>, readonly [L]>, readonly ["a"]>;
        interface Holder { value: Sec<string, "lab"> }
      `);
      expect(value).toEqual({
        ...box({ type: "string" }),
        ifc: { integrity: ["lab"], confidentiality: ["a"] },
      });
    });

    it("keeps a writer binding passed as an argument to an alias the payload holds", async () => {
      const { value } = await generate(`
        declare function setName(): void;
        type Owned<T, B> = Confidential<WriteAuthorizedBy<T, B>, readonly ["a"]>;
        interface Holder { value: Owned<string, typeof setName> }
      `);
      expect(value).toMatchObject({
        type: "string",
        ifc: {
          writeAuthorizedBy: { __ctWriterIdentityOf: { path: ["setName"] } },
        },
      });
    });

    it("reads a library alias over a parameter by its syntax", async () => {
      const { value, diagnostics } = await generate(`
        type Sec<T> = Confidential<Partial<T>, readonly ["a"]>;
        interface Holder { value: Sec<{ a: string }> }
      `);
      expect(value).toEqual({
        type: "object",
        properties: { a: { type: "string" } },
        ifc: { confidentiality: ["a"] },
      });
      expect(diagnostics).toEqual([]);
    });

    const unreachable: [string, string, unknown][] = [
      ["an indexed access", '{ n: T["a"] }', {
        type: "object",
        properties: { n: { type: "string" } },
        required: ["n"],
      }],
      ["a mapped type", "{ [K in keyof T]: T[K] }", {
        type: "object",
        properties: { a: { type: "string" } },
        required: ["a"],
      }],
      ["`keyof`", "{ k: keyof T }", {
        type: "object",
        properties: { k: { type: "string", enum: ["a"] } },
        required: ["k"],
      }],
    ];
    for (const [use, payload, expected] of unreachable) {
      it(`reads a payload using a parameter in ${use} from the type the chain instantiates`, async () => {
        const { value, diagnostics } = await generate(`
          type Sec<T extends { a: string }> = Confidential<${payload}, readonly ["a"]>;
          interface Holder { value: Sec<{ a: string }> }
        `);
        expect(value).toEqual({
          ...(expected as object),
          ifc: { confidentiality: ["a"] },
        });
        expect(diagnostics).toEqual([]);
      });
    }

    it("reports a library alias over a parameter whose rules do not apply", async () => {
      // `Pick` reads its keys from a literal, and `K` is a parameter.
      const { value, diagnostics } = await generate(`
        type Sec<T, K extends keyof T> =
          Confidential<{ picked: Pick<T, K> }, readonly ["a"]>;
        interface Holder { value: Sec<{ a: string; b: number }, "a"> }
      `);
      expect(value).toEqual({
        type: "object",
        properties: { picked: true },
        required: ["picked"],
        ifc: { confidentiality: ["a"] },
      });
      expect(diagnostics.map((diagnostic) => diagnostic.type)).toEqual([
        "schema-type:unread",
      ]);
    });

    it("reports a mapped type over a parameter that a generic declaration in the payload holds", async () => {
      const { value, diagnostics } = await generate(`
        interface W<U> { m: Partial<U> }
        type Sec<T> = Confidential<W<T>, readonly ["a"]>;
        interface Holder { value: Sec<{ a: string }> }
      `);
      expect(value).toEqual({
        type: "object",
        properties: { m: {} },
        required: ["m"],
        ifc: { confidentiality: ["a"] },
      });
      expect(diagnostics.map((diagnostic) => diagnostic.type)).toEqual([
        "schema-type:unread",
      ]);
    });

    it("reports a mapped type a generic declaration in the payload writes over its own parameter", async () => {
      // `W<T>`'s `m` is `W`'s mapped type instantiated over `T`, which has no
      // alias arguments to show it and no member the checker can list.
      const { value, diagnostics } = await generate(`
        interface W<U> { m: { [K in keyof U]: U[K] } }
        type Sec<T> = Confidential<W<T>, readonly ["a"]>;
        interface Holder { value: Sec<{ a: string }> }
      `);
      expect(value).toEqual({
        type: "object",
        properties: { m: {} },
        required: ["m"],
        ifc: { confidentiality: ["a"] },
      });
      expect(diagnostics.map((diagnostic) => diagnostic.type)).toEqual([
        "schema-type:unread",
      ]);
    });

    it("reads a mapped type a generic declaration in the payload writes over a concrete argument", async () => {
      const { value, diagnostics } = await generate(`
        interface W<U> { m: { [K in keyof U]: U[K] } }
        type Sec<T> = Confidential<{ w: W<{ a: string }>; t: T }, readonly ["a"]>;
        interface Holder { value: Sec<number> }
      `);
      expect(value).toEqual({
        type: "object",
        properties: {
          w: {
            type: "object",
            properties: {
              m: {
                type: "object",
                properties: { a: { type: "string" } },
                required: ["a"],
              },
            },
            required: ["m"],
          },
          t: { type: "number" },
        },
        required: ["w", "t"],
        ifc: { confidentiality: ["a"] },
      });
      expect(diagnostics).toEqual([]);
    });

    for (
      const [spelling, member] of [
        ["a mapped type", "{ [K in keyof U]: U[K] }"],
        ["`Partial`", "Partial<U>"],
      ]
    ) {
      it(`reads ${spelling} a generic declaration writes over an empty concrete argument`, async () => {
        // `W<{}>`'s `m` has no members because its argument has none, not
        // because the checker has yet to instantiate it.
        const { value, diagnostics } = await generate(`
          interface W<U> { m: ${member} }
          type Sec<T> = Confidential<{ w: W<{}>; t: T }, readonly ["a"]>;
          interface Holder { value: Sec<number> }
        `);
        expect((value as { properties: { w: unknown } }).properties.w).toEqual({
          type: "object",
          properties: { m: { type: "object", properties: {} } },
          required: ["m"],
        });
        expect(diagnostics).toEqual([]);
      });
    }

    it("reads a module's own alias named as a library alias as its own", async () => {
      const { value, diagnostics } = await generate(`
        type Partial<X> = { wrapped: X };
        type Sec<T> = Confidential<{ p: Partial<T> }, readonly ["a"]>;
        interface Holder { value: Sec<string> }
        export {};
      `);
      expect(value).toEqual({
        type: "object",
        properties: {
          p: {
            type: "object",
            properties: { wrapped: { type: "string" } },
            required: ["wrapped"],
          },
        },
        required: ["p"],
        ifc: { confidentiality: ["a"] },
      });
      expect(diagnostics).toEqual([]);
    });

    it("reads a recursion through the alias with its own parameter as a reference to its definition", async () => {
      const { value, schema, diagnostics } = await generate(`
        type Sec<T> = Confidential<{ v: T; next?: Sec<T> }, readonly ["a"]>;
        interface Holder { value: Sec<string> }
      `);
      const next = (value as any).properties.next;
      const def = schema.$defs?.[next.$ref.split("/").pop()] as any;
      expect((value as any).properties.v).toEqual({ type: "string" });
      expect(def.properties.v).toEqual({ type: "string" });
      expect(def.properties.next.$ref).toBe(next.$ref);
      expect(diagnostics).toEqual([]);
    });

    for (
      const [spelling, argument, holder, member] of [
        [
          "`undefined` joined to it",
          "T | undefined",
          "Sec<string>",
          "next?: X",
        ],
        [
          "an object intersected with it",
          "T & { a: string }",
          "Sec<{ a: string }>",
          "next?: X",
        ],
        ["`Readonly` over it", "Readonly<T>", "Sec<string>", "next?: X"],
        [
          "`Readonly` over an object argument",
          "Readonly<T>",
          "Sec<{ a: string }>",
          "next?: X",
        ],
        [
          "`undefined` joined to it, in a member that is also `null`",
          "T | undefined",
          "Sec<string>",
          "next: X | null",
        ],
        [
          "`undefined` joined to it, in an `Array`",
          "T | undefined",
          "Sec<string>",
          "next: Array<X>",
        ],
        [
          "`undefined` joined to it, in a `ReadonlyArray`",
          "T | undefined",
          "Sec<string>",
          "next: ReadonlyArray<X>",
        ],
        [
          "`undefined` joined to it, in a tuple",
          "T | undefined",
          "Sec<string>",
          "next: [X]",
        ],
        [
          "`undefined` joined to it, in a `Record`",
          "T | undefined",
          "Sec<string>",
          "next: Record<string, X>",
        ],
        [
          "`undefined` joined to it, under an index signature",
          "T | undefined",
          "Sec<string>",
          "next: { [key: string]: X }",
        ],
        [
          "`undefined` joined to it, through an identity alias",
          "T | undefined",
          "Sec<string>",
          "next?: Id<X>",
        ],
        [
          "`undefined` joined to it, in a `Default`",
          "T | undefined",
          "Sec<string>",
          "next: Default<X[], []>",
        ],
        [
          "`undefined` joined to it, as a tuple's element before a rest",
          "T | undefined",
          "Sec<string>",
          "next: [X, ...string[]]",
        ],
        [
          "`undefined` joined to it, as a tuple's rest",
          "T | undefined",
          "Sec<string>",
          "next: [...X[]]",
        ],
        [
          "`undefined` joined to it, in `Readonly`",
          "T | undefined",
          "Sec<string>",
          "next: Readonly<X>",
        ],
        [
          "`undefined` joined to it, in `Required`",
          "T | undefined",
          "Sec<string>",
          "next: Required<X>",
        ],
        [
          "`undefined` joined to it, in a `Default` that is also `null`",
          "T | undefined",
          "Sec<string>",
          "next: Default<X | null, null>",
        ],
        [
          "`undefined` joined to it, in a union with another value",
          "T | undefined",
          "Sec<string>",
          "next: X | number",
        ],
        [
          "`undefined` joined to it, in a `Readonly` object",
          "T | undefined",
          "Sec<string>",
          "next: Readonly<{ inner: X }>",
        ],
        [
          "`undefined` joined to it, in a `Partial` object",
          "T | undefined",
          "Sec<string>",
          "next: Partial<{ inner: X }>",
        ],
        [
          "`undefined` joined to it, in a `Pick` of an object",
          "T | undefined",
          "Sec<string>",
          'next: Pick<{ inner: X; other: number }, "inner">',
        ],
        [
          "`undefined` joined to it, in a `NonNullable` object",
          "T | undefined",
          "Sec<string>",
          "next: NonNullable<{ inner: X } | null>",
        ],
        [
          "`undefined` joined to it, through an identity alias over an object",
          "T | undefined",
          "Sec<string>",
          "next: Id<{ inner: X }>",
        ],
        [
          "`undefined` joined to it, in a `Record` over a literal key",
          "T | undefined",
          "Sec<string>",
          'next: Record<"only", X>',
        ],
        [
          "`undefined` joined to it, in a generic declaration's array",
          "T | undefined",
          "Sec<string>",
          "next: List<X>",
        ],
        [
          "`undefined` joined to it, under a generic declaration's index signature",
          "T | undefined",
          "Sec<string>",
          "next: Dict<X>",
        ],
        [
          "`undefined` joined to it, in a generic declaration's tuple",
          "T | undefined",
          "Sec<string>",
          "next: Twice<X>",
        ],
      ] as const
    ) {
      it(`reads a recursion through the alias with ${spelling}, which the checker settles, as a reference to its definition`, async () => {
        // The written argument nests without end, but the type the checker
        // instantiates settles, and that identifies the reading.
        const next = member.replace("X", `Sec<${argument}>`);
        const { value, schema, diagnostics } = await generate(`
          type Id<Y> = Y;
          interface List<U> { items: U[] }
          interface Dict<U> { [key: string]: U }
          interface Twice<U> { items: [U, U] }
          type Sec<T> = Confidential<{ value: T; ${next} }, readonly ["a"]>;
          interface Holder { value: ${holder} }
        `);
        // Some definition refers to itself, and the value refers to it.
        const definitions = Object.entries(schema.$defs ?? {});
        const recursive = definitions.find(([name, definition]) =>
          JSON.stringify(definition).includes(`"#/$defs/${name}"`)
        );
        expect(recursive).toBeDefined();
        expect(JSON.stringify(value)).toContain(`"#/$defs/${recursive?.[0]}"`);
        expect(diagnostics).toEqual([]);
      });
    }

    for (
      const argument of [
        "[T]",
        "[x?: T]",
        "[...T[]]",
        "[T?]",
        "readonly T[]",
        "{ k: T }",
        "{ readonly k?: T }",
        "{ [key: string]: T }",
        '{ [K in "k"]: T }',
        "{ m(): T }",
        '{ ["k"]: T }',
      ]
    ) {
      it(`reports a recursion that grows through \`${argument}\`, which settles to no level`, async () => {
        // Each level's argument denotes a deeper type than the one before,
        // so no two compare alike, and the nesting bound ends the reading.
        const { diagnostics } = await generate(`
          type Nest<T> = Confidential<{ v: T; next?: Nest<${argument}> }, readonly ["a"]>;
          interface Holder { value: Nest<string> }
        `);
        expect(diagnostics.map((diagnostic) => diagnostic.type)).toContain(
          "cfc-schema:recursion-limit",
        );
      });
    }

    /** Each level of `value` down `next`, through local references. */
    const levels = (
      schema: object,
      read: (value: Record<string, any>) => unknown,
    ) => {
      const { $defs, properties } = schema as Record<string, any>;
      const definitions = ($defs ?? {}) as Record<string, any>;
      const resolve = (at: any) =>
        typeof at?.$ref === "string"
          ? definitions[at.$ref.split("/").pop()]
          : at;
      const seen: unknown[] = [];
      let level = resolve(properties.value);
      for (let depth = 0; depth < 4; depth++) {
        seen.push(read(resolve(level.properties.value) ?? level));
        level = resolve(level.properties.next);
      }
      return seen;
    };

    for (
      const [spelling, declarations, expected] of [
        [
          "tuples another alias indexes",
          `type First<X extends unknown[]> = Confidential<{ first: X[0] }, readonly ["b"]>;
          type Sec<A extends unknown[], B extends unknown[]> = Confidential<{ value: First<A>; next?: Sec<B, A> }, readonly ["a"]>;
          interface Holder { value: Sec<[string, number], [number, string]> }`,
          ["string", "number", "string", "number"],
        ],
        [
          "references to two declarations",
          `interface One<U> { one: U }
          interface Two<U> { two: U }
          type Sec<A, B> = Confidential<{ value: A; next?: Sec<B, A> }, readonly ["a"]>;
          type Outer<U> = Sec<One<U>, Two<U>>;
          interface Holder { value: Outer<string> }`,
          ["one", "two", "one", "two"],
        ],
        [
          "an optional and a required member",
          `type Sec<A, B> = Confidential<{ value: A; next?: Sec<B, A> }, readonly ["a"]>;
          type Outer<U> = Sec<{ v?: U }, { v: U }>;
          interface Holder { value: Outer<string> }`,
          ["v?", "v", "v?", "v"],
        ],
        [
          "an optional member and one named with the marker",
          `type Sec<A, B> = Confidential<{ value: A; next?: Sec<B, A> }, readonly ["a"]>;
          type Outer<U> = Sec<{ v?: U }, { "v?": U }>;
          interface Holder { value: Outer<string> }`,
          ["v?", "v?!", "v?", "v?!"],
        ],
      ] as const
    ) {
      it(`keeps each level's value in a recursion that swaps ${spelling}`, async () => {
        // The two arguments differ only in what their written form holds, so
        // each level is its own, and the recursion settles only where the
        // same types come round again.
        const { schema, diagnostics } = await generate(declarations);
        const read = (value: Record<string, any>) => {
          if (value.properties?.first) return value.properties.first.type;
          const [name] = Object.keys(value.properties ?? {});
          const required = (value.required ?? []).includes(name);
          // A required member named `v?` reads `v?!`, an optional `v` `v?`.
          return name === "v"
            ? (required ? "v" : "v?")
            : name === "v?"
            ? (required ? "v?!" : "v??")
            : name;
        };
        expect(levels(schema, read)).toEqual([...expected]);
        expect(diagnostics).toEqual([]);
      });
    }

    it("keeps each level's value in a recursion whose argument alternates", async () => {
      // The payload is read from its instantiation, which leaves the written
      // argument's `T` unbound, so that argument has no form.
      const { schema, diagnostics } = await generate(`
        type Sec<T> = Confidential<{ value: T; next?: Sec<T extends string ? number : string> }, readonly ["a"]>;
        interface Holder { value: Sec<string> }
      `);
      expect(levels(schema, (value) => value.type)).toEqual([
        "string",
        "number",
        "string",
        "number",
      ]);
      expect(diagnostics).toEqual([]);
    });

    it("keeps each level's writer in a recursion that swaps its writer bindings", async () => {
      // `f` and `g` have one type, so each level's instantiation is
      // assignable both ways with the one before, though its writer is the
      // other; a `typeof` argument settles nothing.
      const { schema } = await generate(`
        function f(x: string): void {}
        function g(x: string): void {}
        type Sec<T, A, B> = WriteAuthorizedBy<{ value: T; next?: Sec<T, B, A> }, A>;
        interface Holder { value: Sec<string, typeof f, typeof g> }
      `);
      const definitions = (schema.$defs ?? {}) as Record<string, any>;
      const resolve = (at: any) =>
        typeof at?.$ref === "string"
          ? definitions[at.$ref.split("/").pop()]
          : at;
      const writers: unknown[] = [];
      let level = resolve(schema.properties?.value);
      for (let depth = 0; depth < 4; depth++) {
        writers.push(
          JSON.stringify(level.ifc.writeAuthorizedBy).includes('"f"')
            ? "f"
            : "g",
        );
        level = resolve(level.properties.next);
      }
      expect(writers).toEqual(["f", "g", "f", "g"]);
    });

    it("settles a recursion whose argument has a numeric member name", async () => {
      // The union with another value loses the instantiation, so the
      // arguments' written forms settle it.
      const { schema, diagnostics } = await generate(`
        type Sec<T> = Confidential<{ value: T; next: Sec<T | undefined> | number }, readonly ["a"]>;
        type Outer<U> = Sec<{ 0: U }>;
        interface Holder { value: Outer<string> }
      `);
      const definitions = Object.entries(schema.$defs ?? {});
      expect(
        definitions.some(([name, definition]) =>
          JSON.stringify(definition).includes(`"#/$defs/${name}"`)
        ),
      ).toBe(true);
      expect(diagnostics).toEqual([]);
    });

    it("reports a written mapped type, or an alias of one, over a bound parameter", async () => {
      // A union payload is read under the bindings, and the checker has not
      // instantiated a mapped type over a parameter.
      const { value, diagnostics } = await generate(`
        type M<X> = { [K in keyof X]: X[K] };
        type Sec<T> = Confidential<
          { written: { [K in keyof T]: T[K] }; aliased: M<T | undefined> } | { n: number },
          readonly ["a"]
        >;
        interface Holder { value: Sec<{ a: string }> }
      `);
      expect(value).toBeDefined();
      expect(diagnostics.map((diagnostic) => diagnostic.type)).toContain(
        "schema-type:unread",
      );
    });

    it("reads a mapped alias over a type that is its own argument", async () => {
      // `Rec` is `Box<Rec>`, so its type arguments hold it again.
      const { value, diagnostics } = await generate(`
        interface Box<U> { inner?: U }
        type Rec = Box<Rec>;
        type M<X> = { [K in keyof X]: X[K] };
        type Sec<T> = Confidential<{ value: T; m: M<Rec> } | { n: number }, readonly ["a"]>;
        interface Holder { value: Sec<string> }
      `);
      expect(value).toBeDefined();
      expect(diagnostics).toEqual([]);
    });

    it("reads a chain through an identity alias that leaves its argument to its default", async () => {
      const { value, diagnostics } = await generate(`
        type Sec<T> = Confidential<T, readonly ["a"]>;
        type Id<X = Sec<string>> = X;
        interface Holder { value: Id }
      `);
      expect(value).toEqual({
        type: "string",
        ifc: { confidentiality: ["a"] },
      });
      expect(diagnostics).toEqual([]);
    });

    for (
      const alias of [
        'Pick<Sec<{ x: T; y: number }>, "x">',
        'Omit<Sec<{ x: T; y: number }>, "y">',
      ]
    ) {
      it(`keeps the label of \`${alias}\` in a payload read under bindings`, async () => {
        // The picked members are the labelled value's.
        const { value, diagnostics } = await generate(`
          type Sec<T> = Confidential<T, readonly ["a"]>;
          type Outer<T> = Confidential<{ inner: ${alias} }, readonly ["b"]>;
          interface Holder { value: Outer<string> }
        `);
        expect((value as any).properties.inner).toEqual({
          type: "object",
          properties: { x: { type: "string" } },
          required: ["x"],
          ifc: { confidentiality: ["a"] },
        });
        expect(diagnostics).toEqual([]);
      });
    }

    it("reads a nesting of an alias in its own argument as written", async () => {
      const { value, diagnostics } = await generate(`
        type Wrap<B> = Confidential<{ w: B }, readonly ["w"]>;
        type Pair<A> = Confidential<{ l: Wrap<A[]> }, readonly ["p"]>;
        interface Holder { value: Pair<Pair<string>> }
      `);
      const pair = (inner: unknown) => ({
        type: "object",
        properties: {
          l: {
            type: "object",
            properties: { w: { type: "array", items: inner } },
            required: ["w"],
            ifc: { confidentiality: ["w"] },
          },
        },
        required: ["l"],
        ifc: { confidentiality: ["p"] },
      });
      expect(value).toEqual(pair(pair({ type: "string" })));
      expect(diagnostics).toEqual([]);
    });

    it("reports a recursion that nests the alias's own argument without end", async () => {
      const { diagnostics } = await generate(`
        type Nest<T> = Confidential<{ inner?: Nest<T[]>; v: T }, readonly ["a"]>;
        interface Holder { value: Nest<string> }
      `);
      expect(diagnostics.map((diagnostic) => diagnostic.type)).toEqual([
        "cfc-schema:recursion-limit",
      ]);
    });

    it("reports a generic declaration's member naming a generic alias whose payload its instantiated type does not hold apart", async () => {
      // `Wrapper<string>` holds the argument, but its payload, a union, is
      // not one member beside the carrier, and `U` binds nothing here.
      const { value, diagnostics } = await generate(`
        type Inner<X> = Confidential<{ v: X } | number, readonly ["i"]>;
        interface Wrapper<U> { inner: Inner<U> }
        interface Holder { value: Wrapper<string> }
      `);
      expect(value).toEqual({
        type: "object",
        properties: {
          inner: {
            anyOf: [
              { type: "number" },
              { type: "object", properties: { v: {} }, required: ["v"] },
            ],
            ifc: { confidentiality: ["i"] },
          },
        },
        required: ["inner"],
      });
      expect(diagnostics.map((diagnostic) => diagnostic.type)).toEqual([
        "schema-type:unread",
      ]);
    });

    it("reads a generic declaration's member naming a generic alias from its instantiated type", async () => {
      // `inner: Inner<U>` is written in `Wrapper`'s parameter, whose argument
      // is in the type `Wrapper<string>`, not in the member's syntax.
      const { value, diagnostics } = await generate(`
        type Inner<X> = Confidential<X[], readonly ["i"]>;
        interface Wrapper<U> { inner: Inner<U> }
        interface Holder { value: Wrapper<string> }
      `);
      expect(value).toEqual({
        type: "object",
        properties: {
          inner: {
            type: "array",
            items: { type: "string" },
            ifc: { confidentiality: ["i"] },
          },
        },
        required: ["inner"],
      });
      expect(diagnostics).toEqual([]);
    });
  });

  describe("a default-library alias mapping a labelled type's members", () => {
    // `Readonly`, `Partial`, `Required`, `Pick` and `Omit` over a labelled
    // type fold the label's carrier into the object they build, as one more
    // member, and over a primitive or an array build an object of its
    // methods. Read by type, the value keeps its label and its payload, and
    // no schema holds the carrier as a member.

    const ALIASES = `
      type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
      type Confidential<T, X extends readonly unknown[]> = Cfc<T, { confidentiality: X }>;
      type Sec<T> = Confidential<T, readonly ["a"]>;
      type Pair = { x?: string; y: number };
    `;

    const generate = async (value: string, declarations = "") => {
      const { checker, sourceFile } = await createTestProgram(
        ALIASES + declarations + `interface Holder { value: ${value} }`,
      );
      const holder = checker.getSymbolsInScope(
        sourceFile,
        ts.SymbolFlags.Interface,
      ).find((candidate) => candidate.name === "Holder")!;
      const property = checker.getDeclaredTypeOfSymbol(holder).getProperty(
        "value",
      )!;
      const diagnostics: SchemaGenerationDiagnostic[] = [];
      const schema = new SchemaGenerator().generateSchema(
        checker.getTypeOfSymbolAtLocation(property, sourceFile),
        checker,
        undefined,
        { onDiagnostic: (diagnostic) => diagnostics.push(diagnostic) },
      );
      return { schema, diagnostics };
    };

    const secret = { confidentiality: ["a"] };
    const x = { type: "string" };
    const y = { type: "number" };

    for (
      const [value, expected] of [
        [
          "Readonly<Sec<Pair>>",
          {
            type: "object",
            properties: { x, y },
            required: ["y"],
            ifc: secret,
          },
        ],
        [
          "Partial<Sec<Pair>>",
          { type: "object", properties: { x, y }, ifc: secret },
        ],
        [
          "Required<Sec<Pair>>",
          {
            type: "object",
            properties: { x, y },
            required: ["x", "y"],
            ifc: secret,
          },
        ],
        [
          'Pick<Sec<Pair>, "x">',
          { type: "object", properties: { x }, ifc: secret },
        ],
        [
          'Omit<Sec<Pair>, "x">',
          {
            type: "object",
            properties: { y },
            required: ["y"],
            ifc: secret,
          },
        ],
        ["Readonly<Sec<string>>", { type: "string", ifc: secret }],
        [
          "Readonly<Sec<string[]>>",
          { type: "array", items: x, ifc: secret },
        ],
        [
          'Readonly<Confidential<Sec<Pair>, readonly ["b"]>>',
          {
            type: "object",
            properties: { x, y },
            required: ["y"],
            ifc: { confidentiality: ["a", "b"] },
          },
        ],
        [
          "Partial<Readonly<Sec<Pair>>>",
          { type: "object", properties: { x, y }, ifc: secret },
        ],
        [
          '{ readonly [K in keyof Confidential<Sec<{ y: number }>, readonly ["b"]>]: Confidential<Sec<{ y: number }>, readonly ["b"]>[K] }',
          {
            type: "object",
            properties: { y },
            required: ["y"],
            ifc: { confidentiality: ["a", "b"] },
          },
        ],
        [
          "{ readonly [K in keyof Sec<Pair>]: Sec<Pair>[K] }",
          {
            type: "object",
            properties: { x, y },
            required: ["y"],
            ifc: secret,
          },
        ],
      ] as const
    ) {
      it(`keeps the label of \`${value}\` and holds no carrier`, async () => {
        const { schema, diagnostics } = await generate(value);
        expect(schema).toEqual(expected);
        expect(diagnostics).toEqual([]);
      });
    }

    it("reads `Required` of a labelled tuple as the tuple it builds, a required slot keeping its `undefined`", async () => {
      const { schema, diagnostics } = await generate(
        "Required<Sec<[string | undefined, number?]>>",
      );
      expect(schema).toEqual({
        type: "array",
        items: { type: ["number", "string", "undefined"] },
        ifc: secret,
      });
      expect(diagnostics).toEqual([]);
    });

    for (const value of ['Pick<Sec<string>, "length">', "Length"]) {
      it(`reads \`${value}\`, a pick of a primitive's members, as the object it builds`, async () => {
        // A user's alias of a `Pick` names the object the `Pick` builds, so
        // the alias is followed to the `Pick` its body writes.
        const { schema, diagnostics } = await generate(
          value,
          `type Length = Pick<Sec<string>, "length">;`,
        );
        const definitions = (schema as Record<string, any>).$defs ?? {};
        const at = schema as Record<string, any>;
        const shape = typeof at.$ref === "string"
          ? definitions[at.$ref.split("/").pop()!]
          : at;
        expect(shape).toEqual({
          type: "object",
          properties: { length: y },
          required: ["length"],
          ifc: secret,
        });
        expect(diagnostics).toEqual([]);
      });
    }

    for (
      const [alias, node, properties, required] of [
        [
          "Partial",
          "{ value: string; next?: Partial<Node> }",
          ["value", "next"],
          [],
        ],
        [
          "Required",
          "{ value?: string; next?: Required<Node> }",
          ["value", "next"],
          ["value", "next"],
        ],
        [
          "Pick",
          '{ value: string; secret: number; next?: Pick<Node, "value" | "next"> }',
          ["value", "next"],
          ["value"],
        ],
      ] as const
    ) {
      it(`keeps \`${alias}\` over a labelled type still being read, as a definition of its own`, async () => {
        // The operand's own definition is not yet written, so the value is
        // the type the alias builds, which refers to itself.
        const { schema, diagnostics } = await generate(
          "Node",
          `type Node = Sec<${node}>;`,
        );
        const definitions = (schema as Record<string, any>).$defs ?? {};
        const resolve = (at: any) =>
          typeof at?.$ref === "string"
            ? definitions[at.$ref.split("/").pop()]
            : at;
        const next = resolve(resolve(schema).properties.next);
        expect(Object.keys(next.properties)).toEqual([...properties]);
        expect(next.required ?? []).toEqual([...required]);
        expect(next.ifc).toEqual(secret);
        expect(resolve(next.properties.next)).toBe(next);
        expect(diagnostics).toEqual([]);
      });
    }

    it("reads such an alias over an unlabelled type as the type it builds", async () => {
      // Only a labelled operand is read in the alias's place; any other is
      // the mapped type the checker builds, a named one no reference to it.
      const { schema } = await generate("Readonly<Pair>");
      expect(schema).toEqual({
        type: "object",
        properties: { x, y },
        required: ["y"],
      });
    });

    it("reads a module's own alias of such a name as its own", async () => {
      const { checker, sourceFile } = await createTestProgram(
        ALIASES + `
        type Partial<T> = { inner: T };
        interface Holder { value: Partial<Sec<{ y: number }>> }
        export {};
      `,
      );
      const holder = checker.getSymbolsInScope(
        sourceFile,
        ts.SymbolFlags.Interface,
      ).find((candidate) => candidate.name === "Holder")!;
      const property = checker.getDeclaredTypeOfSymbol(holder).getProperty(
        "value",
      )!;
      const schema = new SchemaGenerator().generateSchema(
        checker.getTypeOfSymbolAtLocation(property, sourceFile),
        checker,
        undefined,
      );
      expect(schema).toEqual({
        type: "object",
        properties: {
          inner: {
            type: "object",
            properties: { y },
            required: ["y"],
            ifc: secret,
          },
        },
        required: ["inner"],
      });
    });

    describe("a user's generic alias of one", () => {
      // The checker names a `Pick` or an `Omit` over literal keys by a user's
      // alias of it, and holds that alias's arguments. The alias is followed,
      // down a chain of aliases, to the one its body writes, with each
      // parameter read as the argument it is given, so it reads as that alias
      // written out with the arguments in place: labeled where that is, and
      // unlabeled where that is.

      const DECLARATIONS = `
        type Select<T extends { x?: string }> = Pick<T, "x">;
        type SelectLabelled<L extends readonly unknown[]> = Pick<Confidential<Pair, L>, "x">;
        type SelectSecond<A, B extends { x?: string }> = Pick<B, "x">;
        type SelectDefault<T extends { x?: string } = Sec<Pair>> = Pick<T, "x">;
        type SelectSec<T extends { x?: string }> = Pick<Sec<T>, "x">;
        type SelectBoth<T extends { x?: string }, L extends readonly unknown[]> =
          Pick<Confidential<Sec<T>, L>, "x">;
        type SelectNothing<T> = Pick<Sec<T>, never>;
        type SelectSpread<L extends readonly unknown[]> =
          Pick<Confidential<Pair, readonly [...L, "b"]>, "x">;
        type OmitSpread<L extends readonly unknown[]> =
          Omit<Confidential<Pair, readonly [...L, "b"]>, "y">;
        type Forward<T extends { x?: string }> = Select<T>;
        type ForwardSec<T extends { x?: string }> = Select<Sec<T>>;
        type SelectOrDefault<T extends { x?: string }, U extends { x?: string } = Sec<T>> =
          Pick<U, "x">;
        type ForwardDefault<T extends { x?: string }> = SelectOrDefault<T>;
        type ForwardLabelled<T extends { x?: string }> =
          SelectSec<Confidential<T, readonly ["c"]>>;
        type Id<X> = X;
        type ForwardThroughId<T extends { x?: string }> = SelectSec<Id<T>>;
      `;

      for (
        const [alias, written, ifc] of [
          ["Select<Sec<Pair>>", 'Pick<Sec<Pair>, "x">', secret],
          [
            'SelectLabelled<readonly ["b"]>',
            'Pick<Confidential<Pair, readonly ["b"]>, "x">',
            { confidentiality: ["b"] },
          ],
          ["SelectSecond<Pair, Sec<Pair>>", 'Pick<Sec<Pair>, "x">', secret],
          ["SelectSecond<Sec<Pair>, Pair>", 'Pick<Pair, "x">', undefined],
          ["SelectDefault", 'Pick<Sec<Pair>, "x">', secret],
          [
            'SelectSec<Confidential<Pair, readonly ["b"]>>',
            'Pick<Sec<Confidential<Pair, readonly ["b"]>>, "x">',
            { confidentiality: ["b", "a"] },
          ],
          [
            'SelectBoth<Pair, readonly ["b"]>',
            'Pick<Confidential<Sec<Pair>, readonly ["b"]>, "x">',
            { confidentiality: ["a", "b"] },
          ],
          ["Forward<Sec<Pair>>", 'Pick<Sec<Pair>, "x">', secret],
          ["ForwardSec<Pair>", 'Pick<Sec<Pair>, "x">', secret],
          ["ForwardDefault<Pair>", 'Pick<Sec<Pair>, "x">', secret],
          [
            'ForwardLabelled<Confidential<Pair, readonly ["d"]>>',
            'Pick<Sec<Confidential<Confidential<Pair, readonly ["d"]>, readonly ["c"]>>, "x">',
            { confidentiality: ["d", "c", "a"] },
          ],
          [
            'ForwardThroughId<Confidential<Pair, readonly ["d"]>>',
            'Pick<Sec<Confidential<Pair, readonly ["d"]>>, "x">',
            { confidentiality: ["d", "a"] },
          ],
          [
            "SelectLabelled<readonly [string]>",
            'Pick<Confidential<Pair, readonly [string]>, "x">',
            undefined,
          ],
          ["SelectSec<never>", 'Pick<Sec<never>, "x">', undefined],
          ["SelectSec<any>", 'Pick<Sec<any>, "x">', undefined],
          [
            "SelectNothing<null | undefined>",
            "Pick<Sec<null | undefined>, never>",
            undefined,
          ],
          ["SelectNothing<void>", "Pick<Sec<void>, never>", secret],
          [
            'SelectSpread<readonly ["c", "d"]>',
            'Pick<Confidential<Pair, readonly ["c", "d", "b"]>, "x">',
            { confidentiality: ["c", "d", "b"] },
          ],
          [
            "SelectSpread<readonly []>",
            'Pick<Confidential<Pair, readonly ["b"]>, "x">',
            { confidentiality: ["b"] },
          ],
          [
            'OmitSpread<readonly ["c", "d"]>',
            'Omit<Confidential<Pair, readonly ["c", "d", "b"]>, "y">',
            { confidentiality: ["c", "d", "b"] },
          ],
          [
            "OmitSpread<readonly []>",
            'Omit<Confidential<Pair, readonly ["b"]>, "y">',
            { confidentiality: ["b"] },
          ],
          [
            "SelectSpread<string[]>",
            'Pick<Confidential<Pair, readonly [...string[], "b"]>, "x">',
            undefined,
          ],
        ] as const
      ) {
        it(`reads \`${alias}\` as \`${written}\`, ${ifc ? "labeled" : "unlabeled"}`, async () => {
          const read = await generate(alias, DECLARATIONS);
          const direct = await generate(written, DECLARATIONS);
          expect(read.schema).toEqual(direct.schema);
          expect((read.schema as Record<string, unknown>).ifc).toEqual(ifc);
          expect(read.diagnostics).toEqual([]);
        });
      }

      it("keeps the operand's own label for a union argument, which the alias written out distributes over", async () => {
        // Every member of the union carries the operand's carrier. Written
        // out, the intersection distributes over the union and is read as
        // no one labeled operand.
        const read = await generate(
          "SelectSec<{ x: string } | { x: string; z: 1 }>",
          DECLARATIONS,
        );
        const direct = await generate(
          'Pick<Sec<{ x: string } | { x: string; z: 1 }>, "x">',
          DECLARATIONS,
        );
        expect((read.schema as Record<string, unknown>).ifc).toEqual(secret);
        expect((direct.schema as Record<string, unknown>).ifc)
          .toBeUndefined();
        expect(read.diagnostics).toEqual([]);
      });
    });
  });
});
