import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";

import {
  carriesWriterPolicy,
  holdsWriterPolicy,
  writerPolicyHeldBy,
} from "../../src/typescript/writer-policy.ts";
import { createTestProgram } from "../utils.ts";

const DECLARATIONS = `
  type Cfc<T, Meta> = T & { readonly __ct_cfc__?: Meta };
  type WriteAuthorizedBy<T, B> = Cfc<T, { writeAuthorizedBy: B }>;
  type WritePolicyAnyOf<
    T,
    Policies extends readonly [unknown, ...unknown[]],
  > = Cfc<T, { readonly writePolicyAnyOf: Policies }>;
  type Confidential<T, C> = Cfc<T, { confidentiality: C }>;
  type Stamped<T, Meta> = T & {
    readonly __ct_cfc__?: { readonly meta?: Meta; readonly of?: T };
  };
  function save() {}
  type Policy = WriteAuthorizedBy<string, typeof save>;
  interface Node { next: Node | null; value: string }
`;

/**
 * The type each entry of `types` writes, read from a program that declares
 * them after `DECLARATIONS`.
 */
async function typesOf<K extends string>(
  types: Record<K, string>,
): Promise<{ checker: ts.TypeChecker; types: Record<K, ts.Type> }> {
  const names = Object.keys(types) as K[];
  const { checker, sourceFile } = await createTestProgram(
    `${DECLARATIONS}\n${
      names.map((name) => `type Probe_${name} = ${types[name]};`).join("\n")
    }`,
  );
  const read = {} as Record<K, ts.Type>;
  for (const statement of sourceFile.statements) {
    if (
      ts.isTypeAliasDeclaration(statement) &&
      statement.name.text.startsWith("Probe_")
    ) {
      read[statement.name.text.slice("Probe_".length) as K] = checker
        .getTypeFromTypeNode(statement.type);
    }
  }
  return { checker, types: read };
}

describe("writer-policy", () => {
  describe("writerPolicyHeldBy", () => {
    it("names the alias that writes the policy a carrier's metadata holds", async () => {
      const { checker, types } = await typesOf({
        single: "{ writeAuthorizedBy: typeof save }",
        set: "{ readonly writePolicyAnyOf: [Policy] }",
        optional: "{ writeAuthorizedBy: typeof save } | undefined",
        label: '{ confidentiality: ["secret"] }',
      });

      expect(writerPolicyHeldBy(types.single, checker)).toBe(
        "WriteAuthorizedBy",
      );
      expect(writerPolicyHeldBy(types.set, checker)).toBe("WritePolicyAnyOf");
      expect(writerPolicyHeldBy(types.optional, checker)).toBe(
        "WriteAuthorizedBy",
      );
      expect(writerPolicyHeldBy(types.label, checker)).toBeUndefined();
    });
  });

  describe("carriesWriterPolicy", () => {
    it("returns `true` for a type whose own carrier holds a writer policy, through unions", async () => {
      const { checker, types } = await typesOf({
        policy: "Policy",
        nullable: "Policy | null",
        set: "WritePolicyAnyOf<string, [Policy]>",
      });

      expect(carriesWriterPolicy(types.policy, checker)).toBe(true);
      expect(carriesWriterPolicy(types.nullable, checker)).toBe(true);
      expect(carriesWriterPolicy(types.set, checker)).toBe(true);
    });

    it("returns `true` for a carrier that records the payload its writer policy was written around", async () => {
      // `CfcStamp` keeps the policy's payload beside its metadata.
      const { checker, types } = await typesOf({
        stamped: "Stamped<string, { writeAuthorizedBy: typeof save }>",
        labelled: 'Stamped<string, { confidentiality: ["secret"] }>',
      });

      expect(carriesWriterPolicy(types.stamped, checker)).toBe(true);
      expect(carriesWriterPolicy(types.labelled, checker)).toBe(false);
    });

    it("returns `false` for a carrier holding only labels, and for a policy a member holds", async () => {
      const { checker, types } = await typesOf({
        labelled: 'Confidential<string, ["secret"]>',
        member: "{ value: Policy }",
        plain: "string",
      });

      expect(carriesWriterPolicy(types.labelled, checker)).toBe(false);
      expect(carriesWriterPolicy(types.member, checker)).toBe(false);
      expect(carriesWriterPolicy(types.plain, checker)).toBe(false);
    });
  });

  describe("holdsWriterPolicy", () => {
    it("returns `true` for a writer policy the type carries or a value it holds carries", async () => {
      const { checker, types } = await typesOf({
        policy: "Policy",
        member: "{ value: Policy }",
        nested: "{ outer: { inner: Policy } }",
        element: "{ list: Policy[] }",
        tupleElement: "{ pair: [string, Policy] }",
        nullableMember: "{ value: Policy | null }",
        indexSignature: "{ byId: { [key: string]: Policy } }",
        numericIndexSignature: "{ byIndex: { [index: number]: Policy } }",
        twentyDeep: `${"{ nested: ".repeat(20)}Policy${" }".repeat(20)}`,
      });

      for (const type of Object.values(types)) {
        expect(holdsWriterPolicy(type, checker)).toBe(true);
      }
    });

    it("returns `true` for a value holding a carrier that records the payload its writer policy was written around", async () => {
      const { checker, types } = await typesOf({
        stamped:
          "{ value: Stamped<string, { writeAuthorizedBy: typeof save }> }",
        labelled: '{ value: Stamped<string, { confidentiality: ["secret"] }> }',
      });

      expect(holdsWriterPolicy(types.stamped, checker)).toBe(true);
      expect(holdsWriterPolicy(types.labelled, checker)).toBe(false);
    });

    it("returns `false` for labels alone, a function's result, and a recursive type holding no policy", async () => {
      const { checker, types } = await typesOf({
        labelled: '{ value: Confidential<string, ["secret"]> }',
        callback: "{ get: () => Policy }",
        recursive: "Node",
        plain: "{ value: string; count: number }",
      });

      for (const type of Object.values(types)) {
        expect(holdsWriterPolicy(type, checker)).toBe(false);
      }
    });
  });
});
