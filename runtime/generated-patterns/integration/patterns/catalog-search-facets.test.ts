import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

interface CatalogSearchArgument {
  catalog?: Array<{
    id?: string;
    title?: string;
    category?: string;
    brand?: string;
    price?: number;
    tags?: string[];
  }>;
}

const catalogSearchFacetsScenario: PatternIntegrationScenario<
  CatalogSearchArgument
> = {
  name: "catalog search facets respond to toggled filters",
  module: new URL("./catalog-search-facets.pattern.ts", import.meta.url),
  exportName: "catalogSearchFacets",
  steps: [
    {
      expect: [
        {
          path: "facets.available.categories",
          value: ["Electronics", "Kitchen", "Outdoors"],
        },
        {
          path: "facets.available.brands",
          value: [
            "Brew Pro",
            "Daily Bean",
            "Sonic Pulse",
            "Trailhead",
          ],
        },
        {
          path: "facets.available.priceRange",
          value: { min: 38, max: 180, average: 103.75 },
        },
        {
          path: "facets.selection.summary",
          value: "Categories: All • Brands: All • Price ≤ Any",
        },
        { path: "results.count", value: 6 },
        { path: "results.total", value: 6 },
        { path: "results.statusLabel", value: "Showing 6 of 6 products" },
        { path: "results.items.0.id", value: "hiking-pack" },
        { path: "results.items.5.id", value: "trail-shoes" },
      ],
    },
    {
      events: [{
        stream: "controls.toggleCategory",
        payload: { value: " kitchen " },
      }],
      expect: [
        { path: "facets.selection.categories.0", value: "Kitchen" },
        {
          path: "facets.selection.summary",
          value: "Categories: Kitchen • Brands: All • Price ≤ Any",
        },
        { path: "results.count", value: 2 },
        { path: "results.statusLabel", value: "Showing 2 of 6 products" },
        { path: "results.items.0.id", value: "pour-over-kit" },
        { path: "results.items.1.id", value: "french-press" },
      ],
    },
    {
      events: [{
        stream: "controls.toggleBrand",
        payload: { value: "brew pro" },
      }],
      expect: [
        { path: "facets.selection.brands.0", value: "Brew Pro" },
        {
          path: "facets.selection.summary",
          value: "Categories: Kitchen • Brands: Brew Pro • Price ≤ Any",
        },
        { path: "results.count", value: 1 },
        { path: "results.items.0.id", value: "french-press" },
        { path: "results.statusLabel", value: "Showing 1 of 6 products" },
      ],
    },
    {
      events: [{
        stream: "controls.setPriceCeiling",
        payload: { ceiling: 40.49 },
      }],
      expect: [
        {
          path: "facets.selection.summary",
          value: "Categories: Kitchen • Brands: Brew Pro • Price ≤ $40.49",
        },
        { path: "results.count", value: 0 },
        { path: "results.statusLabel", value: "Showing 0 of 6 products" },
      ],
    },
    {
      events: [{
        stream: "controls.toggleBrand",
        payload: { value: "Brew Pro" },
      }],
      expect: [
        {
          path: "facets.selection.summary",
          value: "Categories: Kitchen • Brands: All • Price ≤ $40.49",
        },
        { path: "results.count", value: 1 },
        { path: "results.items.0.id", value: "pour-over-kit" },
      ],
    },
    {
      events: [{ stream: "controls.clearFilters", payload: {} }],
      expect: [
        {
          path: "facets.selection.summary",
          value: "Categories: All • Brands: All • Price ≤ Any",
        },
        { path: "results.count", value: 6 },
        { path: "results.statusLabel", value: "Showing 6 of 6 products" },
        { path: "facets.selection.categories", value: [] },
        { path: "facets.selection.brands", value: [] },
        { path: "facets.selection.priceCeiling", value: null },
      ],
    },
  ],
};

export const scenarios = [catalogSearchFacetsScenario];

describe("catalog-search-facets", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
