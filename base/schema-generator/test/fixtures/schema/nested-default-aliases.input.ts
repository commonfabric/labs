type Default<T, V extends T = T> = T;
type UserDefault<T, V extends T = T> = Default<T, V>;
type MyDefault<T, V extends T = T> = UserDefault<T, V>;

interface SchemaRoot {
  directDefault: Default<string, "direct">;
  singleAlias: UserDefault<string, "single">;
  doubleAlias: MyDefault<string, "double">;
}
