type Default<T, V extends T = T> = T;
interface SchemaRoot {
  cellOfDefault: Cell<Default<string, "d">>;
  defaultArray: Default<string[], ["a", "b"]>;
}
