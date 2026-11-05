/**
 * Returns the class name of the given object, or `<anonymous>` when it has
 * none. A class with no name reports it as the empty string, which counts.
 */
export function classNameOf(value: object): string {
  const name = (value as { constructor?: { name?: unknown } }).constructor
    ?.name;
  return ((typeof name === "string") && (name !== "")) ? name : "<anonymous>";
}
