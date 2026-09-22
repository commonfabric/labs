import type { HarnessRunState } from "../run-state.ts";
import { isPatternRefId } from "../pattern-refs.ts";
import { parseSkillsShSkillId } from "../skills-sh/pin.ts";

/**
 * Recognizes a task that already selects an implementation: attached patterns,
 * an exact pattern id, or a named skill. This only skips automatic orientation;
 * reference admission, skill acquisition, and explicit research remain separate.
 */
export const isClosedResearchTask = (
  task: string,
  context: Pick<HarnessRunState, "patternRefs" | "skillRegistry">,
): boolean => {
  if (context.patternRefs?.length) return true;

  for (const match of task.matchAll(/[A-Za-z0-9_:/.-]+/g)) {
    const token = match[0].replace(/[.:]+$/, "");
    if (
      token.startsWith("cf:pattern:") &&
      isPatternRefId(token.slice("cf:pattern:".length))
    ) {
      return true;
    }
    if (!token.startsWith("https://skills.sh/")) continue;
    try {
      parseSkillsShSkillId(token.slice("https://skills.sh/".length));
      return true;
    } catch {
      // An incomplete address still needs discovery.
    }
  }

  const skillNames = new Set(
    context.skillRegistry?.skills.map((skill) => skill.name),
  );
  for (
    const match of task.matchAll(
      /\b(?:use|using|run|instantiate|compose|acquire|follow)\s+(?:the\s+)?(?:(named\s+)?(pattern(?:\s+id)?|patternId|skill)(?:\s+(named|called))?\s+)?([`"']?)([A-Za-z0-9_:/.-]+)/gi,
    )
  ) {
    const kind = match[2]?.toLowerCase().replace(/\s+/, " ");
    const token = match[5].replace(/[.:]+$/, "");
    const after = task.slice(match.index + match[0].length);
    const skillNamed = kind === "skill" || /^[`"']?\s+skill\b/i.test(after);
    const patternNamed = kind === "pattern id" || kind === "patternid" ||
      (kind === "pattern" && Boolean(match[1] || match[3] || match[4]));
    if (skillNames.has(token) && !kind?.startsWith("pattern")) return true;
    if (skillNamed) {
      try {
        parseSkillsShSkillId(token);
        return true;
      } catch {
        // An invalid skill address still needs discovery.
      }
    } else if (
      // Length distinguishes an unmarked content hash from ordinary prose;
      // explicitly labeled pattern ids use the full grammar without this bound.
      (patternNamed || token.length === 43) &&
      isPatternRefId(token)
    ) {
      return true;
    }
  }
  return false;
};
