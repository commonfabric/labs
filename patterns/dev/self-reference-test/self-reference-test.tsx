// PATTERN TIER: fixture — scaffolding that pins a bug or drives the
// runtime. Do not copy from this file. Tiers: patterns/index.md
import { Default, pattern, SELF, UI, type VNode, Writable } from "commonfabric";

/** A node as its parent, children and registry hold it. */
export interface TreeNode {
  label: string;
  parent: TreeNode | null;
  children: TreeNode[];
}
interface Input {
  label: string | Default<"Untitled">;
  parent: TreeNode | null | Default<null>;
  registry: Writable<TreeNode[] | Default<[]>>;
}
export interface Output extends TreeNode {
  [UI]: VNode;
}

const Node = pattern<Input, Output>(
  ({ label, parent, registry, [SELF]: self }) => {
    const children = new Writable<TreeNode[]>([]);

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
