/**
 * FIXTURE: helper-owned-compute-branches
 * Verifies: helper-owned branches inside computed() can mix compute-owned array
 * maps with reactive Writable captures without losing branch rewriting.
 * Expected transform:
 * - visibleProjects.map(...), project.badges.map(...), project.members.map(...),
 *   and plainPreview.map(...) remain plain Array.map() calls in compute context
 * - fallbackMembers.map(...) still lowers because it comes from a closed-over
 *   Writable array capture
 * - authored ifElse branches still lower safely around the mixed map behavior
 */

import { computed, ifElse, pattern, UI, Writable } from "commonfabric";

interface Badge {
  text: string;
  active: boolean;
}

interface Project {
  id: string;
  name: string;
  archived: boolean;
  members: string[];
  badges: Badge[];
}

// [TRANSFORM] pattern: type param stripped; input+output schemas appended after callback
export default pattern<{
  projects: Project[];
  prefix: string;
  showArchived: boolean;
}>((state) => {
  // [TRANSFORM] new Writable: schema arg injected
  const fallbackMembers = new Writable(["ops", "sales"]);
  // [TRANSFORM] computed() -> lift(): captures state.showArchived, state.projects
  const visibleProjects = computed(() =>
    state.showArchived
      ? state.projects
      : state.projects.filter((project) => !project.archived)
  );

  // [TRANSFORM] computed() -> lift(): captures visibleProjects (asOpaque), state.prefix, fallbackMembers (asCell — Writable)
  const rows = computed(() =>
    // [TRANSFORM] .map() stays plain: visibleProjects is a captured computed input, plain inside this compute
    visibleProjects.map((project, projectIndex) => {
      // [TRANSFORM] .map() stays plain: ["alpha","beta"] is a literal array
      const plainPreview = ["alpha", "beta"].map((label, labelIndex) =>
        `${project.name}-${labelIndex}-${label}`
      );

      // [TRANSFORM] ifElse: schema args injected on authored ifElse
      return ifElse(
        project.badges.length > 0,
        <div>
          <h3>{project.name}</h3>
          {/* [TRANSFORM] .map() stays plain: project.badges is compute-owned data inside computed */}
          {project.badges.map((badge, badgeIndex) => (
            <span>
              {badge.active
                ? `${state.prefix}${badge.text}-${projectIndex}`
                : badgeIndex === 0
                ? `${project.name}:${badge.text}`
                : ""}
            </span>
          ))}
          {/* [TRANSFORM] .map() → mapWithPattern: fallbackMembers is a Writable (reactive Cell), lowered even inside computed */}
          {fallbackMembers.map((member, memberIndex) => (
            <small>
              {memberIndex === 0 ? `${project.name}-${member}` : member}
            </small>
          ))}
          {/* [TRANSFORM] .map() stays plain: plainPreview is a local literal array */}
          {plainPreview.map((label) => <i>{label}</i>)}
        </div>,
        <div>
          {/* [TRANSFORM] .map() stays plain: project.members is compute-owned data inside computed */}
          {project.members.map((member, memberIndex) => (
            <span>
              {memberIndex === projectIndex
                ? `${state.prefix}${member}`
                : member}
            </span>
          ))}
        </div>,
      );
    })
  );

  return {
    [UI]: <div>{rows}</div>,
  };
});
