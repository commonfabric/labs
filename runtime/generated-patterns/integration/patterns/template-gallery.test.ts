import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

interface TemplateArgument {
  id?: string;
  name?: string;
  category?: string;
  summary?: string;
  tags?: string[];
  popularity?: number;
}

const galleryTemplates: TemplateArgument[] = [
  {
    id: "hero-email-kit",
    name: "Hero Email Kit",
    category: "Marketing",
    summary: "Coordinate hero messaging across channels.",
    tags: ["Email", "Hero", "Campaign"],
    popularity: 95,
  },
  {
    id: "product-tour-deck",
    name: "Product Tour Deck",
    category: "marketing",
    summary: "Showcase product value with modular slides.",
    tags: ["Demo", "Slides"],
    popularity: 85,
  },
  {
    id: "support-shift-schedule",
    name: "Support Shift Schedule",
    category: " SUPPORT ",
    summary: "Assign support coverage by hour and channel.",
    tags: ["Support", "Schedule"],
    popularity: 88,
  },
  {
    id: "ops-kanban",
    name: "Operations Kanban",
    category: "Operations",
    summary: "Visualize operational work and handoffs.",
    tags: ["Ops", "Tasks"],
    popularity: 80,
  },
  {
    id: "retro-guide",
    name: "Retro Guide",
    category: "Facilitation",
    summary: "Guide sprint retrospectives with prompts.",
    tags: ["Team", "Retro"],
    popularity: 67,
  },
];

export const templateGalleryScenario: PatternIntegrationScenario<
  { templates?: TemplateArgument[]; category?: string }
> = {
  name: "template gallery filters templates by category",
  module: new URL("./template-gallery.pattern.ts", import.meta.url),
  exportName: "templateGallery",
  argument: {
    templates: galleryTemplates,
    category: "Marketing",
  },
  steps: [
    {
      expect: [
        { path: "selectedCategory", value: "marketing" },
        { path: "counts.total", value: 5 },
        { path: "counts.visible", value: 2 },
        {
          path: "summary",
          value: "2 of 5 templates in Marketing",
        },
        {
          path: "visibleTemplates.0.id",
          value: "hero-email-kit",
        },
        {
          path: "visibleTemplates.1.category",
          value: "Marketing",
        },
        {
          path: "featuredTemplate.id",
          value: "hero-email-kit",
        },
        {
          path: "categories.2.label",
          value: "Marketing",
        },
        { path: "selectionLabel", value: "initial load" },
        { path: "selectionTrail", value: "No selections yet" },
      ],
    },
    {
      events: [
        {
          stream: "handlers.selectCategory",
          payload: { category: "Support" },
        },
      ],
      expect: [
        { path: "selectedCategory", value: "support" },
        { path: "counts.visible", value: 1 },
        {
          path: "summary",
          value: "1 of 5 templates in Support",
        },
        {
          path: "visibleTemplates.0.name",
          value: "Support Shift Schedule",
        },
        {
          path: "featuredTemplate.id",
          value: "support-shift-schedule",
        },
        {
          path: "selectionLabel",
          value: "Category set to Support",
        },
        { path: "selectionTrail", value: "Support" },
      ],
    },
    {
      events: [
        {
          stream: "handlers.selectCategory",
          payload: { category: "unknown" },
        },
      ],
      expect: [
        { path: "selectedCategory", value: "all" },
        { path: "counts.visible", value: 5 },
        {
          path: "summary",
          value: "5 of 5 templates in All",
        },
        {
          path: "visibleTemplates.0.id",
          value: "hero-email-kit",
        },
        {
          path: "selectionLabel",
          value: "Category set to All",
        },
        {
          path: "selectionTrail",
          value: "Support → All",
        },
      ],
    },
    {
      events: [
        {
          stream: "handlers.selectCategory",
          payload: { category: "Operations" },
        },
      ],
      expect: [
        { path: "selectedCategory", value: "operations" },
        { path: "counts.visible", value: 1 },
        {
          path: "summary",
          value: "1 of 5 templates in Operations",
        },
        {
          path: "featuredTemplate.id",
          value: "ops-kanban",
        },
        {
          path: "selectionTrail",
          value: "Support → All → Operations",
        },
      ],
    },
  ],
};

export const scenarios = [templateGalleryScenario];

describe("template-gallery", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
