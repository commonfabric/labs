import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

const initialContent = "# Welcome\n\n**Bold** move";
const updatedContent = "# Welcome\n\nNow _italic_ text";

export const markdownPreviewToggleScenario: PatternIntegrationScenario<
  { initialContent?: string; preview?: boolean }
> = {
  name: "markdown preview toggles formatted view",
  module: new URL(
    "./markdown-preview-toggle.pattern.ts",
    import.meta.url,
  ),
  exportName: "markdownPreviewToggle",
  argument: {
    initialContent,
    preview: true,
  },
  steps: [
    {
      expect: [
        { path: "content", value: initialContent },
        { path: "previewEnabled", value: true },
        {
          path: "previewText",
          value: "<h1>Welcome</h1>\n\n<strong>Bold</strong> move",
        },
        {
          path: "activeView",
          value: "<h1>Welcome</h1>\n\n<strong>Bold</strong> move",
        },
        {
          path: "summary",
          value:
            "Preview view — <h1>Welcome</h1>\n\n<strong>Bold</strong> move",
        },
      ],
    },
    {
      events: [
        { stream: "updateContent", payload: { text: updatedContent } },
      ],
      expect: [
        { path: "content", value: updatedContent },
        {
          path: "previewText",
          value: "<h1>Welcome</h1>\n\nNow <em>italic</em> text",
        },
        {
          path: "activeView",
          value: "<h1>Welcome</h1>\n\nNow <em>italic</em> text",
        },
        {
          path: "summary",
          value: "Preview view — <h1>Welcome</h1>\n\nNow <em>italic</em> text",
        },
      ],
    },
    {
      events: [{ stream: "togglePreview", payload: {} }],
      expect: [
        { path: "previewEnabled", value: false },
        { path: "activeView", value: updatedContent },
        {
          path: "summary",
          value: "Raw view — # Welcome\n\nNow _italic_ text",
        },
      ],
    },
    {
      events: [{ stream: "togglePreview", payload: {} }],
      expect: [
        { path: "previewEnabled", value: true },
        {
          path: "activeView",
          value: "<h1>Welcome</h1>\n\nNow <em>italic</em> text",
        },
        {
          path: "summary",
          value: "Preview view — <h1>Welcome</h1>\n\nNow <em>italic</em> text",
        },
      ],
    },
  ],
};

export const scenarios = [markdownPreviewToggleScenario];

describe("markdown-preview-toggle", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
