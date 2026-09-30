import { FRAMEWORK_RESULT_KEYS } from "@commonfabric/utils/framework-result-keys";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import type ts from "typescript";

import type { TransformationContext } from "../core/mod.ts";

/** The type to name instead, for the keys whose value has a fixed shape. */
const SUGGESTED_TYPE: Readonly<Record<string, string>> = {
  $TYPE: "string",
  $NAME: "string",
  $UI: "VNode",
  $TILE_UI: "VNode",
  $CHIP_UI: "VNode",
};

/**
 * The schema describing the root value, following `$ref` indirection into
 * `$defs`. A `$ref` measures the same value against another schema, so the
 * root is still the root however many schemas describe it — the same rule the
 * runner's schema sanitizer applies when it decides which value's keys are the
 * framework's to name.
 */
function resolveRootSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const seen = new Set<string>();
  let current = schema;
  while (typeof current.$ref === "string") {
    const ref = current.$ref;
    if (seen.has(ref)) return undefined;
    seen.add(ref);
    const path = ref.split("/");
    if (path.length !== 3 || path[0] !== "#" || path[1] !== "$defs") {
      return undefined;
    }
    const defs = schema.$defs;
    if (!isObjectOrArray(defs)) return undefined;
    const target = (defs as Record<string, unknown>)[path[2]!];
    if (!isObjectNotArray(target)) {
      return undefined;
    }
    current = target as Record<string, unknown>;
  }
  return current;
}

/** Whether a property schema leaves the value it describes unmaterialized. */
function isOpaque(schema: unknown): boolean {
  return isObjectNotArray(schema) &&
    (schema as Record<string, unknown>).type === "unknown";
}

/**
 * Report a pattern whose own result declares a reserved key opaque.
 *
 * A reserved key's spelling belongs to the framework rather than to whoever
 * described it, so at the root of a result the value under it is one this
 * pattern produced: the screen it just built, the name it chose. `unknown` is
 * the declaration for a field that holds a reference to another piece, and it
 * projects to an empty object carrying only a back-to-cell annotation. For a
 * field holding a value this pattern produced, that is the whole value gone
 * for every reader of it.
 *
 * The rule reaches the root of a result schema and nothing else. A reserved
 * key one level down names a field of another piece, where staying a reference
 * is what keeps the controls in it bound to the piece that owns them. An
 * argument schema is checked contravariantly — it has to keep accepting every
 * value it accepted before — so a consumer seam cannot narrow it either.
 */
export function reportOpaqueReservedResultKeys(
  context: Pick<TransformationContext, "reportDiagnosticOnce" | "options">,
  schema: unknown,
  anchor: ts.Node,
): void {
  if (!isObjectNotArray(schema)) {
    return;
  }
  const root = resolveRootSchema(schema as Record<string, unknown>);
  const properties = root?.properties;
  if (!isObjectOrArray(properties)) return;
  const offenders = FRAMEWORK_RESULT_KEYS.filter((key) =>
    isOpaque((properties as Record<string, unknown>)[key])
  );
  if (offenders.length === 0) return;

  const plural = offenders.length > 1;
  const names = offenders.map((key) => `\`${key}\``).join(", ");
  const suggestions = offenders.flatMap((key) => {
    const type = SUGGESTED_TYPE[key];
    return type === undefined ? [] : [`${key} holds a \`${type}\``];
  });
  const advice = suggestions.length > 0
    ? ` Name the type the field holds: ${suggestions.join(", ")}.`
    : " Name the type the field holds.";

  context.reportDiagnosticOnce({
    // Admission is judged once; reconstruction re-judges nothing. Stored
    // source already carrying this shape was accepted when it was deployed,
    // and an identity-pinned reload can admit nothing new — so there the
    // report keeps its visibility and loses its veto.
    severity: context.options.storedSource ? "warning" : "error",
    type: "pattern-result:opaque-reserved-key",
    message: `pattern() output ${plural ? "fields" : "field"} ${names} ` +
      `${plural ? "are" : "is"} declared \`unknown\`, so the result schema ` +
      `carries \`{ type: "unknown" }\` there. \`unknown\` declares a field ` +
      `that holds a reference to another piece. A reader of such a field ` +
      `gets an opaque reference carrying no properties rather than the ` +
      `value. A reserved key at the root of a result holds what this ` +
      `pattern produced: the screen it built, the name it chose. Declaring ` +
      `it \`unknown\` throws that value away for every reader. The screen ` +
      `goes on rendering, because the renderer supplies its own schema and ` +
      `never reads the declared one.${advice} Below the root, and on the ` +
      `argument side, a reserved key may stay \`unknown\`: there it does ` +
      `name another piece's field.`,
    node: anchor,
  });
}
