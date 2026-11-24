// Nested mutual recursion: TreeNode ↔ TreeBranch
interface TreeNode {
  value: number;
  left?: TreeBranch;
  right?: TreeBranch;
}

interface TreeBranch {
  node: TreeNode;
  metadata: string;
}

// Root type for schema generation
type SchemaRoot = TreeNode;
