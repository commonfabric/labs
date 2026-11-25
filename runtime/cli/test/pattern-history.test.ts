import { expect } from "@std/expect";
import { join } from "@std/path";
import type {
  PatternIndexLineage,
  PatternIndexProgram,
  PatternIndexVersionSummary,
} from "@commonfabric/pattern-index/client";
import { decodeDataFile } from "@commonfabric/text/data-file";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import {
  entryHistory,
  historyLines,
  type HistoryRow,
  PatternHistoryError,
  type RollbackDeps,
  rollbackEntry,
} from "../lib/pattern-history.ts";
import { entrySlot, type SlotSources } from "../lib/pattern-versions.ts";

const SOURCES: SlotSources = {
  pathKey: () => Promise.resolve(new Uint8Array(32)),
  checkoutOf: () => Promise.resolve(undefined),
};

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
  const indexWith = async (
    slotEntry = entry,
    extra: Record<string, PatternIndexProgram> = {},
  ) => {
    const lineage: PatternIndexLineage = {
      lineageId: "lin-1",
      slot: await entrySlot(slotEntry, SOURCES),
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
      ...extra,
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
      sources: SOURCES,
      readFile: (path) => Deno.readFile(path),
      writeFile: (path, bytes) => Deno.writeFile(path, bytes),
    };
    return { deps, rollbacks };
  };

  describe("entryHistory()", () => {
    it("lists the entry's versions newest first and marks the current one", async () => {
      const { deps } = await indexWith();

      const { rows } = await entryHistory(deps.client, entry, SOURCES);

      expect(rows.map((r) => [r.seq, r.current])).toEqual([[2, true], [
        1,
        false,
      ]]);
      expect(historyLines("count.tsx", rows)[1]).toContain("(current)");
    });

    it("marks each shared version's number and channel, and nothing on one never shared", () => {
      const row: HistoryRow = {
        seq: 2,
        versionId: "ver-2",
        createdAt: "2026-11-16T10:02:00.000Z",
        visibility: "shared",
        share: "exposed",
        current: true,
      };
      const lines = historyLines("count.tsx", [
        { ...row, shared: { number: 3, stable: false } },
        { ...row, seq: 1, current: false, shared: { number: 1, stable: true } },
        {
          ...row,
          seq: 0,
          current: false,
          visibility: "private",
          share: "none",
        },
      ]);

      expect(lines[1]).toContain("shared #3 (beta)");
      expect(lines[2]).toContain("shared #1 (stable)");
      expect(lines[3]).not.toContain("shared #");
    });

    it("throws saying deploys keep versions for an entry with none", async () => {
      const { deps } = await indexWith(join(dir, "other.tsx"));

      await expect(entryHistory(deps.client, entry, SOURCES)).rejects.toThrow(
        PatternHistoryError,
      );
    });
  });

  describe("rollbackEntry()", () => {
    it("writes the current version's files back with force, keeping no new version", async () => {
      const { deps, rollbacks } = await indexWith();
      await Deno.writeTextFile(entry, "export default () => 99;\n");

      const report = await rollbackEntry(entry, "2", { force: true }, deps);

      expect(await Deno.readTextFile(entry)).toBe(V2);
      expect(report.version).toBeUndefined();
      expect(rollbacks).toEqual([]);
    });

    it("refuses, writing nothing, over a file only the restored version has whose contents no version keeps", async () => {
      const helper = join(dir, "helper.ts");
      const { deps, rollbacks } = await indexWith(entry, {
        "ver-1": {
          main: "/count.tsx",
          files: [
            { name: "/count.tsx", contents: V1 },
            { name: "/helper.ts", contents: "export const x = 1;\n" },
          ],
        },
      });
      await Deno.writeTextFile(helper, "export const x = 'mine';\n");

      await expect(rollbackEntry(entry, "1", {}, deps)).rejects.toThrow(
        "edits that no version keeps",
      );
      expect(await Deno.readTextFile(helper)).toBe(
        "export const x = 'mine';\n",
      );
      expect(await Deno.readTextFile(entry)).toBe(V2);
      expect(rollbacks).toEqual([]);
    });

    it("takes an image on disk as the version holding it, and restores its bytes", async () => {
      // A source package holds an image as its `data:` URL, and the file on
      // disk is the image's bytes; the two are one file.

      const glaze = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
      const stored = decodeDataFile(glaze, "/glaze.png");
      const image = join(dir, "glaze.png");
      const { deps } = await indexWith(entry, {
        "ver-1": {
          main: "/count.tsx",
          files: [
            { name: "/count.tsx", contents: V1 },
            { name: "/glaze.png", contents: stored },
          ],
        },
        "ver-2": {
          main: "/count.tsx",
          files: [
            { name: "/count.tsx", contents: V2 },
            { name: "/glaze.png", contents: stored },
          ],
        },
      });
      await Deno.writeFile(image, glaze);

      const report = await rollbackEntry(entry, "1", {}, deps);

      expect(report.written.some((path) => path.endsWith("glaze.png")))
        .toBe(false);
      expect(await Deno.readFile(image)).toEqual(glaze);

      await Deno.remove(image);
      await rollbackEntry(entry, "2", { force: true }, deps);

      expect(await Deno.readFile(image)).toEqual(glaze);
    });

    it("refuses, writing nothing, a version whose image holds no `data:` URL", async () => {
      // The entry file comes first, so a rollback that encoded each file as
      // it wrote it would have written the entry before refusing the image.

      const { deps, rollbacks } = await indexWith(entry, {
        "ver-1": {
          main: "/count.tsx",
          files: [
            { name: "/count.tsx", contents: V1 },
            { name: "/glaze.png", contents: "not a data URL" },
          ],
        },
      });

      await expect(rollbackEntry(entry, "1", { force: true }, deps)).rejects
        .toThrow(
          "This version's /glaze.png cannot be written as a file (Data file " +
            "`/glaze.png` does not hold an `image/png` `data:` URL.); nothing " +
            "was restored.",
        );
      expect(await Deno.readTextFile(entry)).toBe(V2);
      await expect(Deno.stat(join(dir, "glaze.png"))).rejects.toThrow();
      expect(rollbacks).toEqual([]);
    });

    it("refuses a version naming a file outside the pattern's directory, writing nothing", async () => {
      const { deps, rollbacks } = await indexWith(entry, {
        "ver-1": {
          main: "/count.tsx",
          files: [
            { name: "/count.tsx", contents: V1 },
            { name: "/../escaped.txt", contents: "x" },
          ],
        },
      });

      await expect(rollbackEntry(entry, "1", { force: true }, deps)).rejects
        .toThrow("outside the pattern's directory");
      await expect(Deno.stat(join(dir, "..", "escaped.txt"))).rejects.toThrow();
      expect(await Deno.readTextFile(entry)).toBe(V2);
      expect(rollbacks).toEqual([]);
    });

    it("restores over an edited file the restored version leaves alone", async () => {
      const notes = join(dir, "notes.ts");
      const { deps, rollbacks } = await indexWith(entry, {
        "ver-2": {
          main: "/count.tsx",
          files: [
            { name: "/count.tsx", contents: V2 },
            { name: "/notes.ts", contents: "export const n = 2;\n" },
          ],
        },
      });
      await Deno.writeTextFile(notes, "export const n = 'edited';\n");

      await rollbackEntry(entry, "1", {}, deps);

      expect(await Deno.readTextFile(entry)).toBe(V1);
      expect(await Deno.readTextFile(notes)).toBe(
        "export const n = 'edited';\n",
      );
      expect(rollbacks).toHaveLength(1);
    });

    it("refuses, writing nothing, when a file it would write cannot be read", async () => {
      const { deps, rollbacks } = await indexWith();

      await expect(rollbackEntry(entry, "1", {}, {
        ...deps,
        readFile: () => Promise.reject(new Deno.errors.PermissionDenied()),
      })).rejects.toThrow("could not be read");
      expect(await Deno.readTextFile(entry)).toBe(V2);
      expect(rollbacks).toEqual([]);
    });

    it("refuses, writing nothing, a file reached through a symbolic link out of the pattern's directory", async () => {
      const outside = await Deno.makeTempDir();
      try {
        await Deno.symlink(outside, join(dir, "lib"));
        const { deps, rollbacks } = await indexWith(entry, {
          "ver-1": {
            main: "/count.tsx",
            files: [
              { name: "/count.tsx", contents: V1 },
              { name: "/lib/helper.ts", contents: "export const x = 1;\n" },
            ],
          },
        });

        await expect(rollbackEntry(entry, "1", { force: true }, deps)).rejects
          .toThrow("symbolic link");
        await expect(Deno.stat(join(outside, "helper.ts"))).rejects.toThrow();
        expect(await Deno.readTextFile(entry)).toBe(V2);
        expect(rollbacks).toEqual([]);
      } finally {
        await Deno.remove(outside, { recursive: true });
      }
    });

    it("refuses an entry file whose name only ends like the version's entry", async () => {
      const other = join(dir, "account.tsx");
      await Deno.writeTextFile(other, V2);
      const { deps } = await indexWith(other);

      await expect(rollbackEntry(other, "1", {}, {
        ...deps,
        client: {
          ...deps.client,
          getVersion: () =>
            Promise.resolve({
              ...summary(1),
              keywords: [],
              dependencies: [],
              program: {
                main: "count.tsx",
                files: [{ name: "count.tsx", contents: V1 }],
              },
            }),
        },
      })).rejects.toThrow("is not where this version's entry");
    });

    it("leaves the index where it was when writing the files fails", async () => {
      const { deps, rollbacks } = await indexWith();

      await expect(rollbackEntry(entry, "1", {}, {
        ...deps,
        writeFile: () => Promise.reject(new Error("disk full")),
      })).rejects.toThrow("disk full");
      expect(rollbacks).toEqual([]);
    });

    it("restores an earlier version in the index and over the file", async () => {
      const { deps, rollbacks } = await indexWith();

      const report = await rollbackEntry(entry, "v1", {}, deps);

      expect(rollbacks).toEqual([{ lineageId: "lin-1", toVersionId: "ver-1" }]);
      expect(await Deno.readTextFile(entry)).toBe(V1);
      expect(report.restored).toBe(1);
      expect(report.version?.seq).toBe(3);
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

    it("takes a file that is not valid UTF-8 as an edit no version keeps, and writes over it with force", async () => {
      const { deps } = await indexWith();
      const unstorable = new Uint8Array([0xff, 0xfe, 0x00]);
      await Deno.writeFile(entry, unstorable);

      await expect(rollbackEntry(entry, "1", {}, deps)).rejects.toThrow(
        "edits that no version keeps",
      );
      expect(await Deno.readFile(entry)).toEqual(unstorable);

      await rollbackEntry(entry, "1", { force: true }, deps);

      expect(await Deno.readTextFile(entry)).toBe(V1);
    });

    it("refuses to restore the current version over matching files, and a version that does not exist", async () => {
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
