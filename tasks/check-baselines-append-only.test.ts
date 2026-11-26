import { expect } from "@std/expect";
import {
  baselineKeyOf,
  deletedSince,
  main,
  unjustifiedDeletions,
} from "./check-baselines-append-only.ts";
import { type Git, gitIn } from "./repository-files.ts";
import { describe, it } from "@commonfabric/test-support/test";

const BASE = "patterns/baselines";

describe("baselineKeyOf", () => {
  it("recovers the pattern key a baseline belongs to", () => {
    expect(
      baselineKeyOf(`${BASE}/system/home/home.tsx/20260101T000000Z-a.json`),
    )
      .toBe("system/home/home.tsx");
    expect(baselineKeyOf(`${BASE}/top.tsx/20260101T000000Z-a.json`))
      .toBe("top.tsx");
  });

  it("ignores paths that are not baselines", () => {
    expect(baselineKeyOf("patterns/system/home/home.tsx")).toBeUndefined();
    expect(baselineKeyOf(`${BASE}/system/home/home.tsx/README.md`))
      .toBeUndefined();
    expect(baselineKeyOf("tasks/pattern-compat.ts")).toBeUndefined();
  });
});

describe("unjustifiedDeletions", () => {
  it("flags a baseline deleted while its pattern still exists", () => {
    // This is the laundering path the gate's safety argument depends on being
    // impossible: drop the baseline that proves the break, then --update.
    const offenders = unjustifiedDeletions(
      [`${BASE}/system/home/home.tsx/20260101T000000Z-a.json`],
      new Set(),
    );
    expect(offenders.length).toBe(1);
    expect(offenders[0].key).toBe("system/home/home.tsx");
  });

  it("allows baselines to go when the pattern is retired in the same change", () => {
    const offenders = unjustifiedDeletions(
      [
        `${BASE}/system/gone.tsx/20260101T000000Z-a.json`,
        "patterns/system/gone.tsx",
      ],
      new Set(["patterns/system/gone.tsx"]),
    );
    expect(offenders).toEqual([]);
  });

  it("recognizes a retired connector-owned pattern", () => {
    const offenders = unjustifiedDeletions(
      [
        `${BASE}/agent-sessions-debug/main.tsx/20260101T000000Z-a.json`,
      ],
      new Set(["connectors/agents/debug-view/main.tsx"]),
    );
    expect(offenders).toEqual([]);
  });

  it("does not let retiring one pattern justify deleting another's baselines", () => {
    const offenders = unjustifiedDeletions(
      [
        `${BASE}/system/gone.tsx/20260101T000000Z-a.json`,
        `${BASE}/system/home/home.tsx/20260101T000000Z-b.json`,
      ],
      new Set(["patterns/system/gone.tsx"]),
    );
    expect(offenders.length).toBe(1);
    expect(offenders[0].key).toBe("system/home/home.tsx");
  });

  it("ignores unrelated deletions", () => {
    expect(
      unjustifiedDeletions(["docs/README.md", "tasks/old.ts"], new Set()),
    ).toEqual([]);
  });
});

describe("deletedSince", () => {
  it("counts a moved file as deleted or kept as asked, and a removed one as deleted either way", async () => {
    const repo = await Deno.makeTempDir({ prefix: "baselines-moved-" });
    const git = async (...args: string[]) => {
      const { success } = await new Deno.Command("git", {
        args,
        cwd: repo,
        env: {
          GIT_AUTHOR_NAME: "A",
          GIT_AUTHOR_EMAIL: "a@example.com",
          GIT_COMMITTER_NAME: "A",
          GIT_COMMITTER_EMAIL: "a@example.com",
        },
        stdout: "null",
        stderr: "null",
      }).output();
      expect(success).toBe(true);
    };
    try {
      const moved = `${BASE}/system/home/home.tsx/1-a.json`;
      const kept = `${BASE}/system/home/home.tsx/2-b.json`;
      const removed = `${BASE}/system/home/home.tsx/3-c.json`;
      await Deno.mkdir(`${repo}/${BASE}/system/home/home.tsx`, {
        recursive: true,
      });
      await Deno.writeTextFile(`${repo}/${moved}`, '{"contract":1}\n');
      await Deno.writeTextFile(`${repo}/${kept}`, '{"contract":2}\n');
      await Deno.writeTextFile(`${repo}/${removed}`, '{"contract":3}\n');
      await git("init", "-q");
      await git("add", ".");
      await git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "base");
      await git("branch", "base");
      await git("mv", moved, "elsewhere.json");
      await git("rm", "-q", removed);
      await git("-c", "commit.gpgsign=false", "commit", "-q", "-m", "move");
      expect(await deletedSince(gitIn(repo), "base", "deleted")).toEqual([
        moved,
        removed,
      ]);
      expect(await deletedSince(gitIn(repo), "base", "kept")).toEqual([
        removed,
      ]);
    } finally {
      await Deno.remove(repo, { recursive: true });
    }
  });
});

describe("main()", () => {
  /**
   * A git that names `abc123` as the merge base of `base` and `HEAD`, and
   * `deleted` as the files the change since it deletes, a move counting as a
   * deletion only where `--no-renames` asks for one. It has an `upstream/main`
   * only where `upstream` says so.
   */
  const gitDeleting = (
    base: string,
    deleted: { removed: readonly string[]; moved?: readonly string[] },
    upstream = false,
  ): Git =>
  (...args) => {
    const asked = args.join(" ");
    if (asked === `merge-base ${base} HEAD`) return Promise.resolve("abc123\n");
    if (
      asked === "for-each-ref --format=%(refname) refs/remotes/upstream/main"
    ) {
      return Promise.resolve(upstream ? "refs/remotes/upstream/main\n" : "");
    }
    const listed = (paths: readonly string[]) =>
      Promise.resolve(paths.map((path) => `${path}\n`).join(""));
    const filter = "--diff-filter=D --name-only abc123...HEAD";
    if (asked === `diff --no-renames ${filter}`) {
      return listed([...deleted.removed, ...deleted.moved ?? []]);
    }
    if (asked === `diff --find-renames ${filter}`) {
      return listed(deleted.removed);
    }
    return Promise.reject(new Error(`unexpected git ${asked}`));
  };

  it("returns 1 and names each baseline deleted while its pattern stays", async () => {
    const { code, out, err } = await main(
      "main",
      gitDeleting("main", {
        removed: [
          `${BASE}/system/home/home.tsx/20260101T000000Z-a.json`,
          `${BASE}/system/gone.tsx/20260101T000000Z-a.json`,
          "patterns/system/gone.tsx",
        ],
      }),
    );

    expect(code).toBe(1);
    expect(out).toBeUndefined();
    expect(err).toContain(
      "1 pattern baseline(s) deleted without retiring the pattern:\n\n" +
        `  ${BASE}/system/home/home.tsx/20260101T000000Z-a.json\n` +
        "    patterns/system/home/home.tsx still exists.\n",
    );
    expect(err).not.toContain("gone.tsx");
    expect(err).toContain("do not delete the evidence.");
  });

  it("returns 1 for a baseline whose pattern the change moved rather than retired", async () => {
    const { code, err } = await main(
      "main",
      gitDeleting("main", {
        removed: [`${BASE}/system/home/home.tsx/20260101T000000Z-a.json`],
        moved: ["patterns/system/home/home.tsx"],
      }),
    );

    expect(code).toBe(1);
    expect(err).toContain("patterns/system/home/home.tsx still exists.");
  });

  it("returns 0 and says so for a change that deletes baselines only with their pattern", async () => {
    expect(
      await main(
        "main",
        gitDeleting("main", {
          removed: [
            `${BASE}/system/gone.tsx/20260101T000000Z-a.json`,
            "patterns/system/gone.tsx",
          ],
        }),
      ),
    ).toEqual({
      out: "Pattern baselines are append-only against this base.",
      code: 0,
    });
  });

  it("measures from `origin/main` where it is named no base and the checkout has no `upstream/main`", async () => {
    expect(
      await main(
        undefined,
        gitDeleting("refs/remotes/origin/main", { removed: [] }),
      ),
    ).toEqual({
      out: "Pattern baselines are append-only against this base.",
      code: 0,
    });
  });

  it("measures from `upstream/main` where it is named no base and the checkout has one", async () => {
    const { code, err } = await main(
      undefined,
      gitDeleting("refs/remotes/upstream/main", {
        removed: [`${BASE}/system/home/home.tsx/20260101T000000Z-a.json`],
      }, true),
    );

    expect(code).toBe(1);
    expect(err).toContain("patterns/system/home/home.tsx still exists.");
  });

  it("returns 2 and asks for real history where git finds no merge base", async () => {
    const { code, out, err } = await main(
      "nowhere",
      gitDeleting("main", { removed: [] }),
    );

    expect(code).toBe(2);
    expect(out).toBeUndefined();
    expect(err).toBe(
      "Could not resolve a merge base against nowhere. This check needs " +
        "real history — CI must check out with fetch-depth: 0.",
    );
  });
});
