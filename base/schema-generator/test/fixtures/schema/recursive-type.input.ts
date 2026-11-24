// Self-recursive type: LinkedList → LinkedList
interface LinkedList {
  value: number;
  next?: LinkedList;
}

// Root type for schema generation
type SchemaRoot = LinkedList;
