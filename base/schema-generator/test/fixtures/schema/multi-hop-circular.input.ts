// Multi-hop circular reference pattern: A → B → C → A
interface A {
  b: B;
}

interface B {
  c: C;
}

interface C {
  a: A;
}

// Root type for schema generation
type SchemaRoot = A;
