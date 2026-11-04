import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import {
  markdownTemplate,
  revealedText,
} from "../../../console/src/markdown.ts";
import { templateText } from "./template-text.ts";

const rendered = (
  source: string,
  revealed?: Readonly<Record<string, string>>,
): string => templateText(markdownTemplate(source, { revealed }));

describe("console/src/markdown", () => {
  describe("markdownTemplate()", () => {
    it("returns each character reference HTML defines as its character", () => {
      expect(
        rendered("a &amp; b &lt;c&gt; &#65;&#x42; &eacute;&mdash;&hellip;"),
      )
        .toContain("a & b <c> AB \u00e9\u2014\u2026");
    });

    it("returns a name HTML does not define, or one with no semicolon, as written, and an impossible code point as the replacement character", () => {
      expect(rendered("&notaname; &eacute &#0; &#xD800;")).toContain(
        "&notaname; &eacute \ufffd \ufffd",
      );
    });

    it("returns a web link as a link that opens apart from the console", () => {
      const text = rendered("[shop](https://shop.example/?a=1&amp;b=2)");

      expect(text).toContain('href="https://shop.example/?a=1&b=2"');
      expect(text).toContain('rel="noopener noreferrer"');
    });

    it("returns a script link as its label alone", () => {
      const text = rendered("[click](javascript:alert(1))");

      expect(text).toContain("click");
      expect(text).not.toContain("<a");
      expect(text).not.toContain("javascript:");
    });

    it("returns raw markup as nothing and an image as its description", () => {
      const text = rendered(
        '<img src="https://x.example/a.png" onerror="alert(1)">\n\n' +
          "![a red chair](https://x.example/chair.png)",
      );

      expect(text).toContain("a red chair");
      expect(text).not.toContain("<img");
      expect(text).not.toContain("x.example");
    });

    it("returns each block as its element, headings starting under the pane's own", () => {
      const text = rendered(
        [
          "# One",
          "## Two",
          "### Three",
          "#### Four",
          "",
          "> quoted",
          "",
          "- a",
          "- b",
          "",
          "---",
          "",
          "3. c",
          "4. d",
          "",
          "| x | y |",
          "| - | - |",
          "| 1 | 2 |",
        ].join("\n"),
      );

      for (
        const element of [
          "<h3>One</h3>",
          "<h4>Two</h4>",
          "<h5>Three</h5>",
          "<h6>Four</h6>",
          "<blockquote><p>quoted</p></blockquote>",
          "<ul><li>a</li><li>b</li></ul>",
          "<hr>",
          '<ol start="3"><li>c</li><li>d</li></ol>',
          "<th>x</th>",
          "<td>2</td>",
        ]
      ) {
        expect(text.replace(/\s+</g, "<").replace(/>\s+/g, ">")).toContain(
          element,
        );
      }
    });

    it("returns emphasis, a struck word, a hard break and an escape as they read", () => {
      const text = rendered("**bold** *em* ~~gone~~ a  \nb \\*not em\\*");

      expect(text).toContain("<strong>bold</strong>");
      expect(text).toContain("<em>em</em>");
      expect(text).toContain("<del>gone</del>");
      expect(text).toContain("a<br>b");
      expect(text).toContain("*not em*");
    });

    it("returns a code block as written, with each revealed return referent as its string", () => {
      const text = rendered("```\nopen cfh:v:22222 &amp;\n```", {
        "cfh:v:22222": "https://shop.example/",
      });

      expect(text).toContain(
        '<pre><code>open <bdi class="live-found" title=https://shop.example/><span class="live-found-badge">found</span>https://shop.example/</bdi> &amp;</code></pre>',
      );
    });

    it("returns a task list's boxes showing their state, and taking no input, in a tight list and a loose one", () => {
      for (
        const source of ["- [x] done\n- [ ] to do", "- [x] done\n\n- [ ] to do"]
      ) {
        const text = rendered(source);

        expect(text).toContain('<input type="checkbox" disabled checked>');
        expect(text).toContain('<input type="checkbox" disabled>');
      }
    });

    it("returns inline markup as nothing, keeping the words around it", () => {
      const text = rendered('a <b onclick="x()">bold</b> b');

      expect(text).toContain("a bold b");
      expect(text).not.toContain("<b");
      expect(text).not.toContain("onclick");
    });

    it("returns a link whose destination is not a URL as its label alone", () => {
      const text = rendered("[shop](https://[shop)");

      expect(text).toContain("shop");
      expect(text).not.toContain("<a");
    });

    it("returns a code span as written, character references included", () => {
      expect(rendered("`a &amp; b`")).toContain("<code>a &amp; b</code>");
    });

    it("returns each revealed return referent in the text as its string, marked as found", () => {
      const text = rendered("Bought **cfh:v:22222**; see cfh:v:33333.", {
        "cfh:v:22222": "https://shop.example/item/7",
      });

      expect(text).toContain(
        '<bdi class="live-found" title=https://shop.example/item/7><span class="live-found-badge">found</span>https://shop.example/item/7</bdi>',
      );
      expect(text).toContain("see cfh:v:33333.");
    });

    it("returns a link to a revealed return referent with its destination as written", () => {
      const text = rendered("[the item](cfh:v:22222)", {
        "cfh:v:22222": "https://shop.example/item/7",
      });

      expect(text).not.toContain("<a");
      expect(text).not.toContain("https://shop.example/item/7");
    });

    it("returns a revealed return referent in a link's label as its token", () => {
      const text = rendered("[cfh:v:22222](https://elsewhere.example/)", {
        "cfh:v:22222": "https://shop.example/item/7",
      });

      expect(text).toContain('href="https://elsewhere.example/"');
      expect(text).toContain("cfh:v:22222");
      expect(text).not.toContain("https://shop.example/item/7");
    });

    it("returns a link with the host it goes to beside its label, and a mail link as its label alone", () => {
      const text = rendered(
        "Open [your bank](https://phish.example/login) or [write](mailto:a@b.example).",
      );

      expect(text).toContain(">your bank</a>");
      expect(text).toContain(
        '<span class="live-link-host">(phish.example)</span>',
      );
      expect(text).toContain("write");
      expect(text).not.toContain("mailto:");
    });

    it("returns a found string on one line, cut short with the whole of it on hover, its control characters, separators and direction marks spelled out", () => {
      const text = rendered("Bought cfh:v:22222.", {
        "cfh:v:22222": `a\nb\u202Ec\u2028${"x".repeat(200)}`,
      });

      expect(text).toContain(
        `<bdi class="live-found" title=a\\nb\\u{202E}c\\u{2028}${
          "x".repeat(200)
        }><span class="live-found-badge">found</span>a\\nb\\u{202E}c\\u{2028}${
          "x".repeat(99)
        }…</bdi>`,
      );
      expect(text).not.toContain("\u202E");
      expect(text).not.toContain("\n");
    });
  });

  describe("revealedText()", () => {
    it("returns plain text with each revealed return referent as its string, marked as found", () => {
      const text = templateText(
        revealedText("Could not buy cfh:v:22222; see cfh:v:33333.", {
          "cfh:v:22222": "the blue one",
        }),
      );

      expect(text).toBe(
        'Could not buy <bdi class="live-found" title=the blue one><span class="live-found-badge">found</span>the blue one</bdi>; see cfh:v:33333.',
      );
    });
  });
});
