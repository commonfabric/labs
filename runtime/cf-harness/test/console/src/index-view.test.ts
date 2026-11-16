import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { PatternIndexListedPattern } from "@commonfabric/pattern-index/client";
import type { TemplateResult } from "lit";
import { ConsoleIndexView } from "../../../console/src/index-view.ts";
import { templateText } from "./template-text.ts";

/** Exposes the component's render result without connecting it to a page. */
class TestIndexView extends ConsoleIndexView {
  /** Returns the template the component renders. */
  view(): TemplateResult {
    return this.render();
  }
}

const listed = (
  overrides: Partial<PatternIndexListedPattern> = {},
): PatternIndexListedPattern => ({
  patternId: "pat-1",
  description: "Reads donut orders",
  hashtags: [],
  keywords: [],
  handle: "p-a1b2c3d4e5",
  createdAt: null,
  events: {},
  score: 0,
  ...overrides,
});

/** The text of every element of `className`, tags stripped and spaces folded. */
const spans = (rendered: string, className: string): string[] =>
  [
    ...rendered.matchAll(
      new RegExp(`<span class="${className}">([\\s\\S]*?)</span>`, "g"),
    ),
  ].map((match) =>
    match[1].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim()
  );

describe("console/src/index-view", () => {
  it("renders one badge per event type, carrying its count and no author", () => {
    const view = new TestIndexView();
    view.patterns = [listed({
      events: { thumbs_up: 3, instantiated: 1 },
      // An older deployment's author breakdown is not shown.
      eventAuthors: { thumbs_up: { "did:key:zRun": 3 } },
    })];

    const rendered = templateText(view.view());

    expect(spans(rendered, "badge")).toEqual([
      "instantiated ×1",
      "thumbs_up ×3",
    ]);
    expect(rendered).not.toContain("did:key:zRun");
  });

  it("renders each pattern's owner by handle, marking the caller's own", () => {
    const view = new TestIndexView();
    view.patterns = [
      listed({ patternId: "pat-mine", handle: "p-a1b2c3d4e5", mine: true }),
      listed({ patternId: "pat-other", handle: "p-z9y8x7w6v5", score: 1 }),
    ];

    const rendered = templateText(view.view());

    expect(rendered).toContain("<th>owner</th>");
    expect(rendered).toContain("p-a1b2c3d4e5");
    expect(rendered).toContain("p-z9y8x7w6v5");
    expect(spans(rendered, "index-mine")).toEqual(["you"]);
    // The caller's pattern ranks second, so its owner cell is the one marked.
    expect(rendered.indexOf("index-mine")).toBeGreaterThan(
      rendered.indexOf("p-a1b2c3d4e5"),
    );
  });

  it("renders each pattern's listing state and bucket in its own column", () => {
    const view = new TestIndexView();
    view.patterns = [
      listed({ patternId: "pat-1", listing: "passed", bucket: "main" }),
      listed({ patternId: "pat-2", listing: "held", score: 1 }),
    ];

    const rendered = templateText(view.view());

    expect(rendered).toContain("<th>listing</th>");
    expect(rendered).toContain(`<td class="muted">passed · main</td>`);
    expect(rendered).toContain(`<td class="muted">held</td>`);
  });

  it("renders the opened pattern's owner by handle, and no events of its own", () => {
    const view = new TestIndexView();
    view.patterns = [listed({ handle: "p-a1b2c3d4e5" })];
    view.open = {
      patternId: "pat-1",
      pattern: {
        patternId: "pat-1",
        handle: "p-q1w2e3r4t5",
        mine: true,
        createdAt: "2026-08-01T00:00:00.000Z",
        description: "Reads donut orders",
        hashtags: [],
        dependencies: [],
      },
    };

    const rendered = templateText(view.view());
    const detail = rendered.slice(rendered.indexOf(`class="index-detail"`));

    expect(detail).toContain("p-q1w2e3r4t5");
    expect(spans(detail, "index-mine")).toEqual(["you"]);
    expect(rendered).not.toContain("its events");
    expect(rendered).not.toContain("Your events");
  });
});
