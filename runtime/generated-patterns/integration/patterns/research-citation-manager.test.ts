import { describe, it } from "@std/testing/bdd";
import { runPatternScenario } from "../pattern-harness.ts";
import type { PatternIntegrationScenario } from "../pattern-harness.ts";

interface CitationArgs {
  citations?: Array<{
    id?: string;
    title?: string;
    authors?: string[];
    topic?: string;
    year?: number;
    style?: string;
    summary?: string;
  }>;
  style?: string;
}

const researchCitationManagerScenario: PatternIntegrationScenario<
  CitationArgs
> = {
  name: "research citation manager reorganizes bibliographies",
  module: new URL(
    "./research-citation-manager.pattern.ts",
    import.meta.url,
  ),
  exportName: "researchCitationManager",
  argument: {
    style: "apa",
    citations: [
      {
        id: "paper-1",
        title: "Graph Neural Networks",
        authors: ["Xu, K.", "Hu, W."],
        topic: "Machine Learning",
        year: 2020,
        style: "APA",
      },
      {
        id: "paper-2",
        title: "Reinforcement Learning Survey",
        authors: ["Li, Y."],
        topic: "Machine Learning",
        year: 2018,
        style: "MLA",
      },
      {
        id: "paper-3",
        title: "Climate Change Impacts",
        authors: ["Smith, J.", "Doe, A."],
        topic: "Environmental Science",
        year: 2019,
        style: "Chicago",
      },
    ],
  },
  steps: [
    {
      expect: [
        { path: "activeStyle", value: "APA" },
        { path: "snapshot.total", value: 3 },
        { path: "snapshot.topics", value: 2 },
        { path: "snapshot.styles", value: 3 },
        {
          path: "snapshot.headline",
          value: "3 citations across 2 topics using 3 styles.",
        },
        {
          path: "summary",
          value: "3 citations in 2 topics with 3 styles (active APA).",
        },
        {
          path: "groupedByTopic.Environmental Science.0.id",
          value: "paper-3",
        },
        {
          path: "topicBibliographies.Environmental Science.0",
          value:
            "Smith, J., Doe, A. (2019). Climate Change Impacts — Environmental Science. [Chicago]",
        },
        {
          path: "styleBibliographies.APA.0",
          value:
            "Xu, K., Hu, W. (2020). Graph Neural Networks — Machine Learning. [APA]",
        },
        {
          path: "styleBibliographies.MLA.0",
          value:
            "Li, Y. (2018). Reinforcement Learning Survey — Machine Learning. [MLA]",
        },
        {
          path: "activeBibliography.0",
          value:
            "Xu, K., Hu, W. (2020). Graph Neural Networks — Machine Learning. [APA]",
        },
      ],
    },
    {
      events: [{
        stream: "controls.addCitation",
        payload: {
          title: "Ocean Acidification Trends",
          authors: ["Lee, C.", "Patel, R."],
          topic: "Environmental Science",
          year: 2021,
        },
      }],
      expect: [
        { path: "snapshot.total", value: 4 },
        {
          path: "groupedByTopic.Environmental Science.1.title",
          value: "Ocean Acidification Trends",
        },
        {
          path: "groupedByTopic.Environmental Science.1.style",
          value: "APA",
        },
        {
          path: "citations.3.id",
          value: "citation-4",
        },
        {
          path: "styleBibliographies.APA.1",
          value:
            "Lee, C., Patel, R. (2021). Ocean Acidification Trends — Environmental Science. [APA]",
        },
        {
          path: "activeBibliography.1",
          value:
            "Lee, C., Patel, R. (2021). Ocean Acidification Trends — Environmental Science. [APA]",
        },
        {
          path: "summary",
          value: "4 citations in 2 topics with 3 styles (active APA).",
        },
      ],
    },
    {
      events: [{
        stream: "controls.retagCitation",
        payload: {
          id: "paper-2",
          topic: "Policy Studies",
          style: "APA",
        },
      }],
      expect: [
        {
          path: "groupedByTopic.Policy Studies.0.id",
          value: "paper-2",
        },
        {
          path: "topicBibliographies.Policy Studies.0",
          value:
            "Li, Y. (2018). Reinforcement Learning Survey — Policy Studies. [APA]",
        },
        {
          path: "groupedByTopic.Machine Learning.0.id",
          value: "paper-1",
        },
        {
          path: "styleBibliographies.APA.0",
          value:
            "Li, Y. (2018). Reinforcement Learning Survey — Policy Studies. [APA]",
        },
        {
          path: "activeBibliography.0",
          value:
            "Li, Y. (2018). Reinforcement Learning Survey — Policy Studies. [APA]",
        },
        {
          path: "activeBibliography.1",
          value:
            "Xu, K., Hu, W. (2020). Graph Neural Networks — Machine Learning. [APA]",
        },
      ],
    },
    {
      events: [{
        stream: "controls.setStyle",
        payload: { style: "Chicago" },
      }],
      expect: [
        { path: "activeStyle", value: "Chicago" },
        {
          path: "activeBibliography.0",
          value:
            "Smith, J., Doe, A. (2019). Climate Change Impacts — Environmental Science. [Chicago]",
        },
        {
          path: "summary",
          value: "4 citations in 3 topics with 2 styles (active Chicago).",
        },
      ],
    },
  ],
};

export const scenarios = [researchCitationManagerScenario];

describe("research-citation-manager", () => {
  for (const scenario of scenarios) {
    it(scenario.name, async () => {
      await runPatternScenario(scenario);
    });
  }
});
