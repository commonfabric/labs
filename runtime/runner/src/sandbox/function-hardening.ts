export function hardenVerifiedFunction<T extends (...args: any[]) => unknown>(
  fn: T,
): T {
  Object.freeze(fn);
  const prototype = (fn as { prototype?: unknown }).prototype;
  if (prototype && typeof prototype === "object") {
    Object.freeze(prototype);
  }
  return fn;
}
