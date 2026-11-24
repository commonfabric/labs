import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

type TokenDefinitionInput = {
  background?: string;
  foreground?: string;
  accent?: string;
};

type DesignTokenSwitcherArgs = {
  tokens?: Record<string, TokenDefinitionInput>;
  activeToken?: string;
};

export const designTokenSwitcherScenario: PatternIntegrationScenario<
  DesignTokenSwitcherArgs
> = {
  name: "design token switcher cycles and selects tokens",
  module: new URL(
    "./design-token-switcher.pattern.ts",
    import.meta.url,
  ),
  exportName: "designTokenSwitcher",
  steps: [
    {
      expect: [
        { path: "tokenNames", value: ["contrast", "light", "midnight"] },
        { path: "activeToken", value: "light" },
        { path: "backgroundColor", value: "#ffffff" },
        { path: "foregroundColor", value: "#161616" },
        { path: "accentColor", value: "#2f80ed" },
        { path: "colorSummary", value: "#ffffff/#161616/#2f80ed" },
        { path: "preview.background", value: "#ffffff" },
        { path: "preview.summary", value: "bg #ffffff fg #161616" },
        { path: "history", value: [] },
        { path: "lastApplied", value: "none" },
        {
          path: "label",
          value: "Active token light renders #ffffff/#161616/#2f80ed",
        },
      ],
    },
    {
      events: [{ stream: "switchToken", payload: {} }],
      expect: [
        { path: "activeToken", value: "midnight" },
        { path: "backgroundColor", value: "#0b1220" },
        { path: "foregroundColor", value: "#f5f7fb" },
        { path: "accentColor", value: "#5b8def" },
        { path: "colorSummary", value: "#0b1220/#f5f7fb/#5b8def" },
        { path: "tokenNames", value: ["contrast", "light", "midnight"] },
        { path: "history", value: ["midnight"] },
        { path: "lastApplied", value: "midnight" },
        {
          path: "label",
          value: "Active token midnight renders #0b1220/#f5f7fb/#5b8def",
        },
      ],
    },
    {
      events: [{ stream: "switchToken", payload: { token: "contrast" } }],
      expect: [
        { path: "activeToken", value: "contrast" },
        { path: "backgroundColor", value: "#000000" },
        { path: "foregroundColor", value: "#ffdd00" },
        { path: "accentColor", value: "#ff6f61" },
        { path: "colorSummary", value: "#000000/#ffdd00/#ff6f61" },
        { path: "history", value: ["midnight", "contrast"] },
        { path: "lastApplied", value: "contrast" },
        {
          path: "label",
          value: "Active token contrast renders #000000/#ffdd00/#ff6f61",
        },
      ],
    },
    {
      events: [{ stream: "switchToken", payload: { token: "unknown" } }],
      expect: [
        { path: "activeToken", value: "light" },
        { path: "backgroundColor", value: "#ffffff" },
        { path: "foregroundColor", value: "#161616" },
        { path: "accentColor", value: "#2f80ed" },
        { path: "colorSummary", value: "#ffffff/#161616/#2f80ed" },
        { path: "history", value: ["midnight", "contrast", "light"] },
        { path: "lastApplied", value: "light" },
        {
          path: "label",
          value: "Active token light renders #ffffff/#161616/#2f80ed",
        },
      ],
    },
    {
      events: [{ stream: "switchToken", payload: { token: " midnight " } }],
      expect: [
        { path: "activeToken", value: "midnight" },
        { path: "backgroundColor", value: "#0b1220" },
        { path: "foregroundColor", value: "#f5f7fb" },
        { path: "accentColor", value: "#5b8def" },
        { path: "colorSummary", value: "#0b1220/#f5f7fb/#5b8def" },
        {
          path: "history",
          value: ["midnight", "contrast", "light", "midnight"],
        },
        { path: "lastApplied", value: "midnight" },
        {
          path: "label",
          value: "Active token midnight renders #0b1220/#f5f7fb/#5b8def",
        },
      ],
    },
  ],
};

export const scenarios = [designTokenSwitcherScenario];

describe("design-token-switcher", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
