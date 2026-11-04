import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, fromFileUrl, join } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import {
  checkIndex,
  checkShape,
  coversPath,
  type HistoryTree,
  readTree,
  report,
  run,
} from "./check-docs-history-index.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));
const SCRIPT = join(REPO_ROOT, "tasks/check-docs-history-index.ts");

const TITLE = "# Index of historical documents";
const PROSE = "One line per archived document; the rules are in `README.md`.";

const index = (...body: string[]): string =>
  [TITLE, "", PROSE, "", ...body].join("\n");

describe("checkShape", () => {
  it("accepts a title, one line of prose, headings, and one-line entries", () => {
    const { problems, entries } = checkShape(index(
      "## Audits and reports",
      "",
      "- [a.md](specs/a.md) — an audit, July 2026.",
      "",
      "## Executed plans and work orders",
      "",
      "- [b.md](plans/b.md) — a plan, August 2026.",
    ));
    expect(problems).toEqual([]);
    expect(entries.map((entry) => entry.targets)).toEqual([
      ["specs/a.md"],
      ["plans/b.md"],
    ]);
  });

  it("reads every target from an entry that groups several documents", () => {
    const { problems, entries } = checkShape(index(
      "## Investigations, journals, and working notes",
      "",
      "- [a.md](runtime/a.md) and [b.md](runtime/b.md) — working notes.",
    ));
    expect(problems).toEqual([]);
    expect(entries[0].targets).toEqual(["runtime/a.md", "runtime/b.md"]);
  });

  it("rejects a wrapped entry, which a union merge can splice", () => {
    // The failure this exists for: two branches each add an entry whose last
    // line is "  August 2026.", and the union merge keeps that line once.
    const { problems } = checkShape(index(
      "## Audits and reports",
      "",
      "- [a.md](specs/a.md) — an audit of the thing that was audited,",
      "  August 2026.",
    ));
    expect(problems.length).toBe(1);
    expect(problems[0].lineNumber).toBe(8);
    expect(problems[0].message).toContain("never wrapped");
  });

  it("rejects prose after the first section heading", () => {
    const { problems } = checkShape(index(
      "## Audits and reports",
      "",
      "Some note about this section.",
      "",
      "- [a.md](specs/a.md) — an audit, July 2026.",
    ));
    expect(problems.length).toBe(1);
    expect(problems[0].message).toContain("section heading or an entry");
  });

  it("rejects a second paragraph in the preamble", () => {
    const { problems } = checkShape([
      TITLE,
      "",
      PROSE,
      "",
      "A second paragraph, which two branches could edit at once.",
      "",
      "## Audits and reports",
      "",
      "- [a.md](specs/a.md) — an audit, July 2026.",
    ].join("\n"));
    expect(problems.length).toBe(1);
    expect(problems[0].message).toContain("exactly one line of prose");
  });

  it("reports the same document indexed twice", () => {
    const { problems } = checkShape(index(
      "## Audits and reports",
      "",
      "- [a.md](specs/a.md) — an audit, July 2026.",
      "- [a.md](specs/a.md) — an audit, rewritten, July 2026.",
    ));
    expect(problems.length).toBe(1);
    expect(problems[0].lineNumber).toBe(8);
    expect(problems[0].message).toContain("already indexed on line 7");
  });

  it("reports an entry that links nothing", () => {
    const { problems } = checkShape(index(
      "## Audits and reports",
      "",
      "- an audit, July 2026.",
    ));
    expect(problems.length).toBe(1);
    expect(problems[0].message).toContain("links nothing");
  });

  it("ignores links that leave the tree", () => {
    const { problems, entries } = checkShape(index(
      "## Shipped or superseded designs and decision records",
      "",
      "- [a.md](specs/a.md) — superseded by the [live spec](../specs/a.md).",
    ));
    expect(problems).toEqual([]);
    expect(entries[0].targets).toEqual(["specs/a.md"]);
  });

  it("ignores a link to somewhere off the filesystem", () => {
    const { problems, entries } = checkShape(index(
      "## Audits and reports",
      "",
      "- [a.md](specs/a.md) — an audit, measured against " +
        "[the site](https://example.com/thing).",
    ));
    expect(problems).toEqual([]);
    expect(entries[0].targets).toEqual(["specs/a.md"]);
  });

  it("reports an index with no sections rather than reading it as entries", () => {
    const { problems, entries } = checkShape([
      TITLE,
      "",
      PROSE,
      "",
      "- [a.md](specs/a.md) — an audit filed under no section.",
    ].join("\n"));
    expect(problems.length).toBe(1);
    expect(problems[0].message).toContain("no `## ` section heading");
    expect(entries).toEqual([]);
  });

  it("requires the title", () => {
    const { problems } = checkShape([
      "# Historical documents",
      "",
      PROSE,
      "",
      "## Audits and reports",
      "",
      "- [a.md](specs/a.md) — an audit, July 2026.",
    ].join("\n"));
    expect(problems.length).toBe(1);
    expect(problems[0].lineNumber).toBe(1);
  });
});

const tree = (...documents: string[]): HistoryTree => {
  const paths = new Set<string>();
  for (const document of documents) {
    paths.add(document);
    const segments = document.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      const directory = segments.slice(0, depth).join("/");
      paths.add(directory);
      paths.add(`${directory}/`);
    }
  }
  return { documents, paths };
};

describe("checkIndex", () => {
  it("passes an index that names every document once", () => {
    const { problems, entryCount } = checkIndex(
      index(
        "## Audits and reports",
        "",
        "- [a.md](specs/a.md) — an audit, July 2026.",
        "- [b.md](plans/b.md) — another audit, August 2026.",
      ),
      tree("specs/a.md", "plans/b.md"),
    );
    expect(problems).toEqual([]);
    expect(entryCount).toBe(2);
  });

  it("reports an entry pointing at a document that is not there", () => {
    const { problems } = checkIndex(
      index(
        "## Audits and reports",
        "",
        "- [gone.md](specs/gone.md) — an audit whose document moved.",
      ),
      tree("specs/a.md"),
    );
    expect(problems.map((problem) => problem.message)).toEqual([
      "specs/gone.md does not exist",
      "docs/history/specs/a.md is missing from the index",
    ]);
  });

  it("reports a document no entry covers", () => {
    const { problems } = checkIndex(
      index(
        "## Audits and reports",
        "",
        "- [a.md](specs/a.md) — an audit, July 2026.",
      ),
      tree("specs/a.md", "development/performance/unindexed.md"),
    );
    expect(problems.length).toBe(1);
    expect(problems[0].message).toContain(
      "docs/history/development/performance/unindexed.md is missing",
    );
    expect(problems[0].lineNumber).toBeUndefined();
  });

  it("lets one entry naming a directory cover the whole subtree", () => {
    const { problems } = checkIndex(
      index(
        "## The retired tutorial site",
        "",
        "- [tutorials/](tutorials/) — the retired site, entered at " +
          "[index.md](tutorials/index.md).",
      ),
      tree("tutorials/index.md", "tutorials/state.md", "tutorials/notes.md"),
    );
    expect(problems).toEqual([]);
  });

  it("carries the shape problems through alongside the coverage ones", () => {
    const { problems } = checkIndex(
      index(
        "## Audits and reports",
        "",
        "- [a.md](specs/a.md) — an audit that runs long,",
        "  July 2026.",
      ),
      tree("specs/a.md"),
    );
    expect(problems.length).toBe(1);
    expect(problems[0].message).toContain("never wrapped");
  });
});

describe("report", () => {
  it("states the counts when nothing is wrong", () => {
    expect(report("docs/history/INDEX.md", [], 111, 138)).toEqual([
      "docs/history/INDEX.md: 111 entries covering 138 documents.",
    ]);
  });

  it("gives a line number for a problem that has one, and none otherwise", () => {
    const lines = report(
      "docs/history/INDEX.md",
      [
        { lineNumber: 7, message: "specs/gone.md does not exist" },
        { message: "docs/history/specs/a.md is missing from the index" },
      ],
      1,
      2,
    );
    expect(lines[0]).toContain("needs fixing");
    expect(lines[2]).toBe("  line 7: specs/gone.md does not exist");
    expect(lines[3]).toBe(
      "  docs/history/specs/a.md is missing from the index",
    );
    expect(lines[lines.length - 1]).toContain("README.md");
  });
});

describe("run", () => {
  it("reports a clean tree by its counts", async () => {
    const root = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${root}/specs`);
      await Deno.writeTextFile(`${root}/README.md`, "rules");
      await Deno.writeTextFile(`${root}/specs/a.md`, "an audit");
      await Deno.writeTextFile(
        `${root}/INDEX.md`,
        index(
          "## Audits and reports",
          "",
          "- [a.md](specs/a.md) — an audit, July 2026.",
        ),
      );

      const { lines, ok } = await run(root);

      expect(ok).toBe(true);
      // The report names the index it read, not the repository's own.
      expect(lines).toEqual([
        `${root}/INDEX.md: 1 entries covering 1 documents.`,
      ]);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });

  it("reports a document the index leaves out", async () => {
    const root = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${root}/specs`);
      await Deno.writeTextFile(`${root}/specs/a.md`, "an audit");
      await Deno.writeTextFile(`${root}/specs/forgotten.md`, "another");
      await Deno.writeTextFile(
        `${root}/INDEX.md`,
        index(
          "## Audits and reports",
          "",
          "- [a.md](specs/a.md) — an audit, July 2026.",
        ),
      );

      const { lines, ok } = await run(root);

      expect(ok).toBe(false);
      expect(lines[0]).toContain("needs fixing");
      expect(lines.join("\n")).toContain(
        "docs/history/specs/forgotten.md is missing from the index",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

describe("the check as CI runs it", () => {
  it("passes over this repository's own history tree", async () => {
    // Runs the script the way `deno task` does, so the entry point that CI
    // depends on — reading the repository's index, printing, choosing an exit
    // code — is exercised rather than assumed.
    const output = await runDenoCommandWithTemporaryLock({
      root: REPO_ROOT,
      args: (lockPath) => [
        "run",
        "--config",
        join(REPO_ROOT, "deno.jsonc"),
        "--lock",
        lockPath,
        "--allow-read",
        SCRIPT,
      ],
    });
    const stdout = new TextDecoder().decode(output.stdout);
    expect(output.code).toBe(0);
    expect(stdout).toContain("docs/history/INDEX.md:");
    expect(stdout).toContain("entries covering");
  });

  it("exits non-zero over a tree whose index is wrong", async () => {
    // The behavior the gate is: failing. A check that reported a problem and
    // exited 0 would let every one of these through CI.
    const root = await Deno.makeTempDir();
    try {
      await Deno.writeTextFile(`${root}/forgotten.md`, "an unindexed record");
      await Deno.writeTextFile(
        `${root}/INDEX.md`,
        index("## Audits and reports", "", "- [gone.md](gone.md) — a record."),
      );

      const output = await runDenoCommandWithTemporaryLock({
        root: REPO_ROOT,
        args: (lockPath) => [
          "run",
          "--config",
          join(REPO_ROOT, "deno.jsonc"),
          "--lock",
          lockPath,
          "--allow-read",
          SCRIPT,
          root,
        ],
      });

      expect(output.code).toBe(1);
      const stderr = new TextDecoder().decode(output.stderr);
      expect(stderr).toContain("gone.md does not exist");
      expect(stderr).toContain("forgotten.md is missing from the index");
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

describe("readTree", () => {
  it("finds every document, and registers each directory both ways", async () => {
    const root = await Deno.makeTempDir();
    try {
      await Deno.mkdir(`${root}/specs/scheduler-v2`, { recursive: true });
      await Deno.writeTextFile(`${root}/README.md`, "rules");
      await Deno.writeTextFile(`${root}/INDEX.md`, "index");
      await Deno.writeTextFile(`${root}/audit.md`, "a");
      await Deno.writeTextFile(`${root}/specs/a.md`, "b");
      await Deno.writeTextFile(`${root}/specs/scheduler-v2/PROGRESS.md`, "c");
      await Deno.writeTextFile(`${root}/specs/diagram.png`, "not markdown");

      const tree = await readTree(root);

      expect(tree.documents).toEqual([
        "audit.md",
        "specs/a.md",
        "specs/scheduler-v2/PROGRESS.md",
      ]);
      // A directory entry may be written with or without the trailing slash.
      expect(tree.paths.has("specs")).toBe(true);
      expect(tree.paths.has("specs/")).toBe(true);
      expect(tree.paths.has("specs/scheduler-v2/")).toBe(true);
      // A non-Markdown file is a valid target but is not itself a document.
      expect(tree.paths.has("specs/diagram.png")).toBe(true);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
});

describe("coversPath", () => {
  it("covers the document it names", () => {
    expect(coversPath("specs/a.md", "specs/a.md")).toBe(true);
    expect(coversPath("specs/a.md", "specs/b.md")).toBe(false);
  });

  it("covers a whole subtree when it names a directory", () => {
    expect(coversPath("tutorials/", "tutorials/index.md")).toBe(true);
    expect(coversPath("tutorials/", "tutorials/images/notes.md")).toBe(true);
    expect(coversPath("tutorials/", "plans/a.md")).toBe(false);
  });

  it("does not let a document name cover its siblings", () => {
    expect(coversPath("tutorials/index.md", "tutorials/state.md")).toBe(false);
  });
});
