/**
 * Type predicate function used to determine if an arbitrary value is in fact
 * considered to be the `PlusType`. The `data-model` generally aims to only ever
 * pass `value`s that it receives as being typed to be in the `FabricValuePlus`
 * family, narrowed to the same `PlusType`, and only in cases where a shallow
 * inspection of the value indicates that it is not possibly a valid
 * `FabricValue` or `FabricValueLayer`, or the _container_ options of
 * `FabricValuePlus` or `FabricValuePlusLayer`. That said, by the time a
 * function of this type is called, there is an open question as to what the
 * actual type is, and it should be prepared to deal with a "typesystem lie" of
 * some sort, hence `value` is typed as `unknown` instead of a more-specific
 * `FabricValue`-ish type.
 */
export type PlusTypePredicate<PlusType> = (
  value: unknown,
) => value is PlusType;
