import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { type GitFileSystem, realGit } from "../lib/view/commitmsg.ts";
import { exists } from "./utils.ts";
import {
  git,
  initRepository,
  revParse,
  withGitShim,
} from "./view-commitmsg-test-helpers.ts";

/** A filesystem that refuses the operations `refuse` selects, recording the
 * paths it refused, and performs the rest. */
function refusingFileSystem(
  refuse: (operation: "remove" | "rename", path: string) => boolean,
): { fileSystem: GitFileSystem; refused: string[] } {
  const refused: string[] = [];
  return {
    refused,
    fileSystem: {
      removeSync(path, options) {
        if (refuse("remove", path)) {
          refused.push(path);
          throw new Error(`refused to remove ${path}`);
        }
        Deno.removeSync(path, options);
      },
      renameSync(oldPath, newPath) {
        if (refuse("rename", oldPath)) {
          refused.push(oldPath);
          throw new Error(`refused to rename ${oldPath}`);
        }
        Deno.renameSync(oldPath, newPath);
      },
    },
  };
}

describe("view-commitmsg-real-git", () => {
  let root = "";

  beforeEach(async () => {
    root = await Deno.makeTempDir();
  });

  afterEach(async () => {
    await Deno.remove(root, { recursive: true });
  });

  describe("realGit() queries", () => {
    it("returns the canonical repository root, or null outside a repository", async () => {
      await initRepository(root);
      await Deno.mkdir(`${root}/sub`);

      expect(realGit(`${root}/sub`).repoRoot!()).toBe(Deno.realPathSync(root));
      const outside = await Deno.makeTempDir();
      try {
        expect(realGit(outside).repoRoot!()).toBeNull();
      } finally {
        await Deno.remove(outside, { recursive: true });
      }
    });

    it({
      name:
        "throws for a path whose lexical form leaves the repository though its target is inside",
      ignore: Deno.build.os === "windows",
      fn: async () => {
        const repository = `${root}/repository`;
        await Deno.mkdir(repository);
        await initRepository(repository);
        await Deno.symlink("repository", `${root}/alias`);
        const runner = realGit(repository);
        const head = runner.headSha()!;
        const escaping = `${repository}/../alias/f.txt`;

        expect(Deno.realPathSync(escaping)).toBe(
          Deno.realPathSync(`${repository}/f.txt`),
        );
        expect(runner.fileAtCommit(head, `${repository}/f.txt`)).toBe(
          "one\ntwo\nthree\n",
        );
        expect(() => runner.fileAtCommit(head, escaping)).toThrow(
          `git amend path is outside the repository: ${escaping}`,
        );
      },
    });
  });

  describe("realGit() commit objects", () => {
    it("amends a commit object that has no message separator, keeping an empty message", async () => {
      await initRepository(root);
      const tree = await revParse(root, "HEAD^{tree}");
      const object = (await git(
        root,
        ["hash-object", "-t", "commit", "-w", "--literally", "--stdin"],
        `tree ${tree}\nauthor A <a@a.test> 1 +0000\ncommitter A <a@a.test> 1 +0000\n`,
      )).trim();
      await git(root, ["update-ref", "HEAD", object]);
      const runner = realGit(root);

      const result = runner.amendCommit(null, new Map(), object);

      expect(result.head).not.toBe(object);
      expect(await revParse(root, "HEAD")).toBe(result.head);
      expect(await revParse(root, "HEAD^{tree}")).toBe(tree);
      expect(await git(root, ["log", "-1", "--format=%B"])).toBe("\n");
      expect(
        (await git(root, ["cat-file", "commit", "HEAD"])).endsWith("\n\n"),
      ).toBe(true);
    });
  });

  describe("realGit() cleanup failures", () => {
    // What each case's filesystem refused to remove or rename, some of it
    // temporary directories outside `root`.
    let refusals: string[][];

    /** Like `refusingFileSystem()`, recording what it refuses for cleanup. */
    const refusing = (refuse: Parameters<typeof refusingFileSystem>[0]) => {
      const result = refusingFileSystem(refuse);
      refusals.push(result.refused);
      return result;
    };

    beforeEach(() => {
      refusals = [];
    });

    afterEach(async () => {
      for (const path of refusals.flat()) {
        await Deno.remove(path, { recursive: true }).catch((error) => {
          if (!(error instanceof Deno.errors.NotFound)) throw error;
        });
      }
    });

    it("returns the merged text when the merge's temporary directory cannot be removed", async () => {
      await initRepository(root);
      const { fileSystem, refused } = refusing((_operation, path) =>
        path.includes("cf-view-merge-")
      );

      const merged = realGit(root, fileSystem).applyFileChanges(
        "zero\none\ntwo\nthree\n",
        "one\ntwo\nthree\n",
        "one\ntwo\nthree\nfour\n",
        `${root}/f.txt`,
      );

      expect(merged).toBe("zero\none\ntwo\nthree\nfour\n");
      expect(refused).toHaveLength(1);
      expect(await exists(refused[0])).toBe(true);
    });

    it("leaves the temporary index and directory behind but still amends", async () => {
      await initRepository(root);
      const head = await revParse(root, "HEAD");
      const { fileSystem, refused } = refusing((operation, path) =>
        operation === "remove" &&
        (path.includes("cf-view-index-") || path.includes("cf-view-amend-"))
      );

      const result = realGit(root, fileSystem).amendCommit(
        "amended",
        new Map([[`${root}/f.txt`, "one\nTWO\nthree\n"]]),
        head,
      );

      expect(result.status).toBe("Amended the commit");
      expect(await git(root, ["show", "HEAD:f.txt"])).toBe("one\nTWO\nthree\n");
      expect(refused).toHaveLength(2);
      for (const path of refused) {
        expect(await exists(path)).toBe(true);
      }
    });

    it("moves aside reference locks it cannot remove and reports them", async () => {
      await initRepository(root);
      const head = await revParse(root, "HEAD");
      const { fileSystem, refused } = refusing((operation, path) =>
        operation === "remove" && path.endsWith(".lock")
      );

      const result = realGit(root, fileSystem).amendCommit(
        "amended",
        new Map(),
        head,
      );

      expect(result.status).toMatch(
        /^Amended the commit; could not release Git reference locks: .*refused to remove .*HEAD\.lock; moved the lock to .*\.cf-view-lock-/,
      );
      expect(refused.map((path) => path.slice(path.lastIndexOf("/") + 1)))
        .toEqual(["main.lock", "HEAD.lock"]);
      for (const lock of refused) {
        expect(await exists(lock)).toBe(false);
        const moved = [
          ...Deno.readDirSync(lock.slice(0, lock.lastIndexOf("/"))),
        ]
          .filter((entry) => entry.name.startsWith(".cf-view-lock-"));
        expect(moved).toHaveLength(1);
      }
      expect(await revParse(root, "HEAD")).toBe(result.head);
      expect(await git(root, ["log", "-1", "--format=%s"])).toBe("amended\n");
    });

    it("reports reference locks it can neither remove nor move", async () => {
      await initRepository(root);
      const head = await revParse(root, "HEAD");
      const { fileSystem, refused } = refusing((_operation, path) =>
        path.endsWith(".lock") && !path.endsWith("/index.lock")
      );

      const result = realGit(root, fileSystem).amendCommit(
        "amended",
        new Map(),
        head,
      );

      expect(result.status).toMatch(
        /^Amended the commit; could not release Git reference locks: .*refused to remove .*; could not move the lock: Error: refused to rename /,
      );
      expect(refused.length).toBeGreaterThan(0);
      for (const lock of refused) expect(await exists(lock)).toBe(true);
      expect(await revParse(root, "HEAD")).toBe(result.head);
    });

    it("restores HEAD and reports an index lock it cannot remove after a failed index update", async () => {
      await initRepository(root);
      const head = await revParse(root, "HEAD");
      const indexLock = `${Deno.realPathSync(root)}/.git/index.lock`;
      const { fileSystem } = refusing((_operation, path) =>
        path.endsWith("/index.lock")
      );

      expect(() =>
        realGit(root, fileSystem).amendCommit(
          "amended",
          new Map([[`${root}/f.txt`, "one\nTWO\nthree\n"]]),
          head,
        )
      ).toThrow(
        `refused to rename ${indexLock}; rollback failed: Error: refused to remove ${indexLock}`,
      );
      expect(await revParse(root, "HEAD")).toBe(head);
      expect(await exists(indexLock)).toBe(true);
    });

    it({
      name:
        "reports a hook setup failure even when its temporary directory cannot be removed",
      ignore: Deno.build.os === "windows",
      fn: async () => {
        await initRepository(root);
        const head = await revParse(root, "HEAD");
        const { fileSystem, refused } = refusing((_operation, path) =>
          path.includes("cf-view-amend-")
        );

        await withGitShim(
          `if test "$1" = rev-parse && test "$3" = --absolute-git-dir; then
  exit 1
fi`,
          () =>
            expect(() =>
              realGit(root, fileSystem).amendCommit("amended", new Map(), head)
            ).toThrow("Could not prepare Git hooks for the amend"),
        );

        expect(await revParse(root, "HEAD")).toBe(head);
        expect(refused).toHaveLength(1);
        expect(await exists(refused[0])).toBe(true);
      },
    });
  });
});
