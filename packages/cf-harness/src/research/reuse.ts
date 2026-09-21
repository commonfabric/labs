/** Selected research patterns and the author's decision to reuse or omit them. */

import { ensureCompilerStack } from "@commonfabric/runner";
import { parseFabricRef } from "@commonfabric/runner/shared";

import type { HarnessResearchRunSummary } from "../contracts/research.ts";
import { selectResearchContext } from "./context.ts";

/** Authoring rule shared by research handoffs and the execution tool. */
export const RESEARCH_REUSE_GUIDANCE =
  "For each selected kit.patterns entry in retained research, import as cf:pattern:<id>, or supply reuseReasons[<id>] as one nonblank line explaining why it does not fit this call. Here <id> is the patternId without the cf:pattern: prefix. This also applies to an incomplete kit. A separate atom, a verification reader, or a result already supplied by reference can explain its narrower scope. Leads are unverified candidates, not reuse requirements.";

/**
 * Returns the selected patterns missing both an import and a one-line reason.
 * Uses the compiler's import reader and Fabric reference parser; an import
 * establishes a dependency, not that the program invokes it meaningfully.
 */
export const unexplainedResearchPatterns = async (
  runs: readonly HarnessResearchRunSummary[],
  source: { name: string; contents: string },
  reasons: Readonly<Record<string, string>> | undefined,
): Promise<readonly string[]> => {
  const unexplained = new Set(
    selectResearchContext(runs).flatMap((run) =>
      run.kit.patterns.map((pattern) => pattern.patternId)
    ).filter((id) => {
      const reason = reasons?.[id];
      return typeof reason !== "string" || reason.trim().length === 0 ||
        /[\r\n]/.test(reason);
    }),
  );
  if (unexplained.size === 0) return [];
  const { collectImportSpecifiers, ts } = await ensureCompilerStack();
  for (
    const specifier of collectImportSpecifiers(source, ts.ScriptTarget.ES2023)
  ) {
    const ref = parseFabricRef(specifier)?.ref;
    if (ref?.kind === "uri" && ref.scheme === "pattern") {
      unexplained.delete(ref.hash);
    }
  }
  return [...unexplained];
};
