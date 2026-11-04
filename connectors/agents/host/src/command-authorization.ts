import { decodeJsonPointer, type Pattern } from "@commonfabric/runner";

/** `value` when it is a plain object, and `undefined` otherwise. */
export function recordValue(
  value: unknown,
): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

/**
 * The verified writer binding a pattern declares for the command queue it
 * sends to, read from the `commandAuthorization` field of its result schema.
 * Returns `undefined` for a pattern that declares none.
 */
export function commandWriterAuthorization(
  pattern: Pattern,
): unknown | undefined {
  const root = recordValue(pattern.resultSchema);
  const properties = recordValue(root?.properties);
  let authorization = recordValue(properties?.commandAuthorization);
  const reference = authorization?.$ref;
  if (typeof reference === "string" && reference.startsWith("#/$defs/")) {
    // A local definition reference is one JSON Pointer segment under
    // `$defs`: percent-encoded as a URI fragment, and `~`-escaped as a
    // pointer, so a definition named with `/` or `~` resolves too.
    const segments = decodeJsonPointer(
      decodeURIComponent(reference.slice("#/$defs/".length)),
    );
    const definitions = recordValue(root?.$defs);
    authorization = segments.length === 1
      ? recordValue(definitions?.[segments[0]])
      : undefined;
  }
  const ifc = recordValue(authorization?.ifc);
  const writers = ifc?.writeAuthorizedBy;
  return writers === null ? undefined : writers;
}

/**
 * The identity of the module that defines a declared command writer, or
 * `undefined` when the declaration names none.
 */
export function writerModuleIdentity(
  authorization: unknown,
): string | undefined {
  const identity = recordValue(
    recordValue(authorization)?.__ctWriterIdentityOf,
  )?.moduleIdentity;
  return typeof identity === "string" ? identity : undefined;
}
