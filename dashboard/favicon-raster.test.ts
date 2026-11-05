import { assertEquals } from "@std/assert";
import { Resvg } from "@resvg/resvg-js";
import { faviconPng } from "./favicon.ts";
import { faviconSvg } from "./favicon-artwork.ts";
import { FAVICON_FACES } from "./favicon-types.ts";

Deno.test("embedded favicon PNGs exactly match their SVG artwork", () => {
  for (const status of FAVICON_FACES) {
    const rendered = new Uint8Array(
      new Resvg(faviconSvg(status), {
        font: { loadSystemFonts: false },
        fitTo: { mode: "width", value: 32 },
      }).render().asPng(),
    );
    assertEquals(
      rendered,
      new Uint8Array(faviconPng(status)),
      `${status} PNG matches its SVG source`,
    );
  }
});
