/**
 * The verbs a piece exposes, read from the compiled pattern it is pinned to.
 *
 * Everything that names or describes a verb reads it here, so the command
 * line and an agent's tools cannot list the same piece two different ways:
 * `cf piece verbs`, `cf piece call --help`, and the harness's
 * `describe_handle` all take their rows from {@link verbsFromCompiledPattern}.
 */

import type { JSONSchema } from "@commonfabric/api";
import { ContextualFlowControl, deepEqual } from "@commonfabric/runner";
import {
  cfcSchemaResolvedRoot,
  cfcSchemaWithInheritedDefs,
  pruneCfcSchemaDefinitions,
  resolveCfcSchemaRefs,
} from "@commonfabric/runner/cfc";
import { isObjectNotArray, isObjectOrArray } from "@commonfabric/utils/types";
import { utf8Compare } from "@commonfabric/utils/utf8";
import { isSchemaObject } from "./declared-fields.ts";

/** One row of `cf piece verbs`: a callable the piece exposes. */
export interface PieceCallableListing {
  name: string;
  kind: "handler" | "tool";

  /** Which cell the callable lives on: `result` for a verb the pattern's
   * result declares or wires, `input` for a stream its argument type
   * declares. `result` shadows `input` on a name collision, matching
   * `cf piece call`'s resolution order. */
  on: "result" | "input";

  /** The verb's input schema: a handler's declared event type, or a tool's
   * argument schema less the parameters the tool binds. `true` means
   * unconstrained. */
  inputSchema: JSONSchema | true;

  /** What the verb hands back: a tool's pattern result schema, a handler's
   * declared result. Absent when the verb declares none — the value-less
   * shape, which is the common one. */
  outputSchema?: JSONSchema;

  /**
   * What the verb is FOR, in the author's own words: the doc comment on the
   * pattern property declaring it, the same prose `call <verb> --help` prints
   * as its summary line.
   *
   * Absent where the author documented nothing, and absent where the pattern
   * could not be read (`incomplete`). Never derived from the name — a listing
   * that restates `addItem` as "add item" reports the schema back to the
   * caller who wrote it and calls it documentation.
   */
  description?: string;

  /** Listing mark: a UI affordance outside the headless contract (inferred
   * from session-scoped handler bindings at compile time). Hidden from the
   * default listing; always callable. */
  tier?: "wrapper";

  /** Listing mark: `@deprecated` JSDoc on the verb, lowered to the standard
   * schema annotation. Hidden from the default listing; always callable. */
  deprecated?: boolean;
}

/**
 * A declared object schema's properties, beside the root a property's own
 * references resolve against.
 *
 * The ROOT may itself be a reference. A pattern whose result or argument is
 * a named type compiles to a root of `{$ref: "#/$defs/T"}` beside its
 * `$defs`, and the properties then live in the definition rather than on the
 * root.
 * That is every piece a verb CREATES, because a created piece's result is the
 * named type its author declared, while a root piece's is written inline. The
 * `$defs` sit on the root, so the root is what the reference resolves against.
 *
 * The returned root is the document a property's own references resolve in:
 * the schema itself, or the document the resolved view is when resolution
 * minted one of its own (`cfcSchemaResolvedRoot`).
 *
 * Returns `undefined` for a schema that declares no object at all.
 */
export function declaredProperties(
  schema: unknown,
): { properties: Record<string, unknown>; root: JSONSchema } | undefined {
  if (!isObjectOrArray(schema)) return undefined;
  const declared = typeof schema.$ref === "string"
    ? resolveCfcSchemaRefs(schema, schema as JSONSchema)
    : schema;
  if (!isObjectOrArray(declared) || !isObjectOrArray(declared.properties)) {
    return undefined;
  }
  return {
    properties: declared.properties as Record<string, unknown>,
    root: typeof schema.$ref === "string"
      ? cfcSchemaResolvedRoot(declared as JSONSchema, schema as JSONSchema)
      : schema as JSONSchema,
  };
}

/**
 * Whether a declared property is a stream — the marker that makes a result
 * or argument property a verb. Read off the outermost `asCell` entry, which
 * is the one that says what the property itself is; an inner entry describes
 * what a cell there would hold.
 */
function declaresStream(property: Record<string, unknown>): boolean {
  const entries = property.asCell;
  if (!Array.isArray(entries) || entries.length === 0) return false;
  const outermost: unknown = entries[0];
  return outermost === "stream" ||
    (isObjectOrArray(outermost) && outermost.kind === "stream");
}

/**
 * The keys of a declared verb property that describe the verb rather than
 * its event: the stream marker that makes it a verb at all, and the prose and
 * listing marks a row publishes as fields of its own.
 */
const VERB_PROPERTY_KEYS: readonly string[] = [
  "asCell",
  "description",
  "tier",
  "deprecated",
];

/**
 * The input schema a declared verb serves: the property's event type, made
 * self-contained. A property written as a reference resolves to its
 * definition, with the property's own keys merged over it; the keys that
 * describe the verb rather than its event are then dropped. The definitions of
 * the event's document are attached in place of any `$defs` the property
 * carries of its own, and cut to the ones the event reaches; under a document
 * declaring none, the event serves none. A `Stream<void>` verb serves an
 * empty object schema rather than a stream marker with the verb's prose hung
 * on it, and a referenced event serves its definition alone. A reference that
 * does not resolve serves `true`: the surface cannot invent structure.
 */
function declaredVerbInput(
  property: Record<string, unknown>,
  root: JSONSchema,
): JSONSchema | true {
  const resolved = typeof property.$ref === "string"
    ? resolveCfcSchemaRefs(property, root)
    : property;
  if (!isObjectOrArray(resolved)) return true;
  const { $defs: _own, ...event } = Object.fromEntries(
    Object.entries(resolved).filter(([key]) =>
      !VERB_PROPERTY_KEYS.includes(key)
    ),
  ) as JSONSchema & object;
  // A referenced event serves the definitions of the document its reference
  // chain ends in, which `resolveCfcSchemaRefs` carries on the resolved view;
  // an inline event serves the root's.
  const eventRoot = resolved !== property
    ? cfcSchemaResolvedRoot(resolved as JSONSchema, root)
    : root;
  return pruneCfcSchemaDefinitions({
    ...event,
    ...(isObjectOrArray(eventRoot) && isObjectOrArray(eventRoot.$defs)
      ? { $defs: eventRoot.$defs }
      : {}),
  });
}

/** The listing marks and prose a declared property carries. */
function declaredVerbAnnotations(
  property: Record<string, unknown>,
): Pick<PieceCallableListing, "description" | "tier" | "deprecated"> {
  return {
    ...(typeof property.description === "string"
      ? { description: property.description }
      : {}),
    ...(property.tier === "wrapper" ? { tier: "wrapper" as const } : {}),
    ...(property.deprecated === true ? { deprecated: true } : {}),
  };
}

/** Whether two links written in a compiled pattern's own terms address the
 * same cell. An alias's identity is its cause, path and scope; the schema it
 * carries is fidelity for whoever reads through it, and one cell reached from
 * two positions can carry a different one at each. Anything that is not a pair
 * of aliases falls back to whole-link equality, which can only miss — and a
 * miss costs a row its `outputSchema`, never gives it the wrong one. */
function samePatternLink(left: unknown, right: unknown): boolean {
  if (!isObjectOrArray(left) || !isObjectOrArray(right)) return false;
  const leftAlias = left.$alias;
  const rightAlias = right.$alias;
  if (!isObjectOrArray(leftAlias) || !isObjectOrArray(rightAlias)) {
    return deepEqual(left, right);
  }
  return deepEqual(leftAlias.partialCause, rightAlias.partialCause) &&
    deepEqual(leftAlias.path ?? [], rightAlias.path ?? []) &&
    leftAlias.scope === rightAlias.scope;
}

/** The declared result of each verb a compiled pattern drives from a result
 * property, keyed by that property — or `undefined` where nothing names one.
 *
 * Metadata about candidates, never the list of them: a name absent here is a
 * name with no declared result to report, which is the common case and says
 * nothing about whether the property is callable.
 *
 * A handler node's `$event` input and the result property exposing that
 * handler's stream are one cell written twice in the pattern's own terms, so
 * the property matching a node's `$event` names the verb that node implements
 * — a structural comparison inside one compiled object, with no live cell to
 * resolve. The declared result rides on that node's module, which is where
 * `Stream<E, R>`'s `R` is lowered (verb contract WS-C). A stream two handler
 * nodes share is still a verb and still keyed here, but it names no single
 * result, so it maps to `undefined` rather than to one node's arbitrarily.
 *
 * A tool is absent by construction: it is not driven by a node, and its result
 * schema rides its own callable cell, where `callableCommandSpec` reads it. */
export function handlerVerbResults(
  pattern: { result?: unknown; nodes?: unknown } | null | undefined,
): Map<string, JSONSchema | undefined> {
  const verbs = new Map<string, JSONSchema | undefined>();
  const result = pattern?.result;
  if (!isObjectOrArray(result)) return verbs;
  const nodes = Array.isArray(pattern?.nodes) ? pattern.nodes : [];
  for (const [name, link] of Object.entries(result)) {
    let resultSchema: JSONSchema | undefined;
    let matched = 0;
    for (const node of nodes) {
      if (!isObjectOrArray(node) || !isObjectOrArray(node.inputs)) continue;
      if (!samePatternLink(link, node.inputs.$event)) continue;
      matched++;
      const module = node.module;
      if (isObjectOrArray(module) && module.resultSchema !== undefined) {
        resultSchema = module.resultSchema as JSONSchema;
      }
    }
    if (matched === 0) continue;
    verbs.set(name, matched === 1 ? resultSchema : undefined);
  }
  return verbs;
}

/** The declared event contract of each verb a compiled pattern drives from a
 * result property, keyed by that property — matched to its handler node by
 * the same `$event`-input comparison `handlerVerbResults` makes, so the two
 * can never attribute one stream to different verbs.
 *
 * This reads the handler MODULE's argument schema, not the pattern's result
 * schema, because the module is the only serialized surface that keeps
 * reference markers: the builder sanitizes `Pattern.resultSchema` to stream
 * markers only (`sanitizeSchemaForLinks`, `KeepAsCell.OnlyStream`,
 * builder/pattern.ts), while a module's schemas ride through
 * `moduleToEncodableForm` verbatim. The `$event` property inside it is the
 * authored event as the transformer emitted it — the input contract of
 * docs/history/plans/verb-input-contract.md, `asCell` markers intact.
 *
 * The returned schema is self-contained: a `$ref` event is resolved against
 * the module schema's own root, and an inline one carries that root's
 * `$defs` along, so a consumer can follow interior references without the
 * pattern in hand. A stream two handler nodes share names no single
 * contract and maps to `undefined`, exactly as its result does.
 *
 * Exported for the CLI's per-verb lookup, and for the direct tests in
 * `packages/cli/test/verb-emitted-address.test.ts`: a shared stream, a module
 * with no schema, and an inline event are all reachable by construction and
 * awkward to reach by compiling a pattern. */
export function handlerVerbEvents(
  pattern: { result?: unknown; nodes?: unknown } | null | undefined,
): Map<string, JSONSchema | undefined> {
  const verbs = new Map<string, JSONSchema | undefined>();
  const result = pattern?.result;
  if (!isObjectOrArray(result)) return verbs;
  const nodes = Array.isArray(pattern?.nodes) ? pattern.nodes : [];
  for (const [name, link] of Object.entries(result)) {
    let eventSchema: JSONSchema | undefined;
    let matched = 0;
    for (const node of nodes) {
      if (!isObjectOrArray(node) || !isObjectOrArray(node.inputs)) continue;
      if (!samePatternLink(link, node.inputs.$event)) continue;
      matched++;
      const argumentSchema = isObjectOrArray(node.module)
        ? node.module.argumentSchema
        : undefined;
      if (!isObjectOrArray(argumentSchema)) continue;
      const event = isObjectOrArray(argumentSchema.properties)
        ? argumentSchema.properties.$event
        : undefined;
      if (!isObjectOrArray(event)) continue;
      // An inline event is a fragment of the argument document: it carries
      // that document's definitions — none, under a root declaring none — in
      // place of any `$defs` of its own.
      eventSchema = typeof event.$ref === "string"
        ? resolveCfcSchemaRefs(event, argumentSchema as JSONSchema)
        : pruneCfcSchemaDefinitions(cfcSchemaWithInheritedDefs(
          event as JSONSchema,
          isObjectNotArray(argumentSchema.$defs)
            ? argumentSchema.$defs as Record<string, JSONSchema>
            : {},
        ));
    }
    if (matched === 0) continue;
    verbs.set(name, matched === 1 ? eventSchema : undefined);
  }
  return verbs;
}

/**
 * Every verb a compiled pattern exposes, read from the pattern alone: its
 * declared result type, its result graph, and its declared argument type. No
 * cell is read, so a listing costs what loading the pattern costs, whatever
 * the piece holds.
 *
 * A result-side name is a verb on one of three grounds, each a statement the
 * pattern makes about itself:
 *
 * - the declared result type marks the property a stream, or a tool;
 * - the result graph wires a handler node's `$event` to the property, which
 *   is the same stream written twice in the pattern's own terms
 *   (`handlerVerbEvents`) — the only source of a handler the declared result
 *   type omits;
 * - the result graph holds a tool at the property, inline as `patternTool`
 *   builds one — the only source of a tool the declared type omits.
 *
 * A name meeting none of these is data, whatever else the pattern hangs at
 * it. An argument-side name is a verb when the declared argument type marks
 * it a stream; a result-side row shadows an argument-side one of the same
 * name, as `cf piece call` resolves the result cell first.
 *
 * A declared row serves the declared event type as its input schema and the
 * property's own prose and marks. A row the declared type omits serves the
 * handler module's event contract (`handlerVerbEvents`), or a tool's argument
 * schema less the parameters it binds, and carries no prose — nothing
 * declared it. A handler's declared result rides its node
 * (`handlerVerbResults`); a tool's rides the tool itself.
 *
 * Rows sort by byte order, not locale collation: this is a machine-readable
 * surface and must sort identically on every host.
 */
export function verbsFromCompiledPattern(
  pattern: {
    argumentSchema?: unknown;
    resultSchema?: unknown;
    result?: unknown;
    nodes?: unknown;
  },
): PieceCallableListing[] {
  const listings = new Map<string, PieceCallableListing>();
  const declaredResult = declaredProperties(pattern.resultSchema);
  const graph = isObjectOrArray(pattern.result)
    ? pattern.result as Record<string, unknown>
    : {};
  const handlerEvents = handlerVerbEvents(pattern);
  const handlerResults = handlerVerbResults(pattern);

  const resultNames = new Set([
    ...Object.keys(declaredResult?.properties ?? {}),
    ...Object.keys(graph),
  ]);
  for (const name of resultNames) {
    const property = declaredResult?.properties[name];
    const declared = isObjectOrArray(property)
      ? property as Record<string, unknown>
      : undefined;
    // The stream marker sits on the property itself, beside its `$ref`; the
    // tool shape may sit behind the reference, so that one is asked of the
    // resolved definition.
    const resolved = declared !== undefined && declaredResult !== undefined &&
        typeof declared.$ref === "string"
      ? resolveCfcSchemaRefs(declared, declaredResult.root)
      : declared;
    const wired = graph[name];
    if (
      isPatternToolSchema(resolved as JSONSchema) || isPatternToolValue(wired)
    ) {
      const tool = isPatternToolValue(wired)
        ? wired as {
          pattern: { argumentSchema?: JSONSchema; resultSchema?: JSONSchema };
          extraParams: unknown;
        }
        : undefined;
      const outputSchema = tool?.pattern.resultSchema;
      listings.set(name, {
        name,
        kind: "tool",
        on: "result",
        inputSchema: tool === undefined ? true : cloneWithoutBoundToolKeys(
          tool.pattern.argumentSchema ?? true,
          isObjectNotArray(tool.extraParams) ? tool.extraParams : {},
        ),
        ...(outputSchema !== undefined ? { outputSchema } : {}),
        ...(declared !== undefined ? declaredVerbAnnotations(declared) : {}),
      });
      continue;
    }
    const declaredStream = declared !== undefined && declaresStream(declared);
    if (!declaredStream && !handlerEvents.has(name)) continue;
    const outputSchema = handlerResults.get(name);
    listings.set(name, {
      name,
      kind: "handler",
      on: "result",
      inputSchema: declaredStream && declaredResult !== undefined
        ? declaredVerbInput(declared, declaredResult.root)
        : handlerEvents.get(name) ?? true,
      ...(outputSchema !== undefined ? { outputSchema } : {}),
      ...(declared !== undefined ? declaredVerbAnnotations(declared) : {}),
    });
  }

  const declaredArgument = declaredProperties(pattern.argumentSchema);
  if (declaredArgument !== undefined) {
    for (
      const [name, property] of Object.entries(declaredArgument.properties)
    ) {
      if (listings.has(name)) continue;
      if (!isObjectOrArray(property)) continue;
      const declared = property as Record<string, unknown>;
      if (!declaresStream(declared)) continue;
      listings.set(name, {
        name,
        kind: "handler",
        on: "input",
        inputSchema: declaredVerbInput(declared, declaredArgument.root),
        ...declaredVerbAnnotations(declared),
      });
    }
  }

  return [...listings.values()].sort((a, b) => utf8Compare(a.name, b.name));
}

function isPatternSchemaValue(value: unknown): boolean {
  if (!isObjectNotArray(value)) {
    return false;
  }

  return "argumentSchema" in value || "resultSchema" in value ||
    "nodes" in value;
}

function isPatternSchemaSchema(schema: JSONSchema | undefined): boolean {
  if (!isSchemaObject(schema)) return false;
  if (ContextualFlowControl.getAsCellValues(schema).at(0) === "cell") {
    return true;
  }

  const properties = schema.properties;
  if (!isObjectNotArray(properties)) {
    return false;
  }

  return "argumentSchema" in properties || "resultSchema" in properties ||
    "nodes" in properties;
}

/** Whether `v` is a tool as a pattern builds one inline: a pattern beside
 * the parameters it binds. */
export function isPatternToolValue(v: unknown): boolean {
  if (!isObjectNotArray(v)) return false;
  const obj = v as Record<string, unknown>;
  return "pattern" in obj && "extraParams" in obj &&
    isPatternSchemaValue(obj.pattern);
}

/** Whether `schema` declares a tool: a pattern beside the parameters it
 * binds. */
export function isPatternToolSchema(schema: JSONSchema | undefined): boolean {
  if (!isSchemaObject(schema)) return false;
  const properties = schema.properties;
  if (!isObjectNotArray(properties)) {
    return false;
  }

  return "pattern" in properties && "extraParams" in properties &&
    isPatternSchemaSchema(properties.pattern as JSONSchema | undefined);
}

/**
 * A tool's argument schema as a caller sees it: the schema less the `result`
 * slot and every parameter the tool binds through `extraParams`, which a
 * caller cannot set.
 */
export function cloneWithoutBoundToolKeys(
  schema: JSONSchema,
  extraParams: Record<string, unknown>,
): JSONSchema {
  if (!isSchemaObject(schema)) return schema;
  if (schema.type !== "object" && !schema.properties) return schema;

  const rawProperties = schema.properties;
  if (!isObjectNotArray(rawProperties)) {
    return schema;
  }

  const properties = {
    ...(rawProperties as Record<string, JSONSchema>),
  };
  delete properties.result;
  for (const key of Object.keys(extraParams)) {
    delete properties[key];
  }

  const required = Array.isArray(schema.required)
    ? (schema.required as string[]).filter((key) =>
      key !== "result" && !(key in extraParams)
    )
    : undefined;

  return {
    ...schema,
    properties,
    ...(required ? { required } : {}),
  };
}
