import type { JSONSchema } from "@commonfabric/api";
import { isObjectNotArray } from "@commonfabric/js-values/types";

/** Remove runner-owned inputs from the schema exposed to an external caller. */
export function stripFrameworkProvidedPaths(
  schema: JSONSchema,
  paths: readonly (readonly string[])[],
): JSONSchema {
  let result = schema;
  for (const path of paths) {
    result = stripFrameworkProvidedPath(result, path);
  }
  return result;
}

function stripFrameworkProvidedPath(
  schema: JSONSchema,
  path: readonly string[],
): JSONSchema {
  if (!isObjectNotArray(schema) || path.length === 0) return schema;
  let result = schema;
  for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = result[keyword];
    if (Array.isArray(branches)) {
      result = {
        ...result,
        [keyword]: branches.map((branch) =>
          stripFrameworkProvidedPath(branch, path)
        ),
      };
    }
  }
  const [head, ...tail] = path;
  if (!head || !isObjectNotArray(result.properties)) return result;
  const existing = result.properties[head] as JSONSchema | undefined;
  if (existing === undefined) return result;

  const properties = { ...result.properties };
  let removeFromRequired = tail.length === 0;
  if (tail.length === 0) {
    delete properties[head];
  } else {
    const strippedChild = stripFrameworkProvidedPath(existing, tail);
    if (isSystemOnlyObjectSchema(strippedChild)) {
      delete properties[head];
      removeFromRequired = true;
    } else {
      properties[head] = strippedChild;
      removeFromRequired = !hasRequiredAuthoredProperty(strippedChild);
    }
  }
  return {
    ...result,
    properties,
    ...(Array.isArray(result.required)
      ? {
        required: removeFromRequired
          ? result.required.filter((key) => key !== head)
          : result.required,
      }
      : {}),
  };
}

function isSystemOnlyObjectSchema(schema: JSONSchema): boolean {
  if (!isObjectNotArray(schema) || schema.type !== "object") return false;
  if (
    !isObjectNotArray(schema.properties) ||
    Object.keys(schema.properties).length > 0
  ) {
    return false;
  }
  return Object.keys(schema).every((key) =>
    key === "type" || key === "properties" || key === "required"
  );
}

function hasRequiredAuthoredProperty(schema: JSONSchema): boolean {
  return isObjectNotArray(schema) && Array.isArray(schema.required) &&
    schema.required.length > 0;
}

/** Overwrite runner-owned inputs with a value derived from trusted identity. */
export function applyFrameworkProvidedInputs(
  args: Record<string, unknown>,
  paths: readonly (readonly string[])[],
  stableEntityId: string | undefined,
): Record<string, unknown> {
  if (paths.length === 0) return args;
  if (typeof stableEntityId !== "string" || stableEntityId.length === 0) {
    throw new Error(
      "Cannot provide FrameworkProvided factory inputs: tool instance has no stable entity id",
    );
  }
  const value = stableEntityId.replace(/[^A-Za-z0-9_-]/g, "-");
  let result = args;
  for (const path of paths) {
    result = setFrameworkProvidedPath(result, path, value);
  }
  return result;
}

function setFrameworkProvidedPath(
  input: Record<string, unknown>,
  path: readonly string[],
  value: string,
): Record<string, unknown> {
  const [head, ...tail] = path;
  if (!head) return input;
  if (tail.length === 0) return { ...input, [head]: value };
  const existing = input[head];
  const child = isObjectNotArray(existing) ? { ...existing } : {};
  return {
    ...input,
    [head]: setFrameworkProvidedPath(child, tail, value),
  };
}
