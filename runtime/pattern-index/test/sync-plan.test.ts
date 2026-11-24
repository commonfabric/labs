import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, fromFileUrl, join } from "@std/path";
import type { RepoSyncPlan } from "../src/repo-sync.ts";

const root = fromFileUrl(new URL("../../../", import.meta.url));
const entry = fromFileUrl(new URL("../sync-plan.ts", import.meta.url));
const decoder = new TextDecoder();

const FILES: Record<string, string> = {
  "patterns/counter/main.tsx": `/**
 * Counts clicks.
 *
 * @hashtags #Demo
 */
import { pattern } from "commonfabric";
import { start } from "./start.ts";

export default pattern<{ value: number }>(({ value }) => ({
  value,
  start,
}));
`,
  "patterns/counter/start.ts": `export const start = 0;\n`,
  "patterns/quiet/main.tsx": `import { pattern } from "commonfabric";

export default pattern<{ value: number }>(({ value }) => ({ value }));
`,
  "patterns/broken/main.tsx": `/** Never compiles. */
import { pattern } from "commonfabric";
import { missing } from "./missing.ts";

export default pattern<{ value: number }>(() => ({ missing }));
`,
  "patterns/dev/scratch.tsx": `/** Excluded. */
export default 1;
`,
};

/** Runs `git` in `cwd`, failing the test when it fails. */
const git = async (cwd: string, ...args: string[]) => {
  const { code, stderr } = await new Deno.Command("git", {
    cwd,
    args,
    stdout: "null",
    stderr: "piped",
  }).output();
  if (code !== 0) throw new Error(decoder.decode(stderr));
};

describe("sync-plan", () => {
  let repo: string;

  /** Runs the plan step with the grants the action gives it. */
  const runPlan = async (args: readonly string[]) => {
    const output = await new Deno.Command(Deno.execPath(), {
      cwd: repo,
      args: [
        "run",
        "--no-lock",
        "--config",
        `${root}/deno.jsonc`,
        "--allow-read",
        "--allow-write",
        "--allow-env",
        "--allow-net",
        "--allow-ffi",
        "--allow-run=git",
        entry,
        ...args,
      ],
      stdout: "piped",
      stderr: "piped",
    }).output();
    return {
      code: output.code,
      stdout: decoder.decode(output.stdout),
      stderr: decoder.decode(output.stderr),
    };
  };

  beforeAll(async () => {
    repo = await Deno.makeTempDir({ prefix: "pattern-index-sync-plan-" });
    for (const [path, contents] of Object.entries(FILES)) {
      await Deno.mkdir(dirname(join(repo, path)), { recursive: true });
      await Deno.writeTextFile(join(repo, path), contents);
    }
    await git(repo, "init", "--quiet");
    await git(repo, "add", ".");
  });

  afterAll(async () => {
    await Deno.remove(repo, { recursive: true });
  });

  it("writes a plan recording each entry's outcome and every selected path", async () => {
    const output = await runPlan([
      "--repo-root",
      repo,
      "--program-root",
      "patterns",
      "--include",
      "patterns/**",
      "--exclude",
      "patterns/dev/**",
      "--out",
      `${repo}/plan.json`,
      "--summary",
      `${repo}/summary.md`,
    ]);

    expect(output.code).toBe(0);
    const plan: RepoSyncPlan = JSON.parse(
      await Deno.readTextFile(`${repo}/plan.json`),
    );
    expect(plan.selected).toEqual([
      "patterns/broken/main.tsx",
      "patterns/counter/main.tsx",
      "patterns/counter/start.ts",
      "patterns/quiet/main.tsx",
    ]);
    expect(plan.entries.map((planned) => [planned.path, planned.status]))
      .toEqual([
        ["patterns/broken/main.tsx", "failed"],
        ["patterns/counter/main.tsx", "compiled"],
        ["patterns/quiet/main.tsx", "undescribed"],
      ]);
    const counter = plan.entries[1];
    if (counter.status !== "compiled") throw new Error("not compiled");
    expect(counter.request.description).toBe("Counts clicks.");
    expect(counter.request.hashtags).toEqual(["demo"]);
    expect(await Deno.readTextFile(`${repo}/summary.md`)).toContain(
      "3 entries: 1 compiled, 1 without a description, 1 failed.",
    );
  });

  it("writes the same source hash and pattern id for the same source on a second run", async () => {
    // A sync skips an entry only when both match its head, so a compile that
    // varied between runs would republish every entry on every push.

    const ids = [];
    for (const out of ["first.json", "second.json"]) {
      const output = await runPlan([
        "--repo-root",
        repo,
        "--program-root",
        "patterns",
        "--include",
        "patterns/counter/**",
        "--out",
        `${repo}/${out}`,
      ]);
      expect(output.code).toBe(0);
      const plan: RepoSyncPlan = JSON.parse(
        await Deno.readTextFile(`${repo}/${out}`),
      );
      const [counter] = plan.entries;
      if (counter.status !== "compiled") throw new Error("not compiled");
      ids.push([counter.sourceHash, counter.request.patternId]);
    }
    expect(ids[1]).toEqual(ids[0]);
  });

  it("exits nonzero, writing no plan, when the repository root is not a git checkout", async () => {
    const elsewhere = await Deno.makeTempDir({
      prefix: "pattern-index-sync-plan-",
    });
    try {
      const output = await runPlan([
        "--repo-root",
        elsewhere,
        "--program-root",
        ".",
        "--include",
        "**",
        "--out",
        `${elsewhere}/plan.json`,
      ]);
      expect(output.code).not.toBe(0);
      expect(output.stderr).toContain("git ls-files failed");
      await expect(Deno.stat(`${elsewhere}/plan.json`)).rejects.toThrow();
    } finally {
      await Deno.remove(elsewhere, { recursive: true });
    }
  });

  it("exits 2 without --program-root or --out", async () => {
    const output = await runPlan(["--include", "patterns/**"]);

    expect(output.code).toBe(2);
    expect(output.stderr).toContain("are required");
  });

  it("exits 2 without --include", async () => {
    const output = await runPlan([
      "--program-root",
      "patterns",
      "--out",
      `${repo}/unused.json`,
    ]);

    expect(output.code).toBe(2);
    expect(output.stderr).toContain("at least one --include");
  });
});
