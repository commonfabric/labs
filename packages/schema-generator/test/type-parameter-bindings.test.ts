import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import type { GenerationContext } from "../src/interface.ts";
import { readBoundTypeNode } from "../src/type-parameter-bindings.ts";
import { getTypeFromCode } from "./utils.ts";

/** A bound member and its checker-created instantiation beside `Box<any>`. */
async function memberOf(argument: string, suffix: string) {
  const { type, checker, typeNode } = await getTypeFromCode(
    `
    interface Box<T> { value: T }
    interface Input<T> { c: Box<T | ${suffix}>; other: Box<any> }
    type Root = Input<${argument}>;
  `,
    "Root",
  );
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
      const { member, actual, other, context } = await memberOf(
        "number",
        "string",
      );
      expect(
        readBoundTypeNode(member, { ...context, instantiatedAs: other }, [
          actual,
        ]),
      )
        .toBe(actual);
    });

    for (const argument of ["any", "unknown", "0"]) {
      it(`returns the checker instantiation after normalizing a union argument bound to \`${argument}\``, async () => {
        const { member, actual, context } = await memberOf(argument, "number");
        expect(
          readBoundTypeNode(member, { ...context, instantiatedAs: actual }),
        )
          .toBe(actual);
      });
    }
  });
});
