/**
 * Holds every print of a type as a type node to flags that allow the empty
 * tuple. Without `AllowEmptyTuple` the checker prints nothing at all for a type
 * holding `[]` anywhere, so this reads the package's source and checks the
 * flags argument of each raw `checker.typeToTypeNode()` call there. A call
 * passes by naming `AllowEmptyTuple` or a shared flag set in that argument; the
 * check does not evaluate the argument.
 */

import { expect } from "@std/expect";
import { walk } from "@std/fs";
import { relative } from "@std/path";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import { TYPE_NODE_FLAGS } from "../src/ast/mod.ts";
import { DEFAULT_TYPE_NODE_FLAGS } from "../src/ast/type-building.ts";

const SRC_ROOT = new URL("../src/", import.meta.url);

/** The flag sets the source shares, by the name a call passes one under. */
const SHARED_FLAG_SETS: Record<string, ts.NodeBuilderFlags> = {
  TYPE_NODE_FLAGS,
  DEFAULT_TYPE_NODE_FLAGS,
};

/**
 * Finds each raw print in `SRC_ROOT`, with its location and whether its flags
 * allow `[]`.
 */
async function rawPrints(): Promise<
  { location: string; allowsEmptyTuple: boolean }[]
> {
  const allowing = new Set([
    "AllowEmptyTuple",
    ...Object.keys(SHARED_FLAG_SETS),
  ]);
  const namesAllowing = (node: ts.Node): boolean =>
    (ts.isIdentifier(node) && allowing.has(node.text)) ||
    (ts.forEachChild(node, namesAllowing) ?? false);

  const prints: { location: string; allowsEmptyTuple: boolean }[] = [];
  for await (
    const entry of walk(SRC_ROOT, { includeDirs: false, exts: [".ts"] })
  ) {
    const file = ts.createSourceFile(
      entry.path,
      await Deno.readTextFile(entry.path),
      ts.ScriptTarget.Latest,
      true,
    );
    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "typeToTypeNode"
      ) {
        const flags = node.arguments[2];
        const { line } = file.getLineAndCharacterOfPosition(
          node.getStart(file),
        );
        prints.push({
          location: `${relative(SRC_ROOT.pathname, entry.path)}:${line + 1}`,
          allowsEmptyTuple: flags !== undefined && namesAllowing(flags),
        });
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return prints;
}

describe("type node print flags", () => {
  it("includes `AllowEmptyTuple` in each shared flag set", () => {
    for (const flags of Object.values(SHARED_FLAG_SETS)) {
      expect(flags & ts.NodeBuilderFlags.AllowEmptyTuple).toBe(
        ts.NodeBuilderFlags.AllowEmptyTuple,
      );
    }
  });

  it("allows the empty tuple at every raw `checker.typeToTypeNode()` call", async () => {
    const prints = await rawPrints();

    expect(prints.length).toBeGreaterThan(0);
    expect(
      prints.filter((print) => !print.allowsEmptyTuple).map((print) =>
        print.location
      ),
    ).toEqual([]);
  });
});
