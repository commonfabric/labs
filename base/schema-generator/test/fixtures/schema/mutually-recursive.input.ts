// Mutually recursive pattern: NodeA ↔ NodeB
interface NodeA {
  value: string;
  nodeB: NodeB;
}

interface NodeB {
  value: number;
  nodeA: NodeA;
}

// Root type for schema generation
type SchemaRoot = NodeA;
