import { expect } from "@std/expect";
import ts from "typescript";

import type { TransformationDiagnostic } from "../../../src/mod.ts";
import { COMMONFABRIC_TYPES } from "../../commonfabric-test-types.ts";
import {
  transformSource,
  validateSource,
  withSourceText,
} from "../../utils.ts";
import { collect, parseModule } from "../../transformed-ast.ts";
import { describe, it } from "@commonfabric/test-support/test";

/** A pattern module that renders `buttons` with `count` in scope. */
function buttonsModule(buttons: string): string {
  return `/// <cts-enable />
import { pattern, UI, Writable } from "commonfabric";
export default pattern<{ count: Writable<number> }>(({ count }) => ({
  [UI]: <div>${buttons}</div>,
}));`;
}

/** Each `onClick` attribute's initializer, keyed by its button's text. */
async function onClickInitializers(
  buttons: string,
): Promise<Record<string, string | undefined>> {
  const diagnostics: TransformationDiagnostic[] = [];
  const output = await transformSource(buttonsModule(buttons), {
    types: COMMONFABRIC_TYPES,
    pipelineDiagnostics: diagnostics,
  });
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

/**
 * The diagnostics transforming `buttons` reports, each with the source text
 * it points at.
 */
async function buttonDiagnostics(
  buttons: string,
): Promise<{ type: string; text: string }[]> {
  const source = buttonsModule(buttons);
  const { diagnostics } = await validateSource(source, {
    types: COMMONFABRIC_TYPES,
  });
  return withSourceText(source, diagnostics).map(({ type, text }) => ({
    type,
    text,
  }));
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

    it("reports a handler parameter after the event, which the runtime never passes", async () => {
      expect(
        await buttonDiagnostics(
          `<button type="button" onClick={(e, s?: { step: number }) => count.set(s?.step ?? 1)}>x</button>`,
        ),
      ).toEqual([
        {
          type: "handler-callback:extra-parameter",
          text: "s?: { step: number }",
        },
      ]);
      expect(
        await buttonDiagnostics(
          `<button type="button" onClick={(e) => count.set(e ? 1 : 0)}>x</button>`,
        ),
      ).toEqual([]);
    });
  });
});
