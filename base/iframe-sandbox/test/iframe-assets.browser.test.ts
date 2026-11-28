import { expect } from "@std/expect";

import "../src/common-iframe-sandbox.ts";
import {
  cleanupFixtures,
  ContextShim,
  render,
  waitForContextValue,
} from "./utils.ts";
import { test } from "@commonfabric/test-support/test";

// A guest reports what it found by writing it to the `result` cell, and
// writes something whatever happens, an error included, so a case that fails
// says why rather than waiting.

/** A one-pixel PNG, as base64. */
const PIXEL_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
const PIXEL = `data:image/png;base64,${PIXEL_BASE64}`;

test("reads an asset with `fabric.asset()`: its URL, its bytes, an image and a bitmap of it", async () => {
  cleanupFixtures();
  try {
    const context = new ContextShim({ result: null });
    const script = `
import { connectFabric } from "/guest.js";
const fabric = connectFabric();
let result;
try {
  const pixel = fabric.asset("pixel");
  const image = await pixel.image();
  const bitmap = await pixel.bitmap();
  result = {
    url: pixel.url,
    mediaType: pixel.mediaType,
    size: pixel.size,
    bytes: [...pixel.bytes()],
    text: pixel.text().slice(1, 4),
    image: {
      complete: image.complete,
      width: image.naturalWidth,
      height: image.naturalHeight,
      src: image.src === pixel.url,
    },
    bitmap: { width: bitmap.width, height: bitmap.height },
  };
} catch (error) {
  result = { error: String(error) };
}
fabric.cell("result").set(result);
`;
    const iframe = await render("<p>assets</p>", context, script, {
      pixel: PIXEL,
    });
    await waitForContextValue(
      context,
      iframe,
      "result",
      (value) => value !== null,
    );

    const bytes = Array.from(atob(PIXEL_BASE64), (char) => char.charCodeAt(0));
    expect(context.get(iframe, "result")).toEqual({
      url: PIXEL,
      mediaType: "image/png",
      size: bytes.length,
      bytes,
      text: "PNG",
      image: { complete: true, width: 1, height: 1, src: true },
      bitmap: { width: 1, height: 1 },
    });
  } finally {
    cleanupFixtures();
  }
});

test("loads an image whose `src` is a `cf-asset:` reference under the guest's policy", async () => {
  // The guest's `load` event comes once its images have loaded or failed,
  // which is after the policy has reported refusing one.

  cleanupFixtures();
  try {
    const context = new ContextShim({ result: null });
    const html = "<!doctype html><html><head><script>" +
      "globalThis.violations = [];" +
      'document.addEventListener("securitypolicyviolation", (event) =>' +
      "  globalThis.violations.push(event.violatedDirective));" +
      '</script></head><body><img id="pixel" src="cf-asset:pixel">' +
      "</body></html>";
    const script = `
import { connectFabric } from "/guest.js";
const fabric = connectFabric();
let result;
try {
  if (document.readyState !== "complete") {
    await new Promise((resolve) => addEventListener("load", resolve));
  }
  const image = document.querySelector("#pixel");
  result = {
    src: image.getAttribute("src"),
    width: image.naturalWidth,
    violations: globalThis.violations,
  };
} catch (error) {
  result = { error: String(error) };
}
fabric.cell("result").set(result);
`;
    const iframe = await render(html, context, script, { pixel: PIXEL });
    await waitForContextValue(
      context,
      iframe,
      "result",
      (value) => value !== null,
    );

    expect(context.get(iframe, "result")).toEqual({
      src: PIXEL,
      width: 1,
      violations: [],
    });
  } finally {
    cleanupFixtures();
  }
});

test("reports a reference to an asset it was not given, and loads the guest all the same", async () => {
  cleanupFixtures();
  const descriptions: string[] = [];
  const onError = (event: Event) => {
    if (event instanceof CustomEvent) {
      descriptions.push(event.detail.description);
    }
  };
  // The event bubbles and is composed, so the document hears it, from before
  // the element exists.
  document.addEventListener("common-iframe-error", onError);
  try {
    const context = new ContextShim({ result: null });
    const script = `
import { connectFabric } from "/guest.js";
connectFabric().cell("result").set(document.querySelector("#mark").textContent);
`;
    const iframe = await render(
      '<img src="cf-asset:logo"><p id="mark">shown</p>',
      context,
      script,
      { pixel: PIXEL },
    );
    await waitForContextValue(
      context,
      iframe,
      "result",
      (value) => value === "shown",
    );

    expect(descriptions).toEqual([
      "The guest's document refers to assets it was not given: " +
      "`cf-asset:logo`. It was given `pixel`.",
    ]);
  } finally {
    document.removeEventListener("common-iframe-error", onError);
    cleanupFixtures();
  }
});
