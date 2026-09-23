import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { XSchedulerGraph } from "../src/views/SchedulerGraphView.ts";

const { truncateLabel } = XSchedulerGraph.accessForTestingOnly;

/** A space id long enough that no label holding it fits the default bound. */
const SPACE = "did:key:z6MkabcdefghijkLMNOP";

type LayoutNodes = XSchedulerGraph["accessForTestingOnly"]["layoutNodes"];
type LayoutNode = LayoutNodes extends Map<string, infer N> ? N : never;

/** A laid-out node for `id`, labeled the way the layout labels one. */
function layoutNode(id: string, parentId?: string): LayoutNode {
  return {
    id,
    label: truncateLabel(id),
    fullId: id,
    type: "computation",
    x: 0,
    y: 0,
    width: 140,
    height: 36,
    isDirty: false,
    isPending: false,
    parentId,
  };
}

describe("XSchedulerGraph", () => {
  describe("instance members", () => {
    describe("#renderParentGroups()", () => {
      it("returns a group labeled with the prefix and the entity tail of a parent whose own label holds no path", () => {
        // The parent's own label is `computation:...DDDD`, which holds no `/`
        // and so would be cut from its end. The group's label is cut from the
        // parent's full id.

        const parentId = `computation:${SPACE}/of:fid1:AAAABBBBCCCCDDDD/value`;
        const childId = `sink:${SPACE}/of:fid1:AAAABBBBCCCCDDDD/value`;
        const graph = new XSchedulerGraph();
        graph.accessForTestingOnly.layoutNodes = new Map([
          [parentId, layoutNode(parentId)],
          [childId, layoutNode(childId, parentId)],
        ]);

        const groups = graph.accessForTestingOnly.renderParentGroups();

        expect(groups.length).toBe(1);
        expect(groups[0].values).toContain("computation:...DDDD");
      });
    });
  });

  describe("static members", () => {
    describe("#truncateLabel()", () => {
      // Each expectation is the whole label the method assembles, so a case
      // turns on the assembly itself and not on a fragment surviving it.

      it("returns a label no longer than the default bound unchanged", () => {
        expect(truncateLabel("parentAction")).toBe("parentAction");
        expect(truncateLabel("a".repeat(20))).toBe("a".repeat(20));
      });

      it("returns a label no longer than a given `maxLen` unchanged", () => {
        expect(truncateLabel("abcdefghij", 10)).toBe("abcdefghij");
      });

      describe("given a schemed entity segment", () => {
        it("returns the prefix, the last four characters of the entity, and the path", () => {
          expect(
            truncateLabel(`sink:${SPACE}/of:fid1:AAAABBBBCCCCDDDD/value`),
          ).toBe("sink:...DDDD/value");
        });

        it("returns a `computed:` entity the same way as an `of:` one", () => {
          expect(
            truncateLabel(
              `action:${SPACE}/computed:fid1:EEEEFFFFGGGGHHHH/count`,
            ),
          ).toBe("action:...HHHH/count");
        });

        it("keeps the prefix in the case the label wrote it", () => {
          expect(
            truncateLabel(`Sink:${SPACE}/of:fid1:AAAABBBBCCCCDDDD/value`),
          ).toBe("Sink:...DDDD/value");
        });

        it("returns no prefix when the label has none", () => {
          expect(
            truncateLabel(`${SPACE}/of:fid1:AAAABBBBCCCCDDDD/value`),
          ).toBe("...DDDD/value");
        });

        it("returns no path when only empty segments follow the entity", () => {
          expect(
            truncateLabel(`sink:${SPACE}/of:fid1:AAAABBBBCCCCDDDD/`),
          ).toBe("sink:...DDDD");
        });

        it("cuts the path to fit when the assembled label is still too long", () => {
          expect(
            truncateLabel(
              `sink:${SPACE}/of:fid1:AAAABBBBCCCCDDDD/some/deeply/nested/path`,
            ),
          ).toBe("sink:...DDDD/some...");
        });

        it("returns the whole assembled label when it is exactly `maxLen` long", () => {
          expect(
            truncateLabel(`sink:${SPACE}/of:fid1:AAAABBBBCCCCDDDD/value`, 18),
          ).toBe("sink:...DDDD/value");
        });
      });

      describe("given no schemed entity segment", () => {
        it("returns the last four characters of the first segment longer than 20 characters, then the segments after it", () => {
          expect(truncateLabel("space/abcdefghijklmnopqrstuvwx/count")).toBe(
            "...uvwx/count",
          );
        });

        it("returns the last four characters of the first segment when none is longer than 20 characters", () => {
          expect(truncateLabel("space/entity/some/longer/path")).toBe(
            "...pace/entity/so...",
          );
        });

        it("keeps an entity of four characters or fewer whole", () => {
          expect(truncateLabel("ab/cdefghijklmnopqrstu")).toBe(
            "ab/cdefghijklmnop...",
          );
        });
      });

      describe("given a label whose assembled form is longer than `maxLen`", () => {
        // The prefix and the entity tail are never cut, so the path takes the
        // whole cut. `sink:...DDDD` is 12 characters long and `action:...HHHH`
        // is 14. Each `maxLen` below is chosen against those two lengths.

        it("returns the prefix and the entity tail alone when the two are exactly `maxLen` long", () => {
          expect(
            truncateLabel(`sink:${SPACE}/of:fid1:AAAABBBBCCCCDDDD/value`, 12),
          ).toBe("sink:...DDDD");
        });

        it("returns the prefix and the entity tail alone, uncut, when the two are longer than `maxLen`", () => {
          expect(
            truncateLabel(
              `action:${SPACE}/computed:fid1:EEEEFFFFGGGGHHHH/count`,
              12,
            ),
          ).toBe("action:...HHHH");
        });

        it("returns the path cut to the room that the prefix and the entity tail leave", () => {
          expect(
            truncateLabel(`${SPACE}/of:fid1:AAAABBBBCCCCDDDD/value`, 12),
          ).toBe("...DDDD/v...");
          expect(
            truncateLabel(`sink:${SPACE}/of:fid1:AAAABBBBCCCCDDDD/value`, 17),
          ).toBe("sink:...DDDD/v...");
        });

        it("returns `/...` for the path when there is room for nothing more", () => {
          expect(
            truncateLabel(`sink:${SPACE}/of:fid1:AAAABBBBCCCCDDDD/value`, 16),
          ).toBe("sink:...DDDD/...");
        });

        it("returns no path when there is less room than `/...` takes", () => {
          expect(
            truncateLabel(`sink:${SPACE}/of:fid1:AAAABBBBCCCCDDDD/value`, 15),
          ).toBe("sink:...DDDD");
          expect(
            truncateLabel(`sink:${SPACE}/of:fid1:AAAABBBBCCCCDDDD/value`, 13),
          ).toBe("sink:...DDDD");
        });

        it("returns no path at the default bound for a `computation:` label", () => {
          // `computation:...DDDD` is 19 characters long, one short of the
          // default bound.

          expect(
            truncateLabel(
              `computation:${SPACE}/of:fid1:AAAABBBBCCCCDDDD/value`,
            ),
          ).toBe("computation:...DDDD");
        });
      });

      describe("given fewer than two non-empty segments", () => {
        it("cuts the label from the end", () => {
          expect(truncateLabel("aVeryLongActionIdentifierName")).toBe(
            "aVeryLongActionId...",
          );
        });

        it("returns the prefix as part of the cut label", () => {
          expect(truncateLabel("handler:someVeryLongHandlerName")).toBe(
            "handler:someVeryL...",
          );
        });

        it("cuts to a given `maxLen`", () => {
          expect(truncateLabel("abcdefghijk", 10)).toBe("abcdefg...");
        });

        it("cuts a lone segment followed by `/` the same way", () => {
          expect(truncateLabel("abcdefghijklmnopqrstuvwxyz/")).toBe(
            "abcdefghijklmnopq...",
          );
        });
      });
    });
  });
});
