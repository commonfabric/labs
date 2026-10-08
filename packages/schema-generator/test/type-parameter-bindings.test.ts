import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import type { GenerationContext } from "../src/interface.ts";
import { readBoundTypeNode } from "../src/type-parameter-bindings.ts";
import { getTypeFromCode } from "./utils.ts";

/** A bound member and its checker-created instantiation beside a sibling. */
async function memberOf(code: string) {
  const { type, checker, typeNode } = await getTypeFromCode(code, "Root");
  const reference = typeNode as ts.TypeReferenceNode;
  const declaration = type.getSymbol()!.declarations!.find(
    ts.isInterfaceDeclaration,
  )!;
  const member = declaration.members.find(ts.isPropertySignature)!;
  const actual = checker.getTypeOfSymbol(type.getProperty("c")!);
  const other = checker.getTypeOfSymbol(type.getProperty("other")!);
  const context: GenerationContext = {
    typeChecker: checker,
    cyclicTypes: new Set(),
    cyclicNames: new Set(),
    definitions: {},
    emittedRefs: new Set(),
    mergedIntersectionNames: new Map(),
    nameAnonymousDefinition: () => "AnonymousType_1",
    definitionStack: new Set(),
    inProgressNames: new Set(),
    boundTypeParameters: {
      declaredNode: reference,
      arguments: new Map([[declaration.typeParameters![0]!, {
        type: checker.getTypeFromTypeNode(reference.typeArguments![0]!),
      }]]),
    },
  };
  return { member: member.type!, actual, other, context };
}

describe("type-parameter-bindings", () => {
  describe("readBoundTypeNode()", () => {
    it("returns the member's own instantiation rather than a sibling with an any argument", async () => {
      const { member, actual, other, context } = await memberOf(`
        interface Box<T> { value: T }
        interface Input<T> { c: Box<T | string>; other: Box<any> }
        type Root = Input<number>;
      `);
      expect(
        readBoundTypeNode(member, { ...context, instantiatedAs: other }, [
          actual,
        ]),
      )
        .toBe(actual);
    });

    for (const argument of ["any", "unknown", "0"]) {
      it(`returns the checker instantiation after normalizing a union argument bound to \`${argument}\``, async () => {
        const { member, actual, context } = await memberOf(`
          interface Box<T> { value: T }
          interface Input<T> { c: Box<T | number>; other: Box<any> }
          type Root = Input<${argument}>;
        `);
        expect(
          readBoundTypeNode(member, { ...context, instantiatedAs: actual }),
        )
          .toBe(actual);
      });
    }

    it("returns the checker instantiation of an anonymous member that refers to itself", async () => {
      const { member, actual, other, context } = await memberOf(`
        interface Input<T> {
          c: { value: T; next: Input<T>["c"] };
          other: { value: T; next: Input<T>["c"] };
        }
        type Root = Input<number>;
      `);
      expect(
        readBoundTypeNode(member, { ...context, instantiatedAs: other }, [
          actual,
        ]),
      ).toBe(actual);
    });
  });
});
