// Nested recursive: RootType contains recursive LinkedList
interface LinkedList {
  value: number;
  next?: LinkedList;
}

interface RootType {
  list: LinkedList;
}

// Root type for schema generation
type SchemaRoot = RootType;
