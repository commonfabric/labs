/** The structured answer the research agent presents when it is done. */
export interface ResearchResult {
  summary: string;
  findings: {
    title: string;
    source: string;
    content: string;
  }[];
  sources: string[];
  confidence: "high" | "medium" | "low";
}

/** The text of each part of the research view. */
export interface ResearchSections {
  summaryHeading: string;
  summary: string;
  confidence: string;
  findingsHeading: string;
  findings: string;
  sourcesHeading: string;
  sources: string;
}

/**
 * The text the research view shows for `result`. A part the result does not
 * carry, which is every part until the agent presents one, shows nothing,
 * heading included.
 */
export function researchSections(
  result: Partial<ResearchResult> | undefined,
): ResearchSections {
  const findings = result?.findings ?? [];
  const sources = result?.sources ?? [];
  return {
    summaryHeading: result?.summary ? "Summary" : "",
    summary: result?.summary ?? "",
    confidence: result?.confidence ? `Confidence: ${result.confidence}` : "",
    findingsHeading: findings.length ? "Findings" : "",
    findings: findings
      .map((f) => `${f.title}\n${f.content}\n(${f.source})`)
      .join("\n\n"),
    sourcesHeading: sources.length ? "Sources" : "",
    sources: sources.join("\n"),
  };
}
