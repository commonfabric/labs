import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import type {
  PatternIndexLineage,
  PatternIndexProgram,
  PatternIndexVersionSummary,
} from "@commonfabric/pattern-index/client";
import {
  entryHistory,
  historyLines,
  PatternHistoryError,
  type RollbackDeps,
  rollbackEntry,
} from "../lib/pattern-history.ts";
import { entrySlot } from "../lib/pattern-versions.ts";

const V1 = "export default () => 1;\n";
const V2 = "export default () => 2;\n";

const summary = (
  seq: number,
  more: Partial<PatternIndexVersionSummary> = {},
): PatternIndexVersionSummary => ({
  versionId: `ver-${seq}`,
  lineageId: "lin-1",
  seq,
  patternId: `pat-${seq}`,
  createdAt: `2026-11-16T10:0${seq}:00.000Z`,
  description: "Counts",
  hashtags: [],
  origin: "self",
  visibility: "private",
  share: "none",
  head: false,
  ...more,
});

describe("pattern-history", () => {
  let dir: string;
  let entry: string;

  beforeEach(async () => {
    dir = await Deno.makeTempDir();
    entry = join(dir, "count.tsx");
    await Deno.writeTextFile(entry, V2);
  });

  afterEach(async () => {
    await Deno.remove(dir, { recursive: true });
  });

  /**
   * A client holding one lineage for `entry` with versions v1 (source V1)
   * and v2 (source V2, current), recording rollbacks.
   */
  const indexWith = async (slotEntry = entry) => {
    const lineage: PatternIndexLineage = {
      lineageId: "lin-1",
      slot: await entrySlot(slotEntry),
      origin: "self",
      pseudonym: "a-xyz",
      description: "Counts",
      head: summary(2, { head: true }),
      versions: 2,
      sharedVersions: 0,
      tier: 0,
    };
    const programs: Record<string, PatternIndexProgram> = {
      "ver-1": {
        main: "/count.tsx",
        files: [{ name: "/count.tsx", contents: V1 }],
      },
      "ver-2": {
        main: "/count.tsx",
        files: [{ name: "/count.tsx", contents: V2 }],
      },
    };
    const rollbacks: unknown[] = [];
    const client: RollbackDeps["client"] = {
      listLineages: () => Promise.resolve({ lineages: [lineage] }),
      listVersions: () =>
        Promise.resolve({
          lineageId: "lin-1",
          versions: [summary(2, { head: true }), summary(1)],
        }),
      getVersion: ({ versionId }) =>
        Promise.resolve({
          ...summary(Number(versionId.slice(4))),
          keywords: [],
          dependencies: [],
          program: programs[versionId],
        }),
      rollback: (request) => {
        rollbacks.push(request);
        return Promise.resolve({ patternId: "pat-1", created: true, seq: 3 });
      },
    };
    const deps: RollbackDeps = {
      client,
      readTextFile: (path) => Deno.readTextFile(path),
      writeTextFile: (path, contents) => Deno.writeTextFile(path, contents),
    };
    return { deps, rollbacks };
  };

  describe("entryHistory()", () => {
    it("lists the entry's versions newest first and marks the current one", async () => {
      const { deps } = await indexWith();

      const { rows } = await entryHistory(deps.client, entry);

      expect(rows.map((r) => [r.seq, r.current])).toEqual([[2, true], [
        1,
        false,
      ]]);
      expect(historyLines("count.tsx", rows)[1]).toContain("(current)");
    });

    it("throws saying deploys keep versions for an entry with none", async () => {
      const { deps } = await indexWith(join(dir, "other.tsx"));

      await expect(entryHistory(deps.client, entry)).rejects.toThrow(
        PatternHistoryError,
      );
    });
  });

  describe("rollbackEntry()", () => {
    it("restores an earlier version in the index and over the file", async () => {
      const { deps, rollbacks } = await indexWith();

      const report = await rollbackEntry(entry, "v1", {}, deps);

      expect(rollbacks).toEqual([{ lineageId: "lin-1", toVersionId: "ver-1" }]);
      expect(await Deno.readTextFile(entry)).toBe(V1);
      expect(report.restored).toBe(1);
      expect(report.version.seq).toBe(3);
    });

    it("refuses, writing nothing anywhere, over edits no version keeps", async () => {
      const { deps, rollbacks } = await indexWith();
      await Deno.writeTextFile(entry, "export default () => 99;\n");

      await expect(rollbackEntry(entry, "1", {}, deps)).rejects.toThrow(
        "edits that no version keeps",
      );
      expect(rollbacks).toEqual([]);
      expect(await Deno.readTextFile(entry)).toBe(
        "export default () => 99;\n",
      );
    });

    it("writes over edits no version keeps with force", async () => {
      const { deps } = await indexWith();
      await Deno.writeTextFile(entry, "export default () => 99;\n");

      await rollbackEntry(entry, "1", { force: true }, deps);

      expect(await Deno.readTextFile(entry)).toBe(V1);
    });

    it("refuses to restore the current version, and a version that does not exist", async () => {
      const { deps, rollbacks } = await indexWith();

      await expect(rollbackEntry(entry, "2", {}, deps)).rejects.toThrow(
        "already the current version",
      );
      await expect(rollbackEntry(entry, "7", {}, deps)).rejects.toThrow(
        "There is no version 7",
      );
      expect(rollbacks).toEqual([]);
    });
  });
});
