import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { CSP, HOST_ORIGIN } from "../src/csp.ts";

// Each directive as the policy states it, so a change to one is a change to
// this list rather than something a substring match lets through.
function directive(name: string): string | undefined {
  for (const part of CSP.split(";")) {
    const trimmed = part.trim();
    if (trimmed === "") continue;
    const [key, ...rest] = trimmed.split(" ");
    if (key === name) return rest.join(" ");
  }
  return undefined;
}

describe("csp", () => {
  it("denies every fetch directive it does not name", () => {
    expect(directive("default-src")).toBe("'none'");
  });

  it("denies the directives a guest must not have at all", () => {
    expect(directive("child-src")).toBe("'none'");
    expect(directive("form-action")).toBe("'none'");
    expect(directive("base-uri")).toBe("'none'");
  });

  it("allows scripts from the host origin and inline, and no other origin", () => {
    const sources = directive("script-src")?.split(" ") ?? [];
    expect(sources).toContain(HOST_ORIGIN);
    expect(sources).toContain("'unsafe-inline'");
    expect(
      sources.every((source) =>
        source === HOST_ORIGIN || source.startsWith("'") ||
        source.startsWith("https://")
      ),
    ).toBe(true);
  });

  it("confines connections to the guest's own origin", () => {
    expect(directive("connect-src")).toBe("'self'");
  });

  it("names an origin for the host", () => {
    expect(HOST_ORIGIN).toMatch(/^[a-z]+:\/\//);
  });
});
