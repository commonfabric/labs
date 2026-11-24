import type { HarnessSkillRegistry } from "../contracts/skill.ts";
import { discoverHarnessSkills } from "./registry.ts";

/**
 * The part of a run a registry scan writes to. Narrow on purpose: a caller
 * holds a whole engine, and what it hands over is the one method that records
 * a registry.
 */
export interface HarnessSkillRegistryRun {
  persistSkillRegistry(
    registry: HarnessSkillRegistry,
  ): Promise<string | undefined>;
}

export interface PersistHarnessRunSkillRegistryOptions {
  skillsRoot: string;

  /**
   * Where the skills tree appears to a sandboxed tool. Absent when tools read
   * the tree on the host, which is what the scan then records.
   */
  sandboxSkillsRoot?: string;
}

/**
 * Scans a configured skills tree and records it on the run before the run's
 * first model turn. The registry is what `read_skill_resource`,
 * `run_skill_script`, and subagent profile preloading read, and a subagent
 * inherits it from its parent's run state — so a run that carries a skills
 * root and no registry offers none of them, to itself or to its children.
 * Every path that starts a run with a skills root calls this.
 */
export const persistHarnessRunSkillRegistry = async (
  run: HarnessSkillRegistryRun,
  options: PersistHarnessRunSkillRegistryOptions,
): Promise<HarnessSkillRegistry> => {
  const registry = await discoverHarnessSkills({
    skillsRoot: options.skillsRoot,
    ...(options.sandboxSkillsRoot !== undefined
      ? { sandboxSkillsRoot: options.sandboxSkillsRoot }
      : {}),
  });
  await run.persistSkillRegistry(registry);
  return registry;
};
