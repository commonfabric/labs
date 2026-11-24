interface MyCell<T> extends BrandedCell<T, "cell"> {}
type OptionalCell = MyCell<number> | undefined;
type NullableCell = MyCell<string> | null;

interface SchemaRoot {
  // this will be required, but can be set to undefined
  maybeCell: OptionalCell;
  nullableCell: NullableCell;
}
