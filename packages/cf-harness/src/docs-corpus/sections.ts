/**
 * Splitting Markdown into addressable sections, and ranking the sections that
 * answer a question.
 *
 * A section rather than a file is the unit here because the whole point of the
 * tool is that a child stops paying for a document to read a rule. Selection is
 * lexical and deterministic: the same question over the same corpus ranks the
 * same sections, which is what makes a query reproducible from a run's record.
 */

import { utf8Compare } from "@commonfabric/utils/utf8";

import type { HarnessDocsCorpusSection } from "../contracts/docs-corpus.ts";

/**
 * Words carrying no discrimination between documentation sections. Scoring
 * them would rank a section by how much English it contains rather than by
 * how much of the question it answers.
 */
const STOP_WORDS = new Set([
  "a",
  "all",
  "and",
  "are",
  "can",
  "does",
  "doing",
  "for",
  "from",
  "how",
  "into",
  "not",
  "should",
  "that",
  "the",
  "this",
  "use",
  "using",
  "was",
  "what",
  "when",
  "where",
  "which",
  "why",
  "with",
  "you",
  "your",
]);

const HEADING_PATTERN = /^(#{1,6})\s+(.*)$/;

const sectionText = (lines: readonly string[]): string =>
  lines.join("\n").trim();

/**
 * The sections of one Markdown document. Text above the first heading becomes
 * a section with an empty heading, so a document's opening paragraph — which
 * is where a short skill file says what it is for — is reachable rather than
 * dropped.
 *
 * A fenced code block is passed through verbatim, backtick-fenced or
 * tilde-fenced alike: a `#` inside one is a shell comment or a CSS id, and
 * reading it as a heading would split a section in the middle of an example.
 */
export const splitMarkdownSections = (
  document: Omit<HarnessDocsCorpusSection, "heading" | "text">,
  text: string,
): readonly HarnessDocsCorpusSection[] => {
  const sections: HarnessDocsCorpusSection[] = [];
  let heading = "";
  let documentTitle = "";
  let ancestors: { level: number; title: string }[] = [];
  let lines: string[] = [];
  let inFence = false;
  const flush = () => {
    const text = sectionText(lines);
    if (text.length > 0) {
      sections.push({
        ...document,
        heading,
        headingPath: ancestors.map((entry) => entry.title),
        text,
      });
    }
    lines = [];
  };
  for (const line of text.split("\n")) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      inFence = !inFence;
      lines.push(line);
      continue;
    }
    const match = inFence ? null : HEADING_PATTERN.exec(line);
    if (match === null) {
      lines.push(line);
      continue;
    }
    flush();
    heading = match[2].trim();
    const level = match[1].length;
    if (level === 1 && documentTitle.length === 0) documentTitle = heading;
    ancestors = ancestors.filter((entry) => entry.level < level);
    ancestors.push({ level, title: heading });
  }
  flush();
  return sections.map((section) => ({
    ...section,
    documentTitle: documentTitle || document.path,
  }));
};

/** The scoring terms of a question, lowercased and stripped of stop words. */
export const questionTerms = (question: string): readonly string[] => {
  const terms = new Set<string>();
  for (const raw of question.toLowerCase().split(/[^a-z0-9_]+/)) {
    if (raw.length >= 3 && !STOP_WORDS.has(raw)) {
      terms.add(raw);
    }
  }
  return [...terms];
};

const occurrences = (haystack: string, term: string): number => {
  let count = 0;
  let index = haystack.indexOf(term);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(term, index + term.length);
  }
  return count;
};

/**
 * How well a section answers a question. A term in the heading or the path
 * counts for more than a term in the body: a heading is the section's own
 * claim about its subject, and a body mention may be an aside.
 */
export const scoreSection = (
  section: HarnessDocsCorpusSection,
  terms: readonly string[],
): number => {
  const heading = (section.headingPath?.join(" > ") ?? section.heading)
    .toLowerCase();
  const path = section.path.toLowerCase();
  const body = section.text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    score += occurrences(heading, term) * 8;
    score += occurrences(path, term) * 4;
    score += Math.min(occurrences(body, term), 8);
  }
  return score;
};

/** One section and its deterministic lexical score for a query. */
export interface RankedDocsCorpusSection {
  /** Section found in the corpus. */
  section: HarnessDocsCorpusSection;

  /** Weighted occurrences of the query terms. */
  score: number;
}

/**
 * Every section that lexically matches `query`, in deterministic best-first
 * order. The section remains whole: callers that expose text apply their own
 * read window, so ranking a long section never destroys its tail.
 */
export const rankSections = (
  sections: readonly HarnessDocsCorpusSection[],
  query: string,
): readonly RankedDocsCorpusSection[] => {
  const terms = questionTerms(query);
  if (terms.length === 0) {
    return [];
  }
  return sections
    .map((section) => ({ section, score: scoreSection(section, terms) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) =>
      right.score - left.score ||
      utf8Compare(left.section.path, right.section.path) ||
      utf8Compare(left.section.heading, right.section.heading)
    );
};

/** Exact excerpt around the passage matching the most distinct query terms. */
export interface DocsPassage {
  /** Character offset in the section text. */
  offset: number;

  /** Exclusive end of the excerpt. */
  end: number;

  /** Verbatim section text at these offsets. */
  content: string;
}

/** Groups paragraphs and fenced examples into exact contiguous text ranges. */
const markdownBlocks = (text: string): { offset: number; end: number }[] => {
  const blocks: { offset: number; end: number }[] = [];
  let offset = 0;
  let start = 0;
  let fence: string | undefined;
  for (const line of text.split("\n")) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence === undefined && marker !== undefined) {
      if (offset > start) blocks.push({ offset: start, end: offset });
      start = offset;
      fence = marker;
    } else if (
      fence !== undefined && marker?.[0] === fence[0] &&
      marker.length >= fence.length
    ) {
      blocks.push({ offset: start, end: offset + line.length });
      start = offset + line.length + 1;
      fence = undefined;
    } else if (fence === undefined && line.trim().length === 0) {
      if (offset > start) blocks.push({ offset: start, end: offset });
      start = offset + 1;
    }
    offset += line.length + 1;
  }
  if (start < text.length) blocks.push({ offset: start, end: text.length });
  return blocks;
};

/**
 * Finds a query-bearing passage inside a section, including matches far beyond
 * its opening. Short paragraphs and fenced examples remain whole when they
 * fit in the requested window; longer passages retain exact continuation offsets.
 */
export const findSectionPassage = (
  section: HarnessDocsCorpusSection,
  query: string,
  maxChars = 1_600,
): DocsPassage => {
  const text = section.text;
  const lower = text.toLowerCase();
  const terms = questionTerms(query);
  const positions = new Set<number>([0]);
  for (const term of terms) {
    let position = lower.indexOf(term);
    while (position !== -1) {
      positions.add(Math.max(0, position - 240));
      position = lower.indexOf(term, position + term.length);
    }
  }
  let offset = 0;
  let best = -1;
  for (const position of positions) {
    const window = lower.slice(position, position + maxChars);
    const score = terms.filter((term) => window.includes(term)).length;
    if (score > best) {
      best = score;
      offset = position;
    }
  }
  const firstMatch = Math.min(...terms.map((term) => {
    const at = lower.indexOf(term, offset);
    return at < 0 ? Infinity : at;
  }));
  const block = markdownBlocks(text).find((range) =>
    range.offset <= firstMatch && firstMatch < range.end
  );
  if (block !== undefined && block.end - block.offset <= maxChars) {
    return { ...block, content: text.slice(block.offset, block.end) };
  }
  const end = Math.min(text.length, offset + maxChars);
  return { offset, end, content: text.slice(offset, end) };
};
