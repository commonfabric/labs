import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import ts from "typescript";

import { CELL_DECLARATION_POSITIONS } from "./cell-declaration-positions.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { collect, parseModule } from "./transformed-ast.ts";
import { transformSource } from "./utils.ts";

const CELL = 'Writable<string | Default<"">>';

/**
 * The members of the value type an emitted `c: __cfHelpers.ReadonlyCell<…>`
 * holds in `output`, each named by its reference name or its keyword, or
 * `undefined` when no such property is emitted or its value is not a union.
 */
function readonlyCellValueMembers(output: string): string[] | undefined {
  const value = collect(parseModule(output), ts.isPropertySignature)
    .map((signature) =>
      ts.isIdentifier(signature.name) &&
        signature.name.text === "c" &&
        signature.type && ts.isTypeReferenceNode(signature.type) &&
        ts.isQualifiedName(signature.type.typeName) &&
        signature.type.typeName.right.text === "ReadonlyCell"
        ? signature.type.typeArguments?.[0]
        : undefined
    )
    .find((node) => node !== undefined);
  if (!value || !ts.isUnionTypeNode(value)) return undefined;
  return value.types.map((member) =>
    ts.isTypeReferenceNode(member) && ts.isIdentifier(member.typeName)
      ? member.typeName.text
      : member.kind === ts.SyntaxKind.StringKeyword
      ? "string"
      : `other (${member.kind})`
  );
}

/** Transforms `body`, with the builders it may call imported. */
function transformBody(body: string): Promise<string> {
  return transformSource(
    `import { computed, handler, lift, pattern, Writable, type Default } from "commonfabric";
     ${body}`,
    { types: COMMONFABRIC_TYPES },
  );
}

describe("parenthesized-cell-type", () => {
  // Parentheses around a cell type change nothing it denotes, so each case
  // holds a parenthesized spelling to what the bare wrapper emits.

  for (const spelling of [`(${CELL})`, `((${CELL}))`]) {
    it(`emits the authored value type for a capture of a cell declared as \`${spelling}\``, async () => {
      // The capture's type is emitted as source, which shows the value node the
      // shrinker produced, before schema generation reads it. A value printed
      // from the cell's type instead holds the `Default` as the intersection
      // with its brand.

      const { source } = CELL_DECLARATION_POSITIONS["a `computed()` capture"]!;
      const output = await transformBody(source(spelling));

      expect(readonlyCellValueMembers(output)).toEqual(["string", "Default"]);
    });
  }

  for (
    const [position, { source, schemaOf }] of Object.entries(
      CELL_DECLARATION_POSITIONS,
    )
  ) {
    it(`emits for a parenthesized cell in ${position} what the bare wrapper emits`, async () => {
      const parenthesized = schemaOf(await transformBody(source(`(${CELL})`)));
      const bare = schemaOf(await transformBody(source(CELL)));

      expect(parenthesized).toEqual(bare);
      expect(parenthesized).toHaveProperty("default", "");
    });
  }
});
