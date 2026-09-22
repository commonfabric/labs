import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";
import { SchemaGenerator } from "../../src/schema-generator.ts";
import {
  asObjectSchema,
  createTestProgram,
  getTypeFromCode,
  getTypeFromFiles,
} from "../utils.ts";

describe("Schema: CFC authoring aliases", () => {
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
});
