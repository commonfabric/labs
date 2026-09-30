/**
 * These pin a gate that fails CI, so it has to be exact in both directions.
 *
 * The cases that must NOT match carry most of the weight: a false positive
 * blocks a pull request over ordinary source, and the characters here are
 * invisible, so a reader cannot check the verdict by eye.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { assert } from "@std/assert";
import { join } from "@std/path";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import { fromFileUrl } from "@std/path/from-file-url";

const bytes = (text: string) => new TextEncoder().encode(text);
import {
  blobContents,
  controlViolations,
  isGovernedPath,
  main,
  parseBatchBlobs,
  parseIndexRecords,
  scan,
} from "./check-control-characters.ts";

/** Helper for the tests below, which makes a git repo holding one tracked file. */
async function git(root: string, ...args: string[]): Promise<void> {
  const { success, stderr } = await new Deno.Command("git", {
    args,
    cwd: root,
    stdout: "null",
    stderr: "piped",
  }).output();
  assert(success, `git ${args.join(" ")}: ${new TextDecoder().decode(stderr)}`);
}

/** Stages a file whose contents changed after the repo was made. */
async function gitAdd(root: string, name: string): Promise<void> {
  await git(root, "add", name);
}

async function fixtureRepo(
  name: string,
  contents: string,
  options: { autocrlf?: boolean } = {},
): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "check-control-characters-" });
  await git(root, "init", "-q");
  const at = join(root, name);
  await Deno.mkdir(join(at, ".."), { recursive: true });
  await Deno.writeTextFile(at, contents);
  await git(root, "add", name);
  if (options.autocrlf) {
    // Set AFTER staging, so the blob holds LF and only the checkout converts.
    // Materialized straight from the index rather than through a commit: the
    // conversion this reproduces happens on checkout either way, and a commit
    // would need an author identity that a CI runner has no reason to carry.
    await git(root, "config", "core.autocrlf", "true");
    await Deno.remove(join(root, name));
    await git(root, "checkout-index", "-f", "-a");
  }
  return root;
}

describe("check-control-characters", () => {
  describe("controlViolations()", () => {
    it("returns nothing for source that is only text and newlines", () => {
      expect(controlViolations(bytes("const a = 1;\nconst b = 2;\n"))).toEqual(
        [],
      );
    });

    it("returns nothing for an escape written as source characters", () => {
      // The whole point of the rule: this is the spelling it asks for, so it
      // has to read as clean. These are five ordinary characters.
      expect(controlViolations(bytes("const sep = `${a}\\x00${b}`;\n")))
        .toEqual([]);
    });

    it("reports a literal NUL with the line it first appears on", () => {
      expect(controlViolations(bytes("a\nb\nconst s = \u0000;\n"))).toEqual([
        { line: 3, code: 0x00, count: 1 },
      ]);
    });

    it("counts a codepoint once per file rather than once per occurrence", () => {
      // A CRLF file would otherwise report a finding per line and bury every
      // other file in the run.
      expect(controlViolations(bytes("a\r\nb\r\nc\r\n"))).toEqual([
        { line: 1, code: 0x0d, count: 3 },
      ]);
    });

    it("reports a literal tab", () => {
      expect(controlViolations(bytes("const a = 1;\n\tconst b = 2;\n")))
        .toEqual([
          { line: 2, code: 0x09, count: 1 },
        ]);
    });

    it("allows characters at or above 0x20, including non-ASCII", () => {
      expect(controlViolations(bytes('const s = "— ✓ é";\n'))).toEqual([]);
    });
  });

  describe("isGovernedPath()", () => {
    it("governs every authored format, including ones no list named", () => {
      // These disparate formats pin that new source types remain governed
      // without updating a source-format registry.
      for (
        const path of [
          "tasks/a.ts",
          "packages/ui/b.tsx",
          "x.js",
          "deno.jsonc",
          "scripts/run.sh",
          ".github/workflows/ci.yml",
          "packages/fuse/verify-structs.c",
          "docs/specs/memory-v2/tla/PendingStacks.tla",
          "packages/shell/public/manifest.webmanifest",
          "tasks/test-identity-aliases/tags.test.ts.jsonl",
          "packages/shell/public/assets/cf.svg",
          "Dockerfile.toolshed",
          "docs/README.md",
        ]
      ) {
        expect(isGovernedPath(path)).toBe(true);
      }
    });

    it("exempts formats whose contents are not text", () => {
      for (
        const path of ["a.png", "b.sqlite", "c.gz", "d.ttf", "e.db-wal"]
      ) {
        expect(isGovernedPath(path)).toBe(false);
      }
    });

    it("exempts the named data fixtures and the trees it may not reach", () => {
      for (
        const path of [
          "packages/content-hash/test/fixture-frank.txt",
          "packages/memory/memory.tldr",
          "docs/history/specs/pattern-id-retirement.md",
          "packages/static/assets/types/es2023.d.ts",
        ]
      ) {
        expect(isGovernedPath(path)).toBe(false);
      }
    });

    it("governs a text file that shares a name with an exempt one", () => {
      // The fixture is exempt by PATH, not by name: another `fixture-frank.txt`
      // elsewhere is ordinary tracked text.
      expect(isGovernedPath("packages/other/fixture-frank.txt")).toBe(true);
    });
  });

  describe("parseIndexRecords()", () => {
    it("returns the blob id and path of each record", () => {
      expect(
        parseIndexRecords(
          "100644 abc123 0\ttasks/a.ts\x00100644 def456 0\tb.md\x00",
        ),
      ).toEqual([["abc123", "tasks/a.ts"], ["def456", "b.md"]]);
    });

    it("keeps a path containing a space", () => {
      expect(parseIndexRecords("100644 abc123 0\tdocs/a b.ts\x00"))
        .toEqual([["abc123", "docs/a b.ts"]]);
    });

    it("declines a record with no path separator", () => {
      // Guessing at a malformed record would attribute a violation to the
      // wrong file, which is worse than reading one file fewer.
      expect(parseIndexRecords("100644 abc123 0 no-tab-here\x00")).toEqual([]);
    });
  });

  describe("parseBatchBlobs()", () => {
    const encode = (text: string) => new TextEncoder().encode(text);
    const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

    it("slices each blob by the size its header declares", () => {
      const blobs = parseBatchBlobs(
        encode("abc blob 2\nhi\ndef blob 3\nbye\n"),
        2,
      );
      expect(blobs.map(decode)).toEqual(["hi", "bye"]);
    });

    it("keeps content that contains its own record separator", () => {
      // The reason the size is read rather than scanned for: a blob may hold
      // the very newline that ends its record.
      expect(parseBatchBlobs(encode("abc blob 3\na\nb\n"), 1).map(decode))
        .toEqual(["a\nb"]);
    });

    it("stops at a header carrying no size", () => {
      // Continuing past one would slice every following blob at the wrong
      // offset and report violations against the wrong files.
      expect(parseBatchBlobs(encode("abc missing\ndef blob 2\nhi\n"), 2))
        .toEqual([]);
    });

    it("stops at a size that is not the digits git writes", () => {
      // An empty field and a negative one both read as a number, so both
      // would push a record and carry on from an offset nothing lines up
      // with — the count comes out right and the contents do not.
      expect(parseBatchBlobs(encode("abc blob \ndef blob 2\nhi\n"), 2))
        .toEqual([]);
      expect(parseBatchBlobs(encode("abc blob -1\ndef blob 2\nhi\n"), 2))
        .toEqual([]);
    });

    it("stops at a record the output does not carry in full", () => {
      // The slice clamps to what is there, so a blob short of its declared
      // size would be scanned as the whole file — and with the count intact,
      // the caller's fail-closed check would see a tree fully read.
      expect(parseBatchBlobs(encode("abc blob 2\nhi\ndef blob 9\nnope"), 2))
        .toEqual([encode("hi")]);
      expect(parseBatchBlobs(encode("abc blob 100\nhi\n"), 1)).toEqual([]);
    });

    it("keeps the last record, whose trailing newline ends the output", () => {
      // The boundary either side of the guard above: a complete final record
      // reaches exactly to the last byte of the output, and an empty blob
      // carries nothing between its header and that newline.
      expect(parseBatchBlobs(encode("abc blob 3\nbye\n"), 1).map(decode))
        .toEqual(["bye"]);
      expect(parseBatchBlobs(encode("abc blob 0\n\n"), 1).map(decode))
        .toEqual([""]);
    });
  });

  describe("scan()", () => {
    it("finds a literal NUL in a tracked source file", async () => {
      const root = await fixtureRepo("subject.ts", "const s = \u0000;\n");
      expect(await scan(root)).toEqual([
        { file: "subject.ts", line: 1, code: 0x00, count: 1 },
      ]);
    });

    it("ignores the same byte in a file it does not govern", async () => {
      // A binary extension. Live prose is governed now — a NUL in a Markdown
      // document breaks grep there exactly as it does in source.
      const root = await fixtureRepo("chart.png", "binary \u0000 here\n");
      expect(await scan(root)).toEqual([]);
    });

    it("governs live prose, and exempts only the frozen record", async () => {
      const root = await fixtureRepo("docs/guide.md", "prose \u0000 here\n");
      expect((await scan(root)).map((v) => v.file)).toEqual(["docs/guide.md"]);

      const frozen = await fixtureRepo(
        "docs/history/old.md",
        "prose \u0000 here\n",
      );
      expect(await scan(frozen)).toEqual([]);
    });

    it("exits 1 and names the file when a violation stands", async () => {
      const root = await fixtureRepo("subject.ts", "const s = \u0000;\n");
      expect(await main(root)).toBe(1);
    });

    it("exits 0 for a clean tree", async () => {
      const root = await fixtureRepo("subject.ts", 'const s = "\\x00";\n');
      expect(await main(root)).toBe(0);
    });

    it("judges the stored blob, not what the checkout materialized", async () => {
      // With `core.autocrlf=true` git writes a stored LF blob into the working
      // tree as CRLF. Scanning the working tree would report a carriage return
      // in source nobody wrote one in — a verdict that depends on the reader's
      // git config rather than on the repository.
      const root = await fixtureRepo(
        "subject.ts",
        "const a = 1;\nconst b = 2;\n",
        { autocrlf: true },
      );
      const materialized = await Deno.readFile(join(root, "subject.ts"));
      expect(materialized.includes(0x0d)).toBe(true);
      expect(await scan(root)).toEqual([]);
    });

    it("catches a control byte in a blob that is not valid UTF-8", async () => {
      // An invalid byte elsewhere in the blob cannot hide the NUL. Raw-byte
      // scanning is exact because UTF-8 multibyte sequences use only bytes at
      // or above 0x80.
      const root = await fixtureRepo("subject.ts", "placeholder\n");
      await Deno.writeFile(
        join(root, "subject.ts"),
        new Uint8Array([0xff, 0x00, 0x0a]),
      );
      await gitAdd(root, "subject.ts");
      expect(await scan(root)).toEqual([
        { file: "subject.ts", line: 1, code: 0x00, count: 1 },
      ]);
    });

    it("does not read a symlink's target as source", async () => {
      // A symlink's blob is its target path and a gitlink's object is a
      // commit; batching either lints index metadata as though it were source.
      const root = await fixtureRepo("subject.ts", "const a = 1;\n");
      await Deno.symlink("subject.ts", join(root, "link.ts"));
      await gitAdd(root, "link.ts");
      expect(await scan(root)).toEqual([]);
      expect(
        parseIndexRecords(
          "120000 abc123 0\tlink.ts\x00100644 def456 0\ta.ts\x00",
        ),
      ).toEqual([["def456", "a.ts"]]);
    });

    it("throws rather than skip a file whose blob is unavailable", async () => {
      // A short batch would otherwise skip that file AND every file after it,
      // and the gate would report success over source nothing read.
      const root = await fixtureRepo("subject.ts", "const a = 1;\n");
      const id = (await new Deno.Command("git", {
        args: ["rev-parse", ":subject.ts"],
        cwd: root,
        stdout: "piped",
      }).output()).stdout;
      const sha = new TextDecoder().decode(id).trim();
      await Deno.remove(
        join(root, ".git", "objects", sha.slice(0, 2), sha.slice(2)),
      );
      await expect(scan(root)).rejects.toThrow("was not fully read");
    });

    it("throws when git cannot read the objects it was given", async () => {
      // Not reachable through `scan` once `ls-files` has succeeded, and the
      // gate's trustworthiness rests on it: a read git declined must not come
      // back as an empty tree. The id list is sized past any pipe buffer so
      // the doomed git's exit is certain to close the pipe mid-write — the
      // same failure lands either way, and this pins the mid-write path
      // rather than leaving it to scheduling.
      const root = await Deno.makeTempDir({ prefix: "check-control-no-git-" });
      const ids = Array.from(
        { length: 50_000 },
        () => "0000000000000000000000000000000000000000",
      );
      await expect(
        blobContents(root, ids),
      ).rejects.toThrow("git cat-file failed: fatal: not a git repository");
    });

    it("throws when git cannot list the tree", async () => {
      // A directory that is not a repository. Reporting nothing here would be
      // a gate that silently passes over everything it was meant to read.
      const root = await Deno.makeTempDir({ prefix: "check-control-not-git-" });
      await expect(scan(root)).rejects.toThrow("git ls-files failed");
    });
  });

  describe("as a command", () => {
    const REPO_ROOT = fromFileUrl(new URL("..", import.meta.url));

    it("exits 0 over this repository and says what it read", async () => {
      // The only end-to-end exercise of the entry point: the permissions the
      // shebang and the task grant, and no more.
      const output = await runDenoCommandWithTemporaryLock({
        root: REPO_ROOT,
        args: (lockPath) => [
          "run",
          "--config",
          join(REPO_ROOT, "deno.jsonc"),
          "--lock",
          lockPath,
          "--allow-read",
          "--allow-run=git",
          join(REPO_ROOT, "tasks/check-control-characters.ts"),
        ],
      });
      const stderr = new TextDecoder().decode(output.stderr);
      expect(output.code, `exited non-zero:\n${stderr}`).toBe(0);
      expect(new TextDecoder().decode(output.stdout)).toContain(
        "No control codepoints",
      );
    });
  });
});
