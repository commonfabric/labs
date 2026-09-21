// These branches of the Common Fabric formatter are otherwise exercised only
// when patterns compile cold through the transformer. When the compile cache is
// warm those lines are skipped, so they alternate between covered and uncovered
// across runs of identical code. These unit tests drive the same branches
// directly so the package's own test job records them on every run.

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";
import { SchemaGenerator } from "../src/schema-generator.ts";
import {
  asObjectSchema,
  createTestProgram,
  getTypeFromCode,
  getTypeFromFiles,
} from "./utils.ts";

function findInterfaceMemberTypeNode(
  sourceFile: ts.SourceFile,
  interfaceName: string,
  memberName: string,
): ts.TypeNode {
  let found: ts.TypeNode | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === interfaceName) {
      for (const member of node.members) {
        if (
          ts.isPropertySignature(member) &&
          member.type &&
          ts.isIdentifier(member.name) &&
          member.name.text === memberName
        ) {
          found = member.type;
          return;
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  if (!found) {
    throw new Error(`Member ${interfaceName}.${memberName} not found`);
  }
  return found;
}

// Locate the inner array TypeNode of a wrapper member (e.g. the `Item[]` inside
// `Writable<Item[]>`), used to drive the node-based array-items-override path.
function findWrapperInnerNode(
  sourceFile: ts.SourceFile,
  interfaceName: string,
  memberName: string,
): { wrapperNode: ts.TypeReferenceNode; innerNode: ts.TypeNode } {
  const member = findInterfaceMemberTypeNode(
    sourceFile,
    interfaceName,
    memberName,
  );
  if (!ts.isTypeReferenceNode(member) || !member.typeArguments?.[0]) {
    throw new Error(`Member ${interfaceName}.${memberName} is not a wrapper`);
  }
  return { wrapperNode: member, innerNode: member.typeArguments[0] };
}

describe("Common Fabric formatter flap coverage", () => {
  it(
    "keeps only the scope when a scope wrapper wraps a schema that accepts anything",
    async () => {
      // A scope wrapper carries its scope down onto the schema it wraps. When
      // that schema is `true` there is no object to carry it on, so the scope
      // becomes the whole schema.
      const code = `
        interface SchemaRoot {
          anything: PerUser<any>;
        }
      `;

      const { type, checker } = await getTypeFromCode(code, "SchemaRoot");
      const schema = asObjectSchema(
        new SchemaGenerator().generateSchema(type, checker),
      );

      expect(schema.properties?.anything).toEqual({ scope: "user" });
    },
  );

  it(
    "TrustedActionUiContract defaults required event integrity to the trusted pattern",
    async () => {
      // Three type arguments: the requiredEventIntegrity falls back to the
      // trusted pattern because no integrity argument is supplied.
      const code = `
        type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
        type TrustedActionUiContract<
          T,
          Action extends string,
          Pattern extends string,
        > = Cfc<T, {
          uiContract: {
            helper: "UiAction";
            action: Action;
            trustedPattern: Pattern;
          };
        }>;

        interface SchemaRoot {
          save: TrustedActionUiContract<string, "SaveTitle", "SaveSurface">;
        }
      `;

      const { type, checker } = await getTypeFromCode(code, "SchemaRoot");
      const schema = asObjectSchema(
        new SchemaGenerator().generateSchema(type, checker),
      );

      const save = schema.properties?.save as any;
      expect(save.type).toBe("string");
      expect(save.ifc?.uiContract).toEqual({
        helper: "UiAction",
        action: "SaveTitle",
        trustedPattern: "SaveSurface",
        requiredEventIntegrity: ["SaveSurface"],
      });
    },
  );

  it(
    "TrustedActionUiContract uses an explicit required-event-integrity tuple when provided",
    async () => {
      const code = `
        type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
        type TrustedActionUiContract<
          T,
          Action extends string,
          Pattern extends string,
          Integrity extends readonly [string, ...string[]] = [Pattern],
        > = Cfc<T, {
          uiContract: {
            helper: "UiAction";
            action: Action;
            trustedPattern: Pattern;
            requiredEventIntegrity: Integrity;
          };
        }>;

        interface SchemaRoot {
          save: TrustedActionUiContract<
            string,
            "SaveTitle",
            "SaveSurface",
            ["SaveSurface", "AuditSurface"]
          >;
        }
      `;

      const { type, checker } = await getTypeFromCode(code, "SchemaRoot");
      const schema = asObjectSchema(
        new SchemaGenerator().generateSchema(type, checker),
      );

      const save = schema.properties?.save as any;
      expect(save.type).toBe("string");
      expect(save.ifc?.uiContract).toEqual({
        helper: "UiAction",
        action: "SaveTitle",
        trustedPattern: "SaveSurface",
        requiredEventIntegrity: ["SaveSurface", "AuditSurface"],
      });
    },
  );

  it(
    "resolves a typeof-imported confidentiality tuple through the import alias",
    async () => {
      const { type, checker } = await getTypeFromFiles(
        {
          "/labels.ts": `
            export const LABELS = [
              { kind: "prompt-influence", allowed: false, owner: null },
              "secret",
            ] as const;
          `,
          "/main.ts": `
            import { LABELS } from "./labels.ts";
            type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
            type Confidential<T, X extends readonly unknown[]> = Cfc<
              T,
              { confidentiality: X }
            >;

            export interface SchemaRoot {
              body: Confidential<string, typeof LABELS>;
            }
          `,
        },
        "/main.ts",
        "SchemaRoot",
      );

      const schema = asObjectSchema(
        new SchemaGenerator().generateSchema(type, checker),
      );

      const body = schema.properties?.body as any;
      expect(body.type).toBe("string");
      expect(body.ifc?.confidentiality).toEqual([
        { kind: "prompt-influence", allowed: false, owner: null },
        "secret",
      ]);
    },
  );

  it(
    "preserves an outer cell wrapper via the node-driven array items override with plain items",
    async () => {
      const code = `
        interface SchemaRoot {
          items: Writable<{ name: string }[]>;
        }
      `;
      const { checker, sourceFile } = await createTestProgram(code);
      const { wrapperNode, innerNode } = findWrapperInnerNode(
        sourceFile,
        "SchemaRoot",
        "items",
      );

      // Resolve the wrapper's INNER array type, but format against the WRAPPER
      // node. The array type is not a cell wrapper, so type-level wrapper
      // detection finds nothing while the node still says `Writable<...>`, which
      // is the condition that routes through formatWrapperTypeFromNode.
      const innerArrayType = checker.getTypeFromTypeNode(innerNode);
      const schemaHints = new WeakMap<ts.Node, { items?: unknown }>();
      schemaHints.set(wrapperNode, { items: false });

      const result = new SchemaGenerator().generateSchema(
        innerArrayType,
        checker,
        wrapperNode,
        undefined,
        schemaHints,
      ) as Record<string, any>;

      expect(result).toEqual({
        type: "array",
        items: { type: "unknown" },
        asCell: ["cell"],
      });
    },
  );

  it(
    "recovers item-level cell wrappers via the node-driven array items override",
    async () => {
      const code = `
        interface SchemaRoot {
          items: Writable<Array<Cell<{ name: string }>>>;
        }
      `;
      const { checker, sourceFile } = await createTestProgram(code);
      const { wrapperNode, innerNode } = findWrapperInnerNode(
        sourceFile,
        "SchemaRoot",
        "items",
      );

      const innerArrayType = checker.getTypeFromTypeNode(innerNode);
      const schemaHints = new WeakMap<ts.Node, { items?: unknown }>();
      schemaHints.set(wrapperNode, { items: false });

      const result = new SchemaGenerator().generateSchema(
        innerArrayType,
        checker,
        wrapperNode,
        undefined,
        schemaHints,
      ) as Record<string, any>;

      expect(result).toEqual({
        type: "array",
        items: { type: "unknown", asCell: ["cell"] },
        asCell: ["cell"],
      });
    },
  );

  it(
    "node-driven array items override leaves a non-array wrapper inner untouched",
    async () => {
      // The items-false hint asks the array-items override to run, but the
      // wrapper's inner is a string-keyed map rather than an array. Neither the
      // resolved type nor the inner node yields an array element, and the inner
      // node is not a union, so the override adds no item-level cell wrapper and
      // the map schema survives under the outer cell wrapper.
      const code = `
        interface SchemaRoot {
          entries: Writable<Record<string, number>>;
        }
      `;
      const { checker, sourceFile } = await createTestProgram(code);
      const { wrapperNode, innerNode } = findWrapperInnerNode(
        sourceFile,
        "SchemaRoot",
        "entries",
      );

      const innerMapType = checker.getTypeFromTypeNode(innerNode);
      const schemaHints = new WeakMap<ts.Node, { items?: unknown }>();
      schemaHints.set(wrapperNode, { items: false });

      const result = new SchemaGenerator().generateSchema(
        innerMapType,
        checker,
        wrapperNode,
        undefined,
        schemaHints,
      ) as Record<string, any>;

      expect(result).toEqual({
        type: "object",
        properties: {},
        additionalProperties: { type: "number" },
        asCell: ["cell"],
      });
    },
  );
});
