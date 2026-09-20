import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, fromFileUrl, join } from "@std/path";

import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";

import {
  addressExample,
  codeSpans,
  collectFindings,
  commentsOf,
  type Document,
  exemptions,
  governedKind,
  main,
  readDocuments,
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
 * `commentsOf` reads a comment opener wherever it sits, a string literal
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

  describe("commentsOf()", () => {
    it("keeps a comment and blanks the code around it", () => {
      const comment = `${LINE_OPENER} \`/tracker/items\` is the address.`;
      const source = [
        'const target = "/@bakery/glaze-tracker";',
        comment,
      ].join("\n");
      const prose = commentsOf(source);

      expect(prose).toContain(comment);
      expect(prose).not.toContain("glaze-tracker");
    });

    it("blanks a template literal", () => {
      // A program building an address is the business of the tests that run
      // it, and a template literal holds backticks of its own.

      const source = "const url = `/@${space}/top/42`;";

      expect(commentsOf(source).trim()).toBe("");
    });

    it("leaves every character at the offset the file gave it", () => {
      const source = ["const a = 1;", "const b = 2;", `${LINE_OPENER} note`]
        .join("\n");

      expect(commentsOf(source).split("\n")[2]).toBe(`${LINE_OPENER} note`);
      expect(commentsOf(source).length).toBe(source.length);
    });

    it("keeps a comment that follows a regular expression holding a quote", () => {
      // The quote inside `/"/` is not a string opening, and nothing here reads
      // it as one: a match can only start at a comment opener, so the comment
      // after it reaches the scan whole.

      const comment =
        `${LINE_OPENER} Use \`/@bakery/glaze-tracker\` and say "done".`;
      const source = `const quoted = /"/; ${comment}\n`;

      expect(commentsOf(source)).toContain(comment);
    });

    it("keeps a comment that follows a regular expression holding a backtick", () => {
      const comment = `${LINE_OPENER} Read \`/@bakery/glaze-tracker\`.`;
      const source = "const pattern = /`/;\n" + comment + "\n";

      expect(commentsOf(source)).toContain(comment);
    });

    it("keeps a comment in full past a block closer opened inside a literal", () => {
      // A stray `/*` opens a region that ends at the first closer after it,
      // which can fall inside a later comment. The comment's own opener
      // contributes a region of its own, so all of it is kept either way.

      const comment = `${LINE_OPENER} Read \`/@bakery/glaze-tracker\` ${
        "*" + "/"
      } on.`;
      const source = `const glob = "${BLOCK_OPENER}";\n${comment}\n`;

      expect(commentsOf(source)).toContain(comment);
    });

    it("stops an unclosed block opener at the end of its line", () => {
      // A block comment always has a closer, so an opener without one is prose
      // or a literal. Reading it to the end of the file would put everything
      // under a comment that names those two characters into prose.

      const source = `${LINE_OPENER} the ${BLOCK_OPENER} characters\n` +
        "const url = `/x/y`;\n";

      expect(commentsOf(source)).not.toContain("`/x/y`");
    });

    it("reads a comment opener inside a string as opening a comment", () => {
      // The stated cost of recognizing openers and nothing else: code after a
      // `//` in a literal is read as prose. It can add a candidate and can
      // never take one away, which is the direction this check needs.

      const source =
        `const separator = "${LINE_OPENER}"; const url = \`/x/y\`;`;

      expect(commentsOf(source)).toContain("`/x/y`");
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

  describe("exemptions()", () => {
    it("returns the string a Markdown directive names, with its reason", () => {
      const found = exemptions(
        "<!-- check-address-examples-ignore: /@bakery/tracker quoted as " +
          "refused -->\n",
      );

      expect([...found.keys()]).toEqual(["/@bakery/tracker"]);
      expect(found.get("/@bakery/tracker")?.reason).toBe("quoted as refused");
      expect(found.get("/@bakery/tracker")?.line).toBe(1);
    });

    it("returns the string a source directive names", () => {
      const found = exemptions(
        `${LINE_OPENER} line one\n${LINE_OPENER} ` +
          "check-address-examples-ignore: /@bakery/tracker why\n",
      );

      expect(found.get("/@bakery/tracker")?.reason).toBe("why");
      expect(found.get("/@bakery/tracker")?.line).toBe(2);
    });

    it("returns an empty reason for a directive that gives none", () => {
      const found = exemptions(
        "<!-- check-address-examples-ignore: /@bakery/tracker -->\n",
      );

      expect(found.get("/@bakery/tracker")?.reason).toBe("");
    });

    it("returns nothing for the directive's own form written out", () => {
      // The string a directive names begins with `/`, which is what lets the
      // check spell its own form out without exempting anything.

      expect(
        exemptions("check-address-examples-ignore: <the string> <why>\n").size,
      ).toBe(0);
    });
  });

  describe("collectFindings()", () => {
    it("returns nothing for an address the parser reads", () => {
      const documents = markdown(
        "Read `//bakery/glaze-tracker/items/0/title`, or `/tracker@user`.\n",
      );

      expect(collectFindings(documents)).toEqual([]);
    });

    it("returns the file, the line, the string, and what the parser said", () => {
      const documents = markdown(
        "One.\nTwo.\nWrite `/@bakery/glaze-tracker` to reach it.\n",
      );
      const findings = collectFindings(documents);

      expect(findings.length).toBe(1);
      expect(findings[0].file).toBe("doc.md");
      expect(findings[0].line).toBe(3);
      expect(findings[0].example).toBe("/@bakery/glaze-tracker");
      expect(findings[0].message).toContain("is retired");
    });

    it("returns nothing for an example a directive names", () => {
      const documents = markdown(
        "<!-- check-address-examples-ignore: /@bakery/glaze-tracker the " +
          "table quotes what the parser refuses -->\n\n" +
          "| `/@bakery/glaze-tracker` | a name-shaped `@` space |\n",
      );

      expect(collectFindings(documents)).toEqual([]);
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

      expect(collectFindings(quoted).length).toBe(1);
      expect(collectFindings(ticked).length).toBe(1);
    });

    it("returns a finding past a directive a string literal carries", () => {
      // An exemption is something a writer states, so it is read from the file
      // rather than from the prose read out of it. Blanking code to spaces
      // leaves an opener inside a literal looking like one at the head of a
      // line, and the file still tells the two apart.

      const documents = typescript(
        `const note = "${LINE_OPENER} check-address-examples-ignore: ` +
          `/@bakery/glaze-tracker string data";\n` +
          `${LINE_OPENER} Use \`/@bakery/glaze-tracker\`.\n`,
      );

      expect(collectFindings(documents).length).toBe(1);
    });

    it("returns a finding past a directive named in a sentence", () => {
      // A directive opens its own line, so prose about one is prose.

      const documents = typescript(
        `${LINE_OPENER} It is spelled check-address-examples-ignore: /@bakery/x/y here.\n` +
          `${LINE_OPENER} Use \`/@bakery/x/y\`.\n`,
      );

      expect(collectFindings(documents).length).toBe(1);
    });

    it("returns nothing for a directive a comment opens its line with", () => {
      const inLine = typescript(
        `${LINE_OPENER} check-address-examples-ignore: /@bakery/glaze-tracker quoted as refused\n` +
          `${LINE_OPENER} Use \`/@bakery/glaze-tracker\`.\n`,
      );
      const inBlock = typescript(
        `${BLOCK_OPENER}*\n * check-address-examples-ignore: /@bakery/glaze-tracker quoted as ` +
          `refused\n ${"*" + "/"}\n` +
          `${LINE_OPENER} Use \`/@bakery/glaze-tracker\`.\n`,
      );

      expect(collectFindings(inLine)).toEqual([]);
      expect(collectFindings(inBlock)).toEqual([]);
    });

    it("returns a finding for an example split across a line break", () => {
      // A code span an author wrapped is one span, and a search that reads a
      // line at a time sees neither half of it.

      const documents = markdown(
        "Write `/@bakery/glaze-\ntracker/items` to reach it.\n",
      );
      const findings = collectFindings(documents);

      expect(findings.length).toBe(1);
      expect(findings[0].example).toBe("/@bakery/glaze-tracker/items");
      expect(findings[0].line).toBe(1);
    });

    it("returns a finding for a directive that gives no reason", () => {
      const documents = markdown(
        "<!-- check-address-examples-ignore: /@bakery/glaze-tracker -->\n\n" +
          "`/@bakery/glaze-tracker`\n",
      );
      const findings = collectFindings(documents);

      expect(findings.map((finding) => finding.message)).toEqual([
        "the directive gives no reason for the exemption",
      ]);
    });

    it("returns a finding for a directive no example in the file uses", () => {
      const documents = markdown(
        "<!-- check-address-examples-ignore: /@bakery/glaze-tracker quoted " +
          "as refused -->\n\nNothing here writes it any more.\n",
      );
      const findings = collectFindings(documents);

      expect(findings.map((finding) => finding.message)).toEqual([
        "no address example in this file is written this way",
      ]);
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
        collectFindings(documents).map((finding) =>
          `${finding.file}:${finding.line}`
        ),
      ).toEqual(["first.md:2", "first.md:3", "second.md:1"]);
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
          code = await main(root);
        });

        expect(code).toBe(0);
        expect(out).toContain("Address examples OK (1 files)");
      } finally {
        await Deno.remove(root, { recursive: true });
      }
    });

    it("returns 1 and reports the finding and the directive", async () => {
      const root = await fixtureRepo({
        "docs/guide.md": "One.\nRead `/@bakery/glaze-tracker`.\n",
      });
      try {
        let code = -1;
        const { err } = await captureConsole(async () => {
          code = await main(root);
        });

        expect(code).toBe(1);
        expect(err).toContain("docs/guide.md:2");
        expect(err).toContain("`/@bakery/glaze-tracker`");
        expect(err).toContain("is retired");
        expect(err).toContain("check-address-examples-ignore:");
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
        const findings = collectFindings(await readDocuments(root));

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
        expect(collectFindings(await readDocuments(root))).toEqual([]);
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
        collectFindings(documents).map((finding) =>
          `${finding.file}:${finding.line} \`${finding.example}\` ${finding.message}`
        ),
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
