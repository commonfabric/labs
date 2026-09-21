import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, fromFileUrl, join } from "@std/path";

import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

import {
  addressExample,
  codeSpans,
  collectFindings,
  type Document,
  type Exemption,
  exemptionKey,
  EXEMPTIONS,
  findingLocation,
  governedKind,
  main,
  proseOf,
  readDocuments,
  refusalMessage,
} from "./check-address-examples.ts";

const REPO_ROOT = dirname(dirname(fromFileUrl(import.meta.url)));

/** Runs git under `root`, throwing on a non-zero exit. */
async function git(root: string, args: string[]): Promise<void> {
  const { code, stderr } = await new Deno.Command("git", {
    args: ["-C", root, ...args],
    stdout: "null",
    stderr: "piped",
  }).output();
  if (code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(stderr)}`,
    );
  }
}

/**
 * Writes `files` into a fresh temp git repo and returns its root. The check
 * reads the index for membership and the working tree for content, so nothing
 * needs committing. The caller removes the tree.
 */
async function fixtureRepo(files: Record<string, string>): Promise<string> {
  const root = await Deno.makeTempDir({ prefix: "check-address-examples-" });
  for (const [path, contents] of Object.entries(files)) {
    await Deno.mkdir(join(root, dirname(path)), { recursive: true });
    await Deno.writeTextFile(join(root, path), contents);
  }
  await git(root, ["init", "-q"]);
  await git(root, ["add", "-A"]);
  return root;
}

/** Runs `body` with console output captured, returning what each stream got. */
async function captureConsole(
  body: () => Promise<void>,
): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => out.push(args.map(String).join(" "));
  console.error = (...args) => err.push(args.map(String).join(" "));
  try {
    await body();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return { out: out.join("\n"), err: err.join("\n") };
}

/** One Markdown document named `doc.md`, carrying `text`. */
function markdown(text: string): Document[] {
  return [{ path: "doc.md", kind: "markdown", text }];
}

/** One TypeScript file named `src/demo.ts`, carrying `text`. */
function typescript(text: string): Document[] {
  return [{ path: "src/demo.ts", kind: "source", text }];
}

/**
 * The two characters that open a line comment, and the two that open a block
 * comment, built rather than written.
 *
 * `proseOf` reads a comment opener wherever it sits, a string literal
 * included. A fixture below that spelled one out would turn its own text into
 * prose that this check reads when it scans this file, so every fixture
 * composes its openers instead and stays inert here.
 */
const LINE_OPENER = "/" + "/";
const BLOCK_OPENER = "/" + "*";

describe("check-address-examples", () => {
  describe("governedKind()", () => {
    it("returns `markdown` for a Markdown document", () => {
      expect(governedKind("docs/specs/collection-naming.md")).toBe("markdown");
    });

    it("returns `source` for TypeScript", () => {
      expect(governedKind("packages/cli/lib/callable.ts")).toBe("source");
      expect(governedKind("packages/patterns/notes/notes.tsx")).toBe("source");
    });

    it("returns `null` for a file under `docs/history/`", () => {
      expect(governedKind("docs/history/plans/rehearsal.md")).toBe(null);
    });

    it("returns `null` for a file of another kind", () => {
      expect(governedKind("deno.jsonc")).toBe(null);
      expect(governedKind("packages/cli/README.txt")).toBe(null);
    });
  });

  describe("proseOf()", () => {
    it("keeps a comment and blanks the code around it", () => {
      const comment = `${LINE_OPENER} \`/tracker/items\` is the address.`;
      const source = [
        'const target = "/@bakery/glaze-tracker";',
        comment,
      ].join("\n");
      const prose = proseOf(source);

      expect(prose).toContain(comment);
      expect(prose).not.toContain("glaze-tracker");
    });

    it("blanks a template literal", () => {
      // A program building an address is the business of the tests that run
      // it, and a template literal holds backticks of its own.

      const source = "const url = `/@${space}/top/42`;";

      expect(proseOf(source).trim()).toBe("");
    });

    it("leaves every character at the offset the file gave it", () => {
      const source = ["const a = 1;", "const b = 2;", `${LINE_OPENER} note`]
        .join("\n");

      expect(proseOf(source).split("\n")[2]).toBe(`${LINE_OPENER} note`);
      expect(proseOf(source).length).toBe(source.length);
    });

    it("keeps a comment that follows a regular expression holding a quote", () => {
      // The quote inside `/"/` is not a string opening, and nothing here reads
      // it as one: a match can only start at a comment opener, so the comment
      // after it reaches the scan whole.

      const comment =
        `${LINE_OPENER} Use \`/@bakery/glaze-tracker\` and say "done".`;
      const source = `const quoted = /"/; ${comment}\n`;

      expect(proseOf(source)).toContain(comment);
    });

    it("keeps a comment that follows a regular expression holding a backtick", () => {
      const comment = `${LINE_OPENER} Read \`/@bakery/glaze-tracker\`.`;
      const source = "const pattern = /`/;\n" + comment + "\n";

      expect(proseOf(source)).toContain(comment);
    });

    it("keeps a comment in full past a block closer opened inside a literal", () => {
      // A stray `/*` opens a region that ends at the first closer after it,
      // which can fall inside a later comment. The comment's own opener
      // contributes a region of its own, so all of it is kept either way.

      const comment = `${LINE_OPENER} Read \`/@bakery/glaze-tracker\` ${
        "*" + "/"
      } on.`;
      const source = `const glob = "${BLOCK_OPENER}";\n${comment}\n`;

      expect(proseOf(source)).toContain(comment);
    });

    it("stops an unclosed block opener at the end of its line", () => {
      // A block comment always has a closer, so an opener without one is prose
      // or a literal. Reading it to the end of the file would put everything
      // under a comment that names those two characters into prose.

      const source = `${LINE_OPENER} the ${BLOCK_OPENER} characters\n` +
        "const url = `/x/y`;\n";

      expect(proseOf(source)).not.toContain("`/x/y`");
    });

    it("reads a comment opener inside a string as opening a comment", () => {
      // The stated cost of recognizing openers and nothing else: code after a
      // `//` in a literal is read as prose. It can add a candidate and can
      // never take one away, which is the direction this check needs.

      const source =
        `const separator = "${LINE_OPENER}"; const url = \`/x/y\`;`;

      expect(proseOf(source)).toContain("`/x/y`");
    });
  });

  describe("codeSpans()", () => {
    it("returns the content between a backtick and the next one", () => {
      expect([...codeSpans("Read `/tracker/items` now.")].map((s) => s.content))
        .toEqual(["/tracker/items"]);
    });

    it("returns the offset of the opening backtick", () => {
      expect([...codeSpans("ab `/x/y`")][0].at).toBe(3);
    });

    it("returns a span after an unpaired backtick", () => {
      // Pairing each backtick with the next makes every span after an odd one
      // read as ending somewhere it does not. A span here opens at a backtick
      // followed by `/` and closes at the next, so one stray backtick shifts
      // nothing.

      const spans = [...codeSpans("a ` b `/tracker/items` c")];

      expect(spans.map((s) => s.content)).toEqual(["/tracker/items"]);
    });

    it("returns nothing for a span that is not rooted or holds whitespace", () => {
      expect([...codeSpans("`items/0` and `cf get /tracker`")]).toEqual([]);
    });

    it("returns a span the author wrapped across a line break", () => {
      expect([...codeSpans("`/@bakery/glaze-\ntracker/items`")][0].content)
        .toBe("/@bakery/glaze-\ntracker/items");
      expect([...codeSpans("`/@bakery/glaze-\n * tracker/items`")][0].content)
        .toBe("/@bakery/glaze-\n * tracker/items");
    });
  });

  describe("addressExample()", () => {
    it("returns a rooted token naming two segments", () => {
      expect(addressExample("/tracker/items")).toBe("/tracker/items");
      expect(addressExample("//bakery/glaze-tracker")).toBe(
        "//bakery/glaze-tracker",
      );
    });

    it("returns `null` for a token that is not rooted", () => {
      expect(addressExample("items/0/title")).toBe(null);
      expect(addressExample("./title")).toBe(null);
      expect(addressExample("packages/cli/lib/callable.ts")).toBe(null);
    });

    it("returns `null` for a span holding whitespace", () => {
      // Rooted, so it reaches the rule this pins rather than stopping at the
      // one above it. A span holding a space is a command line or a sentence.

      expect(addressExample("/tracker items/0")).toBe(null);
      expect(addressExample("cf cell get /tracker")).toBe(null);
    });

    it("returns `null` for a single-segment fragment", () => {
      expect(addressExample("//bakery/")).toBe(null);
      expect(addressExample("/Bytes@1")).toBe(null);
      expect(addressExample("//host")).toBe(null);
    });

    it("returns `null` for a string standing for several", () => {
      expect(addressExample("/<piece>[@<scope>][/<path>]")).toBe(null);
      expect(addressExample("//did:key:…/of:…@scope")).toBe(null);
      expect(addressExample("/@<space>/...")).toBe(null);
    });

    it("returns a placeholder token as written", () => {
      // A hole is judged as the string it is, which is the reading its author
      // means: a name-shaped hole in the space slot reads as a named space.

      expect(addressExample("/@<space>/top/42")).toBe("/@<space>/top/42");
    });

    it("returns a token an author wrapped across a line break", () => {
      expect(addressExample("//bakery/glaze-\ntracker/items")).toBe(
        "//bakery/glaze-tracker/items",
      );
      expect(addressExample("//bakery/glaze-\n * tracker/items")).toBe(
        "//bakery/glaze-tracker/items",
      );
    });
  });

  describe("exemptionKey()", () => {
    it("returns a key holding no control character", () => {
      // The key is built from data at run time, so what it holds is decided
      // by the entry rather than by this file. A key joined on a control
      // character puts one in a string nothing else would show: a NUL makes
      // `grep` skip a whole file, so a search for the problem reports clean.

      const control = String.fromCharCode(0);
      const key = exemptionKey(`docs/a${control}.md`, `/@x/y${control}`);

      expect([...key].some((character) => character.charCodeAt(0) < 0x20))
        .toBe(false);
    });

    it("returns different keys where a bare join would agree", () => {
      expect(exemptionKey("ab", "/c/d")).not.toBe(exemptionKey("a", "b/c/d"));
    });

    it("returns the same key for the same pair", () => {
      expect(exemptionKey("docs/a.md", "/@x/y"))
        .toBe(exemptionKey("docs/a.md", "/@x/y"));
    });
  });

  describe("refusalMessage()", () => {
    it("returns the message of an `Error`", () => {
      expect(refusalMessage(new Error("the prefix is retired")))
        .toBe("the prefix is retired");
    });

    it("returns a value of another kind whole", () => {
      // Reaching into such a value for a `message` would put `undefined` in
      // the report, which says less than the value does.

      expect(refusalMessage("refused")).toBe("refused");
      expect(refusalMessage(undefined)).toBe("undefined");
    });
  });

  describe("collectFindings()", () => {
    it("returns nothing for an address the parser reads", () => {
      const documents = markdown(
        "Read `//bakery/glaze-tracker/items/0/title`, or `/tracker@user`.\n",
      );

      expect(collectFindings(documents, [])).toEqual([]);
    });

    it("returns the file, the line, the string, and what the parser said", () => {
      const documents = markdown(
        "One.\nTwo.\nWrite `/@bakery/glaze-tracker` to reach it.\n",
      );
      const findings = collectFindings(documents, []);

      expect(findings.length).toBe(1);
      expect(findings[0].file).toBe("doc.md");
      expect(findings[0].line).toBe(3);
      expect(findings[0].example).toBe("/@bakery/glaze-tracker");
      expect(findings[0].message).toContain("is retired");
    });

    it("returns a finding from a comment after a regular expression", () => {
      // A quote and a backtick inside a regular expression are not a string
      // and not a template. Where a scan took them for one, the comment after
      // was consumed with them and its address never reached the parser.

      const quoted = typescript(
        `const q = /"/; ${LINE_OPENER} Use \`/@bakery/glaze-tracker\` then "no".\n`,
      );
      const ticked = typescript(
        "const p = /`/;\n" +
          `${LINE_OPENER} Read \`/@bakery/glaze-tracker\`.\n`,
      );

      expect(collectFindings(quoted, []).length).toBe(1);
      expect(collectFindings(ticked, []).length).toBe(1);
    });

    it("returns a finding for an example split across a line break", () => {
      // A code span an author wrapped is one span, and a search that reads a
      // line at a time sees neither half of it.

      const documents = markdown(
        "Write `/@bakery/glaze-\ntracker/items` to reach it.\n",
      );
      const findings = collectFindings(documents, []);

      expect(findings.length).toBe(1);
      expect(findings[0].example).toBe("/@bakery/glaze-tracker/items");
      expect(findings[0].line).toBe(1);
    });

    it("returns findings in file and line order", () => {
      const documents: Document[] = [
        { path: "second.md", kind: "markdown", text: "`/@b/x/y`\n" },
        {
          path: "first.md",
          kind: "markdown",
          text: "One.\n`/@a/x/y`\n`/@c/x/y`\n",
        },
      ];

      expect(
        collectFindings(documents, []).map((finding) =>
          `${finding.file}:${finding.line}`
        ),
      ).toEqual(["first.md:2", "first.md:3", "second.md:1"]);
    });

    it("returns nothing for an example an entry names in that file", () => {
      const documents = markdown("Write `/@bakery/glaze-tracker` there.\n");
      const entry: Exemption = {
        file: "doc.md",
        example: "/@bakery/glaze-tracker",
        reason: "quoted as the form the parser refuses",
      };

      expect(collectFindings(documents, [entry])).toEqual([]);
    });

    it("returns a finding for an example an entry names in another file", () => {
      // An entry is about one file, since a string refused on purpose in one
      // document can be a defect in another. The entry below is then also
      // reported, since the file it names writes nothing.

      const documents = markdown("Write `/@bakery/glaze-tracker` there.\n");
      const entry: Exemption = {
        file: "other.md",
        example: "/@bakery/glaze-tracker",
        reason: "quoted as the form the parser refuses",
      };

      expect(collectFindings(documents, [entry]).map((f) => f.file))
        .toEqual(["doc.md", "other.md"]);
    });

    it("returns a finding for an entry whose file no longer writes it", () => {
      const documents = markdown("Nothing here writes it any more.\n");
      const entry: Exemption = {
        file: "doc.md",
        example: "/@bakery/glaze-tracker",
        reason: "quoted as the form the parser refuses",
      };
      const findings = collectFindings(documents, [entry]);

      expect(findings.length).toBe(1);
      expect(findings[0].line).toBeUndefined();
      expect(findings[0].message).toContain("no longer writes it");
    });

    it("returns a finding for an entry that gives no reason", () => {
      const documents = markdown("Write `/@bakery/glaze-tracker` there.\n");
      const entry: Exemption = {
        file: "doc.md",
        example: "/@bakery/glaze-tracker",
        reason: "   ",
      };

      expect(collectFindings(documents, [entry]).map((f) => f.message))
        .toEqual(["the entry in EXEMPTIONS gives no reason"]);
    });
  });

  describe("findingLocation()", () => {
    it("returns the file and the line where a finding has one", () => {
      expect(
        findingLocation({ file: "a.md", line: 7, example: "", message: "" }),
      )
        .toBe("a.md:7");
    });

    it("returns the file alone where it has none", () => {
      expect(findingLocation({ file: "a.md", example: "", message: "" }))
        .toBe("a.md");
    });
  });

  describe("main()", () => {
    it("returns 0 and names the count on a tree that reads", async () => {
      const root = await fixtureRepo({
        "docs/guide.md": "Read `//bakery/glaze-tracker/items`.\n",
      });
      try {
        let code = -1;
        const { out } = await captureConsole(async () => {
          code = await main(root, []);
        });

        expect(code).toBe(0);
        expect(out).toContain("Address examples OK (1 files)");
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("returns 1 and reports the finding and how to record it", async () => {
      const root = await fixtureRepo({
        "docs/guide.md": "One.\nRead `/@bakery/glaze-tracker`.\n",
      });
      try {
        let code = -1;
        const { err } = await captureConsole(async () => {
          code = await main(root, []);
        });

        expect(code).toBe(1);
        expect(err).toContain("docs/guide.md:2");
        expect(err).toContain("`/@bakery/glaze-tracker`");
        expect(err).toContain("is retired");
        expect(err).toContain("EXEMPTIONS in tasks/check-address-examples.ts");
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("reads a source comment and leaves the code around it alone", async () => {
      const root = await fixtureRepo({
        "src/render.ts": [
          `${LINE_OPENER} The header writes \`/@bakery/glaze-tracker\`.`,
          'export const prefix = "/@bakery/glaze-tracker";',
        ].join("\n"),
      });
      try {
        const findings = collectFindings(await readDocuments(root), []);

        expect(findings.map((finding) => finding.line)).toEqual([1]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("leaves a document under `docs/history/` alone", async () => {
      const root = await fixtureRepo({
        "docs/history/rehearsal.md": "Ran `/@graft-rehearsal/top/2`.\n",
      });
      try {
        expect(collectFindings(await readDocuments(root), [])).toEqual([]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });
  });

  describe("readDocuments()", () => {
    it("drops a file the working tree has lost", async () => {
      // git still holds it in the index, and reading it would fail. A gate
      // that read the index alone would open a path that is not there.

      const root = await fixtureRepo({
        "docs/guide.md": "Read `/tracker/items`.\n",
        "docs/kept.md": "Read `/tracker/other`.\n",
      });
      try {
        await Deno.remove(join(root, "docs/guide.md"));
        const documents = await readDocuments(root);

        expect(documents.map((document) => document.path))
          .toEqual(["docs/kept.md"]);
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("surfaces a git failure rather than reading nothing", async () => {
      // A directory git cannot answer for would otherwise scan as a tree with
      // no files in it, which is a gate that passes over nothing.

      const root = await Deno.makeTempDir({ prefix: "check-address-nogit-" });
      try {
        await expect(readDocuments(root)).rejects.toThrow(
          "git ls-files failed",
        );
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });
  });

  describe("the repository as it stands", () => {
    it("writes no address example the parser refuses", async () => {
      const documents = await readDocuments(REPO_ROOT);

      expect(documents.length).toBeGreaterThan(0);
      expect(
        collectFindings(documents, EXEMPTIONS).map((finding) =>
          `${
            findingLocation(finding)
          } \`${finding.example}\` ${finding.message}`
        ),
      ).toEqual([]);
    });

    it("holds every exemption to the file it names", async () => {
      // The list answers to the tree the way a document does. Running each
      // entry alone shows that every one of them is still load-bearing: an
      // entry whose file stopped writing its string reports here rather than
      // going quiet behind the others.

      const documents = await readDocuments(REPO_ROOT);
      const stale = EXEMPTIONS.filter((entry) =>
        collectFindings(documents, [entry]).some((finding) =>
          finding.file === entry.file && finding.example === entry.example &&
          finding.line === undefined
        )
      );

      expect(EXEMPTIONS.length).toBeGreaterThan(0);
      expect(stale.map((entry) => `${entry.file} ${entry.example}`))
        .toEqual([]);
    });

    it("gives every exemption a reason", () => {
      expect(
        EXEMPTIONS.filter((entry) => entry.reason.trim() === "")
          .map((entry) => entry.file),
      ).toEqual([]);
    });

    it("runs as a command under the permissions its task grants", async () => {
      // Importing the module can never show that the shebang and the
      // `deno.jsonc` task line grant the permissions the script needs.
      //
      // The child gets a throwaway lockfile, since a nested Deno command does
      // not inherit the test runner's lock flags and resolving its imports
      // must not write to the real `deno.lock`.

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
          join(REPO_ROOT, "tasks/check-address-examples.ts"),
        ],
      });
      const stderr = new TextDecoder().decode(output.stderr);

      expect(output.code, `check-address-examples exited non-zero:\n${stderr}`)
        .toBe(0);
      expect(new TextDecoder().decode(output.stdout)).toContain(
        "Address examples OK",
      );
    });
  });
});
