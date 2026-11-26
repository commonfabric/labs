import { join, relative } from "@std/path";
import { walk } from "@std/fs";
import { expect } from "@std/expect";
import { refreshRehearsal } from "./refresh-fabrichat-rehearsal.ts";
import type { Git } from "./repository-files.ts";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

const COMMIT = "c".repeat(40);

/** What `git ls-tree` prints for FabriChat's directory at `COMMIT`. */
const LISTING = [
  "patterns/system/fabrichat/README.md",
  "patterns/system/fabrichat/logic.ts",
  "patterns/system/fabrichat/room.test.tsx",
  "patterns/system/fabrichat/room.tsx",
  "patterns/system/fabrichat/schemas/",
  "",
].join("\n");

/** The modules `COMMIT` holds, by repository path. */
const SOURCES: Readonly<Record<string, string>> = {
  "patterns/system/fabrichat/logic.ts": "export const logic = 1;\n",
  "patterns/system/fabrichat/room.tsx": "export const room = 2;\n",
  "patterns/system/loom/participants.tsx": "export const roster = 3;\n",
};

/**
 * A git that knows `refs/remotes/origin/main` and `release` as `COMMIT`, and
 * `upstream/main` too where `upstream` says so, and holds `sources` at it,
 * failing as git does for anything else.
 */
function fakeGit(
  sources: Readonly<Record<string, string>> = SOURCES,
  upstream = false,
): Git {
  return (...args) => {
    const command = args.join(" ");
    const answer = {
      [`for-each-ref --format=%(refname) refs/remotes/upstream/main`]: upstream
        ? "refs/remotes/upstream/main\n"
        : "",
      ...upstream
        ? {
          [`rev-parse --verify refs/remotes/upstream/main^{commit}`]:
            `${COMMIT}\n`,
        }
        : {},
      [`rev-parse --verify refs/remotes/origin/main^{commit}`]: `${COMMIT}\n`,
      [`rev-parse --verify release^{commit}`]: `${COMMIT}\n`,
      [`ls-tree --name-only ${COMMIT} patterns/system/fabrichat/`]: LISTING,
      ...Object.fromEntries(
        Object.entries(sources).map((
          [path, text],
        ) => [`show ${COMMIT}:${path}`, text]),
      ),
    }[command];
    return answer === undefined
      ? Promise.reject(new Error(`\`git ${command}\` failed: unknown`))
      : Promise.resolve(answer);
  };
}

/** Every file below `directory`, by its path there, with its text. */
async function filesIn(directory: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  for await (const entry of walk(directory, { includeDirs: false })) {
    files[relative(directory, entry.path)] = await Deno.readTextFile(
      entry.path,
    );
  }
  return files;
}

describe("refresh-fabrichat-rehearsal", () => {
  let fixtures: string;

  beforeEach(async () => {
    fixtures = join(
      await Deno.makeTempDir({ prefix: "fabrichat-rehearsal-test-" }),
      "fabrichat-update-rehearsal",
    );
  });

  afterEach(async () => {
    await Deno.remove(join(fixtures, ".."), { recursive: true });
  });

  describe("refreshRehearsal()", () => {
    it("writes every non-test FabriChat module and the roster, with the commit they came from", async () => {
      const said = await refreshRehearsal([], { git: fakeGit(), fixtures });
      expect(await filesIn(fixtures)).toEqual({
        "SOURCE.txt": `${COMMIT}\n`,
        "system/fabrichat/logic.ts.txt": "export const logic = 1;\n",
        "system/fabrichat/room.tsx.txt": "export const room = 2;\n",
        "system/loom/participants.tsx.txt": "export const roster = 3;\n",
      });
      expect(said).toBe(
        `Copied 3 modules from refs/remotes/origin/main (${COMMIT}) into ${fixtures}.`,
      );
    });

    it("copies from `upstream/main` where the checkout has one and the command line names nothing", async () => {
      const said = await refreshRehearsal([], {
        git: fakeGit(SOURCES, true),
        fixtures,
      });
      expect(said).toBe(
        `Copied 3 modules from refs/remotes/upstream/main (${COMMIT}) into ${fixtures}.`,
      );
    });

    it("reads the revision the command line names", async () => {
      const said = await refreshRehearsal(["release"], {
        git: fakeGit(),
        fixtures,
      });
      expect(said).toBe(
        `Copied 3 modules from release (${COMMIT}) into ${fixtures}.`,
      );
    });

    it("removes a module of the old copy that the revision no longer has", async () => {
      await Deno.mkdir(join(fixtures, "system/fabrichat"), { recursive: true });
      await Deno.writeTextFile(
        join(fixtures, "system/fabrichat/retired.tsx.txt"),
        "export const retired = 0;\n",
      );
      await refreshRehearsal([], { git: fakeGit(), fixtures });
      expect(Object.keys(await filesIn(fixtures)).sort()).toEqual([
        "SOURCE.txt",
        "system/fabrichat/logic.ts.txt",
        "system/fabrichat/room.tsx.txt",
        "system/loom/participants.tsx.txt",
      ]);
    });

    it("throws and leaves the old copy as it was when the revision lacks a module", async () => {
      await Deno.mkdir(fixtures);
      await Deno.writeTextFile(join(fixtures, "SOURCE.txt"), "old\n");
      const { "patterns/system/loom/participants.tsx": _, ...withoutRoster } =
        SOURCES;
      await expect(
        refreshRehearsal([], { git: fakeGit(withoutRoster), fixtures }),
      ).rejects.toThrow("participants.tsx");
      expect(await filesIn(fixtures)).toEqual({ "SOURCE.txt": "old\n" });
    });

    it("throws and writes nothing for a revision git cannot name", async () => {
      await expect(
        refreshRehearsal(["no-such-revision"], { git: fakeGit(), fixtures }),
      ).rejects.toThrow("no-such-revision");
      await expect(Deno.stat(fixtures)).rejects.toThrow(Deno.errors.NotFound);
    });
  });
});
