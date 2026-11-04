import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assert } from "@std/assert";
import { join } from "@std/path";

import { FragmentWriter, resetFragmentWarningsForTesting } from "./fragment.ts";
import { parseRecordLine, type TestRecord } from "./schema.ts";

const RECORD: TestRecord = {
  line: "record",
  test: { k: "unit", s: "bakery", n: "glaze > thickens when heated" },
  outcome: "pass",
  durationMs: 7,
};

describe("fragment", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await Deno.makeTempDir({ prefix: "test-records-fragment-" });
    resetFragmentWarningsForTesting();
  });

  afterEach(async () => {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  });

  describe("open()", () => {
    it("returns a writer whose appended lines parse back", async () => {
      const writer = FragmentWriter.open(dir);
      assert(writer);
      writer.append(RECORD);
      writer.append({ ...RECORD, outcome: "skip" });
      writer.close();
      const text = await Deno.readTextFile(writer.path);
      const lines = text.trimEnd().split("\n");
      expect(lines.length).toBe(2);
      expect(parseRecordLine(lines[0]!)).toEqual(RECORD);
      expect(parseRecordLine(lines[1]!)?.outcome).toBe("skip");
    });

    it("creates a missing spool directory", async () => {
      const writer = FragmentWriter.open(join(dir, "made", "by", "open"));
      assert(writer);
      writer.append(RECORD);
      writer.close();
      const text = await Deno.readTextFile(writer.path);
      expect(text.trimEnd().split("\n").length).toBe(1);
    });

    it("returns undefined for an uncreatable directory", async () => {
      await Deno.writeTextFile(join(dir, "occupied"), "a file in the way");
      expect(FragmentWriter.open(join(dir, "occupied"))).toBeUndefined();
    });

    it("returns distinct fragment files for two writers", () => {
      const first = FragmentWriter.open(dir);
      const second = FragmentWriter.open(dir);
      assert(first && second);
      expect(first.path).not.toBe(second.path);
      first.close();
      second.close();
    });
  });

  describe("openForRun()", () => {
    it("returns undefined when the records variable is unset", () => {
      expect(FragmentWriter.openForRun(() => undefined)).toBeUndefined();
    });

    it("returns a writer in the directory the variable names", () => {
      const writer = FragmentWriter.openForRun((name) =>
        name === "CF_TEST_RECORDS_DIR" ? dir : undefined
      );
      assert(writer);
      expect(writer.path.startsWith(dir)).toBe(true);
      writer.close();
    });

    it("returns undefined when reading the variable throws", () => {
      const denied = () => {
        throw new Deno.errors.NotCapable("--allow-env");
      };
      expect(FragmentWriter.openForRun(denied)).toBeUndefined();
    });
  });

  describe("append()", () => {
    it("ignores appends after close", async () => {
      const writer = FragmentWriter.open(dir);
      assert(writer);
      writer.append(RECORD);
      writer.close();
      writer.append(RECORD);
      const text = await Deno.readTextFile(writer.path);
      expect(text.trimEnd().split("\n").length).toBe(1);
    });
  });
});
