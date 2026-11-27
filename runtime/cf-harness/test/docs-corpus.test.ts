/**
 * The documentation corpus `research` inspects: how a Markdown file
 * becomes addressable sections, which sections a question reaches, and the
 * endorsement that says a section is operator-provisioned reference material.
 */

import { expect } from "@std/expect";
import { join } from "@std/path";

import {
  CFC_HARNESS_ATOM_CLASS,
  citationOfSection,
  isOperatorProvisionedReferenceAtom,
  operatorProvisionedReferenceAtom,
} from "../src/contracts/docs-corpus.ts";
import {
  checkoutDocsCorpusRoots,
  checkoutDocsCorpusRootsFrom,
  loadHarnessDocsCorpus,
  MAX_CORPUS_BYTES,
  MAX_CORPUS_FILE_BYTES,
  readAtMost,
  resolveHarnessDocsCorpus,
} from "../src/docs-corpus/corpus.ts";
import {
  rankSections,
  splitMarkdownSections,
} from "../src/docs-corpus/sections.ts";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

const document = {
  path: "docs/example.md",
  integrity: [operatorProvisionedReferenceAtom("/host/docs")],
};

describe("docs-corpus", () => {
  describe("citationOfSection()", () => {
    it("returns the section's path and heading and none of its text", () => {
      expect(citationOfSection({
        path: "labs/docs/glazing.md",
        heading: "Glazing",
        documentTitle: "Pottery",
        headingPath: ["Pottery", "Glazing"],
        text: "Dip once.",
        integrity: [],
      })).toEqual({ path: "labs/docs/glazing.md", heading: "Glazing" });
    });
  });

  describe("splitMarkdownSections()", () => {
    it("returns one section per heading", () => {
      const sections = splitMarkdownSections(
        document,
        "# Title\n\nOpening.\n\n## Glazing\n\nDip once.\n",
      );

      expect(sections.map((section) => section.heading)).toEqual([
        "Title",
        "Glazing",
      ]);
      expect(sections[1].text).toBe("Dip once.");
    });

    it("returns the text above the first heading under an empty heading", () => {
      const sections = splitMarkdownSections(
        document,
        "Preamble about fryers.\n\n# Title\n\nBody.\n",
      );

      expect(sections[0].heading).toBe("");
      expect(sections[0].text).toBe("Preamble about fryers.");
    });

    it("returns a fenced `#` line as part of its own section", () => {
      const sections = splitMarkdownSections(
        document,
        "# Title\n\n```sh\n# not a heading\nfry\n```\n",
      );

      expect(sections).toHaveLength(1);
      expect(sections[0].text).toContain("# not a heading");
    });

    it("returns a tilde-fenced `#` line as part of its own section", () => {
      const sections = splitMarkdownSections(
        document,
        "# Title\n\n~~~sh\n# not a heading\nfry\n~~~\n",
      );

      expect(sections).toHaveLength(1);
      expect(sections[0].text).toContain("# not a heading");
    });

    it("retains section text beyond 4,000 characters", () => {
      const marker = "complete example after the former boundary";
      const sections = splitMarkdownSections(
        document,
        `# Long contract\n\n${"prefix ".repeat(700)}${marker}\n`,
      );

      expect(sections[0].text.length).toBeGreaterThan(4_000);
      expect(sections[0].text).toContain(marker);
    });
  });

  describe("rankSections()", () => {
    it("returns nothing when the question contains only stop words", () => {
      const sections = splitMarkdownSections(
        document,
        "# Guide\nUse the guide.",
      );

      expect(rankSections(sections, "how should you use this")).toEqual([]);
    });
  });

  describe("readAtMost()", () => {
    /**
     * A reader over `text` that hands out at most `chunk` bytes per read, and
     * reports how many bytes it has handed out.
     */
    const chunkedReader = (text: string, chunk: number) => {
      const source = new TextEncoder().encode(text);
      let position = 0;
      return {
        get position() {
          return position;
        },
        read(into: Uint8Array): Promise<number | null> {
          if (position === source.length) {
            return Promise.resolve(null);
          }
          const piece = source.subarray(
            position,
            position + Math.min(chunk, into.length),
          );
          into.set(piece);
          position += piece.length;
          return Promise.resolve(piece.length);
        },
      };
    };
    const decode = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

    it("returns every byte of a reader that ends before the size, as a file that shrank does", async () => {
      const reader = chunkedReader("Dip once.", 4);

      const bytes = await readAtMost(reader, 20);

      expect(decode(bytes)).toBe("Dip once.");
      expect(bytes.length).toBe(9);
    });

    it("returns the first size bytes of a reader holding more, without reading past them", async () => {
      const reader = chunkedReader("Dip once. Then fire.", 4);

      const bytes = await readAtMost(reader, 9);

      expect(decode(bytes)).toBe("Dip once.");
      expect(reader.position).toBe(9);
    });
  });

  describe("loadHarnessDocsCorpus()", () => {
    let root: string;

    beforeEach(async () => {
      root = await Deno.makeTempDir({ prefix: "cf-harness-docs-corpus-" });
      await Deno.mkdir(join(root, "guides"));
      await Deno.writeTextFile(
        join(root, "guides", "glazing.md"),
        "# Glazing\n\nDip once.\n",
      );
      await Deno.writeTextFile(join(root, "notes.txt"), "not markdown");
    });

    afterEach(async () => {
      await Deno.remove(root, { recursive: true });
    });

    it("stamps the operator-provisioned endorsement on every section", async () => {
      const corpus = await loadHarnessDocsCorpus([root]);

      expect(corpus.sections).toHaveLength(1);
      expect(corpus.sections[0].integrity[0].class).toBe(
        CFC_HARNESS_ATOM_CLASS.OperatorProvisionedReference,
      );
      expect(corpus.sections[0].integrity[0].subject).toBe(root);
      expect(
        corpus.sections.every((section) =>
          section.integrity.some(isOperatorProvisionedReferenceAtom)
        ),
      ).toBe(true);
    });

    it("returns a corpus path opening with the root's name", async () => {
      const corpus = await loadHarnessDocsCorpus([root]);

      expect(corpus.sections[0].path).toBe(
        `${corpus.roots[0].name}/guides/glazing.md`,
      );
    });

    it("returns nothing for a file that is not Markdown", async () => {
      const corpus = await loadHarnessDocsCorpus([root]);

      expect(corpus.files).toBe(1);
      expect(
        corpus.sections.some((section) => section.path.endsWith("notes.txt")),
      ).toBe(false);
    });

    it("returns nothing read through a symlink planted under the root", async () => {
      const outside = await Deno.makeTempDir({ prefix: "cf-harness-outside-" });
      try {
        await Deno.writeTextFile(
          join(outside, "smuggled.md"),
          "# Smuggled\n\nWritten elsewhere.\n",
        );
        await Deno.symlink(
          join(outside, "smuggled.md"),
          join(root, "smuggled.md"),
        );
        const corpus = await loadHarnessDocsCorpus([root]);

        expect(
          corpus.sections.some((section) => section.heading === "Smuggled"),
        ).toBe(false);
      } finally {
        await Deno.remove(outside, { recursive: true });
      }
    });

    it("returns distinct names for two roots sharing a basename", async () => {
      const sibling = join(root, "guides");
      const corpus = await loadHarnessDocsCorpus([sibling, sibling]);

      expect(corpus.roots.map((entry) => entry.name)).toEqual([
        "guides",
        "guides-2",
      ]);
    });

    it("returns the sections of a root that is itself a Markdown file", async () => {
      const file = join(root, "guides", "glazing.md");
      const corpus = await loadHarnessDocsCorpus([file]);

      expect(corpus.files).toBe(1);
      expect(corpus.sections.map((section) => section.path)).toEqual([
        corpus.roots[0].name,
      ]);
      expect(corpus.sections[0].heading).toBe("Glazing");
    });

    it("returns nothing for a root that is a file but not Markdown", async () => {
      const corpus = await loadHarnessDocsCorpus([join(root, "notes.txt")]);

      expect(corpus.files).toBe(0);
      expect(corpus.sections).toEqual([]);
    });

    it("throws for a root that cannot be examined for a reason other than absence", async () => {
      // A path through a regular file fails as not-a-directory, which is a
      // misconfiguration to report rather than a tree this host lacks.
      await expect(
        loadHarnessDocsCorpus([join(root, "notes.txt", "inner")]),
      ).rejects.toThrow(Deno.errors.NotADirectory);
    });

    it("returns the corpus as truncated, without the file that would exceed the byte budget", async () => {
      const corpus = await loadHarnessDocsCorpus([root]);
      expect(corpus.truncated).toBe(false);

      // Each file is as large as one document may be, so the budget admits
      // whole files until the next would carry it past the limit.
      const admitted = Math.floor(MAX_CORPUS_BYTES / MAX_CORPUS_FILE_BYTES);
      const large = join(root, "large");
      await Deno.mkdir(large);
      const heading = "# Large\n\n";
      const body = heading +
        "x".repeat(MAX_CORPUS_FILE_BYTES - heading.length);
      for (let index = 0; index <= admitted; index += 1) {
        await Deno.writeTextFile(
          join(large, `${String(index).padStart(3, "0")}.md`),
          body,
        );
      }

      const full = await loadHarnessDocsCorpus([large]);

      expect(new TextEncoder().encode(body).length).toBe(
        MAX_CORPUS_FILE_BYTES,
      );
      expect(full.truncated).toBe(true);
      expect(full.files).toBe(admitted);
    });

    it("leaves out a document one byte over the per-file limit, without truncating the corpus", async () => {
      const oversize = join(root, "oversize");
      await Deno.mkdir(oversize);
      const heading = "# Big\n\n";
      await Deno.writeTextFile(
        join(oversize, "big.md"),
        heading + "x".repeat(MAX_CORPUS_FILE_BYTES + 1 - heading.length),
      );
      await Deno.writeTextFile(
        join(oversize, "small.md"),
        "# Small\n\nKept.\n",
      );

      const corpus = await loadHarnessDocsCorpus([oversize]);

      expect(corpus.files).toBe(1);
      expect(corpus.truncated).toBe(false);
      expect(corpus.sections.map((section) => section.path)).not.toContain(
        "oversize/big.md",
      );
    });

    it("returns an empty corpus for a root this host does not carry", async () => {
      const corpus = await loadHarnessDocsCorpus([join(root, "absent")]);

      expect(corpus.sections).toEqual([]);
      expect(corpus.files).toBe(0);
    });
  });

  describe("resolveHarnessDocsCorpus()", () => {
    it("returns the configured record unchanged", () => {
      const configured = {
        type: "cf-harness.docs-corpus-record" as const,
        source: "configured" as const,
        roots: ["/host/reference"],
      };

      expect(resolveHarnessDocsCorpus(configured)).toBe(configured);
    });

    it("returns the checkout trees when nothing was configured", () => {
      const resolved = resolveHarnessDocsCorpus();

      expect(resolved?.source).toBe("checkout-default");
      expect(resolved?.roots).toEqual(checkoutDocsCorpusRoots());
    });
  });

  describe("checkoutDocsCorpusRoots()", () => {
    it("returns the reference trees of the checkout it runs out of", () => {
      const roots = checkoutDocsCorpusRoots();

      expect(roots).toHaveLength(3);
      expect(roots[0].endsWith(join("docs", "common"))).toBe(true);
      expect(roots[1].endsWith(join("docs", "development"))).toBe(true);
      expect(roots[2].endsWith("skills")).toBe(true);
      for (const root of roots) {
        expect(Deno.statSync(root).isDirectory).toBe(true);
      }
    });

    it("returns nothing for a module that is not addressed by a file URL", () => {
      expect(checkoutDocsCorpusRootsFrom("https://example.test/corpus.ts"))
        .toEqual([]);
    });

    it("returns nothing for a module URL that does not parse", () => {
      expect(checkoutDocsCorpusRootsFrom("not a url")).toEqual([]);
    });
  });
});
