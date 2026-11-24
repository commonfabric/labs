type Default<T, V extends T = T> = T;
interface SchemaRoot {
  maybe: Default<string | null, null>;
}
