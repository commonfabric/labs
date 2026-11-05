import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { CFUpdater } from "./index.ts";
import { resetRetiredElementWarnings } from "../../core/retired-element.ts";

describe("CFUpdater (retired)", () => {
  it("is still registered under its tag", () => {
    expect(customElements.get("cf-updater")).toBe(CFUpdater);
  });

  it("accepts the props old source passes", () => {
    const element = new CFUpdater();
    expect(element.state).toBe(undefined);
    expect(element.integration).toBe(undefined);

    element.integration = "rss";
    expect(element.integration).toBe("rss");
  });

  it("renders a passthrough and no registration button", () => {
    const rendered = new CFUpdater().render();
    const strings = (rendered as { strings?: readonly string[] }).strings;
    expect(strings).toBeDefined();
    expect(strings!.join("")).toContain("<slot></slot>");
    expect(strings!.join("")).not.toContain("<button");
  });

  it("keeps the retired component's block host", () => {
    const css = CFUpdater.styles
      .flat()
      .map((sheet) => String(sheet))
      .join("\n")
      .replace(/\s+/g, " ");
    expect(css).toContain(":host { display: block;");
  });

  it("warns once when durable source reaches it", () => {
    resetRetiredElementWarnings();
    const lines: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => lines.push(args.join(" "));
    try {
      new CFUpdater().render();
      new CFUpdater().render();
    } finally {
      console.warn = original;
    }
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain("cf-updater");
  });
});
