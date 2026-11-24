import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assert } from "@std/assert";
import { join } from "@std/path";

import {
  CONTEXT_FILE,
  createRunSpool,
  deleteSpool,
  type HeldSpool,
  listSpools,
  listStagingSpools,
  LOCK_FILE,
  readSpool,
  SPOOL_STAGING_PREFIX,
  tryAdoptSpool,
} from "./spool.ts";
import {
  FRAGMENT_PREFIX,
  FRAGMENT_SUFFIX,
  FragmentWriter,
} from "./fragment.ts";
import type { RunContext, TestRecord } from "./schema.ts";

const CONTEXT: RunContext = {
  schema: 1,
  line: "context",
  reportId: "01JSPOOLTESTULID00000000",
  repo: "commonfabric/labs",
  commit: "0123456789abcdef0123456789abcdef01234567",
  dirty: true,
  branch: "test-branch",
  env: "local",
  os: "darwin",
  arch: "aarch64",
  denoVersion: "2.9.4",
  startedAt: "2026-08-17T21:04:05.000Z",
};

const RECORD: TestRecord = {
  line: "record",
  test: { k: "unit", s: "bakery", n: "glaze > sets overnight" },
  outcome: "fail",
  durationMs: 41,
};

describe("spool", () => {
  let root: string;
  let held: HeldSpool | undefined;

  beforeEach(async () => {
    root = await Deno.makeTempDir({ prefix: "test-records-spool-" });
    held = undefined;
  });

  afterEach(async () => {
    held?.close();
    await Deno.remove(root, { recursive: true }).catch(() => {});
  });

  describe("createRunSpool()", () => {
    it("creates a locked directory stamped with the context", async () => {
      held = await createRunSpool(root, CONTEXT);
      const stamped = await Deno.readTextFile(join(held.dir, CONTEXT_FILE));
      expect(JSON.parse(stamped.trim()).reportId).toBe(CONTEXT.reportId);
      expect(await tryAdoptSpool(held.dir)).toBeUndefined();
    });

    it("leaves no staging directory behind", async () => {
      held = await createRunSpool(root, CONTEXT);
      expect(await listStagingSpools(root)).toEqual([]);
      expect(await listSpools(root)).toEqual([held.dir]);
    });

    it("throws and cleans its staging directory for an unusable root", async () => {
      const file = join(root, "a-file");
      await Deno.writeTextFile(file, "not a directory");
      await expect(createRunSpool(file, CONTEXT)).rejects.toThrow();
      expect(await listStagingSpools(root)).toEqual([]);
    });

    it("throws and cleans its staging directory when its lock is held", async () => {
      // Another holder of the staging lock file is a run that started under
      // the same report id, which the new run must not take over.

      const staging = join(root, `${SPOOL_STAGING_PREFIX}${CONTEXT.reportId}`);
      await Deno.mkdir(staging);
      const rival = await Deno.open(join(staging, LOCK_FILE), {
        create: true,
        write: true,
      });
      try {
        expect(await rival.tryLock(true)).toBe(true);

        await expect(createRunSpool(root, CONTEXT)).rejects.toThrow(
          "another process holds the lock",
        );
        expect(await listStagingSpools(root)).toEqual([]);
        expect(await listSpools(root)).toEqual([]);
      } finally {
        rival.close();
      }
    });
  });

  describe("tryAdoptSpool()", () => {
    it("returns undefined while the owner holds the lock", async () => {
      held = await createRunSpool(root, CONTEXT);
      expect(await tryAdoptSpool(held.dir)).toBeUndefined();
    });

    it("returns undefined for a directory that does not exist", async () => {
      expect(await tryAdoptSpool(join(root, "absent"))).toBeUndefined();
    });

    it("returns the spool once the owner released it", async () => {
      held = await createRunSpool(root, CONTEXT);
      const dir = held.dir;
      held.close();
      held = undefined;
      const adopted = await tryAdoptSpool(dir);
      assert(adopted);
      adopted.close();
    });

    it("returns a spool whose second close does nothing", async () => {
      held = await createRunSpool(root, CONTEXT);
      const dir = held.dir;
      held.close();
      held.close();
      held = undefined;

      const adopted = await tryAdoptSpool(dir);
      assert(adopted);
      adopted.close();
      adopted.close();
      held = await tryAdoptSpool(dir);
      expect(held?.dir).toBe(dir);
    });

    it("keeps a second adopter out while the first holds it", async () => {
      held = await createRunSpool(root, CONTEXT);
      const dir = held.dir;
      held.close();
      held = await tryAdoptSpool(dir);
      assert(held);
      expect(await tryAdoptSpool(dir)).toBeUndefined();
    });
  });

  describe("listSpools()", () => {
    it("returns spool directories sorted by name", async () => {
      const first = await createRunSpool(root, {
        ...CONTEXT,
        reportId: "01AAA0000000000000000000",
      });
      first.close();
      const second = await createRunSpool(root, {
        ...CONTEXT,
        reportId: "01BBB0000000000000000000",
      });
      second.close();
      const spools = await listSpools(root);
      expect(spools).toEqual([
        join(root, "run-01AAA0000000000000000000"),
        join(root, "run-01BBB0000000000000000000"),
      ]);
    });

    it("returns an empty list for a missing root", async () => {
      expect(await listSpools(join(root, "absent"))).toEqual([]);
    });
  });

  describe("listStagingSpools()", () => {
    it("returns abandoned staging directories and no finished spools", async () => {
      held = await createRunSpool(root, CONTEXT);
      const abandoned = join(
        root,
        `${SPOOL_STAGING_PREFIX}01DEADOWNER0000000000000`,
      );
      await Deno.mkdir(abandoned);
      expect(await listStagingSpools(root)).toEqual([abandoned]);
      expect(await listSpools(root)).toEqual([held.dir]);
    });
  });

  describe("readSpool()", () => {
    it("returns the stamped context and every complete record line", async () => {
      held = await createRunSpool(root, CONTEXT);
      const writer = FragmentWriter.open(held.dir);
      assert(writer);
      writer.append(RECORD);
      writer.append({ ...RECORD, outcome: "pass" });
      writer.close();
      const contents = await readSpool(held.dir);
      expect(contents.context).toEqual(CONTEXT);
      expect(contents.records.length).toBe(2);
      expect(contents.warnings).toEqual([]);
    });

    it("drops a torn final line with a warning", async () => {
      held = await createRunSpool(root, CONTEXT);
      const writer = FragmentWriter.open(held.dir);
      assert(writer);
      writer.append(RECORD);
      writer.close();
      await Deno.writeTextFile(
        writer.path,
        '{"line":"record","test":{"k":"unit","s":"bakery","n":"torn"},"ou',
        { append: true },
      );
      const contents = await readSpool(held.dir);
      expect(contents.records).toEqual([RECORD]);
      expect(contents.warnings.length).toBe(1);
      expect(contents.warnings[0]).toContain("torn");
    });

    it("drops an unparsable line with a warning and keeps the rest", async () => {
      held = await createRunSpool(root, CONTEXT);
      const writer = FragmentWriter.open(held.dir);
      assert(writer);
      writer.append(RECORD);
      writer.close();
      await Deno.writeTextFile(writer.path, "not json\n", { append: true });
      const contents = await readSpool(held.dir);
      expect(contents.records).toEqual([RECORD]);
      expect(contents.warnings.length).toBe(1);
    });

    it("skips a blank line without a warning", async () => {
      held = await createRunSpool(root, CONTEXT);
      const writer = FragmentWriter.open(held.dir);
      assert(writer);
      writer.append(RECORD);
      writer.close();
      await Deno.writeTextFile(writer.path, "\n", { append: true });

      const contents = await readSpool(held.dir);

      expect(contents.records).toEqual([RECORD]);
      expect(contents.warnings).toEqual([]);
    });

    it("warns about a fragment it cannot read and keeps the others", async () => {
      held = await createRunSpool(root, CONTEXT);
      const writer = FragmentWriter.open(held.dir);
      assert(writer);
      writer.append(RECORD);
      writer.close();
      const unreadable = `${FRAGMENT_PREFIX}unreadable${FRAGMENT_SUFFIX}`;
      await Deno.writeTextFile(
        join(held.dir, unreadable),
        `${JSON.stringify(RECORD)}\n`,
        { mode: 0o000 },
      );

      const contents = await readSpool(held.dir);

      expect(contents.records).toEqual([RECORD]);
      expect(contents.warnings.length).toBe(1);
      expect(contents.warnings[0]).toContain(
        `unreadable fragment ${unreadable}`,
      );
    });

    it("returns an undefined context for a spool with none", async () => {
      const dir = join(root, "run-01NOCONTEXT0000000000000");
      await Deno.mkdir(dir);
      const contents = await readSpool(dir);
      expect(contents.context).toBeUndefined();
      expect(contents.records).toEqual([]);
    });

    it("warns about a context that does not parse", async () => {
      const dir = join(root, "run-01BADCONTEXT000000000000");
      await Deno.mkdir(dir);
      await Deno.writeTextFile(join(dir, CONTEXT_FILE), "not json\n");
      const contents = await readSpool(dir);
      expect(contents.context).toBeUndefined();
      expect(contents.warnings[0]).toContain("unreadable context");
    });

    it("returns nothing for a spool directory that vanished", async () => {
      const contents = await readSpool(join(root, "run-GONE"));
      expect(contents.context).toBeUndefined();
      expect(contents.records).toEqual([]);
    });
  });

  describe("deleteSpool()", () => {
    it("removes the directory and its fragments", async () => {
      held = await createRunSpool(root, CONTEXT);
      const writer = FragmentWriter.open(held.dir);
      assert(writer);
      writer.append(RECORD);
      writer.close();
      const dir = held.dir;
      held.close();
      held = undefined;
      await deleteSpool(dir);
      expect(await listSpools(root)).toEqual([]);
    });
  });
});
