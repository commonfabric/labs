import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { PatternIndexClient } from "@commonfabric/pattern-index/client";
import { PatternIndexStore } from "@commonfabric/pattern-index/store";
import { gitUncommitted, mine } from "../commands/pattern.ts";
import type { IndexDeps } from "../commands/pattern-index.ts";
import { FakePatternIndex } from "../../pattern-index/test/fake-pattern-index.ts";

const git = async (cwd: string, ...args: string[]) => {
  const { code } = await new Deno.Command("git", {
    args: ["-C", cwd, ...args],
    stdout: "null",
    stderr: "null",
  }).output();
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed`);
};

describe("pattern", () => {
  describe("gitUncommitted()", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await Deno.makeTempDir();
    });

    afterEach(async () => {
      await Deno.remove(dir, { recursive: true });
    });

    it("returns the edited and the untracked paths, and not the committed one", async () => {
      await git(dir, "init", "-q");
      for (const name of ["clean.tsx", "edited.tsx"]) {
        await Deno.writeTextFile(join(dir, name), "export {};\n");
      }
      await git(dir, "add", ".");
      await git(
        dir,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "commit",
        "-qm",
        "x",
      );
      await Deno.writeTextFile(
        join(dir, "edited.tsx"),
        "export const x = 1;\n",
      );
      await Deno.writeTextFile(join(dir, "new.tsx"), "export {};\n");

      expect(
        await gitUncommitted(
          ["clean.tsx", "edited.tsx", "new.tsx"].map((n) => join(dir, n)),
        ),
      ).toEqual([join(dir, "edited.tsx"), join(dir, "new.tsx")]);
    });

    it("returns a gitignored file and a committed symbolic link, which git checkout cannot restore", async () => {
      await git(dir, "init", "-q");
      await Deno.writeTextFile(join(dir, ".gitignore"), "ignored.tsx\n");
      await Deno.writeTextFile(join(dir, "target.tsx"), "export {};\n");
      await Deno.symlink("target.tsx", join(dir, "link.tsx"));
      await git(dir, "add", ".");
      await git(
        dir,
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "commit",
        "-qm",
        "x",
      );
      await Deno.writeTextFile(join(dir, "ignored.tsx"), "export {};\n");

      expect(
        await gitUncommitted(
          ["ignored.tsx", "link.tsx", "target.tsx"].map((n) => join(dir, n)),
        ),
      ).toEqual([join(dir, "ignored.tsx"), join(dir, "link.tsx")]);
    });

    it("returns undefined outside a git working tree", async () => {
      await Deno.writeTextFile(join(dir, "a.tsx"), "export {};\n");

      expect(await gitUncommitted([join(dir, "a.tsx")])).toBeUndefined();
    });
  });

  describe("mine()", () => {
    const BASE = "https://index.test";
    let dir: string;
    let keyPath: string;
    let signer: Identity;
    let index: FakePatternIndex;
    let store: PatternIndexStore;
    let rendered: { value: unknown; json?: boolean }[];
    let deps: IndexDeps;

    beforeEach(async () => {
      dir = await Deno.makeTempDir();
      keyPath = join(dir, "me.key");
      const pkcs8 = await Identity.generatePkcs8();
      await Deno.writeFile(keyPath, pkcs8);
      signer = await Identity.fromPkcs8(pkcs8);
      index = new FakePatternIndex();
      store = new PatternIndexStore(join(dir, "store"));
      rendered = [];
      deps = {
        fetchFn: index.fetchFn,
        store,
        render: (value, options) => {
          rendered.push({ value, json: options?.json });
        },
      };
    });

    afterEach(async () => {
      await Deno.remove(dir, { recursive: true });
    });

    /** Publishes `patternId` as `as`, a member under `handle`. */
    const publishAs = async (
      as: Identity,
      handle: string,
      patternId: string,
    ) => {
      index.admit(as.did(), handle);
      await new PatternIndexClient({
        baseUrl: BASE,
        signer: as,
        fetchFn: index.fetchFn,
      }).publishPattern({
        patternId,
        description: `about ${patternId}`,
        hashtags: [],
        program: { main: "/main.tsx", files: [] },
      });
    };

    it("prints the identity's own patterns, with the entry file each was published from", async () => {
      await publishAs(signer, "p-me", "id-mine");
      await publishAs(await Identity.generate(), "p-other", "id-theirs");
      await store.recordPublished(join(dir, "bins.tsx"), "id-mine");

      await mine({ identity: keyPath, patternIndexUrl: BASE }, deps);

      expect(rendered).toEqual([{
        value: [
          "about id-mine  id-mine",
          `  not shared: run cf pattern share ${
            join(dir, "bins.tsx")
          } to share it on beta, by link`,
        ].join("\n"),
        json: undefined,
      }]);
    });

    it("prints the rows as JSON with --json", async () => {
      await publishAs(signer, "p-me", "id-mine");

      await mine(
        { identity: keyPath, patternIndexUrl: BASE, json: true },
        deps,
      );

      expect(rendered[0].json).toBe(true);
      expect(rendered[0].value).toEqual([
        expect.objectContaining({
          patternId: "id-mine",
          versions: 1,
          listing: "not_requested",
        }),
      ]);
    });

    it("throws what to do for an identity the index does not know, printing nothing", async () => {
      await expect(
        mine({ identity: keyPath, patternIndexUrl: BASE }, deps),
      ).rejects.toThrow("join with your invite link");
      expect(rendered).toEqual([]);
    });
  });
});
