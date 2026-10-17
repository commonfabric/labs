/**
 * Reading a generated schema's local references, written `#/$defs/<name>`,
 * into the definitions they name. Shared by the checks that read a pattern's
 * result schema.
 */
import { isObjectNotArray } from "@commonfabric/utils/types";

/** A `$defs` entry a local reference names, with its name. */
export interface LocalDefinition {
  /** The entry's name under `$defs`. */
  readonly name: string;

  /** The entry's schema. */
  readonly schema: Readonly<Record<string, unknown>>;
}

/**
 * The entry of `root.$defs` that `ref` names, when `ref` is a local reference
 * written `#/$defs/<name>` and the entry is a schema object. A reference of
 * any other form, a name holding a `/`, and a name `root` does not define all
 * name nothing here.
 */
export function localDefinition(
  root: Readonly<Record<string, unknown>>,
  ref: unknown,
): LocalDefinition | undefined {
  if (typeof ref !== "string") return undefined;
  const path = ref.split("/");
  if (path.length !== 3 || path[0] !== "#" || path[1] !== "$defs") {
    return undefined;
  }
  const name = path[2]!;
  const definitions = root.$defs;
  if (!isObjectNotArray(definitions)) return undefined;
  const schema = definitions[name];
  return isObjectNotArray(schema) ? { name, schema } : undefined;
}
