import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { CELL_DECLARATION_POSITIONS } from "./cell-declaration-positions.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { transformSource } from "./utils.ts";

const CELL = 'Writable<string | Default<"">>';

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
      // shrinker produced, before schema generation reads it.

      const { source } = CELL_DECLARATION_POSITIONS["a `computed()` capture"]!;
      const output = await transformBody(source(spelling));

      expect(output).toContain(
        'c: __cfHelpers.ReadonlyCell<string | Default<"">>',
      );
      expect(output).not.toContain("DEFAULT_MARKER");
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
