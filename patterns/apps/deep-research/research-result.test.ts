import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { researchSections } from "./research-result.ts";

describe("research-result", () => {
  it("returns empty text for every part before a result arrives", () => {
    expect(researchSections(undefined)).toEqual({
      summaryHeading: "",
      summary: "",
      confidence: "",
      findingsHeading: "",
      findings: "",
      sourcesHeading: "",
      sources: "",
    });
  });

  it("returns each part of a complete result under its heading", () => {
    expect(researchSections({
      summary: "Agents now plan over many steps.",
      confidence: "medium",
      findings: [
        {
          title: "Planning",
          content: "Longer horizons.",
          source: "https://a.test",
        },
        { title: "Tools", content: "More of them.", source: "https://b.test" },
      ],
      sources: ["https://a.test", "https://b.test"],
    })).toEqual({
      summaryHeading: "Summary",
      summary: "Agents now plan over many steps.",
      confidence: "Confidence: medium",
      findingsHeading: "Findings",
      findings: "Planning\nLonger horizons.\n(https://a.test)\n\n" +
        "Tools\nMore of them.\n(https://b.test)",
      sourcesHeading: "Sources",
      sources: "https://a.test\nhttps://b.test",
    });
  });

  it("returns no heading for an empty list of findings or sources", () => {
    const sections = researchSections({
      summary: "Nothing found.",
      findings: [],
      sources: [],
    });

    expect(sections.findingsHeading).toBe("");
    expect(sections.sourcesHeading).toBe("");
    expect(sections.confidence).toBe("");
    expect(sections.summaryHeading).toBe("Summary");
  });
});
