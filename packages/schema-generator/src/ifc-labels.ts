/**
 * How the `ifc` labels of one value combine when more than one declaration
 * gives it some.
 *
 * A value is labeled more than once when CFC wrappers nest
 * (`Confidential<Confidential<T, A>, B>`), and when a wrapper goes around a
 * named type whose definition is itself labeled: the wrapper's label is then
 * written beside the `$ref` to that definition. Confidentiality labels join,
 * since the value is confidential under every label any wrapper gave it. The
 * other `ifc` keys have no agreed way to combine yet, so two declarations of
 * one must agree, or generation fails; keeping one and dropping the other
 * would be silent.
 *
 * The label beside a `$ref` states the labels of the definitions it reaches as
 * well as its own. Resolving a reference lets each keyword beside it replace
 * the definition's, and `ifc` is one keyword, so a label left out there is a
 * label the resolved schema does not have.
 */

import type {
  MutableJSONSchema,
  MutableJSONSchemaObj,
} from "@commonfabric/api";
import {
  debugStr,
  type FabricValue,
  valueEqual,
} from "@commonfabric/data-model";
import { forEachSubschema } from "@commonfabric/data-model-schema/schema-walk";
import { isObjectOrArray } from "@commonfabric/utils/types";
import { dedupeByValueEqual } from "./value-equality.ts";

type IfcLabels = Readonly<Record<string, unknown>>;

const LOCAL_DEFINITION_PREFIX = "#/$defs/";

/**
 * The labels of one value that `inner` and then `outer` both declared:
 * confidentiality joined, every other key declared by one of them or alike by
 * both. A key declared as `undefined` (a label the lowering could not read)
 * counts as not declared.
 */
export const combineIfcLabels = (
  inner: IfcLabels,
  outer: IfcLabels,
): Record<string, unknown> => {
  const combined: Record<string, unknown> = { ...inner };
  for (const key of Object.keys(outer)) {
    const declared = outer[key];
    if (declared === undefined) continue;
    const existing = combined[key];
    if (existing === undefined) {
      combined[key] = declared;
    } else if (
      key === "confidentiality" && Array.isArray(existing) &&
      Array.isArray(declared)
    ) {
      combined[key] = dedupeByValueEqual(
        [...existing, ...declared] as FabricValue[],
      );
    } else if (
      !valueEqual(existing as FabricValue, declared as FabricValue)
    ) {
      throw new Error(
        debugStr`One value declares \`ifc.${key}\` twice, as ` +
          debugStr`$quote${existing} and as $quote${declared}. Only ` +
          `confidentiality labels combine; declare this one once.`,
      );
    }
  }
  return combined;
};

/**
 * Writes beside each local `$ref` that carries `ifc` the labels of the
 * definitions it reaches, combined with its own, so that resolving the
 * reference keeps all of them. A definition keeps its own labels, which are
 * all that a reference with no label of its own resolves to.
 *
 * It rewrites `ifc` in place, on positions the formatter built for this
 * generation: a label beside a reference is only ever written there.
 */
export const stateReferencedIfcLabels = (schema: MutableJSONSchema): void => {
  if (!isObjectOrArray(schema)) return;
  const definitions = isObjectOrArray(schema.$defs) ? schema.$defs : {};

  // A position and the definitions its reference chain reaches, nearest
  // first. A chain that comes back to a definition already on it ends there:
  // walking it again would add nothing.
  const chainOf = (position: MutableJSONSchemaObj): MutableJSONSchemaObj[] => {
    const chain = [position];
    const reached = new Set<string>();
    for (let at = position;;) {
      const ref = at.$ref;
      if (
        typeof ref !== "string" || !ref.startsWith(LOCAL_DEFINITION_PREFIX)
      ) {
        return chain;
      }
      const name = ref.slice(LOCAL_DEFINITION_PREFIX.length);
      const definition = definitions[name];
      if (reached.has(name) || !isObjectOrArray(definition)) return chain;
      reached.add(name);
      chain.push(definition);
      at = definition;
    }
  };

  const visited = new Set<MutableJSONSchema>();
  const visit = (node: MutableJSONSchema): void => {
    if (!isObjectOrArray(node) || visited.has(node)) return;
    visited.add(node);
    if (typeof node.$ref === "string" && isObjectOrArray(node.ifc)) {
      // The farthest definition's labels are the innermost declaration.
      let labels: IfcLabels = {};
      for (const declaring of chainOf(node).reverse()) {
        if (isObjectOrArray(declaring.ifc)) {
          labels = combineIfcLabels(labels, declaring.ifc);
        }
      }
      node.ifc = labels as NonNullable<MutableJSONSchemaObj["ifc"]>;
    }
    // Every keyword the walk reads as holding schemas, `$defs` included (this
    // generator emits no `definitions`); `default`, `const` and `enum` hold
    // data, however it is shaped.
    forEachSubschema(node, (child) => {
      visit(child as MutableJSONSchema);
      return false;
    }, { includeDefs: true, includeUnused: true });
  };
  visit(schema);
};
