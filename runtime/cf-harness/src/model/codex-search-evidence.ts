/**
 * Codex search evidence crosses the delegate boundary separately from answer
 * text, so a structured answer stays valid JSON and citations stay available.
 */
import {
  type HarnessOpenAIWebSearchResult,
  type HarnessWebSearchSource,
  OPENAI_WEB_SEARCH_NATIVE_MODEL_TOOL,
} from "../contracts/native-model-tool.ts";
import type { HarnessTranscriptMessage } from "../contracts/transcript.ts";

/** Extracts public citation links without interpreting provider text as markup. */
export const codexSearchSources = (
  output: readonly Record<string, unknown>[],
): HarnessWebSearchSource[] => {
  const sources = new Map<string, HarnessWebSearchSource>();
  for (const item of output) {
    if (item.type !== "message" || !Array.isArray(item.content)) continue;
    for (const content of item.content) {
      if (
        content?.type !== "output_text" || !Array.isArray(content.annotations)
      ) continue;
      for (const annotation of content.annotations) {
        if (
          annotation?.type !== "url_citation" ||
          typeof annotation.url !== "string" || annotation.url.length > 4096
        ) continue;
        let url: URL;
        try {
          url = new URL(annotation.url);
        } catch {
          continue;
        }
        if (
          (url.protocol !== "https:" && url.protocol !== "http:") ||
          url.username || url.password
        ) continue;
        if (!sources.has(url.href)) {
          sources.set(url.href, {
            url: url.href,
            title: typeof annotation.title === "string"
              ? annotation.title
              : url.hostname,
          });
        }
      }
    }
  }
  return [...sources.values()];
};

/** Collects the child transcript's observed searches, including earlier turns. */
export const collectCodexSearchResults = (
  transcript: readonly HarnessTranscriptMessage[],
): HarnessOpenAIWebSearchResult[] =>
  transcript.flatMap((message) =>
    message.role === "assistant"
      ? (message.nativeModelToolResults ?? []).filter(
        (result): result is HarnessOpenAIWebSearchResult =>
          result.toolId === OPENAI_WEB_SEARCH_NATIVE_MODEL_TOOL &&
          result.provider === "openai-codex",
      )
      : []
  );

/** Adds a bounded source footer only to unstructured delegate summaries. */
export const searchSourceSummary = (
  results: readonly HarnessOpenAIWebSearchResult[],
): string => {
  const sources = new Map(
    results.flatMap((result) => result.sources).map((
      source,
    ) => [source.url, source]),
  );
  if (sources.size === 0) return "";
  const heading = "\n\nSources:\n";
  const omission =
    "\nAdditional sources omitted; full source evidence is retained.";
  // Reserve the notice before admitting complete links: no URL is truncated,
  // and a long destination cannot multiply into an oversized summary footer.
  let remaining = 12000 - heading.length - omission.length;
  const links: string[] = [];
  for (const source of sources.values()) {
    if (links.length === 32) break;
    const title = source.title.replace(/\s+/g, " ").slice(0, 300).replace(
      /[\\[\]<>]/g,
      "\\$&",
    );
    const link = `- [${title || "Source"}](<${source.url}>)`;
    const size = link.length + (links.length > 0 ? 1 : 0);
    if (size > remaining) continue;
    remaining -= size;
    links.push(link);
  }
  return heading + links.join("\n") +
    (links.length < sources.size ? omission : "");
};
