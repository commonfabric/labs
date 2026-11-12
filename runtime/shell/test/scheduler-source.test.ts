import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { PatternSourceInfo } from "@commonfabric/runtime-client";

import {
  buildLineAnnotations,
  heatColor,
  parseActionLocation,
  sourcePosition,
  type SourceViewNode,
} from "../src/lib/scheduler-source.ts";

/** A node of `type` with the given statistics, in pattern `patternIdentity`. */
function node(
  id: string,
  type: string,
  stats?: { totalTime: number; runCount: number },
  patternIdentity?: string,
): SourceViewNode {
  return { id, type, label: id, stats, patternIdentity };
}

/** A map of nodes keyed by their IDs. */
function nodeMap(...nodes: SourceViewNode[]): Map<string, SourceViewNode> {
  return new Map(nodes.map((n) => [n.id, n]));
}

/** A pattern whose files are named `names`, each with empty contents. */
function pattern(identity: string, ...names: string[]): PatternSourceInfo {
  return { identity, files: names.map((name) => ({ name, contents: "" })) };
}

describe("scheduler-source", () => {
  describe("parseActionLocation()", () => {
    it("returns the file, line and column after an `action:` hash prefix", () => {
      expect(parseActionLocation("action:abc123/api/patterns/main.tsx:42:15"))
        .toEqual({ file: "/api/patterns/main.tsx", line: 42, col: 15 });
    });

    it("returns the location without a trailing `[via ...]`", () => {
      expect(parseActionLocation("/main.tsx:7:3 [via lift]")).toEqual({
        file: "/main.tsx",
        line: 7,
        col: 3,
      });
    });

    it("returns `null` for an ID that ends in no line and column", () => {
      expect(parseActionLocation("action:abc123/main.tsx")).toBeNull();
      expect(parseActionLocation("/main.tsx:7")).toBeNull();
    });
  });

  describe("buildLineAnnotations()", () => {
    it("returns the nodes grouped by file and line, ordered by column, with their statistics summed", () => {
      const annotations = buildLineAnnotations(
        nodeMap(
          node("/main.tsx:3:20", "computation", {
            totalTime: 4,
            runCount: 1,
          }),
          node("/main.tsx:3:5", "effect", { totalTime: 2, runCount: 3 }),
          node("/main.tsx:9:1", "effect"),
          node("/other.tsx:3:1", "effect", { totalTime: 1, runCount: 1 }),
        ),
        new Map(),
        undefined,
      );

      expect([...annotations.keys()]).toEqual(["/main.tsx", "/other.tsx"]);
      const line3 = annotations.get("/main.tsx")!.get(3)!;
      expect(line3.entries.map((e) => e.nodeId)).toEqual([
        "/main.tsx:3:5",
        "/main.tsx:3:20",
      ]);
      expect(line3.types).toEqual(new Set(["effect", "computation"]));
      expect(line3.totalTime).toBe(6);
      expect(line3.runCount).toBe(4);
      expect(annotations.get("/main.tsx")!.get(9)!.totalTime).toBe(0);
      expect(annotations.get("/main.tsx")!.has(4)).toBe(false);
    });

    it("returns the deltas against each node's baseline, or against zero where it has none", () => {
      const annotations = buildLineAnnotations(
        nodeMap(
          node("/main.tsx:1:1", "effect", { totalTime: 10, runCount: 5 }),
          node("/main.tsx:1:9", "effect", { totalTime: 3, runCount: 2 }),
        ),
        new Map([["/main.tsx:1:1", { totalTime: 4, runCount: 3 }]]),
        undefined,
      );

      const line = annotations.get("/main.tsx")!.get(1)!;
      expect(line.entries.map((e) => [e.deltaTime, e.deltaRuns])).toEqual([
        [6, 2],
        [3, 2],
      ]);
      expect(line.deltaTime).toBe(9);
      expect(line.deltaRuns).toBe(4);
    });

    it("returns no entry for a node whose ID names no source location", () => {
      const annotations = buildLineAnnotations(
        nodeMap(node("action:abc123", "effect")),
        new Map(),
        undefined,
      );

      expect(annotations.size).toBe(0);
    });

    it("returns the nodes of the given pattern and of no pattern, and none of another pattern", () => {
      const annotations = buildLineAnnotations(
        nodeMap(
          node("/main.tsx:1:1", "effect", undefined, "pattern-a"),
          node("/main.tsx:2:1", "effect", undefined, "pattern-b"),
          node("/main.tsx:3:1", "effect"),
        ),
        new Map(),
        "pattern-a",
      );

      expect([...annotations.get("/main.tsx")!.keys()]).toEqual([1, 3]);
    });

    it("returns the nodes of every pattern when given no pattern", () => {
      const annotations = buildLineAnnotations(
        nodeMap(
          node("/main.tsx:1:1", "effect", undefined, "pattern-a"),
          node("/main.tsx:2:1", "effect", undefined, "pattern-b"),
        ),
        new Map(),
        undefined,
      );

      expect([...annotations.get("/main.tsx")!.keys()]).toEqual([1, 2]);
    });
  });

  describe("heatColor()", () => {
    it("returns `transparent` when the hottest line took no time", () => {
      expect(heatColor(0, 0, new Set(["effect"]))).toBe("transparent");
    });

    it("returns blue for effects, more opaque for the hottest line than for a cooler one", () => {
      const effects = new Set(["effect"]);

      expect(heatColor(100, 100, effects)).toBe("rgba(59, 130, 246, 0.43)");
      expect(heatColor(25, 100, effects)).toBe("rgba(59, 130, 246, 0.255)");
    });

    it("returns violet for computations alone", () => {
      expect(heatColor(100, 100, new Set(["computation"]))).toBe(
        "rgba(167, 139, 250, 0.43)",
      );
    });

    it("returns a blend for a line with both effects and computations", () => {
      expect(heatColor(100, 100, new Set(["effect", "computation"]))).toBe(
        "rgba(99, 140, 255, 0.43)",
      );
    });
  });

  describe("sourcePosition()", () => {
    const sources = [
      pattern("pattern-a", "/main.tsx"),
      pattern("pattern-b", "/main.tsx", "/util.ts"),
    ];

    it("returns the node's pattern, the file the location names, and the line", () => {
      const id = "/util.ts:12:3";

      expect(
        sourcePosition(
          id,
          node(id, "effect", undefined, "pattern-b"),
          sources,
          0,
          0,
        ),
      ).toEqual({ patternIdx: 1, fileIdx: 1, line: 12 });
    });

    it("returns the current pattern for a node of no pattern or of an unknown one", () => {
      const id = "/main.tsx:4:1";

      expect(sourcePosition(id, node(id, "effect"), sources, 1, 1)).toEqual({
        patternIdx: 1,
        fileIdx: 0,
        line: 4,
      });
      expect(
        sourcePosition(
          id,
          node(id, "effect", undefined, "unknown"),
          sources,
          1,
          1,
        ),
      ).toEqual({ patternIdx: 1, fileIdx: 0, line: 4 });
      expect(sourcePosition(id, undefined, sources, 1, 1)).toEqual({
        patternIdx: 1,
        fileIdx: 0,
        line: 4,
      });
    });

    it("returns the current file where the pattern holds no file the location names", () => {
      const id = "/missing.tsx:4:1";

      expect(sourcePosition(id, undefined, sources, 1, 1)).toEqual({
        patternIdx: 1,
        fileIdx: 1,
        line: 4,
      });
      expect(sourcePosition(id, undefined, sources, 5, 1)).toEqual({
        patternIdx: 5,
        fileIdx: 1,
        line: 4,
      });
    });

    it("returns `null` for an ID that names no source location", () => {
      expect(sourcePosition("action:abc123", undefined, sources, 0, 0))
        .toBeNull();
    });
  });
});
