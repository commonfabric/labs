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
  });
});
