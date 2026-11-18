import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { guestDocument } from "../src/guest-document.ts";

describe("guest-document", () => {
  describe("guestDocument()", () => {
    const html = '<!doctype html><html><body><div id="root"></div></body>' +
      "</html>";

    it("returns the document unchanged given no script", () => {
      expect(guestDocument(html)).toBe(html);
      expect(guestDocument(html, "")).toBe(html);
    });

    it("returns an empty document without the script", () => {
      expect(guestDocument("", "console.log('glazed');")).toBe("");
    });

    it("returns the document with the script appended as an inline module", () => {
      expect(guestDocument(html, "console.log('glazed');")).toBe(
        `${html}<script type="module">console.log('glazed');</script>`,
      );
    });

    it("escapes every closing tag the script holds, in any case", () => {
      const document = guestDocument(
        html,
        'a = "</script>"; b = "</SCRIPT >";',
      );
      expect(document).toBe(
        `${html}<script type="module">a = "<\\/script>"; ` +
          `b = "<\\/SCRIPT >";</script>`,
      );
    });

    it("escapes every comment opener the script holds", () => {
      const document = guestDocument(html, 'a = "<!--<script>";');
      expect(document).toBe(
        `${html}<script type="module">a = "<\\x21--<script>";</script>`,
      );
    });

    it("escapes the script into text that computes what the original does", () => {
      const script = 'x = "</script><!--<script>" + `</Script>` + ' +
        '/^<!--$/u.test("<!--");';
      const escaped = guestDocument("<p></p>", script).slice(
        '<p></p><script type="module">'.length,
        -"</script>".length,
      );
      const read = (source: string) =>
        new Function(`let x; ${source} return x;`)();
      expect(read(escaped)).toBe(read(script));
    });

    describe("with assets", () => {
      const GLAZE = "data:image/png;base64,iVBORw0KGgo=";
      const MENU = "data:font/woff2;base64,d09GMg==";
      const ASSETS = { glaze: GLAZE, menu: MENU };
      const RECORD = '<script type="application/json" data-cf-assets>' +
        `{"glaze":"${GLAZE}","menu":"${MENU}"}</script>`;

      it("replaces each reference in the document with its asset's URL", () => {
        const document = guestDocument(
          '<img src="cf-asset:glaze"><style>p { font: url(cf-asset:menu); }' +
            "</style>",
          undefined,
          ASSETS,
        );
        expect(document).toBe(
          `${RECORD}<img src="${GLAZE}">` +
            `<style>p { font: url(${MENU}); }</style>`,
        );
      });

      it("leaves a reference to a name the assets lack in place", () => {
        expect(guestDocument('<img src="cf-asset:logo">', undefined, ASSETS))
          .toBe(`${RECORD}<img src="cf-asset:logo">`);
      });

      it("searches the document and not the script", () => {
        const document = guestDocument(
          "<p>cf-asset:glaze</p>",
          'image.src = "cf-asset:glaze";',
          ASSETS,
        );
        expect(document).toBe(
          `${RECORD}<p>${GLAZE}</p>` +
            '<script type="module">image.src = "cf-asset:glaze";</script>',
        );
      });

      it("writes the record right after the doctype, ahead of every script", () => {
        const document = guestDocument(
          '<!DOCTYPE html>\n<html lang="en"><head><script>go();</script>' +
            "</head></html>",
          "run();",
          ASSETS,
        );
        expect(document).toBe(
          `<!DOCTYPE html>${RECORD}\n<html lang="en"><head>` +
            "<script>go();</script></head></html>" +
            '<script type="module">run();</script>',
        );
      });

      it("writes the record after the whitespace and comments ahead of a doctype", () => {
        const document = guestDocument(
          "\n<!-- <!doctype x> --> <!doctype html><p></p>",
          undefined,
          ASSETS,
        );
        expect(document).toBe(
          `\n<!-- <!doctype x> --> <!doctype html>${RECORD}<p></p>`,
        );
      });

      it("writes the record after a byte order mark ahead of the doctype", () => {
        expect(guestDocument("\ufeff<!doctype html><p></p>", undefined, ASSETS))
          .toBe(`\ufeff<!doctype html>${RECORD}<p></p>`);
      });

      it("finds no doctype after many comments in time linear in their number", () => {
        // Each comment ends at its first `-->`; a scan that let one stretch
        // across a later `-->` would try exponentially many ways to split
        // them before giving up.

        const comments = "<!-- a --><!-- b -->".repeat(2000);

        expect(guestDocument(`${comments}<p></p>`, undefined, ASSETS)).toBe(
          `${RECORD}${comments}<p></p>`,
        );
      });

      it("writes the record after the byte order mark of a document with no doctype", () => {
        expect(guestDocument("\ufeff<p>plain</p>", undefined, ASSETS))
          .toBe(`\ufeff${RECORD}<p>plain</p>`);
      });

      it("writes the record at the start of a document with no doctype", () => {
        expect(guestDocument("<p>plain</p><!doctype html>", undefined, ASSETS))
          .toBe(`${RECORD}<p>plain</p><!doctype html>`);
      });

      it("writes the record as JSON that reads back as the assets", () => {
        const document = guestDocument("<p></p>", undefined, ASSETS);
        const text = document.slice(
          document.indexOf(">") + 1,
          document.indexOf("</script>"),
        );
        expect(JSON.parse(text)).toEqual(ASSETS);
      });

      it("escapes every `<` in the record", () => {
        const document = guestDocument("<p></p>", undefined, {
          glaze: "</script><!--",
        });
        expect(document).toBe(
          '<script type="application/json" data-cf-assets>' +
            '{"glaze":"\\u003c/script>\\u003c!--"}</script><p></p>',
        );
      });

      it("writes no record for no assets", () => {
        expect(guestDocument("<p>cf-asset:glaze</p>", undefined, {})).toBe(
          "<p>cf-asset:glaze</p>",
        );
      });

      it("returns an empty document empty", () => {
        expect(guestDocument("", "go();", ASSETS)).toBe("");
      });
    });
  });
});
