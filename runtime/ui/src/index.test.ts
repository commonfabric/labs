// First, so that the document it installs is there when Lit loads.
import "./v2/test-utils/dom.ts";

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import * as ui from "./index.ts";

/**
 * Tags the renderer in `runtime/html` acts on itself, which no component
 * defines: a render boundary only scopes what its subtree may show.
 */
const RENDERER_TAGS = new Set(["cf-cfc-render-boundary"]);

/** The `cf-` tags that the JSX typing lets a pattern write for a component. */
async function declaredTags(): Promise<string[]> {
  const typing = await Deno.readTextFile(
    new URL("../../html/src/jsx.d.ts", import.meta.url),
  );
  return [...typing.matchAll(/"(cf-[a-z0-9-]+)": CFDOM\.DetailedHTMLProps/g)]
    .map(([, tag]) => tag)
    .filter((tag) => !RENDERER_TAGS.has(tag))
    .sort();
}

describe("index", () => {
  it("defines an element for every `cf-` tag the JSX typing declares", async () => {
    const tags = await declaredTags();
    expect(tags.length).toBeGreaterThan(100);
    expect(tags.filter((tag) => customElements.get(tag) === undefined))
      .toEqual([]);
  });

  it("exports the class of every element it defines", async () => {
    const exported = new Set<unknown>(Object.values(ui));
    const missing = (await declaredTags()).filter((tag) =>
      !exported.has(customElements.get(tag))
    );
    expect(missing).toEqual([]);
  });

  it("defines no element for a tag the renderer handles itself", () => {
    for (const tag of RENDERER_TAGS) {
      expect(customElements.get(tag)).toBeUndefined();
    }
  });
});
