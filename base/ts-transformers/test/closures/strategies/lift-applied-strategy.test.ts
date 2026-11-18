import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import ts from "typescript";

import { COMMONFABRIC_TYPES } from "../../commonfabric-test-types.ts";
import type { TransformationDiagnostic } from "../../../src/core/mod.ts";
import { transformSource } from "../../utils.ts";
import {
  callsNamed,
  collect,
  literalToValue,
  parseModule,
} from "../../transformed-ast.ts";

/**
 * Transforms a module whose handler body runs `statements`. A handler body is
 * where an authored `lift(fn)(input)` with captures compiles without a
 * diagnostic.
 */
async function transformHandler(
  state: string,
  statements: string,
): Promise<ts.SourceFile> {
  const source = `/// <cts-enable />
import { handler, lift, OpaqueCell, Writable } from "commonfabric";
interface Item { name: string }
function double(v: number) { return v * 2; }
export const h = handler<{ x: number }, ${state}>((e, s) => {
${statements}
});`;
  const diagnostics: TransformationDiagnostic[] = [];
  const output = await transformSource(source, {
    types: COMMONFABRIC_TYPES,
    pipelineDiagnostics: diagnostics,
  });
  expect(diagnostics).toEqual([]);
  return parseModule(output);
}

/** The `lift(...)` call that `const <name> = ...` hoists to module scope. */
function hoistedLift(root: ts.SourceFile, name: string): ts.CallExpression {
  const declaration = collect(root, ts.isVariableDeclaration).find((decl) =>
    ts.isIdentifier(decl.name) && decl.name.text === name
  );
  const initializer = declaration?.initializer;
  if (!initializer || !ts.isCallExpression(initializer)) {
    throw new Error(`Expected \`const ${name} = lift(...)\``);
  }
  return initializer;
}

/** The callback the hoisted `lift(...)` call takes as its first argument. */
function liftCallback(root: ts.SourceFile, name: string): ts.ArrowFunction {
  const callback = hoistedLift(root, name).arguments[0];
  if (!callback || !ts.isArrowFunction(callback)) {
    throw new Error(`Expected an arrow callback in ${name}`);
  }
  return callback;
}

/**
 * The `[propertyName, localName]` pairs of the callback's destructured
 * parameter, in order.
 */
function parameterBindings(callback: ts.ArrowFunction): string[][] {
  const name = callback.parameters[0]?.name;
  if (!name || !ts.isObjectBindingPattern(name)) {
    throw new Error("Expected a destructured callback parameter");
  }
  return name.elements.map((element) => {
    if (!ts.isIdentifier(element.name)) {
      throw new Error("Expected an identifier binding");
    }
    const property = element.propertyName;
    return [
      property && ts.isIdentifier(property) ? property.text : element.name.text,
      element.name.text,
    ];
  });
}

/** The object literal the handler body applies the hoisted lift to. */
function appliedInput(
  root: ts.SourceFile,
  name: string,
): ts.ObjectLiteralExpression {
  const input = callsNamed(root, name)[0]?.arguments[0];
  if (!input || !ts.isObjectLiteralExpression(input)) {
    throw new Error(`Expected ${name}({ ... })`);
  }
  return input;
}

/** Each property of an object literal as `name: initializer` text. */
function propertyTexts(
  root: ts.SourceFile,
  literal: ts.ObjectLiteralExpression,
): string[] {
  return literal.properties.map((property) => {
    if (ts.isShorthandPropertyAssignment(property)) {
      return property.name.text;
    }
    if (ts.isPropertyAssignment(property) && ts.isIdentifier(property.name)) {
      return `${property.name.text}: ${property.initializer.getText(root)}`;
    }
    throw new Error("Unexpected property kind");
  });
}

describe("lift-applied-strategy", () => {
  describe("transformLiftAppliedCall()", () => {
    it("keys a property-access input by its property name", async () => {
      const root = await transformHandler(
        "{ value: number; out: Writable<number> }",
        `const m = e.x;
  s.out.set(lift((v: number) => v * m)(s.value));`,
      );

      expect(parameterBindings(liftCallback(root, "__cfLift_1"))).toEqual([
        ["value", "v"],
        ["m", "m"],
      ]);
      expect(propertyTexts(root, appliedInput(root, "__cfLift_1"))).toEqual([
        "value: s.value",
        "m: m",
      ]);
    });

    it("keys an input that is neither an identifier nor a property access as `input`", async () => {
      const root = await transformHandler(
        "{ value: number; out: Writable<number> }",
        `const m = e.x;
  s.out.set(lift((v: number) => v + m)(s.value + 1));`,
      );

      expect(parameterBindings(liftCallback(root, "__cfLift_1"))).toEqual([
        ["input", "v"],
        ["m", "m"],
      ]);
      expect(propertyTexts(root, appliedInput(root, "__cfLift_1"))).toEqual([
        "input: s.value + 1",
        "m: m",
      ]);
    });

    it("renames a capture that shares the input's name past the names other captures use", async () => {
      // The input `s.value` is keyed `value`, which the captured local `value`
      // also wants. `value_1` is taken by another capture, so the colliding
      // capture becomes `value_2`, in the callback's bindings, its body, and
      // the applied input alike.
      const root = await transformHandler(
        "{ value: number; out: Writable<number> }",
        `const value = e.x;
  const value_1 = e.x;
  s.out.set(lift((v: number) => v + value + value_1)(s.value));`,
      );

      const callback = liftCallback(root, "__cfLift_1");
      expect(parameterBindings(callback)).toEqual([
        ["value", "v"],
        ["value_2", "value_2"],
        ["value_1", "value_1"],
      ]);
      expect(callback.body.getText(root)).toBe("v + value_2 + value_1");
      expect(propertyTexts(root, appliedInput(root, "__cfLift_1"))).toEqual([
        "value: s.value",
        "value_2: value",
        "value_1: value_1",
      ]);
    });

    it("leaves a lift of a function declaration applied to its bare input", async () => {
      // `double` is no arrow or function expression, so there is no callback
      // to take captures from; the lift keeps its authored argument and input.
      const root = await transformHandler(
        "{ value: number; out: Writable<number> }",
        "s.out.set(lift(double)(s.value));",
      );

      const lift = hoistedLift(root, "__cfLift_1");
      expect(lift.arguments.map((arg) => arg.getText(root))).toEqual([
        "double",
      ]);
      const applied = callsNamed(root, "__cfLift_1")[0]!;
      expect(applied.arguments.map((arg) => arg.getText(root))).toEqual([
        "s.value",
      ]);
    });

    it("emits no type arguments when the callback returns a type parameter", async () => {
      const root = await transformHandler(
        "{ value: number; out: Writable<number> }",
        `const m = e.x;
  s.out.set(lift(<T,>(v: T) => (m ? v : v))(s.value));`,
      );

      const lift = hoistedLift(root, "__cfLift_1");
      expect(lift.typeArguments).toBeUndefined();
      expect(lift.arguments.slice(1, 3).map(literalToValue)).toEqual([
        { type: "unknown" },
        { type: "unknown" },
      ]);

      // A concrete return type is spelled as the second type argument.
      const concrete = hoistedLift(
        await transformHandler(
          "{ value: number; out: Writable<number> }",
          `const m = e.x;
  s.out.set(lift((v: number) => (m ? v : v))(s.value));`,
        ),
        "__cfLift_1",
      );
      expect(concrete.typeArguments?.[1]?.kind).toBe(
        ts.SyntaxKind.NumberKeyword,
      );
    });

    it("types a captured opaque cell as its unwrapped value in the lift's input", async () => {
      // Inside the lift the captured `OpaqueCell<Item[]>` is the plain array,
      // so the input type argument spells `items` as `Item[]`, not as a cell.
      const root = await transformHandler(
        "{ items: OpaqueCell<Item[]>; out: Writable<string> }",
        `const items = s.items;
  const sep = "" + e.x;
  s.out.set(lift((sep: string) => items.map((i) => i.name).join(sep))(sep));`,
      );

      const input = hoistedLift(root, "__cfLift_1").typeArguments?.[0];
      if (!input || !ts.isTypeLiteralNode(input)) {
        throw new Error("Expected an object input type argument");
      }
      const items = input.members.find((member) =>
        member.name && ts.isIdentifier(member.name) &&
        member.name.text === "items"
      );
      if (!items || !ts.isPropertySignature(items) || !items.type) {
        throw new Error("Expected an `items` input property");
      }
      expect(items.type.getText(root)).toBe("Item[]");
    });
  });
});
