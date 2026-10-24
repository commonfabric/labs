import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { isDeepFrozen } from "@commonfabric/data-model";

import { patternLiteralForTestingOnly } from "@commonfabric/runner/for-testing-only";
import type { Pattern } from "../src/builder/types.ts";

describe("for-testing-only", () => {
  describe("patternLiteralForTestingOnly()", () => {
    /**
     * A pattern literal whose manifest and `$alias` bindings each hold their
     * own object cause, as a literal written out by hand does.
     */
    const literal = (): Pattern => ({
      argumentSchema: {},
      resultSchema: {},
      derivedInternalCells: [{ partialCause: { stream: "increment" } }],
      result: {
        increment: {
          $alias: { partialCause: { stream: "increment" }, path: [] },
        },
      },
      nodes: [
        {
          module: { type: "passthrough" },
          inputs: {
            value: { $alias: { partialCause: ["inner", 1], path: [] } },
          },
          outputs: { $alias: { partialCause: { $generated: 0 }, path: [] } },
        },
      ],
    });

    /** Every partial cause `pattern` holds, in a fixed order. */
    const causesOf = (pattern: Pattern): unknown[] => {
      const node = pattern.nodes[0] as any;
      return [
        pattern.derivedInternalCells![0].partialCause,
        (pattern.result as any).increment.$alias.partialCause,
        node.inputs.value.$alias.partialCause,
        node.outputs.$alias.partialCause,
      ];
    };

    it("returns the pattern it is given", () => {
      const pattern = literal();

      expect(patternLiteralForTestingOnly(pattern)).toBe(pattern);
    });

    it("deep-freezes the partial causes of the manifest and of every `$alias` binding", () => {
      const pattern = literal();
      expect(causesOf(pattern).map(isDeepFrozen)).toEqual([
        false,
        false,
        false,
        false,
      ]);

      patternLiteralForTestingOnly(pattern);

      expect(causesOf(pattern).map(isDeepFrozen)).toEqual([
        true,
        true,
        true,
        true,
      ]);
    });

    it("deep-freezes the partial cause of an `$alias` binding inside a record with a string `type`", () => {
      // A record holding a string `type`, an inline schema or an author's own
      // data, is no module, and the walk descends it like any other record.

      const pattern = literal();
      const node = pattern.nodes[0] as any;
      node.inputs.typed = {
        type: "vote",
        count: { $alias: { partialCause: { $generated: 1 }, path: [] } },
      };

      patternLiteralForTestingOnly(pattern);

      expect(isDeepFrozen(node.inputs.typed.count.$alias.partialCause)).toBe(
        true,
      );
    });

    it("leaves the rest of the literal unfrozen", () => {
      const pattern = patternLiteralForTestingOnly(literal());
      const node = pattern.nodes[0] as any;

      expect(Object.isFrozen(pattern)).toBe(false);
      expect(Object.isFrozen(pattern.nodes)).toBe(false);
      expect(Object.isFrozen(node.module)).toBe(false);
      expect(Object.isFrozen(node.inputs.value)).toBe(false);
      expect(Object.isFrozen(node.inputs.value.$alias)).toBe(false);
    });
  });
});
