import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { CFCellContext } from "./index.ts";
import { resetRetiredElementWarnings } from "../../core/retired-element.ts";

describe("CFCellContext (retired)", () => {
  // The contract for a retired element, exercised on the first one.
  //
  // It stays REGISTERED — that is the whole point. Durable pattern source names
  // it, a piece runs the source it was stored with, and an element the browser
  // does not know is one nothing can warn about. It renders its children and
  // nothing else, and it accepts the props the old source passes without acting
  // on them.

  it("is still registered under its tag", () => {
    expect(customElements.get("cf-cell-context")).toBe(CFCellContext);
  });

  it("constructs, and accepts the props old source passes", () => {
    const element = new CFCellContext();
    expect(element).toBeInstanceOf(CFCellContext);

    // `$cell` / `label` / `inline` are what stored source binds. They are
    // retained so that source keeps working; nothing reads them.
    expect(element.cell).toBe(undefined);
    expect(element.label).toBe(undefined);
    expect(element.inline).toBe(false);

    element.label = "whatever the old markup said";
    element.inline = true;
    expect(element.label).toBe("whatever the old markup said");
    expect(element.inline).toBe(true);
  });

  it("renders a passthrough and nothing else", () => {
    const element = new CFCellContext();
    const rendered = element.render();
    // A lit template whose only content is the default slot: children survive,
    // the retired behavior does not come back.
    const strings = (rendered as { strings?: readonly string[] }).strings;
    expect(strings).toBeDefined();
    expect(strings!.join("")).toContain("<slot></slot>");
  });

  it("keeps the retired component's host layout", () => {
    // An inert element is not a layout-neutral one. Stored source was authored
    // against this box (`display: block` with `flex: 1`, plus the inline
    // variant), so a stub that collapsed it — `display: contents`, say — would
    // reflow the very pages the stub exists to keep working.
    const css = CFCellContext.styles
      .flat()
      .map((sheet) => String(sheet))
      .join("\n")
      .replace(/\s+/g, " ");

    expect(css).toContain(":host { display: block;");
    expect(css).toContain("flex: 1;");
    expect(css).toContain(":host([inline]) { display: inline-block;");
    expect(css).not.toContain("display: contents");
  });

  it("warns once when durable source reaches it", () => {
    resetRetiredElementWarnings();
    const lines: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => lines.push(args.join(" "));
    try {
      // `notifyRetiredUsage` rather than `connectedCallback`: the latter
      // delegates to lit, which needs a real document to build a render root.
      // This is the half that matters, and it runs first for that reason.
      new CFCellContext().notifyRetiredUsage();
      new CFCellContext().notifyRetiredUsage();
    } finally {
      console.warn = original;
    }
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("cf-cell-context");
    expect(lines[0]).toContain("cf-piece-menu");
  });
});
