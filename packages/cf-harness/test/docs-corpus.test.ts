/**
 * The documentation corpus `research` inspects: how a Markdown file
 * becomes addressable sections, which sections a question reaches, and the
 * endorsement that says a section is operator-provisioned reference material.
 */

import { expect } from "@std/expect";
import { join } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import {
  CFC_HARNESS_ATOM_CLASS,
  isOperatorProvisionedReferenceAtom,
  operatorProvisionedReferenceAtom,
} from "../src/contracts/docs-corpus.ts";
import {
  checkoutDocsCorpusRoots,
  checkoutDocsCorpusRootsFrom,
  loadHarnessDocsCorpus,
  resolveHarnessDocsCorpus,
} from "../src/docs-corpus/corpus.ts";
import {
  rankSections,
  splitMarkdownSections,
} from "../src/docs-corpus/sections.ts";

const document = {
  path: "docs/example.md",
  integrity: [operatorProvisionedReferenceAtom("/host/docs")],
};

describe("docs-corpus", () => {
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
