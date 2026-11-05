// A user-local alias with a reserved public name is still an ordinary callable.
// Only Common Fabric declarations or compiler-owned schema hints may emit
// `asFactory`.
type PatternFactory<T, R> = (input: T) => R;

interface SchemaRoot {
  label: string;
  operation: PatternFactory<{ query: string }, { count: number }>;
}
