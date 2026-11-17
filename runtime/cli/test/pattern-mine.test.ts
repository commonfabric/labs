import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { PatternIndexListedPattern } from "@commonfabric/pattern-index/client";
import { mineLines, mineRows } from "../lib/pattern-mine.ts";

const row = (
  fields: Partial<PatternIndexListedPattern> & { patternId: string },
): PatternIndexListedPattern => ({
  description: `about ${fields.patternId}`,
  hashtags: [],
  keywords: [],
  createdAt: "2026-11-01T00:00:00.000Z",
  events: {},
  score: 0,
  mine: true,
  ...fields,
});

const noEntry = () => Promise.resolve(undefined);

describe("pattern-mine", () => {
  describe("mineRows()", () => {
    it("returns one row per lineage, for its newest version, counting versions", async () => {
      const rows = await mineRows([
        row({ patternId: "v1", lineageId: "v1", listing: "passed" }),
        row({
          patternId: "v2",
          lineageId: "v1",
          listing: "pending",
          createdAt: "2026-11-02T00:00:00.000Z",
        }),
        row({ patternId: "other", lineageId: "other", listing: "passed" }),
      ], noEntry);

      expect(rows.map((r) => [r.patternId, r.versions])).toEqual([
        ["v2", 2],
        ["other", 1],
      ]);
      expect(rows[0].next).toContain("checking");
    });

    it("returns a held pattern's failed gate findings and the command that republishes its entry file", async () => {
      const [held] = await mineRows([
        row({
          patternId: "h",
          listing: "held",
          gates: {
            privacy: {
              status: "failed",
              attempt: 1,
              findings: [{
                file: "/main.tsx",
                line: 3,
                category: "personal_name",
                why: "a person's name as a field",
              }],
            },
          },
        }),
      ], (id) => Promise.resolve(id === "h" ? "./bins.tsx" : undefined));

      expect(held.findings).toHaveLength(1);
      expect(held.next).toBe(
        "held: fix the findings, then run cf pattern share ./bins.tsx",
      );
      expect(mineLines([held]).join("\n")).toContain(
        "personal_name in /main.tsx:3",
      );
    });

    it("returns the republish command with an entry path a shell would split quoted", async () => {
      const [held] = await mineRows(
        [row({ patternId: "h", listing: "held" })],
        () => Promise.resolve("/work/my patterns/main.tsx"),
      );

      expect(held.next).toBe(
        "held: fix the findings, then run cf pattern share '/work/my patterns/main.tsx'",
      );
    });

    it("returns no findings for a held pattern whose gates passed", async () => {
      const [held] = await mineRows([
        row({
          patternId: "h",
          listing: "held",
          gates: { privacy: { status: "passed", attempt: 1, findings: [] } },
        }),
      ], noEntry);

      expect(held.findings).toBeUndefined();
    });

    it("returns bucket, counts, and what moves an unvetted pattern to Main", async () => {
      const [unvetted] = await mineRows([
        row({
          patternId: "u",
          listing: "passed",
          listed: true,
          bucket: "unvetted",
          aggregates: {
            deployed: { aggregate: "distinct_actors", value: 3 },
          },
        }),
      ], noEntry);

      expect(unvetted.bucket).toBe("unvetted");
      expect(unvetted.counts).toEqual({ deployed: 3 });
      expect(unvetted.next).toContain("/deploy index:u");
    });

    it("says an error waits for an admin re-run", async () => {
      const [failed] = await mineRows(
        [row({ patternId: "e", listing: "error" })],
        noEntry,
      );

      expect(failed.next).toContain("admin re-run");
    });

    it("leaves out rows the index marks as someone else's, or does not mark as the caller's", async () => {
      const { mine: _mine, ...unmarked } = row({ patternId: "y" });
      expect(
        await mineRows(
          [row({ patternId: "x", mine: false }), unmarked],
          noEntry,
        ),
      ).toEqual([]);
    });
  });
});
