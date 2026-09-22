import type { HarnessRunState } from "../run-state.ts";
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

  const skillNames = new Set(
    context.skillRegistry?.skills.map((skill) => skill.name),
  );
  for (const match of task.matchAll(/[A-Za-z0-9_:/.-]+/g)) {
    const token = match[0].replace(/[.:]+$/, "");
    if (
      /^cf:pattern:[A-Za-z0-9_-]+$/.test(token) ||
      /^[A-Za-z0-9_-]{43}$/.test(token) || skillNames.has(token)
    ) return true;

    const skillUrl = token.startsWith("https://skills.sh/");
    const before = task.slice(0, match.index);
    const after = task.slice(match.index + match[0].length);
    if (
      !skillUrl &&
      !/\b(?:skill(?:\s+(?:named|called))?|use|using|run|acquire|follow)\s+(?:the\s+)?[`"']?$/i
        .test(before) &&
      !/^[`"']?\s+skill\b/i.test(after)
    ) continue;

    try {
      parseSkillsShSkillId(
        skillUrl ? token.slice("https://skills.sh/".length) : token,
      );
      return true;
    } catch {
      // Ordinary prose and file paths need not be skill addresses.
    }
  }
  return false;
};
