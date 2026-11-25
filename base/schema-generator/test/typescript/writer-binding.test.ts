import { expect } from "@std/expect";
import ts from "typescript";

import { resolveWriterBinding } from "../../src/typescript/writer-binding.ts";
import { createTestProgram } from "../utils.ts";
import { describe, it } from "@commonfabric/test-support/test";

/**
 * What `resolveWriterBinding()` returns for the identifier `binding` in
 * `typeof binding`, the type of `type Claim` in `source`.
 */
async function writerOf(source: string) {
  const { checker, sourceFile } = await createTestProgram(source);
  let binding: ts.Identifier | undefined;
  ts.forEachChild(sourceFile, (node) => {
    if (
      ts.isTypeAliasDeclaration(node) && node.name.text === "Claim" &&
      ts.isTypeQueryNode(node.type) && ts.isIdentifier(node.type.exprName)
    ) {
      binding = node.type.exprName;
    }
  });
  if (!binding) throw new Error("`type Claim` is no `typeof` a name");
  const resolved = resolveWriterBinding(binding, checker);
  return resolved && { name: resolved.name, fileName: resolved.fileName };
}

describe("resolveWriterBinding()", () => {
  it("returns a variable's declared name and module", async () => {
    expect(
      await writerOf(`const writer = () => 1; type Claim = typeof writer;`),
    ).toEqual({ name: "writer", fileName: "test.ts" });
  });

  it("returns a function's declared name and module", async () => {
    expect(
      await writerOf(`function writer() {} type Claim = typeof writer;`),
    ).toEqual({ name: "writer", fileName: "test.ts" });
  });

  it("returns `undefined` for a class, which is neither", async () => {
    expect(await writerOf(`class Writer {} type Claim = typeof Writer;`))
      .toBeUndefined();
  });

  it("returns `undefined` for a name bound by destructuring", async () => {
    // Its declaration is the binding element, not a variable declaration.

    expect(
      await writerOf(
        `const { writer } = { writer: () => 1 }; type Claim = typeof writer;`,
      ),
    ).toBeUndefined();
  });

  it("returns `undefined` for a name declared only by the library", async () => {
    expect(await writerOf(`type Claim = typeof parseInt;`)).toBeUndefined();
  });
});
