import { join } from "@std/path";

import { PATTERN_AUTHOR_SUBAGENT_SKILL_NAMES } from "../../src/contracts/subagent.ts";

/**
 * The one resource every fixture skill indexes. A pattern-author child reads it
 * back through `read_skill_resource`, so the path is part of the fixture's
 * contract.
 */
export const PATTERN_SKILL_FIXTURE_RESOURCE_PATH = "references/guide.md";

const skillMarkdown = (name: string): string =>
  [
    "---",
    `name: ${name}`,
    `description: Synthetic ${name} skill for harness tool-surface tests`,
    "---",
    "",
    `# ${name}`,
    "",
    "Synthetic skill body. This tree stands in for the live repo skills so a",
    "test never depends on a real skill file that a rename could move.",
  ].join("\n");

/**
 * A disposable synthetic skills tree. Points a run's `skillsRoot` at
 * {@linkcode skillsRoot} to advertise `read_skill_resource`/`run_skill_script`
 * and to give a pattern-author child a real resource to read. `await using`
 * removes the temp tree when the binding leaves scope.
 */
export interface PatternSkillsFixture extends AsyncDisposable {
  readonly skillsRoot: string;
}

/**
 * Writes a minimal skills tree holding the pattern-author preload skills
 * ({@linkcode PATTERN_AUTHOR_SUBAGENT_SKILL_NAMES}) plus one indexed resource
 * under each, then returns the disposable handle over it.
 */
export const createPatternSkillsFixture = async (): Promise<
  PatternSkillsFixture
> => {
  const skillsRoot = await Deno.makeTempDir({
    prefix: "cf-harness-pattern-skills-",
  });
  for (const name of PATTERN_AUTHOR_SUBAGENT_SKILL_NAMES) {
    const skillDir = join(skillsRoot, name);
    await Deno.mkdir(join(skillDir, "references"), { recursive: true });
    await Deno.writeTextFile(join(skillDir, "SKILL.md"), skillMarkdown(name));
    await Deno.writeTextFile(
      join(skillDir, PATTERN_SKILL_FIXTURE_RESOURCE_PATH),
      `# ${name} guide\n\nSynthetic reference resource for harness tests.\n`,
    );
  }
  return {
    skillsRoot,
    async [Symbol.asyncDispose]() {
      await Deno.remove(skillsRoot, { recursive: true });
    },
  };
};
