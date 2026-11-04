import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";
import type { ClauseInput } from "./legal-clause-library.pattern.ts";

const libraryClauses: ClauseInput[] = [
  {
    id: "nda-standard",
    title: "Mutual NDA",
    topic: "Confidentiality",
    region: "NA",
    status: "approved",
    text: "Protects confidential exchanges for joint projects.",
    lastReviewed: "2023-09-30",
  },
  {
    id: "gdpr-data-addendum",
    title: "GDPR Controller Addendum",
    topic: " DATA PROTECTION ",
    region: "eu",
    status: "draft",
    text: "Defines cross-border safeguards for EU personal data.",
    lastReviewed: "2023-08-01",
  },
  {
    id: "ccpa-supplement",
    title: "CCPA Supplement",
    topic: "data protection",
    region: "na",
    status: "approved",
    text: "Extends opt-out workflows for California residents.",
    lastReviewed: "bad-value",
  },
  {
    id: "supplier-governance",
    title: "Supplier Governance Clause",
    topic: "Supplier Risk",
    region: "APAC",
    status: "deprecated",
    text: "Tracks supplier audits across quarterly cadences.",
    lastReviewed: "2023-05-10",
  },
  {
    id: "ccpa-supplement",
    title: "Duplicate Entry",
    topic: "data protection",
    region: "na",
    status: "draft",
    text: "Should be ignored due to duplicate identifier.",
    lastReviewed: "2023-01-01",
  },
];

export const legalClauseLibraryScenario: PatternIntegrationScenario<
  { clauses?: ClauseInput[] }
> = {
  name: "legal clause library filters clauses by topic and region",
  module: new URL("./legal-clause-library.pattern.ts", import.meta.url),
  exportName: "legalClauseLibrary",
  argument: { clauses: libraryClauses },
  steps: [
    {
      expect: [
        { path: "selectedTopic", value: "all" },
        { path: "selectedRegion", value: "all" },
        { path: "filteredClauses.length", value: 4 },
        { path: "filteredClauses.0.id", value: "nda-standard" },
        { path: "filteredClauses.2.id", value: "gdpr-data-addendum" },
        {
          path: "summaryLine",
          value: "Showing 4 of 4 clauses for All Topics in All Regions",
        },
        { path: "statusSummary.approved", value: 2 },
        { path: "statusSummary.draft", value: 1 },
        { path: "statusSummary.deprecated", value: 1 },
        { path: "topicOptions.length", value: 3 },
        { path: "topicOptions.1.label", value: "Data Protection" },
        { path: "topicOptions.1.count", value: 2 },
        { path: "topicOptions.1.active", value: false },
        { path: "topicOptions.1.regions.0.label", value: "Europe" },
        { path: "topicOptions.1.regions.0.count", value: 1 },
        { path: "regionOptions.1.count", value: 2 },
        { path: "regionOptions.2.label", value: "Europe" },
        { path: "regionOptions.2.count", value: 1 },
        { path: "regionOptions.0.count", value: 0 },
      ],
    },
    {
      events: [
        {
          stream: "handlers.selectTopic",
          payload: { topic: " Data Protection " },
        },
      ],
      expect: [
        { path: "selectedTopic", value: "data-protection" },
        { path: "filteredClauses.length", value: 2 },
        { path: "filteredClauses.0.id", value: "ccpa-supplement" },
        { path: "filteredClauses.1.id", value: "gdpr-data-addendum" },
        {
          path: "summaryLine",
          value: "Showing 2 of 4 clauses for Data Protection in All Regions",
        },
        { path: "topicOptions.1.active", value: true },
        { path: "regionOptions.1.active", value: false },
      ],
    },
    {
      events: [
        {
          stream: "handlers.selectRegion",
          payload: { region: "EU" },
        },
      ],
      expect: [
        { path: "selectedRegion", value: "eu" },
        { path: "filteredClauses.length", value: 1 },
        { path: "filteredClauses.0.id", value: "gdpr-data-addendum" },
        {
          path: "summaryLine",
          value: "Showing 1 of 4 clauses for Data Protection in Europe",
        },
        { path: "regionOptions.2.active", value: true },
      ],
    },
    {
      events: [
        {
          stream: "handlers.updateClauseStatus",
          payload: {
            id: "gdpr-data-addendum",
            status: "approved",
            reviewedOn: "2024-01-15",
          },
        },
      ],
      expect: [
        { path: "filteredClauses.0.status", value: "approved" },
        { path: "filteredClauses.0.lastReviewed", value: "2024-01-15" },
        { path: "statusSummary.approved", value: 3 },
        { path: "statusSummary.draft", value: 0 },
        {
          path: "summaryLine",
          value: "Showing 1 of 4 clauses for Data Protection in Europe",
        },
      ],
    },
    {
      events: [{ stream: "handlers.clearFilters", payload: {} }],
      expect: [
        { path: "selectedTopic", value: "all" },
        { path: "selectedRegion", value: "all" },
        { path: "filteredClauses.length", value: 4 },
        {
          path: "summaryLine",
          value: "Showing 4 of 4 clauses for All Topics in All Regions",
        },
        { path: "topicOptions.1.active", value: false },
        { path: "regionOptions.2.active", value: false },
        { path: "filteredClauses.2.status", value: "approved" },
      ],
    },
  ],
};

export const scenarios = [legalClauseLibraryScenario];

describe("legal-clause-library", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
