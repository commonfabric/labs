import { fromFileUrl, join } from "@std/path";
import { expect } from "@std/expect";

import {
  buildSnapshot,
  compareSections,
  functionsOf,
  main,
  normalizeBlock,
  readChaptersAt,
  renderSnapshot,
  revision,
  sectionsOf,
  sha256Hex,
  SNAPSHOT_PATH,
  specsDirectory,
} from "./cfc-spec-snapshot.ts";
import { type Git, gitIn } from "./repository-files.ts";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

const ROOT = fromFileUrl(new URL("..", import.meta.url));

const SPECS_COMMIT = "9e751d583760fe44780aad2f4b138edb2667fa1a";

/**
 * A git that answers each argument list `answers` names, joined by spaces,
 * and rejects any other; `calls` records each call's directory and arguments.
 */
function fakeGit(
  answers: Readonly<Record<string, string>>,
  calls: string[][] = [],
): (directory: string) => Git {
  return (directory) => (...args) => {
    calls.push([directory, ...args]);
    const answer = answers[args.join(" ")];
    return answer === undefined
      ? Promise.reject(new Error(`unexpected \`git ${args.join(" ")}\``))
      : Promise.resolve(answer);
  };
}

/** What git says of a specs checkout's `cfc/` directory at `v1`. */
const SPECS_AT_V1: Readonly<Record<string, string>> = {
  "rev-parse v1^{commit}": `${SPECS_COMMIT}\n`,
  "rev-parse --show-prefix": "cfc/\n",
  [`ls-tree --full-tree --name-only ${SPECS_COMMIT}:cfc/`]:
    "03-labels.md\nREADME.md\n11-guide.md\n",
  [`show ${SPECS_COMMIT}:cfc/03-labels.md`]:
    "# 3. Labels\n## 3.1 Atoms\n```ts\nfunction atom() {}\n```\n",
  [`show ${SPECS_COMMIT}:cfc/11-guide.md`]: "# 11. Guide\n",
};

/** An environment holding exactly `vars`. */
const environment = (vars: Readonly<Record<string, string>>) => ({
  get: (name: string): string | undefined => vars[name],
});

const chapter = [
  "# 8. Label Transition Rules",
  "",
  "## 8.12 Store Label Monotonicity",
  "",
  "### 8.12.1 Comparison",
  "",
  "```typescript",
  "function atomLe(proposed: Atom, current: Atom): boolean {  ",
  "  return proposed === current;",
  "}",
  "",
  "export function isMoreRestrictiveCNF(a: Clause[], b: Clause[]): boolean {",
  "  return true;",
  "}",
  "```",
  "",
  "#### Unnumbered aside",
  "",
  "```ts",
  "async function canUpdateStoreLabel<T>(label: T): Promise<boolean> {",
  "  return true;",
  "}",
  "```",
  "",
  "```json",
  '{ "function": "notCode(" }',
  "```",
  "",
  "### 8.12.4 Reads",
  "",
  "```typescript",
  "const canWrite = (label: Label) => true;",
  "```",
].join("\n");

describe("cfc-spec-snapshot", () => {
  describe("sectionsOf()", () => {
    it("returns every numbered heading's number, chapter dot dropped, and skips unnumbered headings", () => {
      expect(sectionsOf(chapter)).toEqual(["8", "8.12", "8.12.1", "8.12.4"]);
    });
  });

  describe("compareSections()", () => {
    it("orders by numeric component rather than by string", () => {
      const sections = ["8.12.4", "8.2", "8.12.1", "8", "10", "8.12"];
      expect(sections.toSorted(compareSections)).toEqual([
        "8",
        "8.2",
        "8.12",
        "8.12.1",
        "8.12.4",
        "10",
      ]);
    });

    it("returns 0 for a section compared with itself", () => {
      expect(compareSections("8.12", "8.12")).toBe(0);
    });
  });

  describe("normalizeBlock()", () => {
    it("strips trailing whitespace per line and joins with `\\n`", () => {
      expect(normalizeBlock(["a  ", "b\t", "", "c"])).toBe("a\nb\n\nc");
    });

    it("strips the indentation every non-blank line shares and keeps the rest", () => {
      expect(normalizeBlock(["  a", "", "    b", "  c  "])).toBe(
        "a\n\n  b\nc",
      );
    });
  });

  describe("functionsOf()", () => {
    it("returns each declared function under the nearest numbered heading, sharing its block's hash", () => {
      const found = functionsOf("08-12.md", chapter);
      const hash = sha256Hex(
        normalizeBlock([
          "function atomLe(proposed: Atom, current: Atom): boolean {  ",
          "  return proposed === current;",
          "}",
          "",
          "export function isMoreRestrictiveCNF(a: Clause[], b: Clause[]): boolean {",
          "  return true;",
          "}",
        ]),
      );
      expect(found.map(({ section, name }) => [section, name])).toEqual([
        ["8.12.1", "atomLe"],
        ["8.12.1", "isMoreRestrictiveCNF"],
        ["8.12.1", "canUpdateStoreLabel"],
      ]);
      expect(found[0].sha256).toBe(hash);
      expect(found[1].sha256).toBe(hash);
      expect(found[2].sha256).not.toBe(hash);
    });

    it("gives a block the same hash at any indentation, as inside a list", () => {
      const [flat] = functionsOf(
        "x.md",
        "## 1\n```ts\nfunction f() {\n  return 1;\n}\n```",
      );
      const [listed] = functionsOf(
        "x.md",
        "## 1\n- item\n\n  ```ts\n  function f() {\n    return 1;\n  }\n  ```",
      );
      expect(listed.sha256).toBe(flat.sha256);
    });

    it("reads a heading inside a non-pseudocode fence as text, and a fence inside a longer fence as text", () => {
      const text = [
        "## 1 Real",
        "```text",
        "### 1.9 Not a heading",
        "```",
        "````md",
        "```ts",
        "function nested() {}",
        "```",
        "````",
        "~~~typescript",
        "function tilde() {}",
        "~~~",
        "```ts title=example",
        "function titled() {}",
        "```",
      ].join("\n");
      expect(sectionsOf(text)).toEqual(["1"]);
      expect(
        (functionsOf("x.md", text)).map(({ section, name }) => [
          section,
          name,
        ]),
      ).toEqual([["1", "tilde"], ["1", "titled"]]);
    });

    it("reads a function whose type parameters nest angle brackets", () => {
      const text =
        "## 1\n```ts\nfunction f<T extends Map<string, Set<number>>>(\n  a: T,\n): T {\n  return a;\n}\nfunction g<K, V>(m: Map<K, V>): void {}\n```";
      expect(functionsOf("x.md", text).map(({ name }) => name)).toEqual([
        "f",
        "g",
      ]);
    });

    it("throws on a fence the chapter never closes, naming the chapter and the line", () => {
      const text = "## 1\n\n```ts\nfunction f() {}\n## 2 swallowed\n";
      expect(() => functionsOf("08-12.md", text)).toThrow(
        "08-12.md: the fence opened at line 3 is never closed",
      );
      expect(() => sectionsOf(text, "08-12.md")).toThrow(
        "08-12.md: the fence opened at line 3 is never closed",
      );
    });

    it("gives a block the same hash whatever its trailing whitespace", () => {
      const [a] = functionsOf(
        "x.md",
        "## 1\n```ts\nfunction f() {}\n```",
      );
      const [b] = functionsOf(
        "x.md",
        "## 1\n```ts\nfunction f() {}   \n```",
      );
      expect(a.sha256).toBe(b.sha256);
    });
  });

  describe("buildSnapshot()", () => {
    it("reads sections from every numbered chapter and functions from the pseudocode chapters only", () => {
      const text = "## 5.1 A\n```ts\nfunction g() {}\n```\n";
      const snapshot = buildSnapshot("abc", [
        { name: "README.md", text: "## 9.9 Ignored\n" },
        { name: "11-developer-guide.md", text },
        { name: "05-policy-architecture.md", text },
      ]);
      expect(snapshot).toEqual({
        specsCommit: "abc",
        sections: ["5.1"],
        functions: [{
          file: "05-policy-architecture.md",
          section: "5.1",
          name: "g",
          sha256: sha256Hex("function g() {}"),
        }],
      });
    });
  });

  describe("renderSnapshot()", () => {
    it("returns the snapshot as two-space-indented JSON ending in a newline", () => {
      expect(
        renderSnapshot({ specsCommit: "abc", sections: ["1"], functions: [] }),
      ).toBe(
        '{\n  "specsCommit": "abc",\n  "sections": [\n    "1"\n  ],\n' +
          '  "functions": []\n}\n',
      );
    });
  });

  describe("readChaptersAt()", () => {
    it("returns the numbered chapter files at the commit the revision names", async () => {
      const calls: string[][] = [];
      const read = await readChaptersAt(
        "/specs/cfc",
        "v1",
        fakeGit(SPECS_AT_V1, calls),
      );
      expect(read).toEqual({
        specsCommit: SPECS_COMMIT,
        chapters: [
          {
            name: "03-labels.md",
            text: SPECS_AT_V1[`show ${SPECS_COMMIT}:cfc/03-labels.md`],
          },
          { name: "11-guide.md", text: "# 11. Guide\n" },
        ],
      });
      expect(calls.every(([directory]) => directory === "/specs/cfc")).toBe(
        true,
      );
    });

    it("throws what git throws for a revision it cannot resolve", async () => {
      await expect(readChaptersAt("/specs/cfc", "v2", fakeGit(SPECS_AT_V1)))
        .rejects.toThrow("unexpected `git rev-parse v2^{commit}`");
    });
  });

  describe("specsDirectory()", () => {
    it("returns `CF_SPECS_DIR` where it is set", () => {
      expect(
        specsDirectory(environment({ CF_SPECS_DIR: "/x/cfc", HOME: "/h" })),
      ).toBe("/x/cfc");
    });

    it("returns `~/src/specs/cfc` where `CF_SPECS_DIR` is unset or empty", () => {
      expect(specsDirectory(environment({ HOME: "/h" }))).toBe(
        join("/h", "src", "specs", "cfc"),
      );
      expect(specsDirectory(environment({ CF_SPECS_DIR: "", HOME: "/h" })))
        .toBe(join("/h", "src", "specs", "cfc"));
    });

    it("throws where neither `CF_SPECS_DIR` nor `HOME` is set", () => {
      expect(() => specsDirectory(environment({}))).toThrow(
        "Set `CF_SPECS_DIR` to the `cfc/` directory of a specs checkout.",
      );
    });
  });

  describe("revision()", () => {
    it("returns `HEAD` when `--rev` is not given", () => {
      expect(revision([])).toBe("HEAD");
    });

    it("returns the argument after `--rev`", () => {
      expect(revision(["--rev", "origin/main"])).toBe("origin/main");
    });

    it("throws when `--rev` is last or followed by an option", () => {
      expect(() => revision(["--rev"])).toThrow("`--rev` takes a revision.");
      expect(() => revision(["--rev", "--other"])).toThrow(
        "`--rev` takes a revision.",
      );
    });
  });

  describe("main()", () => {
    let dir: string;

    beforeEach(async () => {
      dir = await Deno.makeTempDir();
    });

    afterEach(async () => {
      await Deno.remove(dir, { recursive: true });
    });

    it("writes the snapshot of the revision `--rev` names and returns what it wrote", async () => {
      const calls: string[][] = [];
      const target = join(dir, "spec-snapshot.json");
      const said = await main(["--rev", "v1"], {
        env: environment({ CF_SPECS_DIR: "/specs/cfc" }),
        git: fakeGit(SPECS_AT_V1, calls),
        target,
      });
      expect(JSON.parse(await Deno.readTextFile(target))).toEqual({
        specsCommit: SPECS_COMMIT,
        sections: ["3", "3.1", "11"],
        functions: [{
          file: "03-labels.md",
          section: "3.1",
          name: "atom",
          sha256: sha256Hex("function atom() {}"),
        }],
      });
      expect(said).toBe(
        `Wrote ${SNAPSHOT_PATH}: specs 9e751d58, 3 sections, 1 functions.`,
      );
      expect(calls[0]).toEqual(["/specs/cfc", "rev-parse", "v1^{commit}"]);
    });

    it("writes nothing when the specs checkout cannot be read", async () => {
      const target = join(dir, "spec-snapshot.json");
      await expect(
        main([], {
          env: environment({ CF_SPECS_DIR: "/specs/cfc" }),
          git: fakeGit(SPECS_AT_V1),
          target,
        }),
      ).rejects.toThrow("unexpected `git rev-parse HEAD^{commit}`");
      await expect(Deno.stat(target)).rejects.toThrow(Deno.errors.NotFound);
    });
  });

  describe("the command-line entry point", () => {
    let repo: string;

    beforeEach(async () => {
      repo = await Deno.makeTempDir();
      const git = gitIn(repo);
      const commit = async (chapter: string) => {
        await Deno.writeTextFile(join(repo, "cfc", "03-labels.md"), chapter);
        await git("add", ".");
        await git(
          "-c",
          "user.name=Test",
          "-c",
          "user.email=test@example.com",
          "-c",
          "commit.gpgsign=false",
          "commit",
          "-q",
          "-m",
          "specs",
        );
      };
      await Deno.mkdir(join(repo, "cfc"));
      await git("init", "-q");
      await commit("# 3. Labels\n```ts\nfunction atom() {}\n```\n");
      await git("tag", "v1");
      // `HEAD` holds a chapter whose fence never closes, which no snapshot
      // can be built from.
      await commit("# 3. Labels\n```ts\nfunction atom() {}\n");
    });

    afterEach(async () => {
      await Deno.remove(repo, { recursive: true });
    });

    /**
     * Runs the script as its own process with `args`, reading the specs
     * checkout at `repo`, with the permissions the `cfc-spec-snapshot` task
     * grants except write access, so the committed snapshot stays as it is.
     */
    const run = async (args: readonly string[]) => {
      const { code, stdout, stderr } = await runDenoCommandWithTemporaryLock({
        root: ROOT,
        args: (lockPath) => [
          "run",
          "--config",
          join(ROOT, "deno.jsonc"),
          "--lock",
          lockPath,
          "--no-prompt",
          "--allow-read",
          "--allow-run=git",
          "--allow-env=CF_SPECS_DIR,HOME",
          join(ROOT, "tasks", "cfc-spec-snapshot.ts"),
          ...args,
        ],
        env: { CF_SPECS_DIR: join(repo, "cfc") },
      });
      return {
        code,
        stdout: new TextDecoder().decode(stdout),
        stderr: new TextDecoder().decode(stderr),
      };
    };

    it("asks for write access to the committed snapshot once it has read the `--rev` revision of the checkout `CF_SPECS_DIR` names", async () => {
      const { code, stdout, stderr } = await run(["--rev", "v1"]);
      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain(
        `Requires write access to "${join(ROOT, SNAPSHOT_PATH)}"`,
      );
      expect(stderr).not.toContain("never closed");
    });

    it("writes nothing when the checkout `CF_SPECS_DIR` names cannot be read at `HEAD` and no `--rev` is given", async () => {
      const { code, stdout, stderr } = await run([]);
      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain(
        "03-labels.md: the fence opened at line 2 is never closed",
      );
      expect(stderr).not.toContain("write access");
    });

    it("writes nothing when `--rev` names a revision the checkout lacks", async () => {
      const { code, stdout, stderr } = await run(["--rev", "v2"]);
      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("`git rev-parse v2^{commit}` failed");
      expect(stderr).not.toContain("write access");
    });
  });
});
