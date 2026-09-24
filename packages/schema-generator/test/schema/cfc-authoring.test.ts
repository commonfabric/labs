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

  it("lowers only the labels where an alias chain's payload keeps a parameter substitution does not reach", async () => {
    // `Contact` names no parameter, but its expansion reaches `Secret`'s `T`
    // through an indexed access the lowering does not substitute.
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
});
