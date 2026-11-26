import { expect } from "@std/expect";

import type { CapabilityParamSummary } from "../../src/core/mod.ts";
import { narrowEventCapabilities } from "../../src/transformers/contract-capabilities.ts";
import { describe, it } from "@commonfabric/test-support/test";

describe("contract-capabilities", () => {
  describe("narrowEventCapabilities()", () => {
    /** A summary of a body that makes `uses` of the event. */
    const summaryOf = (
      uses: Partial<CapabilityParamSummary>,
    ): CapabilityParamSummary => ({
      name: "event",
      capability: "opaque",
      readPaths: [],
      writePaths: [],
      opaquePaths: [],
      passthrough: false,
      wildcard: false,
      ...uses,
    });
    const cell = (kind: unknown) => ({ type: "number", asCell: [kind] });
    const event = (properties: Record<string, unknown>) => ({
      type: "object",
      properties,
    });

    it("counts an opaque use as a read, and a summary without opaque uses as having none", () => {
      const schema = event({ o: cell("cell"), u: cell("cell") });

      expect(
        narrowEventCapabilities(schema, summaryOf({ opaquePaths: [["o"]] })),
      ).toEqual(event({ o: cell("readonly"), u: cell("opaque") }));
      expect(
        narrowEventCapabilities(schema, summaryOf({ opaquePaths: undefined })),
      ).toEqual(event({ o: cell("opaque"), u: cell("opaque") }));
    });

    it("narrows a definition a recursion reaches through another again once the recursion changes", () => {
      // `Leaf` is narrowed first while `Tree` is assumed unchanged; `Tree`
      // then changes, so `Leaf` is narrowed again against the changed `Tree`.
      // A boolean subschema in the renamed definition is kept as written.

      const narrowed = narrowEventCapabilities(
        {
          $ref: "#/$defs/Tree",
          $defs: {
            Tree: event({
              c: cell("cell"),
              leaf: { $ref: "#/$defs/Leaf" },
              any: true,
            }),
            Leaf: event({ x: cell("cell"), back: { $ref: "#/$defs/Tree" } }),
          },
        },
        summaryOf({}),
      );

      expect(narrowed).toEqual({
        $ref: "#/$defs/Tree",
        $defs: {
          Tree: event({
            c: cell("opaque"),
            leaf: event({ x: cell("opaque"), back: { $ref: "#/$defs/Tree" } }),
            any: true,
          }),
        },
      });
    });
  });
});
