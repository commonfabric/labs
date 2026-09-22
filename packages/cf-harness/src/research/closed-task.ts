import { parseNamedPieceAddress } from "../input-cells.ts";
import { isPatternRefId } from "../pattern-refs.ts";
import type { HarnessRunState } from "../run-state.ts";
import { parseSkillsShSkillId } from "../skills-sh/pin.ts";

/**
 * Recognizes attached patterns and explicit `pattern:`, `cf:pattern:`, or
 * `skill:` markers in the task. This only skips automatic orientation;
 * reference admission, skill acquisition, and explicit research remain separate.
 */
export const isClosedResearchTask = (
  task: string,
  context: Pick<HarnessRunState, "patternRefs" | "skillRegistry">,
): boolean => {
  if (context.patternRefs?.length) return true;

  const skillNames = new Set(
    context.skillRegistry?.skills.map((skill) => skill.name),
  );
  for (
    const match of task.matchAll(/[^\s`"'()[\]{},;!?<>“”‘’。、，！？]+/gu)
  ) {
    const token = match[0].replace(/[.:]+$/, "")
      .replace(/^(\*{1,3})(.+)\1$/u, "$2");
    if (
      token.startsWith("cf:pattern:") &&
      isPatternRefId(token.slice("cf:pattern:".length))
    ) {
      return true;
    }
    if (token.startsWith("pattern:")) {
      try {
        parseNamedPieceAddress(token);
        return true;
      } catch {
        // A malformed piece address leaves orientation available.
      }
    } else if (token.startsWith("skill:")) {
      const id = token.slice("skill:".length);
      if (skillNames.has(id)) return true;
      try {
        parseSkillsShSkillId(id);
        return true;
      } catch {
        // An unknown local name or malformed address still needs discovery.
      }
    }
  }
  return false;
};
