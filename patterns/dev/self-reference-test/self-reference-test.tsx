// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
import { Default, pattern, SELF, UI, Writable } from "commonfabric";

interface Input {
  label: string | Default<"Untitled">;
  parent: Output | null | Default<null>;
  registry: Writable<Output[] | Default<[]>>;
}
export interface Output {
  label: string;
  parent: Output | null;
  children: Output[];
}

const Node = pattern<Input, Output>(
  ({ label, parent, registry, [SELF]: self }) => {
    const children = new Writable<Output[]>([]);

    return {
      label,
      parent,
      children,
      [UI]: (
        <div>
          <button
            type="button"
            onClick={() =>
              children.push(Node({ label: "Child", parent: self, registry }))}
          >
            Add Child
          </button>
          <button
            type="button"
            onClick={() => registry.push(self)}
          >
            Add to Registry
          </button>
          <div>{parent ? <cf-cell-link $cell={parent} /> : "No parent"}</div>
          <div>
            Registry: {registry.map((node) => <cf-cell-link $cell={node} />)}
          </div>
          <div>
            Children: {children.map((node) => <cf-cell-link $cell={node} />)}
          </div>
        </div>
      ),
    };
  },
);

export default Node;
