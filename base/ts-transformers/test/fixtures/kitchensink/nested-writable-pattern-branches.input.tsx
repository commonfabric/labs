/**
 * FIXTURE: nested-writable-pattern-branches
 * Verifies: pattern-owned maps on explicit Writable inputs stay pattern-lowered
 * across mixed authored ifElse helpers, implicit JSX ternaries, nested maps,
 * and handler closures that capture values from several upper scopes.
 * Expected transform:
 * - state.sections.map(...) and section.tasks.map(...) become mapWithPattern()
 * - authored ifElse predicates and branches lower uniformly
 * - nested ternaries inside task/tag callbacks lower without extra lift-applied noise
 * - handler captures preserve section/task/index/local Writable references
 */

import { computed, handler, ifElse, pattern, UI, Writable } from "commonfabric";

interface Task {
  id: string;
  label: string;
  done: boolean;
  tags: string[];
  note?: string;
}

interface Section {
  id: string;
  title: string;
  expanded: boolean;
  accent?: string;
  tasks: Task[];
}

// [TRANSFORM] handler: event schema (true=unknown) and state schema injected
const selectTask = handler<unknown, {
  selectedTaskId: string | undefined;
  hoveredSectionId: string | undefined;
  sectionId: string;
  taskId: string;
  sectionIndex: number;
  taskIndex: number;
}>((_event, state) => state);

// [TRANSFORM] pattern: type param stripped; input+output schemas appended after callback
export default pattern<{
  sections: Writable<Section[]>;
  showCompleted: boolean;
  globalAccent: string;
}>((state) => {
  // [TRANSFORM] new Writable: schema arg injected; undefined default added for optional type
  const selectedTaskId = new Writable<string | undefined>();
  // [TRANSFORM] new Writable: schema arg injected; undefined default added for optional type
  const hoveredSectionId = new Writable<string | undefined>();
  // [TRANSFORM] computed() -> lift(): captures state.sections (asCell — Writable<Section[]>)
  const hasSections = computed(() => state.sections.get().length > 0);

  return {
    [UI]: (
      <div>
        {/* [TRANSFORM] ifElse: schema-injected authored ifElse(hasSections, ..., ...) */}
        {ifElse(
          hasSections,
          <div>
            {/* [TRANSFORM] .map() → mapWithPattern: state.sections is Writable<Section[]> — reactive, pattern context */}
            {/* [TRANSFORM] closure captures: state (reactive), selectedTaskId (Writable), hoveredSectionId (Writable) */}
            {state.sections.map((section, sectionIndex) => (
              <section>
                <h2
                  style={{
                    // [TRANSFORM] ternary lowered: section.accent ? section.accent : state.globalAccent → ifElse(...)
                    color: section.accent ? section.accent : state.globalAccent,
                  }}
                >
                  {section.title}
                </h2>
                {/* [TRANSFORM] ifElse: schema-injected authored ifElse(section.expanded, ..., ...) */}
                {ifElse(
                  section.expanded,
                  <div>
                    {/* [TRANSFORM] .map() → mapWithPattern: section.tasks is reactive pattern-owned data */}
                    {/* [TRANSFORM] closure captures: selectedTaskId, hoveredSectionId, section, sectionIndex, state (all via params) */}
                    {section.tasks.map((task, taskIndex) => (
                      <div>
                        <button
                          type="button"
                          onClick={selectTask({
                            selectedTaskId,
                            hoveredSectionId,
                            sectionId: section.id,
                            taskId: task.id,
                            sectionIndex,
                            taskIndex,
                          })}
                        >
                          {/* [TRANSFORM] ternary lowered: task.done ? <span>...</span> : ifElse(...) → ifElse(task.done, ..., ...) */}
                          {task.done
                            ? <span>{task.label}</span>
                            : ifElse(
                              task.note !== undefined && task.note !== "",
                              <strong>{task.label}</strong>,
                              <em>{task.label}</em>,
                            )}
                        </button>
                        {/* [TRANSFORM] .map() → mapWithPattern: task.tags is reactive pattern-owned data (nested inside sections map) */}
                        {/* [TRANSFORM] closure captures: taskIndex, section, state, task (all via params) */}
                        {/* [TRANSFORM] ternary lowered: tagIndex===taskIndex ? `${section.title}:${tag}` : (showCompleted||!task.done ? tag : "") */}
                        {task.tags.map((tag, tagIndex) => (
                          <span>
                            {tagIndex === taskIndex
                              ? `${section.title}:${tag}`
                              : state.showCompleted || !task.done
                              ? tag
                              : ""}
                          </span>
                        ))}
                      </div>
                    ))}
                  </div>,
                  // [TRANSFORM] ternary preserved inside the ifElse(expanded) false branch:
                  //   section.tasks.length > 0 ? <small>...collapsed</small> : <small>empty</small>
                  //   → plain local ternary inside the JSX branch
                  section.tasks.length > 0
                    ? <small>{section.title} collapsed</small>
                    : <small>empty</small>,
                )}
              </section>
            ))}
          </div>,
          // [TRANSFORM] false-branch of ifElse(hasSections): ternary showCompleted ? "No completed sections" : "No sections"
          //   → local ifElse(...) inside the <p> JSX expression
          <p>{state.showCompleted ? "No completed sections" : "No sections"}</p>,
        )}
      </div>
    ),
  };
});
