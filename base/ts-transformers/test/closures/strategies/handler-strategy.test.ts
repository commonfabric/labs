import { expect } from "@std/expect";
import ts from "typescript";

import type { TransformationDiagnostic } from "../../../src/core/mod.ts";
import { COMMONFABRIC_TYPES } from "../../commonfabric-test-types.ts";
import { transformSource } from "../../utils.ts";
import { collect, parseModule } from "../../transformed-ast.ts";
import { describe, it } from "@commonfabric/test-support/test";

/** Each `onClick` attribute's initializer, keyed by its button's text. */
async function onClickInitializers(
  buttons: string,
): Promise<Record<string, string | undefined>> {
  const diagnostics: TransformationDiagnostic[] = [];
  const output = await transformSource(
    `/// <cts-enable />
import { pattern, UI, Writable } from "commonfabric";
export default pattern<{ count: Writable<number> }>(({ count }) => ({
  [UI]: <div>${buttons}</div>,
}));`,
    { types: COMMONFABRIC_TYPES, pipelineDiagnostics: diagnostics },
  );
  expect(diagnostics).toEqual([]);
  const root = parseModule(output);
  return Object.fromEntries(
    collect(root, ts.isJsxElement).flatMap((element) => {
      const onClick = element.openingElement.attributes.properties.find((
        attribute,
      ) =>
        ts.isJsxAttribute(attribute) && attribute.name.getText(root) ===
          "onClick"
      );
      if (!onClick || !ts.isJsxAttribute(onClick)) return [];
      return [[
        element.children.map((child) => child.getText(root)).join(""),
        onClick.initializer?.getText(root),
      ]];
    }),
  );
}

describe("handler-strategy", () => {
  describe("transformHandlerJsxAttribute()", () => {
    it("rewrites an arrow-function handler and leaves a string or valueless handler attribute as written", async () => {
      const initializers = await onClickInitializers(`
    <button type="button" onClick={() => count.set(1)}>arrow</button>
    <button type="button" onClick="noop">string</button>
    <button type="button" onClick>bare</button>`);

      expect(initializers.arrow).toMatch(/^\{__cfHandler_1\(/);
      expect(initializers.string).toBe(`"noop"`);
      expect(initializers.bare).toBeUndefined();
    });
  });
});
