export function oneOf<T extends string>(
  value: unknown,
  validValues: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" &&
      (validValues as readonly string[]).includes(value)
    ? value as T
    : fallback;
}
