import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";

import {
  carriesWriterPolicy,
  holdsWriterPolicy,
  readWriterPolicy,
  writerPolicyHeldBy,
  writerPolicyHeldWithin,
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
  interface Holder<T> { readonly value: T }
  interface HoldingCell<T> extends BrandedCell<T, "cell"> { readonly value: T }
  interface HoldingStream<T> extends BrandedCell<T, "stream"> {
    readonly event: T;
  }
  interface Node { next: Node | null; value: string }
  type Expanding<T> = { value: T; next?: Expanding<T[]> };
  interface ExpandingNode<T> { value: T; next?: ExpandingNode<T[]> }
  type ExpandingTuple<T> = [T, ExpandingTuple<T[]>?];
  type ExpandingLabelled<T> = Confidential<
    { value: T; next?: ExpandingLabelled<T[]> },
    ["secret"]
  >;
  interface Pair<T> { first: T }
  interface Cycle<A, B, C> { value: A; next?: Cycle<B, C, A> }
  type DeepReadonly<T> = { readonly [K in keyof T]: DeepReadonly<T[K]> };
  interface Chain<N extends unknown[]> {
    value: string;
    next?: N extends [unknown, ...infer R] ? Chain<R> : null;
  }
  type Branching<T> = { left?: Branching<[T, 1]>; right?: Branching<[T, 2]> };
  type Tree<T, D extends unknown[]> = D extends [unknown, ...infer R]
    ? { left: Tree<[T, 1], R>; right: Tree<[T, 2], R> }
    : T;
  type PolicyLast<T, D extends unknown[]> = D extends [unknown, ...infer R]
    ? { left: Tree<[T, 1], R>; right: PolicyLast<[T, 2], R> }
    : Policy;
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

  describe("writerPolicyHeldWithin", () => {
    it("names the alias that writes the policy a value the type holds carries", async () => {
      const { checker, types } = await typesOf({
        single: "{ value: Policy }",
        set:
          "{ byIndex: { [index: number]: WritePolicyAnyOf<string, [Policy]> } }",
        stamped:
          "{ value: Stamped<string, { readonly writePolicyAnyOf: [Policy] }> }",
        labelled: '{ value: Confidential<string, ["secret"]> }',
      });

      expect(writerPolicyHeldWithin(types.single, checker)).toBe(
        "WriteAuthorizedBy",
      );
      expect(writerPolicyHeldWithin(types.set, checker)).toBe(
        "WritePolicyAnyOf",
      );
      expect(writerPolicyHeldWithin(types.stamped, checker)).toBe(
        "WritePolicyAnyOf",
      );
      expect(writerPolicyHeldWithin(types.labelled, checker)).toBeUndefined();
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

    it("returns `false` for a policy only the type a cell or a stream links to holds, and `true` for one a plain holder or a carrier around the link holds", async () => {
      // A cell or a stream holds a link, and a policy inside the type it links
      // to is the linked document's. A carrier around the link is a policy on
      // the link itself.
      const { checker, types } = await typesOf({
        cellLink: "{ link: HoldingCell<Policy> }",
        streamLink: "{ link: HoldingStream<{ value: Policy }> }",
        plainHolder: "{ box: Holder<Policy> }",
        carrierAroundLink:
          "{ link: WriteAuthorizedBy<HoldingCell<string>, typeof save> }",
      });

      expect(holdsWriterPolicy(types.cellLink, checker)).toBe(false);
      expect(holdsWriterPolicy(types.streamLink, checker)).toBe(false);
      expect(holdsWriterPolicy(types.plainHolder, checker)).toBe(true);
      expect(holdsWriterPolicy(types.carrierAroundLink, checker)).toBe(true);
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

    it("returns `true` for a recursion that instantiates its declaration without end, whose remainder is unread", async () => {
      const { checker, types } = await typesOf({
        alias: "Expanding<string>",
        labelled: "ExpandingLabelled<string>",
      });

      for (const type of Object.values(types)) {
        expect(holdsWriterPolicy(type, checker)).toBe(true);
      }
    });
  });

  describe("readWriterPolicy", () => {
    it('returns `"unread"` for a recursion that instantiates its declaration without end and holds no policy where it is read', async () => {
      const { checker, types } = await typesOf({
        alias: "Expanding<string>",
        interface: "ExpandingNode<string>",
        tuple: "ExpandingTuple<string>",
        labelled: "ExpandingLabelled<string>",
        member: "{ value: ExpandingLabelled<number> }",
        branching: "Branching<string>",
      });

      for (const type of Object.values(types)) {
        expect(readWriterPolicy(type, checker)).toBe("unread");
      }
    });

    it('returns `"unread"` for a nesting that ends past the depth a reading stops at', async () => {
      const { checker, types } = await typesOf({
        chain: `Chain<[${Array(120).fill(1).join(", ")}]>`,
      });

      expect(readWriterPolicy(types.chain, checker)).toBe("unread");
    });

    it('returns `"unread"` for a policy read only after more types than a reading stops at', async () => {
      // Each left subtree holds 2^13 distinct objects, read before the right
      // spine that ends at the policy.
      const { checker, types } = await typesOf({
        policyLast: `PolicyLast<0, [${Array(14).fill(1).join(", ")}]>`,
      });

      expect(readWriterPolicy(types.policyLast, checker)).toBe("unread");
    });

    it("returns the alias of a writer policy beside a recursion it stops reading", async () => {
      const { checker, types } = await typesOf({
        before: "{ policy: Policy; rest: Expanding<string> }",
        after: "{ rest: Expanding<string>; policy: Policy }",
      });

      for (const type of Object.values(types)) {
        expect(readWriterPolicy(type, checker)).toBe("WriteAuthorizedBy");
        expect(writerPolicyHeldWithin(type, checker)).toBe(
          "WriteAuthorizedBy",
        );
      }
    });

    it("is answered by `writerPolicyHeldWithin` as holding no policy where it stops reading a recursion", async () => {
      const { checker, types } = await typesOf({
        alias: "Expanding<string>",
      });

      expect(writerPolicyHeldWithin(types.alias, checker)).toBeUndefined();
    });

    it("returns `undefined` for a nesting that ends within the bounds and holds no policy", async () => {
      const { checker, types } = await typesOf({
        pairs: `${"Pair<".repeat(10)}string${">".repeat(10)}`,
        arrays: `{ value: string${"[]".repeat(10)} }`,
        arraysOfObjects:
          "{ a: { b: { c: { d: { e: { name: string }[] }[] }[] }[] }[] }",
        records:
          "{ a: Record<string, { b: Record<string, { c: Record<string, { d: 1 }> }> }> }",
        mapped:
          "DeepReadonly<{ a: { b: { c: { d: { e: { f: { g: { h: { i: string } } } } } } } } }>",
        cycle: "Cycle<1, 2, 3>",
        shrinking: `Chain<[${Array(30).fill(1).join(", ")}]>`,
      });

      for (const type of Object.values(types)) {
        expect(readWriterPolicy(type, checker)).toBeUndefined();
      }
    });

    it("reads an object literal's own type through the values it holds", async () => {
      const { checker, sourceFile } = await createTestProgram(
        `${DECLARATIONS}
declare const policy: Policy;
const held = { a: { b: policy } };
const plain = { a: { b: 1 } };`,
      );
      const literals = Object.fromEntries(
        sourceFile.statements.filter(ts.isVariableStatement).flatMap((
          statement,
        ) => statement.declarationList.declarations).filter((declaration) =>
          declaration.initializer &&
          ts.isObjectLiteralExpression(declaration.initializer)
        ).map((declaration) => [
          declaration.name.getText(sourceFile),
          checker.getTypeAtLocation(declaration.initializer!),
        ]),
      );

      expect(readWriterPolicy(literals.held!, checker)).toBe(
        "WriteAuthorizedBy",
      );
      expect(readWriterPolicy(literals.plain!, checker)).toBeUndefined();
    });
  });
});
