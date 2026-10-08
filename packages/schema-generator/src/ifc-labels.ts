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
 *
 * Where a value holds data of a declaration's only in part, as a member of an
 * intersection may, the labels divide by where they belong. A restriction
 * belongs wherever that data may be; evidence (`EVIDENCE_LABELS`) only where
 * it must be, so evidence is dropped, not combined, where the value is not
 * provably that declaration's: beside `any` (`labelsBesideAnyValue()`), and
 * on members another declaration holds.
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
 * The labels that are evidence a value carries, which a part of a value may
 * carry only where it provably came from the policy's payload. Every other
 * label restricts what may happen to the value or is a claim the runtime
 * verifies at the write, and is safe wherever the payload's data may be.
 */
export const EVIDENCE_LABELS: ReadonlySet<string> = new Set([
  "integrity",
  "addIntegrity",
]);

/**
 * The keywords a schema accepting any value may carry: what it states about
 * the whole value (`scope`, `default`), its labels, and its documentation.
 */
const BESIDE_ANY_VALUE: ReadonlySet<string> = new Set([
  "ifc",
  "scope",
  "default",
  "description",
  "tags",
  "deprecated",
  "$comment",
]);

/**
 * `labels` divided into the restrictions among them and the evidence
 * (`EVIDENCE_LABELS`), each `undefined` where there is none.
 */
export const restrictionsAndEvidence = (
  labels: IfcLabels,
): {
  readonly restrictions?: Record<string, unknown>;
  readonly evidence?: Record<string, unknown>;
} => {
  const restrictions: Record<string, unknown> = {};
  const evidence: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(labels)) {
    (EVIDENCE_LABELS.has(key) ? evidence : restrictions)[key] = value;
  }
  return {
    ...(Object.keys(restrictions).length > 0 ? { restrictions } : {}),
    ...(Object.keys(evidence).length > 0 ? { evidence } : {}),
  };
};

/** Whether `schema` accepts any value, whatever it states beside that. */
export const acceptsAnyValue = (schema: MutableJSONSchema): boolean =>
  schema === true ||
  (isObjectOrArray(schema) && !Array.isArray(schema) &&
    Object.keys(schema).every((key) => BESIDE_ANY_VALUE.has(key)));

/** Whether `schema` accepts no value, whatever it states beside that. */
export const acceptsNoValue = (schema: MutableJSONSchema): boolean =>
  schema === false ||
  (isObjectOrArray(schema) && !Array.isArray(schema) &&
    schema.not === true &&
    Object.keys(schema).every((key) =>
      key === "not" || BESIDE_ANY_VALUE.has(key)
    ));

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
 * Whether `held` already declares every label `labels` does: each
 * confidentiality atom, and every other key alike.
 */
export const holdsIfcLabels = (
  held: IfcLabels,
  labels: IfcLabels,
): boolean =>
  Object.entries(labels).every(([key, declared]) => {
    if (declared === undefined) return true;
    const existing = held[key];
    return key === "confidentiality" && Array.isArray(existing) &&
        Array.isArray(declared)
      ? declared.every((atom) =>
        existing.some((have) =>
          valueEqual(have as FabricValue, atom as FabricValue)
        )
      )
      : existing !== undefined &&
        valueEqual(existing as FabricValue, declared as FabricValue);
  });

/**
 * The labels of a value that may be any one of `members`, a union's, under
 * the union's own `labels`: every confidentiality atom any of them declares,
 * the union's other labels, and each other label every member declares alike.
 * A member's other labels bind only while the value is that member.
 */
export const joinMemberIfcLabels = (
  labels: IfcLabels,
  members: readonly IfcLabels[],
): Record<string, unknown> | undefined => {
  const joined: Record<string, unknown> = { ...labels };
  const atoms = [labels, ...members].flatMap(({ confidentiality }) =>
    Array.isArray(confidentiality) ? confidentiality : []
  );
  if (atoms.length > 0) {
    joined.confidentiality = dedupeByValueEqual(atoms as FabricValue[]);
  }
  const [first, ...rest] = members;
  for (const [key, declared] of Object.entries(first ?? {})) {
    if (key === "confidentiality" || declared === undefined || key in joined) {
      continue;
    }
    if (
      rest.every((member) =>
        member[key] !== undefined &&
        valueEqual(member[key] as FabricValue, declared as FabricValue)
      )
    ) {
      joined[key] = declared;
    }
  }
  return Object.keys(joined).length > 0 ? joined : undefined;
};

/**
 * `schema` with `labels` combined into its own, as an outer declaration's.
 */
export const withIfcLabels = (
  schema: MutableJSONSchema,
  labels: IfcLabels,
): MutableJSONSchema => {
  if (typeof schema === "boolean") {
    return schema === false ? { not: true, ifc: labels } : { ifc: labels };
  }
  const existing = isObjectOrArray(schema.ifc) ? schema.ifc : {};
  return { ...schema, ifc: combineIfcLabels(existing, labels) };
};

/**
 * `position` and the definitions its chain of local references reaches in
 * `definitions`, nearest first. A chain that comes back to a definition
 * already on it ends there: walking it again would add nothing.
 */
export const referenceChain = (
  position: MutableJSONSchemaObj,
  definitions: Readonly<Record<string, MutableJSONSchema>>,
): MutableJSONSchemaObj[] => {
  const chain = [position];
  const reached = new Set<string>();
  for (let at = position;;) {
    const ref = at.$ref;
    if (typeof ref !== "string" || !ref.startsWith(LOCAL_DEFINITION_PREFIX)) {
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

/**
 * The labels of every declaration along `position`'s reference chain in
 * `definitions`, combined, or `undefined` where none declares any. The
 * farthest definition's labels are the innermost declaration.
 */
export const declaredIfcLabels = (
  position: MutableJSONSchema,
  definitions: Readonly<Record<string, MutableJSONSchema>>,
): Record<string, unknown> | undefined => {
  if (!isObjectOrArray(position)) return undefined;
  let labels: Record<string, unknown> | undefined;
  for (const declaring of referenceChain(position, definitions).reverse()) {
    if (isObjectOrArray(declaring.ifc)) {
      labels = combineIfcLabels(labels ?? {}, declaring.ifc);
    }
  }
  return labels;
};

/**
 * Whether `schema` accepts only `null`, `undefined`, or both: written so, or a
 * bare local reference whose definition in `definitions`, through any further
 * bare references, is.
 */
const isNullishSchema = (
  schema: MutableJSONSchema,
  definitions: Readonly<Record<string, MutableJSONSchema>>,
): boolean => {
  if (!isObjectOrArray(schema)) return false;
  const chain = referenceChain(schema, definitions);
  const last = chain[chain.length - 1]!;
  return chain.every((link) => Object.keys(link).length === 1) &&
    (Array.isArray(last.type) ? last.type : [last.type]).every((type) =>
      type === "null" || type === "undefined"
    );
};

/**
 * The value member of `position`, a union of one value with `null` or
 * `undefined`, where the member declares labels, as the labels in
 * `definitions` its references reach count, and the union declares none of
 * its own: a value that may be missing, whose labels formatting put on its
 * value member. `undefined` for any other position.
 */
export const labeledValueMember = (
  position: MutableJSONSchema,
  definitions: Readonly<Record<string, MutableJSONSchema>>,
): MutableJSONSchemaObj | undefined => {
  if (
    !isObjectOrArray(position) || !Array.isArray(position.anyOf) ||
    isObjectOrArray(position.ifc)
  ) {
    return undefined;
  }
  const values = position.anyOf.filter((member) =>
    !isNullishSchema(member, definitions)
  );
  const [member] = values;
  return values.length === 1 && values.length < position.anyOf.length &&
      isObjectOrArray(member) &&
      declaredIfcLabels(member, definitions) !== undefined
    ? member
    : undefined;
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

  const visited = new Set<MutableJSONSchema>();
  const visit = (node: MutableJSONSchema): void => {
    if (!isObjectOrArray(node) || visited.has(node)) return;
    visited.add(node);
    if (typeof node.$ref === "string" && isObjectOrArray(node.ifc)) {
      node.ifc = declaredIfcLabels(node, definitions) as NonNullable<
        MutableJSONSchemaObj["ifc"]
      >;
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

/**
 * The labels an intersection keeps of `constituents` where the checker gives
 * it `any`, combined, or `undefined` where it keeps none. A constituent that
 * itself accepts any value is the whole value, and keeps every label it
 * states. Of any other, the value may hold that constituent's data anywhere
 * and is not provably its value: its restrictions, wherever in its value they
 * are written and through the definitions in `definitions` its references
 * reach, go on the whole value, and its evidence (`EVIDENCE_LABELS`) goes
 * nowhere. A definition a reference names that `definitions` does not hold
 * yet, as one still being generated does not, is added to `unwritten`.
 */
export const labelsBesideAnyValue = (
  constituents: readonly MutableJSONSchema[],
  definitions: Readonly<Record<string, MutableJSONSchema>>,
  unwritten?: Set<string>,
): Record<string, unknown> | undefined => {
  let kept: Record<string, unknown> | undefined;
  const keep = (labels: IfcLabels) => {
    if (Object.keys(labels).length > 0) {
      kept = combineIfcLabels(kept ?? {}, labels);
    }
  };
  for (const constituent of constituents) {
    if (acceptsAnyValue(constituent)) {
      if (isObjectOrArray(constituent) && isObjectOrArray(constituent.ifc)) {
        keep(constituent.ifc);
      }
      continue;
    }
    const visited = new Set<MutableJSONSchema>();
    const visit = (node: MutableJSONSchema): void => {
      if (!isObjectOrArray(node) || visited.has(node)) return;
      visited.add(node);
      if (isObjectOrArray(node.ifc)) {
        keep(restrictionsAndEvidence(node.ifc).restrictions ?? {});
      }
      if (
        typeof node.$ref === "string" &&
        node.$ref.startsWith(LOCAL_DEFINITION_PREFIX)
      ) {
        const name = node.$ref.slice(LOCAL_DEFINITION_PREFIX.length);
        const definition = definitions[name];
        if (definition !== undefined) visit(definition);
        else unwritten?.add(name);
      }
      forEachSubschema(node, (child) => {
        visit(child as MutableJSONSchema);
        return false;
      }, { includeUnused: true });
    };
    visit(constituent);
  }
  return kept;
};

/**
 * A value an intersection the checker gives `any` settled to, which met
 * definitions not yet written (`unwritten`) in `definitions`, and the labels
 * it kept (`labelsBesideAnyValue()`).
 */
export type AnyValueBesideUnwritten = {
  readonly definitions: Readonly<Record<string, MutableJSONSchema>>;
  readonly unwritten: readonly string[];
  readonly kept: IfcLabels | undefined;
};

/**
 * Refuses a value in `values` that kept fewer restrictions than the
 * definitions it met before they were written state now that they are: a
 * reference met inside its own definition, as recursion meets it, names a
 * definition whose labels could not be read there.
 */
export const assertAnyValuesKeptLabels = (
  values: readonly AnyValueBesideUnwritten[],
): void => {
  for (const { definitions, unwritten, kept } of values) {
    for (const name of unwritten) {
      const stated = labelsBesideAnyValue(
        [{ $ref: `${LOCAL_DEFINITION_PREFIX}${name}` }],
        definitions,
      );
      if (stated !== undefined && !holdsIfcLabels(kept ?? {}, stated)) {
        throw new Error(
          `A value intersected with \`any\` keeps the labels of what it is ` +
            `intersected with, but it meets \`${name}\` inside the ` +
            `definition of \`${name}\`, where those labels cannot be read ` +
            `yet. Declare that value without \`any\`, or with the labels ` +
            `\`${name}\` states.`,
        );
      }
    }
  }
};
