import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";

import {
  declaredTypeNode,
  destructuredSourceProperty,
  namesOnlyPolicyBindings,
  namesValueBinding,
  readBindingAnnotation,
  readDeclaringSymbol,
  readValueSymbol,
  spellSameValue,
} from "../../src/typescript/value-annotation.ts";
import { createTestProgramFromFiles } from "../utils.ts";

const ENTRY = `
  import type { PolicyOf } from "./cfc-types.ts";
  type Cfc<T, M> = T & { readonly __ct_cfc__?: { readonly meta?: M; readonly of?: T } };
  type Confidential<T, X extends readonly unknown[]> = Cfc<T, { confidentiality: X }>;
  type Writes<T, W> = Cfc<T, { writeAuthorizedBy: W }>;
  export const rules = {};
  export const other = {};
  export function save(): void {}
  type Labelled = Confidential<string, [PolicyOf<typeof rules>]>;
  type OtherLabelled = Confidential<string, [PolicyOf<typeof other>]>;
  type Shape = { name: string };
  type Written = Writes<string, typeof save>;
  interface Input {
    labelled: Confidential<string, [PolicyOf<typeof rules>]>;
    labelledAgain: Confidential<string, [PolicyOf<typeof rules>]>;
    otherLabelled: Confidential<string, [PolicyOf<typeof other>]>;
    aliased: Labelled;
    aliasedAgain: Labelled;
    otherAliased: OtherLabelled;
    written: Writes<string, typeof save>;
    aliasedWriter: Written;
    both: Writes<Confidential<string, [PolicyOf<typeof rules>]>, typeof save>;
    plain: string;
    shape: Shape;
    nested: { inner: Labelled };
    16: Labelled;
  }
  class Holder {
    get value(): Labelled { return null!; }
    method(): void {}
  }
  export function read(
    { labelled, aliased: renamed, nested: { inner }, 0x10: hex, ...rest }: Input,
    holder: Holder,
  ) {
    return {
      labelled,
      renamed,
      inner,
      hex,
      rest,
      parenthesized: (labelled),
      fromHolder: holder.value,
      plain: rest.plain,
      written: rest.written,
      called: String(labelled),
    };
  }
`;

/**
 * The program declaring `ENTRY`, with each member of `Input` by name, and
 * each member of the object `read` returns by name, as the expression it is
 * written with.
 */
async function program() {
  const { checker, sourceFile } = await createTestProgramFromFiles({
    "/cfc-types.ts":
      `export type PolicyOf<B> = { readonly __ct_cfc_policy_of__?: B };`,
    "/entry.ts": ENTRY,
  }, "/entry.ts");
  const input = sourceFile.statements.find((statement) =>
    ts.isInterfaceDeclaration(statement) && statement.name.text === "Input"
  ) as ts.InterfaceDeclaration;
  const members = new Map<string, ts.PropertySignature>();
  for (const member of input.members) {
    if (ts.isPropertySignature(member)) {
      members.set(member.name.getText(sourceFile), member);
    }
  }
  const returned = new Map<string, ts.Expression>();
  const visit = (node: ts.Node) => {
    if (
      ts.isReturnStatement(node) && node.expression &&
      ts.isObjectLiteralExpression(node.expression)
    ) {
      for (const property of node.expression.properties) {
        if (ts.isShorthandPropertyAssignment(property)) {
          returned.set(property.name.text, property.name);
        } else if (ts.isPropertyAssignment(property)) {
          returned.set(property.name.getText(sourceFile), property.initializer);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const memberType = (name: string) =>
    checker.getTypeAtLocation(
      members.get(name)!.type!,
    );
  return { checker, sourceFile, members, returned, memberType };
}

describe("value-annotation", () => {
  describe("namesValueBinding", () => {
    it("returns `true` for a node writing a `typeof`, directly or through an authored alias", async () => {
      const { checker, members } = await program();

      expect(namesValueBinding(members.get("labelled")!.type!, checker))
        .toBe(true);
      expect(namesValueBinding(members.get("aliased")!.type!, checker))
        .toBe(true);
    });

    it("returns `false` for a node naming only shapes", async () => {
      const { checker, members } = await program();

      expect(namesValueBinding(members.get("plain")!.type!, checker))
        .toBe(false);
      expect(namesValueBinding(members.get("shape")!.type!, checker))
        .toBe(false);
    });
  });

  describe("namesOnlyPolicyBindings", () => {
    it("returns `true` for a node whose every `typeof` is a `PolicyOf`'s rules", async () => {
      const { checker, members } = await program();

      expect(namesOnlyPolicyBindings(members.get("labelled")!.type!, checker))
        .toBe(true);
      expect(namesOnlyPolicyBindings(members.get("aliased")!.type!, checker))
        .toBe(true);
    });

    it("returns `false` for a node naming a writer, alone, beside a policy, or through an authored alias", async () => {
      const { checker, members } = await program();

      expect(namesOnlyPolicyBindings(members.get("written")!.type!, checker))
        .toBe(false);
      expect(namesOnlyPolicyBindings(members.get("both")!.type!, checker))
        .toBe(false);
      expect(
        namesOnlyPolicyBindings(members.get("aliasedWriter")!.type!, checker),
      ).toBe(false);
    });
  });

  describe("readValueSymbol", () => {
    it("returns the binding a shorthand property names, not the property", async () => {
      const { checker, returned } = await program();
      const symbol = readValueSymbol(
        returned.get("labelled") as ts.Identifier,
        checker,
      );

      expect(
        symbol?.valueDeclaration &&
          ts.isBindingElement(symbol.valueDeclaration),
      )
        .toBe(true);
    });
  });

  describe("destructuredSourceProperty", () => {
    const sourceOf = async (name: string) => {
      const { checker, returned } = await program();
      const identifier = returned.get(name) as ts.Identifier;
      return destructuredSourceProperty(identifier, identifier.text, checker)
        ?.getName();
    };

    it("returns the property a binding reads, by its own name", async () => {
      expect(await sourceOf("labelled")).toBe("labelled");
    });

    it("returns the source property of a renamed binding", async () => {
      expect(await sourceOf("renamed")).toBe("aliased");
    });

    it("returns the property a binding inside a nested pattern reads", async () => {
      expect(await sourceOf("inner")).toBe("inner");
    });

    it("returns the property a numeric key names", async () => {
      expect(await sourceOf("hex")).toBe("16");
    });

    it("returns `undefined` for a rest binding", async () => {
      expect(await sourceOf("rest")).toBeUndefined();
    });
  });

  describe("declaredTypeNode", () => {
    it("returns the annotation of a property, and the return annotation of a getter", async () => {
      const { checker, sourceFile, members, returned } = await program();
      const property = checker.getSymbolAtLocation(
        members.get("labelled")!.name,
      );
      const getter = readDeclaringSymbol(returned.get("fromHolder")!, checker);

      expect(declaredTypeNode(property)).toBe(members.get("labelled")!.type);
      expect(declaredTypeNode(getter)?.getText(sourceFile)).toBe("Labelled");
    });

    it("returns `undefined` for a method, and for no symbol", async () => {
      const { checker, sourceFile } = await program();
      const holder = sourceFile.statements.find((statement) =>
        ts.isClassDeclaration(statement)
      ) as ts.ClassDeclaration;
      const method = holder.members.find(ts.isMethodDeclaration)!;

      expect(declaredTypeNode(checker.getSymbolAtLocation(method.name!)))
        .toBeUndefined();
      expect(declaredTypeNode(undefined)).toBeUndefined();
    });
  });

  describe("readDeclaringSymbol", () => {
    it("returns the source property of a binding read inside parentheses", async () => {
      const { checker, returned } = await program();

      expect(
        readDeclaringSymbol(returned.get("parenthesized")!, checker)
          ?.getName(),
      ).toBe("labelled");
    });

    it("returns the member a property access names", async () => {
      const { checker, returned } = await program();

      expect(readDeclaringSymbol(returned.get("plain")!, checker)?.getName())
        .toBe("plain");
    });

    it("returns `undefined` for a value no name reads", async () => {
      const { checker, returned } = await program();

      expect(readDeclaringSymbol(returned.get("called")!, checker))
        .toBeUndefined();
    });
  });

  describe("readBindingAnnotation", () => {
    it("returns the annotation that names a binding and denotes the type the value is read at", async () => {
      const { checker, returned, members, memberType } = await program();

      expect(
        readBindingAnnotation(
          readDeclaringSymbol(returned.get("labelled")!, checker),
          memberType("labelled"),
          checker,
        ),
      ).toBe(members.get("labelled")!.type);
    });

    it("returns `undefined` for an annotation naming no binding", async () => {
      const { checker, returned, memberType } = await program();

      expect(
        readBindingAnnotation(
          readDeclaringSymbol(returned.get("plain")!, checker),
          memberType("plain"),
          checker,
        ),
      ).toBeUndefined();
    });

    it("returns `undefined` where the annotation denotes another type", async () => {
      const { checker, returned, memberType } = await program();

      expect(
        readBindingAnnotation(
          readDeclaringSymbol(returned.get("labelled")!, checker),
          memberType("plain"),
          checker,
        ),
      ).toBeUndefined();
    });

    it("returns `undefined` for no symbol", async () => {
      const { checker, memberType } = await program();

      expect(readBindingAnnotation(undefined, memberType("plain"), checker))
        .toBeUndefined();
    });
  });

  describe("spellSameValue", () => {
    // `rules` and `other` are both `{}`, so every labelled member here denotes
    // one type; only the bindings the annotations name tell them apart.

    const annotation = (
      members: Map<string, ts.PropertySignature>,
      name: string,
    ) => members.get(name)!.type!;

    it("returns `true` for one node", async () => {
      const { checker, members } = await program();
      const labelled = annotation(members, "labelled");

      expect(spellSameValue(labelled, labelled, checker)).toBe(true);
    });

    it("returns `true` for two annotations written alike, naming one binding", async () => {
      const { checker, members } = await program();

      expect(spellSameValue(
        annotation(members, "labelled"),
        annotation(members, "labelledAgain"),
        checker,
      )).toBe(true);
    });

    it("returns `false` for two annotations denoting one type that name different bindings", async () => {
      const { checker, members } = await program();

      expect(spellSameValue(
        annotation(members, "labelled"),
        annotation(members, "otherLabelled"),
        checker,
      )).toBe(false);
    });

    it("reads the bindings an alias names", async () => {
      const { checker, members } = await program();

      expect(spellSameValue(
        annotation(members, "aliased"),
        annotation(members, "aliasedAgain"),
        checker,
      )).toBe(true);
      expect(spellSameValue(
        annotation(members, "aliased"),
        annotation(members, "otherAliased"),
        checker,
      )).toBe(false);
    });

    it("returns `false` for a type written through an alias beside the same type written out", async () => {
      // The two denote a type apart (`denotesSameType`), so they are not held
      // to spell one value, whatever bindings they name.
      const { checker, members } = await program();

      expect(spellSameValue(
        annotation(members, "labelled"),
        annotation(members, "aliased"),
        checker,
      )).toBe(false);
    });

    it("returns `false` for annotations denoting different types", async () => {
      const { checker, members } = await program();

      expect(spellSameValue(
        annotation(members, "labelled"),
        annotation(members, "plain"),
        checker,
      )).toBe(false);
    });

    it("returns `false` where a binding does not resolve, given one type for both", async () => {
      // A `typeof` built without positions names nothing the checker can find,
      // written alone or inside a built reference.
      const { checker, members, memberType } = await program();
      const query = () =>
        ts.factory.createTypeQueryNode(ts.factory.createIdentifier("rules"));
      const labelled = annotation(members, "labelled");
      const type = () => memberType("labelled");

      expect(spellSameValue(labelled, query(), checker, type)).toBe(false);
      expect(spellSameValue(
        labelled,
        ts.factory.createTypeReferenceNode("PolicyOf", [query()]),
        checker,
        type,
      )).toBe(false);
    });
  });
});
