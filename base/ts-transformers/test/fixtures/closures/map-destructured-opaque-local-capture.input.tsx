import { pattern, UI } from "commonfabric";

interface State {
  sections: { tasks: { label: string }[]; tags: { name: string }[] }[];
}

// FIXTURE: map-destructured-opaque-local-capture
// Verifies: destructured opaque locals captured by nested map callbacks stay reactive
//   const { tasks } = section → const tasks = __cf_pattern_input.key("params", "tasks")
//   nested tag callback reads tasks.length through key("length"), not plain params values
export default pattern<State>((state) => ({
  [UI]: (
    <div>
      {state.sections.map((section) => {
        const { tasks } = section;
        return (
          <div>
            {section.tags.map((tag) => (
              <span>
                {tag.name}:{tasks.length}
              </span>
            ))}
          </div>
        );
      })}
    </div>
  ),
}));
