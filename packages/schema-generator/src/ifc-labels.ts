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
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import type { GenerationContext } from "./interface.ts";
import { armsDeclareScope } from "./scope-placement.ts";
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

/** The keywords a value of `unknown` may carry beside its `type`. */
const UNKNOWN_VALUE_KEYWORDS: ReadonlySet<string> = new Set([
  "type",
  "description",
  "deprecated",
  "$comment",
]);

/**
 * Whether `schema` is `unknown` alone: its `type` and documentation, so a
 * labeled `unknown`, or a cell of one, is not. It is the identity of an
 * intersection, and accepts any value.
 */
export const isUnknownValue = (schema: MutableJSONSchema): boolean =>
  isObjectOrArray(schema) && schema.type === "unknown" &&
  Object.keys(schema).every((key) => UNKNOWN_VALUE_KEYWORDS.has(key));

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

/** The labels `schema` declares on itself, none where it declares none. */
const ownIfcLabels = (schema: unknown): IfcLabels =>
  isObjectNotArray(schema) && isObjectNotArray(schema.ifc) ? schema.ifc : {};

/** The members `schema` lists by name, where it lists any. */
const listedMembers = (
  schema: MutableJSONSchema,
): Record<string, MutableJSONSchema> | undefined =>
  isObjectNotArray(schema) && isObjectNotArray(schema.properties)
    ? schema.properties as Record<string, MutableJSONSchema>
    : undefined;

/**
 * A schema of `schema`'s shape alone, as labels are placed on it: an object
 * with each of its members, accepting anything, where it has any, and
 * otherwise a schema accepting anything. Each member of a value that may be
 * any one of several has its labels placed on one, to be joined
 * (`joinPlacedIfcLabels()`).
 */
export const placementShape = (schema: MutableJSONSchema): MutableJSONSchema =>
  isObjectNotArray(schema) && isObjectNotArray(schema.properties)
    ? {
      type: "object",
      properties: Object.fromEntries(
        Object.keys(schema.properties).map((name) => [name, {}]),
      ),
    }
    : {};

/**
 * `schema`, the schema of a value that may be any one of several members,
 * with their labels joined where they land: `placed` holds, for each member,
 * a schema of the value's shape alone carrying the labels that member puts
 * on the whole value and on each member of the value. The whole value
 * carries those each puts on the whole, joined (`joinMemberIfcLabels()`). A
 * label on the whole value is on each of its members too, so a member of the
 * value carries every confidentiality atom any of them puts on it, and each
 * other label every one of them puts on it or on the whole value alike, past
 * those the whole value carries already.
 */
export const joinPlacedIfcLabels = (
  schema: MutableJSONSchema,
  placed: readonly MutableJSONSchema[],
): MutableJSONSchema => {
  const wholes = placed.map(ownIfcLabels);
  const whole = joinMemberIfcLabels({}, wholes) ?? {};
  const held = Array.isArray(whole.confidentiality)
    ? whole.confidentiality
    : [];
  const members = listedMembers(schema);
  const labeled = members && { ...members };
  for (const name of Object.keys(members ?? {})) {
    const own = placed.map((member) =>
      ownIfcLabels(listedMembers(member)?.[name])
    );
    let labels: Record<string, unknown> = {};
    const atoms = own.flatMap(({ confidentiality }) =>
      Array.isArray(confidentiality) ? confidentiality : []
    ).filter((atom) =>
      !held.some((have) => valueEqual(have as FabricValue, atom as FabricValue))
    );
    if (atoms.length > 0) {
      labels.confidentiality = dedupeByValueEqual(atoms as FabricValue[]);
    }
    for (
      const [key, declared] of [
        ...Object.entries(wholes[0] ?? {}),
        ...Object.entries(own[0] ?? {}),
      ]
    ) {
      if (key === "confidentiality" || declared === undefined) continue;
      const alike = (value: unknown) =>
        value !== undefined &&
        valueEqual(value as FabricValue, declared as FabricValue);
      if (
        !alike(whole[key]) &&
        wholes.every((onWhole, index) =>
          alike(onWhole[key]) || alike(own[index]![key])
        )
      ) {
        labels = combineIfcLabels(labels, { [key]: declared });
      }
    }
    if (Object.keys(labels).length > 0) {
      labeled![name] = withIfcLabels(labeled![name]!, labels);
    }
  }
  const joined = labeled
    ? { ...(schema as MutableJSONSchemaObj), properties: labeled }
    : schema;
  return Object.keys(whole).length > 0 ? withIfcLabels(joined, whole) : joined;
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
 * The key a view's `ifc` holds, during one generation, where it read a writer
 * policy without its writer (`settlePoliciesReadInPart()`). The generation
 * removes it before it returns the schema.
 */
export const POLICY_READ_IN_PART = "__ctPolicyReadInPart";

/**
 * Whether `value`, a label atom or a part of one, names the current principal
 * (`CurrentPrincipal`, lowered as `{ __ctCurrentPrincipal: true }`).
 */
const namesCurrentPrincipal = (value: unknown): boolean =>
  isObjectOrArray(value) &&
  ((!Array.isArray(value) && value.__ctCurrentPrincipal === true) ||
    Object.values(value).some(namesCurrentPrincipal));

/**
 * `labels` without the principal claims the runtime enforces only beside a
 * writer: an `ownerPrincipal`, and each `integrity` or `addIntegrity` atom
 * naming the current principal. A write against either, with no writer
 * declared beside it, is refused. `undefined` where nothing else is left.
 */
const withoutWriterBoundClaims = (
  labels: Readonly<Record<string, unknown>>,
): Record<string, unknown> | undefined => {
  const kept: Record<string, unknown> = { ...labels };
  delete kept.ownerPrincipal;
  for (const key of ["integrity", "addIntegrity"] as const) {
    const atoms = kept[key];
    if (!Array.isArray(atoms)) continue;
    const rest = atoms.filter((atom) => !namesCurrentPrincipal(atom));
    if (rest.length > 0) kept[key] = rest;
    else delete kept[key];
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
};

/**
 * Settles each writer policy a view read in part (`POLICY_READ_IN_PART`),
 * once the whole schema is generated, so that the view holds the policy whole
 * or not at all. Where the writer arrived since, as a label the value's
 * declaration states merged in beside the part read, the policy is whole and
 * stays. Where none did, its principal claims are left out with the writer
 * (`withoutWriterBoundClaims()`), since either alone refuses every write
 * against it.
 *
 * It rewrites `ifc` in place, on positions the formatter built for this
 * generation, as `stateReferencedIfcLabels()` does.
 */
export const settlePoliciesReadInPart = (schema: MutableJSONSchema): void => {
  if (!isObjectOrArray(schema)) return;
  const visited = new Set<MutableJSONSchema>();
  const visit = (node: MutableJSONSchema): void => {
    if (!isObjectOrArray(node) || visited.has(node)) return;
    visited.add(node);
    if (isObjectOrArray(node.ifc) && POLICY_READ_IN_PART in node.ifc) {
      const { [POLICY_READ_IN_PART]: _, ...labels } = node.ifc as Record<
        string,
        unknown
      >;
      const kept = labels.writeAuthorizedBy !== undefined ||
          labels.writePolicyAnyOf !== undefined
        ? labels
        : withoutWriterBoundClaims(labels);
      if (kept) node.ifc = kept as NonNullable<MutableJSONSchemaObj["ifc"]>;
      else delete node.ifc;
    }
    forEachSubschema(node, (child) => {
      visit(child as MutableJSONSchema);
      return false;
    }, { includeDefs: true, includeUnused: true });
  };
  visit(schema);
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
    forEachIfcLabels(
      constituent,
      definitions,
      (labels) => keep(restrictionsAndEvidence(labels).restrictions ?? {}),
      unwritten,
    );
  }
  return kept;
};

/**
 * Calls `found` with the `ifc` labels of each schema in `schema`'s value that
 * states some: its own, and those of every schema below it and of the
 * definitions in `definitions` its local references reach, each schema once.
 * A definition a reference names that `definitions` does not hold yet, as
 * one still being generated does not, is added to `unwritten`.
 */
const forEachIfcLabels = (
  schema: MutableJSONSchema,
  definitions: Readonly<Record<string, MutableJSONSchema>>,
  found: (labels: IfcLabels) => void,
  unwritten?: Set<string>,
): void => {
  const visited = new Set<MutableJSONSchema>();
  const visit = (at: MutableJSONSchema): void => {
    if (!isObjectOrArray(at) || visited.has(at)) return;
    visited.add(at);
    if (isObjectNotArray(at.ifc)) found(at.ifc);
    if (
      typeof at.$ref === "string" &&
      at.$ref.startsWith(LOCAL_DEFINITION_PREFIX)
    ) {
      const name = at.$ref.slice(LOCAL_DEFINITION_PREFIX.length);
      const definition = definitions[name];
      if (definition !== undefined) visit(definition);
      else unwritten?.add(name);
    }
    forEachSubschema(at, (child) => {
      visit(child as MutableJSONSchema);
      return false;
    }, { includeUnused: true });
  };
  visit(schema);
};

/**
 * The labels of a value that may be any of `arms`, a union's, of which those
 * in `accepting` accept any value, joined (`joinMemberIfcLabels()`): an arm
 * accepting anything contributes the labels it states, and any other arm
 * those it states and each confidentiality atom anywhere in its value,
 * through the definitions in `definitions` its references reach.
 */
const reducedArmLabels = (
  arms: readonly MutableJSONSchema[],
  accepting: readonly MutableJSONSchema[],
  definitions: Readonly<Record<string, MutableJSONSchema>>,
): IfcLabels | undefined =>
  joinMemberIfcLabels(
    {},
    arms.map((arm): IfcLabels => {
      const declared = isObjectNotArray(arm) && isObjectNotArray(arm.ifc)
        ? arm.ifc
        : {};
      if (accepting.includes(arm)) return declared;
      let confidentiality: IfcLabels = {};
      forEachIfcLabels(arm, definitions, (found) => {
        confidentiality = combineIfcLabels(confidentiality, {
          confidentiality: found.confidentiality,
        });
      });
      return { ...declared, ...confidentiality };
    }),
  );

/**
 * The schema of a union whose `arms` include one accepting any value, as
 * `any` or a bare `unknown` does (`acceptsAnyValue()`, `isUnknownValue()`),
 * where some arm states a label anywhere in its value: the arm the checker
 * reduces the union to, `any | X` to `any` and `unknown | X` to `unknown`,
 * `any` winning, labeled with the arms' labels joined as a value that may be
 * any of them is (`joinMemberIfcLabels()`). That is each confidentiality atom
 * any arm states anywhere in its value, through its references, and each
 * other label every arm states alike, so an arm accepting anything that
 * states none leaves the value no evidence. The labels go on the whole value
 * because the runtime keeps a union arm's labels only beside arms that cannot
 * hold the same values, and an arm accepting anything can hold any. The arms
 * are recorded (`GenerationContext.schemaOrigins`, `"reduction"`) for a
 * reading that maps the value one arm at a time, as `Pick` and `Omit` do. An
 * option accepting no value, as `never` gives, is no arm of the union, and is
 * neither read nor recorded (`acceptsNoValue()`). `undefined` for any other
 * union, which keeps its arms, and for one with an arm that declares a scope
 * (`armsDeclareScope()`): it keeps its arms too, so the scope's placement
 * inside the union is refused rather than the scope reduced away.
 *
 * An arm may reach a definition not written yet, as one still being
 * generated is not, whose labels cannot be read here. The union is then
 * read again once generation is done (`anyValuesBesideUnwritten`), and
 * refused where its arms state a restriction the value did not keep. So is a
 * union that states no label here, of which an arm is `true`: the union is
 * `true` too, keeping no label the definition may state.
 */
export const reducedLabeledUnion = (
  options: readonly MutableJSONSchema[],
  context: GenerationContext,
): MutableJSONSchema | undefined => {
  const arms = options.filter((option) => !acceptsNoValue(option));
  if (armsDeclareScope(arms)) return undefined;
  const accepting = arms.filter((arm) =>
    acceptsAnyValue(arm) || isUnknownValue(arm)
  );
  if (accepting.length === 0 || accepting.length === arms.length) {
    return undefined;
  }
  const unwritten = new Set<string>();
  let labeled = false;
  for (const arm of arms) {
    forEachIfcLabels(
      arm,
      context.definitions,
      () => (labeled = true),
      unwritten,
    );
  }
  const readOnceWritten = (kept: IfcLabels | undefined) => {
    if (unwritten.size === 0) return;
    context.anyValuesBesideUnwritten.push({
      within: "union",
      definitions: context.definitions,
      unwritten: [...unwritten],
      kept,
      arms,
      accepting,
    });
  };
  if (!labeled) {
    if (arms.includes(true)) readOnceWritten(undefined);
    return undefined;
  }
  const labels = reducedArmLabels(arms, accepting, context.definitions);
  readOnceWritten(labels);
  const unknown = accepting.find(isUnknownValue);
  const base: MutableJSONSchemaObj =
    accepting.some(acceptsAnyValue) || unknown === undefined
      ? {}
      : { ...(unknown as MutableJSONSchemaObj) };
  if (labels === undefined && Object.keys(base).length === 0) return true;
  const reduced = labels ? withIfcLabels(base, labels) : base;
  if (isObjectOrArray(reduced)) {
    context.schemaOrigins?.set(reduced as MutableJSONSchemaObj, {
      kind: "reduction",
      parts: () => [...arms],
    });
  }
  return reduced;
};

/**
 * `labeled`, `schema` with `labels` added to it, recording the arms of the
 * union `schema` was reduced from (`reducedLabeledUnion()`) with `labels`
 * added to each, as a label around a union labels whichever arm the value
 * is. `labeled` as it came where `schema` records no reduction.
 */
export const withReducedArmsLabeled = (
  labeled: MutableJSONSchema,
  schema: MutableJSONSchema,
  labels: IfcLabels,
  context: GenerationContext,
): MutableJSONSchema => {
  const origin = isObjectOrArray(schema)
    ? context.schemaOrigins?.get(schema as MutableJSONSchemaObj)
    : undefined;
  if (origin?.kind !== "reduction" || !isObjectOrArray(labeled)) {
    return labeled;
  }
  const parts = origin.parts().map((part) => withIfcLabels(part, labels));
  context.schemaOrigins?.set(labeled as MutableJSONSchemaObj, {
    kind: "reduction",
    parts: () => parts,
  });
  return labeled;
};

/**
 * A value settled to accept any value, which met definitions not yet written
 * (`unwritten`) in `definitions`, and the labels it kept: one an
 * intersection the checker gives `any` settled to (`labelsBesideAnyValue()`),
 * or a union of `arms`, of which those in `accepting` accept any value,
 * reduced to them (`reducedLabeledUnion()`) or made `true` by one.
 */
export type AnyValueBesideUnwritten =
  & {
    readonly definitions: Readonly<Record<string, MutableJSONSchema>>;
    readonly unwritten: readonly string[];
    readonly kept: IfcLabels | undefined;
  }
  & (
    | { readonly within: "intersection" }
    | {
      readonly within: "union";
      readonly arms: readonly MutableJSONSchema[];
      readonly accepting: readonly MutableJSONSchema[];
    }
  );

/**
 * Refuses a value in `values` that kept fewer restrictions than the
 * definitions it met before they were written state now that they are: a
 * reference met inside its own definition, as recursion meets it, names a
 * definition whose labels could not be read there. A union's are the labels
 * its arms state, read as its reduction reads them (`reducedArmLabels()`), to
 * which a written definition adds confidentiality alone. For a union, only a
 * definition `schema`, the schema generated, holds counts: one it does not
 * hold took the union inside it with it, as a recursion through its own
 * argument does, read again one level down and absorbed by the level above.
 */
export const assertAnyValuesKeptLabels = (
  values: readonly AnyValueBesideUnwritten[],
  schema: MutableJSONSchema,
): void => {
  const emitted = isObjectNotArray(schema) && isObjectNotArray(schema.$defs)
    ? schema.$defs
    : {};
  for (const value of values) {
    const { definitions, kept } = value;
    if (value.within === "union") {
      const unwritten = value.unwritten.filter((name) =>
        Object.hasOwn(emitted, name)
      );
      if (unwritten.length === 0) continue;
      const stated = reducedArmLabels(value.arms, value.accepting, definitions);
      if (stated !== undefined && !holdsIfcLabels(kept ?? {}, stated)) {
        const names = unwritten.map((name) => `\`${name}\``).join(", ");
        const inside = unwritten.length === 1
          ? `the definition of ${names}`
          : "their own definitions";
        throw new Error(
          `A union with a member accepting any value is that member, with ` +
            `the labels of every member, but it meets ${names} inside ` +
            `${inside}, where those labels cannot be read yet. Declare that ` +
            `union without \`any\` or \`unknown\`, or with the labels ` +
            `${names} states on a member of it.`,
        );
      }
      continue;
    }
    for (const name of value.unwritten) {
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
