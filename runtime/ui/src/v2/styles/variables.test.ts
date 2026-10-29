import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import type { CSSResultGroup } from "lit";
import { CFBadge } from "../components/cf-badge/cf-badge.ts";
import { CFCard } from "../components/cf-card/cf-card.ts";
import { CFChip } from "../components/cf-chip/cf-chip.ts";
import { modalStyles } from "../components/cf-modal/styles.ts";
import { CFTags } from "../components/cf-tags/cf-tags.ts";
import { CFToast } from "../components/cf-toast/cf-toast.ts";
import { variablesCSS } from "./variables.ts";

/** A theme-derived variable: a surface recipe or the pill radius. */
const DERIVED =
  /--cf-(?:surface-(?:plain|elevated|overlay|transient)-[a-z-]+|pill-border-radius)\b/g;

/** The text of a component's styles, however they are grouped. */
function cssTextOf(styles: CSSResultGroup | undefined): string {
  if (styles === undefined) return "";
  if (Array.isArray(styles)) return styles.map(cssTextOf).join("\n");
  return "cssText" in styles ? styles.cssText : String(styles);
}

describe("variablesCSS", () => {
  it("derives nothing from the theme", () => {
    // Every base-styled component declares variablesCSS on its host, so a
    // variable in it derived from `--cf-theme-*` is fixed to the theme around
    // that component, and no tint beneath reaches it. Such a variable is
    // declared by the components that read it (see `surfaceRecipesCSS`).
    const declarations = variablesCSS.replace(/\/\*[\s\S]*?\*\//g, "");
    expect(declarations).not.toContain("var(--cf-theme-");
    expect(declarations).toContain("--cf-spacing-4:");
  });
});

describe("a component reading a theme-derived variable", () => {
  const consumers: [string, CSSResultGroup | undefined][] = [
    ["cf-badge", CFBadge.styles],
    ["cf-card", CFCard.styles],
    ["cf-chip", CFChip.styles],
    ["cf-modal", modalStyles],
    ["cf-tags", CFTags.styles],
    ["cf-toast", CFToast.styles],
  ];
  for (const [name, styles] of consumers) {
    it(`${name} declares each one it reads on its own host`, () => {
      const css = cssTextOf(styles);
      const read = new Set(
        [...css.matchAll(/var\(\s*(--cf-[a-z-]+)/g)].map((m) => m[1])
          .filter((v) => v.match(DERIVED)),
      );
      expect(read.size).toBeGreaterThan(0);
      for (const variable of read) {
        expect(css).toContain(`${variable}:`);
      }
    });
  }
});
