import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { TemplateResult } from "lit";
import { ConsoleIndexView } from "../../../console/src/index-view.ts";

/** Exposes the component's render result without connecting it to a page. */
class TestIndexView extends ConsoleIndexView {
  /** Returns the template the component renders. */
  view(): TemplateResult {
    return this.render();
  }
}

/** Helper for badge assertions, which reads templates without running handlers. */
const templateText = (value: unknown): string => {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(templateText).join("");
  if (value === null || typeof value !== "object") return "";
  const template = value as Partial<TemplateResult>;
  return (template.strings ?? []).map((part, index) =>
    part + templateText(template.values?.[index])
  ).join("");
};

describe("console/src/index-view", () => {
  it("renders author DIDs and unattributed counts in the event badges", () => {
    const view = new TestIndexView();
    view.patterns = [{
      patternId: "pat-1",
      description: "Reads donut orders",
      hashtags: [],
      keywords: [],
      ownerDid: "did:key:zPublisher",
      createdAt: null,
      events: { thumbs_up: 4 },
      eventAuthors: {
        thumbs_up: { "did:key:zConsole": 1, "did:key:zRun": 2 },
      },
      score: 8,
    }];

    const rendered = templateText(view.view());
    const badges = [
      ...rendered.matchAll(/<span class="badge">([\s\S]*?)<\/span>/g),
    ]
      .map((match) => match[1].replace(/<[^>]*>/g, "").replace(/\s+/g, " "));
    expect(badges).toHaveLength(3);
    expect(badges[0]).toContain("thumbs_up ×1");
    expect(badges[0]).toContain("did:key:zConsole");
    expect(badges[1]).toContain("thumbs_up ×2");
    expect(badges[1]).toContain("did:key:zRun");
    expect(badges[2]).toContain("thumbs_up ×1 · author unavailable");
    expect(rendered).not.toContain("did:key:zPublisher");
  });
});
