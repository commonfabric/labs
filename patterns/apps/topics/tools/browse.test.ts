import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";

import {
  followSaved,
  Keeper,
  loadSaved,
  runQuietly,
  systemPrograms,
} from "./browse.ts";
import type { Saved } from "./browser.ts";

/** What the browser remembers, with `since` as given. */
function state(since: number): Saved {
  return {
    since,
    seen: { "1": 5 },
    drafts: {},
    pending: {},
    dropped: {},
    hideSettled: false,
  };
}

const DAY = 24 * 60 * 60 * 1000;

describe("browse", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await Deno.makeTempDir({ prefix: "topics-tool-browse-" });
  });

  afterEach(async () => {
    await Deno.remove(dir, { recursive: true });
  });

  describe("loadSaved()", () => {
    it("returns a fresh start at the time given when nothing is saved", async () => {
      expect(await loadSaved(join(dir, "none.json"), 7)).toEqual({
        since: 7,
        seen: {},
        drafts: {},
        pending: {},
        dropped: {},
        hideSettled: true,
      });
    });

    it("returns what was saved, drafts, pending writes, and the name writes are signed with included", async () => {
      const saved: Saved = {
        ...state(1),
        drafts: { "comment:1": { fields: ["Hi."], base: "", at: 2 } },
        pending: {
          "topics-1": {
            request: { verb: "mention", topic: "1", other: "2" },
            agentName: "Ian (person)",
            attempts: 1,
            failure: "Lost.",
            at: 3,
          },
        },
        agentName: "Ian (person)",
      };
      const path = join(dir, "saved.json");
      await Deno.writeTextFile(path, JSON.stringify(saved));

      expect(await loadSaved(path, 7)).toEqual(saved);
    });

    it("throws, rather than starting afresh over it, for a file holding something else or no JSON", async () => {
      const other = join(dir, "other.json");
      await Deno.writeTextFile(other, JSON.stringify({ since: "then" }));
      const broken = join(dir, "broken.json");
      await Deno.writeTextFile(broken, "{");

      for (const path of [other, broken]) {
        await expect(loadSaved(path, 7)).rejects.toThrow("move it aside");
      }
    });

    it("returns the file without a pending write it cannot read", async () => {
      const path = join(dir, "strange.json");
      await Deno.writeTextFile(
        path,
        JSON.stringify({
          ...state(1),
          pending: { x: { request: { verb: "delete" }, at: 1 } },
        }),
      );

      expect(await loadSaved(path, 7)).toEqual(state(1));
    });
  });

  describe("followSaved()", () => {
    it("calls back with what another browser saves, until disposed", async () => {
      const path = join(dir, "state", "saved.json");
      const heard = Promise.withResolvers<Saved>();
      {
        using _following = await followSaved(path, (saved) => {
          if (saved.drafts["new"] !== undefined) heard.resolve(saved);
        }, (error) => heard.reject(error));
        const keeper = new Keeper(path, () => 10);
        keeper.save({
          ...state(1),
          drafts: { "new": { fields: ["T", "B"], base: "", at: 3 } },
        });
        await keeper.settled();

        expect((await heard.promise).drafts["new"]?.fields).toEqual([
          "T",
          "B",
        ]);
      }
    });

    it("calls back with what failed once taking in a save fails", async () => {
      const path = join(dir, "state", "saved.json");
      const failed = Promise.withResolvers<unknown>();
      using _following = await followSaved(path, () => {
        throw new Error("Reconciling failed.");
      }, failed.resolve);
      const keeper = new Keeper(path, () => 10);
      keeper.save(state(1));
      await keeper.settled();

      expect(await failed.promise).toEqual(new Error("Reconciling failed."));
    });
  });

  describe("Keeper", () => {
    it("writes the latest state once the write under way finishes, as a whole file only its owner reads", async () => {
      const path = join(dir, "deep", "saved.json");
      const keeper = new Keeper(path, () => 10);
      keeper.save(state(1));
      keeper.save(state(2));
      keeper.save(state(3));
      await keeper.settled();

      expect(JSON.parse(await Deno.readTextFile(path)).since).toBe(1);
      expect((await Deno.stat(path)).mode! & 0o777).toBe(0o600);
      // The lock stays, since taking it away could let a browser waiting on
      // it and one arriving after both hold a lock at once.
      expect(
        [...Deno.readDirSync(join(dir, "deep"))].map((e) => e.name).sort(),
      ).toEqual(["saved.json", "saved.json.lock"]);
    });

    it("merges what another browser saved there, and forgets what was thrown away a month ago", async () => {
      const path = join(dir, "saved.json");
      await Deno.writeTextFile(
        path,
        JSON.stringify({
          ...state(1),
          drafts: { "new": { fields: ["T", "B"], base: "", at: 40 * DAY } },
        }),
      );
      const keeper = new Keeper(path, () => 40 * DAY);
      keeper.save({
        ...state(2),
        dropped: {
          "comment:1": { at: 1, when: 39 * DAY },
          "comment:2": { at: 1, when: 5 * DAY },
        },
      });
      await keeper.settled();
      const kept = JSON.parse(await Deno.readTextFile(path));

      expect(Object.keys(kept.drafts)).toEqual(["new"]);
      expect(kept.dropped).toEqual({ "comment:1": { at: 1, when: 39 * DAY } });
    });

    it("writes what two keepers of one file save at once, losing neither", async () => {
      const path = join(dir, "saved.json");
      const one = new Keeper(path, () => 10);
      const two = new Keeper(path, () => 10);
      one.save({
        ...state(1),
        drafts: { "comment:1": { fields: ["One."], base: "", at: 3 } },
      });
      two.save({
        ...state(1),
        drafts: { "comment:2": { fields: ["Two."], base: "", at: 4 } },
      });
      await Promise.all([one.settled(), two.settled()]);
      const kept = JSON.parse(await Deno.readTextFile(path));

      expect(Object.keys(kept.drafts).sort()).toEqual([
        "comment:1",
        "comment:2",
      ]);
    });

    it("writes back what a newer build saved there, which this one does not read", async () => {
      const path = join(dir, "saved.json");
      const strange = { request: { verb: "delete" }, at: 1 };
      const sketch = { fields: ["T"], base: "", at: 2, canvas: [1, 2] };
      const shaped = { at: "then" };
      await Deno.writeTextFile(
        path,
        JSON.stringify({
          ...state(1),
          drafts: { "sketch:1": { ...sketch, fields: 7 } },
          pending: { x: strange },
          dropped: { y: shaped },
          theme: "dark",
        }),
      );
      const keeper = new Keeper(path, () => 10);
      keeper.save(state(2));
      await keeper.settled();
      const kept = JSON.parse(await Deno.readTextFile(path));

      expect(kept.drafts).toEqual({ "sketch:1": { ...sketch, fields: 7 } });
      expect(kept.pending).toEqual({ x: strange });
      expect(kept.dropped).toEqual({ y: shaped });
      expect(kept.theme).toBe("dark");
    });

    it("leaves out a pending write the file holds that this browser threw away", async () => {
      const path = join(dir, "saved.json");
      const pending = {
        request: { verb: "mention", topic: "1", other: "2" },
        agentName: "Ian (person)",
        attempts: 1,
        at: 4,
      } as const;
      await Deno.writeTextFile(
        path,
        JSON.stringify({ ...state(1), pending: { p: pending } }),
      );
      const keeper = new Keeper(path, () => 10);
      keeper.save({ ...state(1), dropped: { p: { at: 4, when: 9 } } });
      await keeper.settled();

      expect(JSON.parse(await Deno.readTextFile(path)).pending).toEqual({});
    });

    it("keeps a copy of the state as it was when saved", async () => {
      const path = join(dir, "saved.json");
      const keeper = new Keeper(path, () => 10);
      const saved = state(1);
      keeper.save(saved);
      saved.since = 99;
      await keeper.settled();

      expect(JSON.parse(await Deno.readTextFile(path)).since).toBe(1);
    });

    it("tells of a write that fails as it fails, and fails once the writes are settled", async () => {
      await Deno.writeTextFile(join(dir, "file"), "");
      const failures: unknown[] = [];
      const keeper = new Keeper(
        join(dir, "file", "saved.json"),
        () => 10,
        (error) => failures.push(error),
      );
      keeper.save(state(1));

      await expect(keeper.settled()).rejects.toThrow();
      expect(failures.length).toBe(1);
    });
  });

  describe("systemPrograms()", () => {
    it("returns the programs that open a web browser and fill the clipboard on each system", () => {
      expect(systemPrograms("darwin")).toEqual({
        open: ["open"],
        copy: ["pbcopy"],
      });
      expect(systemPrograms("linux")).toEqual({
        open: ["xdg-open"],
        copy: ["xclip", "-selection", "clipboard"],
      });
      expect(systemPrograms("windows").copy).toEqual(["clip"]);
    });
  });

  describe("runQuietly()", () => {
    it("hands a program its input, and throws when it fails or is missing", async () => {
      const out = join(dir, "out.txt");
      await runQuietly(["sh", "-c", 'cat > "$1"', "sh", out], "piped in");

      expect(await Deno.readTextFile(out)).toBe("piped in");
      await expect(runQuietly(["sh", "-c", "exit 3"]))
        .rejects.toThrow("exited with status 3");
      await expect(runQuietly(["/no/such/program"])).rejects.toThrow();
    });
  });
});
