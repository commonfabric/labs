import type { CfcAtom } from "@commonfabric/api/cfc";
import { cfcAtom } from "@commonfabric/api/cfc";
import type { Schema } from "@commonfabric/api/schema";
import {
  FabricInstance,
  FabricPrimitive,
  type FabricValue,
  isWalkableObjectOrArray,
  refuseFabricInstance,
} from "@commonfabric/data-model";
import {
  entityRefToString,
  isEntityRef,
} from "@commonfabric/data-model/cell-rep";
import { hasDataUriScheme } from "@commonfabric/data-model/codec-data-uri";
import {
  internSchema,
  isNontrivialSchema,
  toDeepFrozenSchema,
} from "@commonfabric/data-model-schema";
import {
  ARRAY_SUBSCHEMA_KEYS,
  mapSubschemas,
  RECORD_SUBSCHEMA_KEYS,
  SINGLE_SUBSCHEMA_KEYS,
} from "@commonfabric/data-model-schema/schema-walk";
import {
  isExternalSchemaRef,
} from "@commonfabric/data-model-schema/schema-refs";
import {
  DEFAULT_MODEL_NAME,
  LLMClient,
  LLMRequest,
  LLMToolCall,
} from "@commonfabric/llm";
import {
  resolveScopeKey,
  type ScopeKeyIdentity,
} from "@commonfabric/memory/v2";
import { getLogger } from "@commonfabric/utils/logger";
import {
  isBoolean,
  isObjectNotArray,
  isObjectOrArray,
} from "@commonfabric/utils/types";
import type {
  BuiltInLLMMessage,
  BuiltInLLMParams,
  BuiltInLLMTextPart,
  BuiltInLLMTool,
  BuiltInLLMToolCallPart,
  JSONSchema,
} from "commonfabric";

import type { JSONSchemaObj } from "../builder/types.ts";
import { type CellScope, NAME, type Pattern } from "../builder/types.ts";
import type { Cell, MemorySpace, Stream } from "../cell.ts";
import {
  isCell,
  isStream,
  markRuntimeInjectedEventKeys,
  recordRelevantSchemaWritePolicyInput,
} from "../cell.ts";
import { ContextualFlowControl } from "../cfc.ts";
import {
  cfcSchemaResolvedRoot,
  cfcSchemaToObject,
  resolveCfcSchemaRefs,
} from "../cfc/schema-refs.ts";
import type { CfcConfClause } from "../cfc/clause.ts";
import {
  type CfcLabelView,
  cfcLabelViewForCellFailClosed,
} from "../cfc/label-view.ts";
import {
  cfcConfidentialityForObservationNode,
  type CfcFloorTrustContext,
  cfcIntegritySatisfiesFloor,
  cfcObservationFitsCeiling,
  type CfcObservationResult,
  joinCfcObservedConfidentiality,
  meetCfcObservationCeilings,
  uniqueCfcAtoms,
} from "../cfc/observation.ts";
import { createFrozenRequestSnapshot } from "../cfc/request-snapshot.ts";
import { enqueueSinkRequestPostCommitEffect } from "../cfc/sink-request.ts";
import { settleAbandonedRequest } from "./abandoned-request.ts";
import { markEffectCompletion } from "../executor/effect-completion.ts";
import { requireWaveAcceptance, waveSettlementOf } from "../executor/wave.ts";
import { createTrustResolver } from "../cfc/trust.ts";
import {
  CFC_ENFORCING_STRICTNESS,
  cfcEnforcementStrictness,
} from "../cfc/types.ts";
import { getEntityId } from "../create-ref.ts";
import { entityUriSchemePrefix } from "../entity-kind.ts";
import { resolveLink } from "../link-resolution.ts";
import {
  createLLMFriendlyLink,
  getMetaLink,
  matchLLMFriendlyLink,
  type NormalizedFullLink,
  ownerStreamSchema,
  parseLink,
  parseLLMFriendlyLink,
  sanitizeSchemaForLinks,
} from "../link-utils.ts";
import type { RawBuiltinResult } from "../module.ts";
import { getResultCellWithSourceSchema } from "../piece-helpers.ts";
import { writeResultSchemaMeta } from "../result-schema-meta.ts";
import {
  getCellOrThrow,
  isCellResultForDereferencing,
  snapshotQueryResult,
} from "../query-result-proxy.ts";
import { Runtime, spaceCellSchema } from "../runtime.ts";
import { type Action, ignoreReadForScheduling } from "../scheduler.ts";
import { schemaToTypeString } from "../schema-format.ts";
import { resolveLinkScope } from "../scope.ts";
import type { IExtendedStorageTransaction } from "../storage/interface.ts";
import { internalVerifierRead } from "../storage/reactivity-log.ts";
import { formatTransactionSummary } from "../storage/transaction-summary.ts";
import {
  LLMDialogResultSchema,
  LLMMessageSchema,
  LLMParamsSchema,
  LLMToolSchema,
} from "./llm-schemas.ts";
import { resolveStoredPatternAsync } from "./op-pattern-ref.ts";
import { ownedCell, recordRuntimeOwnedStore } from "./runtime-owned-store.ts";
import { setCfcImplementationIdentity } from "../storage/extended-storage-transaction.ts";

// Message schema that mints the `LlmDerived` provenance stamp (Epic D1).
// Recorded as the schema write-policy input for each model-produced message's
// own entity doc, so the CFC persist pass stamps a labelMap integrity entry on
// exactly that message — see `pushModelMessages`.
const LLM_DERIVED_MESSAGE_SCHEMA = internSchema({
  ...LLMMessageSchema,
  ifc: { addIntegrity: [cfcAtom.llmDerived()] },
} as JSONSchema);

// Avoid importing from @commonfabric/piece to prevent circular deps in tests

const logger = getLogger("llm-dialog", {
  enabled: false,
  level: "info",
});

const client = new LLMClient();
// How long to keep believing another replica is still working on a dialog. This
// is a heartbeat staleness bound, not a bound on a request: `lastActivity` is
// refreshed by `safelyPerformUpdate` on every durable write of a turn, guarded
// by a requestId match, so only the replica running the turn refreshes it.
// Nothing distinguishes a crashed replica from a slow one without a bound.
const REQUEST_TIMEOUT = 1000 * 60 * 5; // 5 minutes
const MAX_SERIALIZE_DEPTH = 100;

/**
 * Remove the injected `result` field from a JSON schema so tools don't
 * advertise it as an input parameter.
 */
function stripInjectedResult(
  schema: JSONSchema,
): JSONSchema {
  if (!schema || typeof schema !== "object") return schema;
  const obj = schema as Record<string, unknown>;
  if (obj.type !== "object") return schema;

  const copy: Record<string, unknown> = { ...obj };
  const props = copy.properties as Record<string, unknown> | undefined;
  if (props && typeof props === "object") {
    const { result: _, ...rest } = props as Record<string, unknown>;
    copy.properties = rest;
  }
  const req = copy.required as unknown[] | undefined;
  if (Array.isArray(req)) {
    copy.required = req.filter((k) => k !== "result");
  }
  return copy;
}

//
// Helper types + utils
//

type ToolKind = "handler" | "cell" | "pattern";
type LLMObservationSerializationResult = CfcObservationResult;

type SerializeForLLMObservationParams = {
  value: unknown;
  schema?: JSONSchema;
  seen?: Set<unknown>;
  contextSpace?: MemorySpace;
  depth?: number;
  logicalPath?: readonly string[];
  rootLink?: NormalizedFullLink;
  labelView?: CfcLabelView;
  observationMaxConfidentiality?: readonly CfcConfClause[];
};

function normalizeInputSchema(schemaLike: unknown): JSONSchema {
  let inputSchema: any = schemaLike;
  if (isBoolean(inputSchema)) {
    inputSchema = {
      type: "object",
      properties: {},
      additionalProperties: inputSchema,
    };
  }
  if (!isObjectNotArray(inputSchema)) inputSchema = { type: "object" };
  const stripped = stripInjectedResult(inputSchema);
  return prepareSchemaForLLM(stripped);
}

// Tool-input fields the framework fills in (see applyAutoProvidedSandboxId).
// They are removed from the model-facing schema so the model is never asked for
// a value it cannot set — the runtime owns them.
const FRAMEWORK_PROVIDED_TOOL_FIELDS: readonly string[] = ["sandboxId"];

// Remove framework-provided fields from a tool's model-facing input schema. The
// pattern's own argumentSchema (which the runtime reads to decide what to fill)
// is untouched; only what the model sees changes.
function stripFrameworkProvidedFields(schema: JSONSchema): JSONSchema {
  if (!schema || typeof schema !== "object") return schema;
  const obj = schema as Record<string, unknown>;
  const props = obj.properties as Record<string, unknown> | undefined;
  if (!props || typeof props !== "object") return schema;
  const present = FRAMEWORK_PROVIDED_TOOL_FIELDS.filter((f) => f in props);
  if (present.length === 0) return schema;
  const nextProps = { ...props };
  for (const f of present) delete nextProps[f];
  const next: Record<string, unknown> = { ...obj, properties: nextProps };
  if (Array.isArray(obj.required)) {
    next.required = (obj.required as unknown[]).filter(
      (k) => !present.includes(k as string),
    );
  }
  return next as JSONSchema;
}

/**
 * Inline all `$ref: "#/$defs/X"` references in a JSON schema, producing a
 * self-contained schema with no `$ref` or `$defs`.
 *
 * Circular references are detected by tracking which definition names are
 * currently being resolved on the active path. When a cycle is found (or
 * `maxDepth` $ref resolutions are exceeded), the node is truncated to a
 * permissive object.
 *
 * `refDepth` only increments when resolving a `$ref`, not when recursing into
 * regular JSON properties, so deeply nested but non-recursive schemas pass
 * through without truncation.
 */
function resolveRefsForLLM(
  schema: JSONSchema,
  maxDepth = 4,
): JSONSchema {
  // Like toSchemaObj but maps false to a permissive object instead of
  // { not: true } which LLMs don't handle well.
  const toObj = (s: unknown) =>
    s === false
      ? ({ type: "object", properties: {} } as Record<string, unknown>)
      : cfcSchemaToObject(
        typeof s === "boolean" ? s : (s as JSONSchema) ?? undefined,
      );

  const schemaObj = toObj(schema);

  function resolve(
    node: unknown,
    refDepth: number,
    activeRefs: Set<string>,
  ): any {
    const nodeObj = toObj(node);

    // Handle $ref using CFC's resolveSchemaRefs for chain resolution
    if (nodeObj.$ref && typeof nodeObj.$ref === "string") {
      const refString = nodeObj.$ref;
      if (activeRefs.has(refString) || refDepth >= maxDepth) {
        // Circular or too deep — truncate
        return { type: "object", additionalProperties: true };
      }
      const resolved = resolveCfcSchemaRefs(
        nodeObj,
        schema,
      );
      if (resolved === undefined) {
        // Unresolvable or cyclic — truncate
        return { type: "object", additionalProperties: true };
      }
      const resolvedObj = toObj(resolved);
      const newActiveRefs = new Set(activeRefs);
      newActiveRefs.add(refString);
      return resolve(resolvedObj, refDepth + 1, newActiveRefs);
    }

    // Recurse into object properties (does not increment refDepth)
    //
    // TODO(danfuzz): this rebuild recurses into every object-valued key, so it
    // also descends into `default`/`examples` VALUES, and rewrites whatever
    // schema keywords it finds spelled inside one. The sibling
    // `simplifySchemaForContext` carries `default` by reference via
    // `PRESERVE_KEYS`; this walk wants the same treatment for value-bearing
    // keys.
    //
    // A `FabricPrimitive` is carried by reference either way: the rebuild
    // reads a node by property name and would return `{}` for one. A
    // `FabricInstance` is refused rather than carried, as everywhere else.
    const result: any = {};
    for (const [key, value] of Object.entries(nodeObj)) {
      if (key === "$defs") continue; // strip $defs from output
      if (key === "additionalProperties" && value === false) {
        // This keyword controls object openness; converting `false` to an
        // object would permit the extra properties the schema forbids.
        result[key] = value;
      } else if (Array.isArray(value)) {
        result[key] = value.map((item) =>
          isWalkableObjectOrArray(item) || typeof item === "boolean"
            ? resolve(item, refDepth, activeRefs)
            : item
        );
      } else if (isWalkableObjectOrArray(value) || typeof value === "boolean") {
        result[key] = resolve(value, refDepth, activeRefs);
      } else {
        result[key] = value;
      }
    }
    return result;
  }

  return resolve(schemaObj, 0, new Set());
}

/**
 * Prepare a schema for use in LLM tool definitions by:
 * 1. Stripping internal `asCell` markers and removing cycles
 * 2. Inlining all $ref references
 */
function prepareSchemaForLLM(schema: JSONSchema): JSONSchema {
  if (!isObjectOrArray(schema)) return schema;
  const sanitized = sanitizeSchemaForLinks(schema);
  return resolveRefsForLLM(sanitized);
}

/**
 * Resolve a piece's result schema:
 * - Prefer a non-empty pattern.resultSchema if pattern is loaded
 * - Otherwise derive a simple object schema from the current value
 */
function getCellSchema(
  cell: Cell<unknown>,
): JSONSchema | undefined {
  // Extract schema from cell, following links that carry an embedded schema
  const { schema } = cell.asSchemaFromLinks().getAsNormalizedFullLink();

  if (isNontrivialSchema(schema)) {
    return schema;
  }

  // Resolve all links, clear the schema, then look up the schema embedded
  // in the links along the resolved chain. This handles cells accessed via
  // arrays (e.g., mentionables, recents) where the intermediate cell doesn't
  // carry a schema but a link in the chain does.
  try {
    const resolvedSchema = cell.resolveAsCell().asSchema(undefined)
      .asSchemaFromLinks()?.getAsNormalizedFullLink()?.schema;
    if (isNontrivialSchema(resolvedSchema)) {
      return resolvedSchema;
    }
  } catch (e) {
    logger.debug("llm", "getCellSchema fallback failed:", e);
  }

  // Read the resultSchema stored in a result document's meta "schema" field
  // (written by updateResultSchemaMeta when a piece runs), projected along
  // the cell's path. Checked on the cell's own document first (covers paths
  // into a result document whose links carry no schema), then on the fully
  // resolved target (covers reference chains that end at a result document).
  try {
    const own = getResultCellWithSourceSchema(cell.asSchema(undefined));
    if (isNontrivialSchema(own.schema)) {
      return own.schema;
    }
  } catch (e) {
    logger.debug("llm", "getCellSchema meta-schema lookup failed:", e);
  }
  try {
    const resolved = getResultCellWithSourceSchema(
      cell.resolveAsCell().asSchema(undefined),
    );
    if (isNontrivialSchema(resolved.schema)) {
      return resolved.schema;
    }
  } catch (e) {
    logger.debug("llm", "getCellSchema meta-schema fallback failed:", e);
  }

  // Fall back to minimal schema based on current value
  return buildMinimalSchemaFromValue(cell);
}

function buildMinimalSchemaFromValue(piece: Cell<any>): JSONSchema | undefined {
  try {
    const resultValue = piece.asSchema().get();
    if (resultValue && typeof resultValue === "object") {
      const keys = Object.keys(resultValue).filter((k) => !k.startsWith("$"));
      if (keys.length > 0) {
        return {
          type: "object",
          properties: Object.fromEntries(keys.map((k) => [k, true])),
        } as JSONSchema;
      }
    }
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * @deprecated Use schemaToTypeString instead for cleaner TypeScript-like output.
 *
 * Simplifies a schema for LLM context documentation.
 * Removes $defs and $ref which can make schemas very large with recursive types.
 * Preserves essential type information including wrapper markers (asCell),
 * nested properties, required arrays, and small enums.
 *
 * @param schema - The schema to simplify
 * @param depth - Current recursion depth (default 0)
 * @param maxDepth - Maximum recursion depth (default 3)
 */
function simplifySchemaForContext(
  schema: JSONSchema,
  depth: number = 0,
  maxDepth: number = 3,
): JSONSchema {
  if (!isObjectOrArray(schema)) {
    return schema;
  }

  const schemaObj = schema as Record<string, unknown>;

  // At max depth, return a minimal schema preserving only type and wrapper markers
  if (depth >= maxDepth) {
    const minimal: Record<string, unknown> = {};
    if (schemaObj.type) minimal.type = schemaObj.type;
    if (schemaObj.asCell) minimal.asCell = schemaObj.asCell;
    return minimal as JSONSchema;
  }

  const simplified: Record<string, unknown> = {};

  // Semantic markers and essential keys to always preserve
  const PRESERVE_KEYS = [
    "type",
    "description",
    "asCell",
    "default",
    "required",
  ];

  // Maximum enum values to preserve (to prevent bloat)
  const MAX_ENUM_VALUES = 10;

  // Shallow pass: filter keys, then let mapSubschemas rewrite the kept
  // subschema keywords below.
  for (const [key, value] of Object.entries(schemaObj)) {
    // Skip $-prefixed keys: $defs/$ref can be huge with recursive types, and
    // keys like $UI are internal/VDOM
    if (key.startsWith("$")) {
      continue;
    }

    // Keep properties, dropping $-prefixed ones ($UI, $TYPE, etc. are
    // internal/VDOM); their values are simplified by the walk below
    if (key === "properties" && isObjectOrArray(value)) {
      simplified[key] = Object.fromEntries(
        Object.entries(value).filter(([name]) => !name.startsWith("$")),
      );
      continue;
    }

    // Keep the other subschema-bearing keywords for the walk below
    if (SIMPLIFY_SUBSCHEMA_KEYS.has(key)) {
      simplified[key] = value;
      continue;
    }

    // Handle enum - preserve if small, otherwise truncate
    if (key === "enum" && Array.isArray(value)) {
      if (value.length <= MAX_ENUM_VALUES) {
        simplified[key] = value;
      } else {
        // Truncate large enums and add indicator
        simplified[key] = [...value.slice(0, MAX_ENUM_VALUES), "..."];
      }
      continue;
    }

    // Preserve semantic markers and other primitive values, but skip complex
    // objects not handled above
    if (
      PRESERVE_KEYS.includes(key) || !isObjectOrArray(value)
    ) {
      simplified[key] = value;
    }
  }

  return mapSubschemas(
    simplified as JSONSchemaObj,
    (child) =>
      // Draft-07 array-form `items`; the 2020-12 tuple form is `prefixItems`,
      // which mapSubschemas already walks element-wise.
      Array.isArray(child)
        ? child.map((element) =>
          simplifySchemaForContext(element, depth + 1, maxDepth)
        ) as unknown as JSONSchema
        : simplifySchemaForContext(child, depth + 1, maxDepth),
  );
}

// The subschema-bearing keywords simplifySchemaForContext keeps (and recurses
// into). The never-emitted tier (`contains`, `if`/`then`/`else`, ...) is
// deliberately absent: passing those through would make them look supported.
// `properties` is handled separately to drop $-prefixed names first.
const SIMPLIFY_SUBSCHEMA_KEYS: ReadonlySet<string> = new Set([
  ...SINGLE_SUBSCHEMA_KEYS,
  ...ARRAY_SUBSCHEMA_KEYS,
  ...RECORD_SUBSCHEMA_KEYS,
]);

function observationLinkForValue(
  value: unknown,
  logicalPath: readonly string[],
  contextSpace: MemorySpace | undefined,
  rootLink: NormalizedFullLink | undefined,
): { "@link": string } | undefined {
  if (rootLink !== undefined) {
    return {
      "@link": createLLMFriendlyLink({
        ...rootLink,
        path: [...rootLink.path, ...logicalPath],
      }, contextSpace),
    };
  }

  if (isCellResultForDereferencing(value)) {
    value = getCellOrThrow(value);
  }

  if (isCell(value)) {
    return {
      "@link": createLLMFriendlyLink(
        value.resolveAsCell().getAsNormalizedFullLink(),
        contextSpace,
      ),
    };
  }

  return undefined;
}

function serializeForLLMObservation(
  {
    value,
    schema,
    seen = new Set(),
    contextSpace,
    depth = 0,
    logicalPath = [],
    rootLink,
    labelView,
    observationMaxConfidentiality,
  }: SerializeForLLMObservationParams,
): LLMObservationSerializationResult {
  if (depth > MAX_SERIALIZE_DEPTH) {
    const msg =
      `[LLM Serialize] Maximum depth of ${MAX_SERIALIZE_DEPTH} reached.`;
    logger.warn(msg);
    console.warn(msg);
    return {
      value: "[Maximum depth reached]",
      observedConfidentiality: [],
    };
  }

  const nodeConfidentiality = cfcConfidentialityForObservationNode({
    schema,
    labelView,
    logicalPath,
  });
  if (
    !cfcObservationFitsCeiling(
      nodeConfidentiality,
      observationMaxConfidentiality,
    )
  ) {
    const link = observationLinkForValue(
      value,
      logicalPath,
      contextSpace,
      rootLink,
    );
    if (link !== undefined) {
      // Rendering WHICH reference sits here — without following it — is a
      // followRef observation (C4, C0 §7): the opaque handle taints the
      // prompt with the pointer's label, not the target's content label.
      const handleConfidentiality = cfcConfidentialityForObservationNode({
        labelView,
        logicalPath,
        observes: "followRef",
      });
      if (
        cfcObservationFitsCeiling(
          handleConfidentiality,
          observationMaxConfidentiality,
        )
      ) {
        return {
          value: link,
          observedConfidentiality: handleConfidentiality,
        };
      }
      // Even the pointer's label exceeds the ceiling: the handle would leak
      // which-document, and falling through would serialize the over-ceiling
      // CONTENT into consumers with no downstream gate (the post-commit
      // context/pinned-cell docs send llmParams without a sink-request
      // gate). Redact entirely — no content, no handle, no observation
      // (Codex review on #4541).
      return {
        value: "[redacted: exceeds observation ceiling]",
        observedConfidentiality: [],
      };
    }
  }

  if (!isObjectOrArray(value)) {
    return {
      value,
      observedConfidentiality: nodeConfidentiality,
    };
  }

  // If we encounter an `any` schema, turn value into a cell link
  if (
    seen.size > 0 && schema !== undefined &&
    ContextualFlowControl.isTrueSchema(schema) &&
    isCellResultForDereferencing(value)
  ) {
    value = getCellOrThrow(value);
  }

  // Turn cells into a link, unless they are data: URIs and traverse instead
  if (isCell(value)) {
    const link = value.resolveAsCell().getAsNormalizedFullLink();
    if (hasDataUriScheme(link.id)) {
      return serializeForLLMObservation({
        value: value.get(),
        schema,
        seen,
        contextSpace,
        depth: depth + 1,
        logicalPath,
        rootLink,
        labelView,
        observationMaxConfidentiality,
      });
    }
    return {
      value: { "@link": createLLMFriendlyLink(link, contextSpace) },
      observedConfidentiality: [],
    };
  }

  // A `FabricPrimitive` is an atomic value whose state lives in private fields
  // (zero enumerable own-props), so the `Object.fromEntries(Object.entries(
  // ...))` rebuild below would hand the model a bare `{}` in place of its
  // contents. It leaves whole, and it leaves ahead of the `seen` check: being a
  // leaf it cannot participate in a cycle, and one reachable at two positions
  // would otherwise trip the already-seen refusal.
  if (value instanceof FabricPrimitive) {
    return { value, observedConfidentiality: nodeConfidentiality };
  }

  // A `FabricInstance` is NOT a leaf. It is a container reached by its codec
  // contents rather than by property name, which this walk cannot do, so the
  // rebuild below would flatten it to `{}` and the model would be shown an
  // empty record where its contents should be. It refuses instead.
  //
  // Nothing reaches this in production today, de facto rather than by
  // construction: a `FabricError` is exposed to pattern authors and ungated, so
  // what keeps this safe is that nothing yet puts one where a model observes
  // it.
  //
  // TODO(danfuzz): descend a `FabricInstance` by its codec contents, at which
  // point this becomes a walk rather than a refusal.
  if (value instanceof FabricInstance) {
    refuseFabricInstance(
      value,
      "when serializing a value for a language model",
    );
  }

  if (seen.has(value)) {
    if (isCellResultForDereferencing(value)) {
      return serializeForLLMObservation({
        value: getCellOrThrow(value),
        schema,
        seen,
        contextSpace,
        depth: depth + 1,
        logicalPath,
        rootLink,
        labelView,
        observationMaxConfidentiality,
      });
    }
    throw new Error(
      "Cannot serialize a value that has already been seen and cannot be mapped to a cell.",
    );
  }

  const nextSeen = new Set(seen);
  nextSeen.add(value);

  if (Array.isArray(value)) {
    const observedParts: Array<readonly unknown[] | undefined> = [
      nodeConfidentiality,
    ];
    const serialized = value.map((v, index) => {
      const linkSchema = schema !== undefined
        ? ContextualFlowControl.schemaAtPath(schema, [index.toString()])
        : undefined;
      let child = serializeForLLMObservation({
        value: v,
        schema: linkSchema,
        seen: nextSeen,
        contextSpace,
        depth: depth + 1,
        logicalPath: [...logicalPath, index.toString()],
        rootLink,
        labelView,
        observationMaxConfidentiality,
      });
      observedParts.push(child.observedConfidentiality);

      if (isObjectOrArray(child.value) && isCellResultForDereferencing(v)) {
        const link = getCellOrThrow(v).resolveAsCell()
          .getAsNormalizedFullLink();
        if (!hasDataUriScheme(link.id)) {
          child = {
            ...child,
            value: {
              "@arrayEntry": createLLMFriendlyLink(link, contextSpace),
              ...child.value,
            },
          };
        }
      }
      return child.value;
    });

    return {
      value: serialized,
      observedConfidentiality: joinCfcObservedConfidentiality(observedParts),
    };
  }

  const observedParts: Array<readonly unknown[] | undefined> = [
    nodeConfidentiality,
  ];
  const serialized = Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([key]) => !key.startsWith("$"))
      .map(([key, propValue]) => {
        const child = serializeForLLMObservation({
          value: propValue,
          schema: schema !== undefined
            ? ContextualFlowControl.schemaAtPath(schema, [key])
            : undefined,
          seen: nextSeen,
          contextSpace,
          depth: depth + 1,
          logicalPath: [...logicalPath, key],
          rootLink,
          labelView,
          observationMaxConfidentiality,
        });
        observedParts.push(child.observedConfidentiality);
        return [key, child.value];
      }),
  );

  return {
    value: serialized,
    observedConfidentiality: joinCfcObservedConfidentiality(observedParts),
  };
}

/**
 * Traverses a value and serializes any cells mentioned to our LLM-friendly JSON
 * link object format.
 *
 * @param value - The value to traverse and serialize
 * @param schema - The schema for the value
 * @param seen - Set of already-visited values (for cycle detection)
 * @param contextSpace - The current execution space (for cross-space link encoding)
 * @returns The serialized value
 */
function traverseAndSerialize(
  value: unknown,
  schema: JSONSchema | undefined,
  seen: Set<unknown> = new Set(),
  contextSpace?: MemorySpace,
  depth: number = 0,
): unknown {
  return serializeForLLMObservation({
    value,
    schema,
    seen,
    contextSpace,
    depth,
  }).value;
}

/**
 * Traverses a value and converts any of our LLM friendly JSON link object
 * format cells mentioned to actual cells.
 *
 * @param runtime - The runtime to use to get the cells
 * @param space - The space to use to get the cells
 * @param value - The value to traverse and cellify
 * @returns The cellified value
 */
function traverseAndCellify(
  runtime: Runtime,
  space: MemorySpace,
  value: unknown,
): unknown {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (
          isObjectOrArray(parsed) && typeof parsed["@link"] === "string" &&
          Object.keys(parsed).length === 1 &&
          matchLLMFriendlyLink.test(parsed["@link"])
        ) {
          const link = parseLLMFriendlyLink(parsed["@link"], space);
          return runtime.getCellFromLink(link);
        }
      } catch {
        // Not a JSON-encoded link object; leave the string as-is.
      }
    }
  }

  // It's a valid link, if
  // - it's a record with a single key "/"
  // - the value of the "/" key is a string that matches the URI pattern
  if (
    isObjectOrArray(value) && typeof value["@link"] === "string" &&
    Object.keys(value).length === 1 && matchLLMFriendlyLink.test(value["@link"])
  ) {
    const link = parseLLMFriendlyLink(value["@link"], space);
    return runtime.getCellFromLink(link);
  }
  if (Array.isArray(value)) {
    return value.map((v) => traverseAndCellify(runtime, space, v));
  }
  // A `FabricPrimitive` is an atomic value whose state lives in private fields
  // (zero enumerable own-props). It is not a link, so the `Object.fromEntries(
  // Object.entries(...))` rebuild below would flatten it to `{}`; leave it
  // intact as an atomic leaf, like any string or number.
  if (value instanceof FabricPrimitive) return value;

  // A `FabricInstance` is NOT a leaf. It is a container reached by its codec
  // contents rather than by property name, which this walk cannot do, so the
  // rebuild below would flatten it to `{}` -- and a cell nested in its state
  // would go unmade, which is the whole of what this walk is for. It refuses
  // instead.
  //
  // Nothing reaches this in production today, de facto rather than by
  // construction: what this walks is a model's response, parsed from JSON, and
  // no class instance survives that. A caller handing over a value assembled
  // some other way would reach it.
  //
  // TODO(danfuzz): descend a `FabricInstance` by its codec contents, at which
  // point this becomes a walk rather than a refusal.
  if (value instanceof FabricInstance) {
    refuseFabricInstance(
      value,
      "when converting a language model's response to cells",
    );
  }

  if (isObjectOrArray(value)) {
    return Object.fromEntries(
      Object.entries(value).map((
        [key, value],
      ) => [key, traverseAndCellify(runtime, space, value)]),
    );
  }
  return value;
}

const resultSchema = LLMDialogResultSchema;

const internalSchema = internSchema(
  {
    type: "object",
    properties: {
      requestId: { type: "string" },
      lastActivity: { type: "number" },
      messageObservations: {
        type: "object",
        additionalProperties: {
          type: "array",
          items: {},
        },
        default: {},
      },
    },
    required: ["requestId", "lastActivity"],
  },
);

type LegacyToolEntry = {
  name: string;
  tool: any;
  cell: Cell<Schema<typeof LLMToolSchema>>;
};

type PieceToolEntry = {
  name: string;
  piece: Cell<any>;
  pieceName: string;
  handle: string; // e.g., "/of:bafyabc123"
};

type ToolCatalog = {
  llmTools: Record<string, { description: string; inputSchema: JSONSchema }>;
  dynamicToolCells: Map<string, Cell<Schema<typeof LLMToolSchema>>>;
};

type DialogMessageObservationMap = Record<string, unknown[]>;

/** Stable cells shared by every actor of one symbolic output scope. */
type DialogCells = {
  /** Pattern-visible dialog state. */
  result: Cell<Schema<typeof resultSchema>>;

  /** Durable turn claim and observation history. */
  internal: Cell<Schema<typeof internalSchema>>;

  /** Links pinned during dialog turns. */
  pinnedCells: Cell<PinnedCell[]>;
};

/** One accepted turn retained through dispatch and all resulting work. */
type DialogTurn = DialogCells & {
  /** Durable claim this turn may complete. */
  requestId: string;

  /** Cancellation for this turn's model and tool operations. */
  abortController: AbortController;

  /** Actor whose scoped cells this turn reads and writes. */
  identity?: ScopeKeyIdentity;
};

type DialogRequestSnapshot = {
  /** Actor captured before the turn leaves its accepted handler transaction. */
  scopeKeyIdentity?: ScopeKeyIdentity;
  llmParams: LLMRequest;
  toolCatalog: ToolCatalog;
  userResultSchema: JSONSchema | undefined;
  queueName?: string;
  observationMaxConfidentiality?: readonly CfcConfClause[];
  systemObservedConfidentiality: readonly CfcConfClause[];
};

type AvailableCellsDocumentation = {
  docs: string;
  observedConfidentiality: readonly CfcConfClause[];
};

function resolveDirectContextCellRef(cell: unknown): Cell<any> | undefined {
  return isCellResultForDereferencing(cell)
    ? getCellOrThrow(cell).resolveAsCell()
    : isCell(cell)
    ? cell.resolveAsCell()
    : isObjectOrArray(cell) && typeof cell.resolveAsCell === "function"
    ? cell.resolveAsCell()
    : undefined;
}

function resolveContextCellRef(cell: unknown): Cell<any> | undefined {
  const resolved = resolveDirectContextCellRef(cell);
  if (!resolved) {
    return undefined;
  }

  try {
    const nested = resolveDirectContextCellRef(resolved.get());
    if (nested) {
      return nested;
    }
  } catch {
    // Ignore nested resolution failures and use the outer cell.
  }

  return resolved;
}

function readCellValueForObservation(
  cell: Cell<unknown>,
): unknown {
  const readTx = cell.runtime.readTx(
    (cell as unknown as { tx?: IExtendedStorageTransaction }).tx,
  );
  const link = resolveLink(
    cell.runtime,
    readTx,
    cell.getAsNormalizedFullLink(),
    "top",
  );
  const value = readTx.readValueOrThrow(link, {
    meta: { ...ignoreReadForScheduling, ...internalVerifierRead },
  });
  return value === undefined ? cell.get() ?? cell.getRaw() : value;
}

function collectToolEntries(
  toolsCell: Cell<Record<string, Schema<typeof LLMToolSchema>>>,
  includeBuiltinTools = true,
): { legacy: LegacyToolEntry[]; pieces: PieceToolEntry[] } {
  const tools = toolsCell.get() ?? {};
  const legacy: LegacyToolEntry[] = [];
  const pieces: PieceToolEntry[] = [];

  for (const [name, tool] of Object.entries(tools)) {
    assertToolNameAvailable(name, includeBuiltinTools);

    if (tool?.piece?.get?.()) {
      const piece: Cell<any> = tool.piece;
      const pieceValue = piece.get();
      const pieceName = String(pieceValue?.[NAME] ?? name);

      // Extract handle from link
      const link = piece.getAsNormalizedFullLink();
      const handle = link.id; // Keep the "/of:..." format as the internal handle

      pieces.push({ name, piece, pieceName, handle });
      continue;
    }

    legacy.push({
      name,
      tool,
      cell: toolsCell.key(name) as unknown as Cell<
        Schema<typeof LLMToolSchema>
      >,
    });
  }

  return { legacy, pieces };
}

const READ_TOOL_NAME = "read";
const INVOKE_TOOL_NAME = "invoke";
const SCHEMA_TOOL_NAME = "schema";
const PIN_TOOL_NAME = "pin";
const UNPIN_TOOL_NAME = "unpin";
const PRESENT_RESULT_TOOL_NAME = "presentResult";
const UPDATE_ARGUMENT_TOOL_NAME = "updateArgument";

/**
 * The names the dialog itself answers to when built-in tools are enabled.
 */
const BUILTIN_TOOL_NAMES: readonly string[] = [
  READ_TOOL_NAME,
  INVOKE_TOOL_NAME,
  SCHEMA_TOOL_NAME,
  PIN_TOOL_NAME,
  UNPIN_TOOL_NAME,
  UPDATE_ARGUMENT_TOOL_NAME,
];

/**
 * Refuses a tool whose name the dialog has already given a meaning.
 *
 * A name addresses one tool. Letting a pattern supply a second under a name the
 * dialog answers to would leave the catalog, the flattened list the UI reads,
 * the CFC gates, and the system prompt each free to describe a different one,
 * and the prompt describes the built-ins in prose that no lookup can redirect.
 * So the name is refused where it is registered rather than resolved somewhere
 * and quietly wrong everywhere else.
 *
 * `builtinTools: false` leaves the six unregistered, and free.
 * `presentResult` is refused either way: the dialog stores the call carrying
 * that name as its structured result, matching by name, whatever else is
 * enabled.
 */
function assertToolNameAvailable(
  name: string,
  includeBuiltinTools: boolean,
): void {
  if (name === PRESENT_RESULT_TOOL_NAME) {
    throw new Error(
      `A tool may not be named "${PRESENT_RESULT_TOOL_NAME}": the dialog stores the call carrying that name as its structured result.`,
    );
  }
  if (includeBuiltinTools && BUILTIN_TOOL_NAMES.includes(name)) {
    throw new Error(
      `A tool may not be named "${name}": it is a built-in tool of the dialog. Rename it, or pass builtinTools: false to run without the built-ins.`,
    );
  }
}

const READ_INPUT_SCHEMA = internSchema(
  {
    type: "object",
    properties: {
      path: {
        type: "object",
        properties: {
          "@link": { type: "string" },
        },
        required: ["@link"],
        description:
          'Link to the cell to read. Format: { "@link": "/of:bafyabc123/path" }.',
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
);

const INVOKE_INPUT_SCHEMA = internSchema(
  {
    type: "object",
    properties: {
      path: {
        type: "object",
        properties: {
          "@link": { type: "string" },
        },
        required: ["@link"],
        description:
          'Link to the handler or pattern to invoke. Format: { "@link": "/of:bafyabc123/doThing" }.',
      },
      args: {
        type: "object",
        description: "Arguments passed to the handler or pattern.",
      },
    },
    required: ["path"],
    additionalProperties: true,
  },
);

const SCHEMA_INPUT_SCHEMA = internSchema(
  {
    type: "object",
    properties: {
      path: {
        type: "object",
        properties: {
          "@link": { type: "string" },
        },
        required: ["@link"],
        description:
          'Link to the cell to inspect. Format: { "@link": "/of:bafyabc123" }.',
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
);

const PIN_INPUT_SCHEMA = internSchema(
  {
    type: "object",
    properties: {
      path: {
        type: "object",
        properties: {
          "@link": { type: "string" },
        },
        required: ["@link"],
        description:
          'Link to pin for easy reference. Format: { "@link": "/of:bafyabc123" }.',
      },
      name: {
        type: "string",
        description: "Human-readable name for this pinned cell.",
      },
    },
    required: ["path", "name"],
    additionalProperties: false,
  },
);

const UNPIN_INPUT_SCHEMA = internSchema(
  {
    type: "object",
    properties: {
      path: {
        type: "object",
        properties: {
          "@link": { type: "string" },
        },
        required: ["@link"],
        description:
          'Link of the pinned cell to remove. Format: { "@link": "/of:bafyabc123" }.',
      },
    },
    required: ["path"],
    additionalProperties: false,
  },
);

const UPDATE_ARGUMENT_INPUT_SCHEMA = internSchema(
  {
    type: "object",
    properties: {
      path: {
        type: "object",
        properties: {
          "@link": { type: "string" },
        },
        required: ["@link"],
        description:
          'Link to the pattern instance to update. Format: { "@link": "/of:bafyabc123" }.',
      },
      updates: {
        type: "object",
        description:
          "Field updates to apply to the pattern's arguments. Keys are field paths (e.g., 'query' or 'config.theme'), values are new values.",
      },
    },
    required: ["path", "updates"],
    additionalProperties: false,
  },
);

/**
 * Represents a pinned cell in the conversation.
 * Pinned cells are links of interest that the LLM can add/remove as a scratchpad.
 */
type PinnedCell = {
  path: string; // e.g., "/of:bafyabc123" or "/of:bafyabc123"
  name: string; // Human-readable name for display
};

//
// Path Utility Functions
//

// These utilities handle the conversion between LLM-facing path format (/of:...)
// and internal runtime format (of:...). The LLM sees paths with a leading slash
// to make it clear that strings are links.

function ensureString(
  value: unknown,
  field: string,
  example: string,
): string {
  if (isObjectOrArray(value) && typeof value["@link"] === "string") {
    return ensureString(value["@link"], field, example);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new Error(
        `${field} must be a non-empty string, e.g. "${example}".`,
      );
    }
    return trimmed;
  }
  throw new Error(`${field} must be a string, e.g. "${example}".`);
}

function extractStringField(
  input: unknown,
  field: string,
  example: string,
): string {
  if (typeof input === "string") {
    return ensureString(input, field, example);
  }
  if (input && typeof input === "object") {
    const value = (input as Record<string, unknown>)[field];
    return ensureString(value, field, example);
  }
  throw new Error(`${field} must be a non-empty string, e.g. "${example}".`);
}

function extractRunArguments(input: unknown): Record<string, any> {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    if (obj.args && typeof obj.args === "object") {
      return obj.args as Record<string, any>;
    }
    const { path: _path, ...rest } = obj;
    return rest as Record<string, any>;
  }
  return {};
}

/**
 * Builds the tool catalog a reader displays: an entry for each tool the
 * pattern supplies other than a piece-backed one, and the built-in tools
 * unless `includeBuiltinTools` is false.
 *
 * An entry holds the tool's description, its input schema, and its handler
 * as a link. It holds nothing a turn needs to run the tool, which the turn
 * reads from `tools` itself.
 *
 * @param toolsCell - Cell containing the tools
 * @param includeBuiltinTools - Whether the catalog lists the built-in tools
 * @returns The catalog, keyed by tool name
 */
function flattenTools(
  toolsCell: Cell<any>,
  includeBuiltinTools = true,
): Record<
  string,
  {
    handler?: any;
    description: string;
    inputSchema?: JSONSchema;
    internal?: {
      kind: ToolKind;
      path: string[];
      pieceName: string;
      handle?: string;
    };
  }
> {
  const flattened: Record<string, any> = {};
  const { legacy } = collectToolEntries(toolsCell, includeBuiltinTools);

  for (const entry of legacy) {
    // The catalog carries what a reader displays and nothing else, which is
    // what keeps this write the same over inputs that did not change. An
    // array of objects is stored one document per element, and a copy of one
    // mints those documents again, so a catalog holding a copy differs from
    // the last one over tools that did not change. Two fields of a tool are
    // full of such arrays — an author's `extraParams`, and a pattern tool's
    // graph, down to the `anyOf` branches of its argument schema — and a turn
    // reads both from `tools` itself, so neither is copied here. What is left
    // is the tool's description, its input schema, and its handler, which is
    // a stream and so a link to the one the tool already names rather than a
    // copy of anything.
    //
    // An author's `inputSchema` holding an array of objects would land the
    // same way. Nothing in the tree does today, and the fix if something does
    // is to give a copied element a content-derived document rather than to
    // narrow this further: the catalog is already down to what a reader
    // reads.
    const tool = entry.tool as Record<string, unknown> | undefined;
    const flattenedEntry: Record<string, unknown> = {};
    if (tool?.description !== undefined) {
      flattenedEntry.description = tool.description;
    }
    if (tool?.inputSchema !== undefined) {
      flattenedEntry.inputSchema =
        tool.inputSchema && typeof tool.inputSchema === "object"
          ? stripInjectedResult(tool.inputSchema as JSONSchema)
          : tool.inputSchema;
    }
    if (tool?.handler !== undefined) {
      flattenedEntry.handler = entry.cell.key("handler");
    }
    flattened[entry.name] = flattenedEntry;
  }

  if (!includeBuiltinTools) {
    return flattened;
  }

  flattened[READ_TOOL_NAME] = {
    description:
      'Read data from any cell. Input: { "@link": "/of:bafyabc123/path" }. ' +
      "Returns the cell's data with nested cells as link objects. " +
      "Compose with invoke(): invoke() returns a link, then read(link) gets the data. ",
    inputSchema: READ_INPUT_SCHEMA,
  };
  flattened[INVOKE_TOOL_NAME] = {
    description:
      'Invoke a handler or pattern. If you do not know the schema of the the handler, use schema() first. Input: { "@link": "/of:bafyabc123/doThing" }, plus optional args. ' +
      'Returns { "@link": "/of:xyz/result" } pointing to the result cell. ',
    inputSchema: INVOKE_INPUT_SCHEMA,
  };
  flattened[PIN_TOOL_NAME] = {
    description:
      'Pin a cell for easy reference. Input: { "@link": "/of:bafyabc123" } and a name. ' +
      "Pinned cells and their values appear in the system prompt. " +
      "Use to track important cells you're working with.",
    inputSchema: PIN_INPUT_SCHEMA,
  };
  flattened[UNPIN_TOOL_NAME] = {
    description: 'Unpin a cell. Input: { "@link": "/of:bafyabc123" }. ' +
      "Use when you no longer need quick access to a cell.",
    inputSchema: UNPIN_INPUT_SCHEMA,
  };
  flattened[UPDATE_ARGUMENT_TOOL_NAME] = {
    description:
      'Update arguments of a running pattern instance. Input: { "@link": "/of:bafyabc123" } and updates object. ' +
      "The pattern will automatically re-execute with the new arguments. " +
      "Use after invoke() creates a pattern, or to modify attached pattern instances. " +
      'Example: updateArgument({ "@link": "/of:xyz" }, { "query": "new search" })',
    inputSchema: UPDATE_ARGUMENT_INPUT_SCHEMA,
  };
  flattened[SCHEMA_TOOL_NAME] = {
    description:
      "Get the JSON schema for a cell to understand its structure, fields, and handlers. " +
      'Input: { "@link": "/of:bafyabc123" }. ' +
      "Returns schema showing what data can be read and what handlers can be invoked. ",
    inputSchema: SCHEMA_INPUT_SCHEMA,
  };

  return flattened;
}

/**
 * Compare two flattened tool objects to detect changes.
 * Uses a heuristic approach that compares only serializable properties
 * (description, inputSchema, internal) and excludes handler which may have
 * circular references.
 */
function _toolsHaveChanged(
  newTools: Record<string, any>,
  oldTools: Record<string, any> | undefined,
): boolean {
  if (!oldTools) return true;

  const newKeys = Object.keys(newTools).sort();
  const oldKeys = Object.keys(oldTools).sort();

  // Check if the set of tools changed
  if (newKeys.length !== oldKeys.length) return true;
  if (newKeys.some((key, i) => key !== oldKeys[i])) return true;

  // Check if any tool's serializable properties changed
  for (const key of newKeys) {
    const newTool = newTools[key];
    const oldTool = oldTools[key];

    // Compare description
    if (newTool.description !== oldTool.description) return true;

    // Compare inputSchema via interned-schema identity. `internSchema()`
    // returns the canonical reference, so structurally-equal schemas
    // collapse to `===`. Handles non-JSON-compatible `FabricValue`s in
    // schema `default` fields correctly, unlike plain `JSON.stringify`
    // (which silently mis-encodes them and could hide real changes).
    try {
      if (
        internSchema(newTool.inputSchema) !== internSchema(oldTool.inputSchema)
      ) {
        return true;
      }
    } catch {
      // Defensive: preserve the prior try/catch shape in case of
      // unexpected input. Treat any failure as "changed."
      return true;
    }

    // Compare internal metadata
    try {
      const newInternal = JSON.stringify(newTool.internal);
      const oldInternal = JSON.stringify(oldTool.internal);
      if (newInternal !== oldInternal) return true;
    } catch {
      // If internal has circular refs (unlikely), consider it changed
      return true;
    }
  }

  return false;
}

function buildToolCatalog(
  toolsCell:
    | Cell<Record<string, Schema<typeof LLMToolSchema>>>
    | Cell<Record<string, BuiltInLLMTool> | undefined>,
  includeBuiltinTools = true,
): ToolCatalog {
  const { legacy } = collectToolEntries(
    toolsCell as Cell<Record<string, Schema<typeof LLMToolSchema>>>,
    includeBuiltinTools,
  );
  const llmTools: ToolCatalog["llmTools"] = {};
  const dynamicToolCells = new Map<
    string,
    Cell<Schema<typeof LLMToolSchema>>
  >();

  for (const entry of legacy) {
    const cellToolValue = (entry.cell.get() ?? {}) as Record<string, unknown>;
    const parentToolValue = (entry.tool ?? {}) as Record<string, unknown>;
    // Prefer the parent object from toolsCell.get() for static fields like
    // description/inputSchema. Child tool cells can lose nested schema detail
    // after transformer lowering, but still remain useful as a fallback.
    const toolValue = {
      ...cellToolValue,
      ...parentToolValue,
    } as Record<string, unknown>;
    const patternValue = toolValue.pattern ?? cellToolValue.pattern;
    const pattern = (isCell(patternValue)
      ? patternValue.resolveAsCell().get()
      : (patternValue as { get?: () => unknown } | undefined)?.get?.() ??
        patternValue) as { argumentSchema?: JSONSchema } | undefined;
    const handlerValue = toolValue.handler ?? cellToolValue.handler;
    const handler =
      (isCell(handlerValue) ? handlerValue.resolveAsCell() : undefined) as
        | Cell<any>
        | undefined;
    const inputSchema = pattern?.argumentSchema ?? toolValue?.inputSchema ??
      handler?.schema;
    if (inputSchema === undefined) {
      logger.warn("llm", `No input schema found for tool ${entry.name}`);
      continue;
    }
    const normalizedInputSchema = normalizeInputSchema(inputSchema);
    const description: string = toolValue.description ??
      (normalizedInputSchema as any)?.description ?? "";
    llmTools[entry.name] = {
      description,
      inputSchema: stripFrameworkProvidedFields(normalizedInputSchema),
    };
    dynamicToolCells.set(entry.name, entry.cell);
  }

  if (!includeBuiltinTools) {
    return { llmTools, dynamicToolCells };
  }

  llmTools[READ_TOOL_NAME] = {
    description:
      'Read data from any cell. Input: { "@link": "/of:bafyabc123/path" }. ' +
      "Returns the cell's data with nested cells as link objects. " +
      "Compose with invoke(): invoke() returns a link, then read(link) gets the data. ",
    inputSchema: READ_INPUT_SCHEMA,
  };
  llmTools[INVOKE_TOOL_NAME] = {
    description:
      'Invoke a handler or pattern. Input: { "@link": "/of:bafyabc123/doThing" }, plus optional args. ' +
      'Returns { "@link": "/of:xyz/result" } pointing to the result cell. ',
    inputSchema: INVOKE_INPUT_SCHEMA,
  };
  llmTools[PIN_TOOL_NAME] = {
    description:
      'Pin a cell for easy reference. Input: { "@link": "/of:bafyabc123" } and a name. ' +
      "Pinned cells and their values appear in the system prompt. " +
      "Use to track important cells you're working with.",
    inputSchema: PIN_INPUT_SCHEMA,
  };
  llmTools[UNPIN_TOOL_NAME] = {
    description: 'Unpin a cell. Input: { "@link": "/of:bafyabc123" }. ' +
      "Use when you no longer need quick access to a cell.",
    inputSchema: UNPIN_INPUT_SCHEMA,
  };
  llmTools[UPDATE_ARGUMENT_TOOL_NAME] = {
    description:
      'Update arguments of a running pattern instance. Input: { "@link": "/of:bafyabc123" } and updates object. ' +
      "The pattern will automatically re-execute with the new arguments. " +
      "Use after invoke() creates a pattern, or to modify attached pattern instances. " +
      'Example: updateArgument({ "@link": "/of:xyz" }, { "query": "new search" })',
    inputSchema: UPDATE_ARGUMENT_INPUT_SCHEMA,
  };
  llmTools[SCHEMA_TOOL_NAME] = {
    description:
      "Get the JSON schema for a cell to understand its structure, fields, and handlers. " +
      'Input: { "@link": "/of:bafyabc123" }. ' +
      "Returns schema showing what data can be read and what handlers can be invoked. ",
    inputSchema: SCHEMA_INPUT_SCHEMA,
  };

  return { llmTools, dynamicToolCells };
}

function materializeDialogRequestSnapshot(
  runtime: Runtime,
  space: MemorySpace,
  inputs: Cell<Schema<typeof LLMParamsSchema>>,
  pinnedCells: Cell<PinnedCell[]>,
  tx: IExtendedStorageTransaction,
): DialogRequestSnapshot {
  const { system, maxTokens, model } = inputs.withTx(tx).get();
  const context = inputs.key("context").withTx(tx).get();
  // Bound the pattern-supplied observation ceiling by the deployment's llmDialog
  // ceiling so post-commit tool-loop reads (which carry no sink-request input)
  // cannot exceed it (#3993 review).
  const observationMaxConfidentiality = effectiveObservationCeiling(
    runtime,
    "llmDialog",
    inputs.key("observationMaxConfidentiality").withTx(tx).get() as
      | readonly CfcConfClause[]
      | undefined,
  );
  const toolsCell = inputs.key("tools").withTx(tx) as Cell<
    Record<string, Schema<typeof LLMToolSchema>>
  >;
  const builtinTools = inputs.key("builtinTools").withTx(tx).get() !== false;
  const toolCatalog = buildToolCatalog(toolsCell, builtinTools);
  // TODO(danfuzz): `resultSchema` is untrusted input, so this `as` is an
  // unchecked assertion. Replace with a runtime validating guard, e.g.
  // `asSchemaOrThrow(schema: unknown): schema is JSONSchema`.
  const userResultSchema = inputs.key("resultSchema").withTx(tx).get() as
    | JSONSchema
    | undefined;
  if (userResultSchema) {
    // collectToolEntries refuses this name, so nothing else holds it.
    toolCatalog.llmTools[PRESENT_RESULT_TOOL_NAME] = {
      description:
        "Call this tool to present a structured result. This stores the result for the caller.",
      inputSchema: prepareSchemaForLLM(
        toDeepFrozenSchema(userResultSchema),
      ),
    };
  }

  // A DECLARED bound — even the empty one — engages observation-aware
  // serialization: [] means "public only" (cfcObservationFitsCeiling), and the
  // deployment sink ceiling folds in as exactly that, so treating it like the
  // absent bound would disable redaction right when the strictest bound is set
  // (#3993 review).
  const cellsDocs = observationMaxConfidentiality !== undefined
    ? buildAvailableCellsDocumentationWithObservation(
      runtime,
      space,
      context,
      pinnedCells.withTx(tx),
      observationMaxConfidentiality,
    )
    : {
      docs: buildAvailableCellsDocumentation(
        runtime,
        space,
        context,
        pinnedCells.withTx(tx),
      ),
      observedConfidentiality: [],
    };
  const linkModelDocs = builtinTools
    ? "\n\n# Link and Cell Model\n\nThe system organizes all data and computation into cells. Use links to navigate between related data and compose tool operations."
    : "";
  const augmentedSystem = (system ?? "") + linkModelDocs + cellsDocs.docs;

  const llmParams = {
    system: augmentedSystem,
    messages: inputs.key("messages").withTx(tx)
      .get() as readonly BuiltInLLMMessage[],
    maxTokens: maxTokens ?? 4096,
    stream: true,
    model: model ?? DEFAULT_MODEL_NAME,
    metadata: { context: "piece" },
    cache: true,
    tools: toolCatalog.llmTools,
  };

  return {
    scopeKeyIdentity:
      runtime.servingPosture && runtime.experimental.serverExecution
        ? tx.tx.scopeKeyIdentity ?? runtime.scopeKeyIdentity
        : undefined,
    // TODO(danfuzz): Latent — schemas don't admit `Fabric*` values on this
    // `.get()`-path today, but will in the not-too-distant future; at that point
    // this JSON round-trip silently loses any `FabricPrimitive`/`FabricInstance`
    // (class instances don't survive JSON). Mark ahead of that.
    llmParams: createFrozenRequestSnapshot(
      JSON.parse(JSON.stringify(llmParams)),
    ),
    toolCatalog,
    userResultSchema,
    observationMaxConfidentiality,
    systemObservedConfidentiality: cellsDocs.observedConfidentiality,
    queueName: inputs.key("queue").withTx(tx).get() as unknown as
      | string
      | undefined,
  };
}

/**
 * Build a formatted documentation string describing all available cells:
 * both context cells (passed via the context parameter) and pinned cells
 * (managed by pin/unpin tools). Includes schemas and current values for each cell.
 * This is appended to the system prompt so the LLM has immediate context.
 */
function buildAvailableCellsDocumentationWithObservation(
  runtime: Runtime,
  space: MemorySpace,
  context: Record<string, unknown> | undefined,
  pinnedCells: Cell<PinnedCell[]>,
  observationMaxConfidentiality?: readonly CfcConfClause[],
): AvailableCellsDocumentation {
  // Collect all cell entries, deduplicating by resolved path.
  // When the same cell appears multiple times (e.g., from context AND pinned),
  // prefer the entry with a schema.
  const seenPaths = new Map<
    string,
    {
      name: string;
      entry: string;
      hasSchema: boolean;
      observedConfidentiality: readonly CfcConfClause[];
    }
  >();

  function addCellEntry(
    name: string,
    cell: unknown,
  ): void {
    const resolvedCell = resolveContextCellRef(cell);
    if (!resolvedCell) {
      throw new Error(`Context entry "${name}" is not a cell`);
    }
    const concreteCell = resolvedCell;
    const link = concreteCell.getAsNormalizedFullLink();
    const path = createLLMFriendlyLink(link, space);
    const schemaInfo = getCellSchema(concreteCell);

    // Deduplicate: skip if we already have an entry with schema for this path
    const existing = seenPaths.get(path);
    if (existing?.hasSchema && !schemaInfo) return;

    let entry = `## ${name} (${path})\n`;
    let observedConfidentiality: readonly CfcConfClause[] = [];

    if (schemaInfo !== undefined) {
      const schemaStr = getSchemaTypeString(schemaInfo);
      entry += `- Schema: \`\`\`typescript\n${schemaStr}\n\`\`\`\n`;
    }

    try {
      // Declared-empty bound (public only) must take the observation-aware
      // read path too — see the cellsDocs guard above (#3993 review).
      let value = observationMaxConfidentiality !== undefined
        ? readCellValueForObservation(concreteCell)
        : concreteCell.get() ?? concreteCell.getRaw();
      if (
        value === undefined &&
        isObjectOrArray(schemaInfo) &&
        Object.hasOwn(schemaInfo, "default")
      ) {
        value = (schemaInfo as Record<string, unknown>).default;
      }
      const serialized = serializeForLLMObservation({
        value,
        schema: schemaInfo,
        seen: new Set(),
        contextSpace: space,
        rootLink: link,
        labelView: observationMaxConfidentiality
          ? cfcLabelViewForCellFailClosed(concreteCell)
          : undefined,
        observationMaxConfidentiality,
      });
      observedConfidentiality = serialized.observedConfidentiality;

      // TODO(danfuzz): this is an unsafe use of `stringify()`: a
      // `FabricSpecialObject` in the serialized value renders as `{}` in the
      // documentation the model reads. It is a second, independent loss
      // point — `serializeForLLMObservation` above carries its own marker,
      // and fixing that walk alone still leaves this render.
      let valueJson = JSON.stringify(serialized.value ?? null, null, 2);

      const MAX_VALUE_LENGTH = 2000;
      if (valueJson.length > MAX_VALUE_LENGTH) {
        valueJson = valueJson.substring(0, MAX_VALUE_LENGTH) +
          "\n... (truncated)";
      }

      entry += `- Current Value: \`\`\`json\n${valueJson}\n\`\`\`\n`;
    } catch (e) {
      logger.warn(
        "llm",
        `Failed to serialize value for cell ${name}:`,
        e,
      );
      entry += `- Current Value: (unable to serialize)\n`;
    }

    seenPaths.set(path, {
      name,
      entry,
      hasSchema: schemaInfo !== undefined,
      observedConfidentiality,
    });
  }

  // First, process context cells (if provided)
  if (context) {
    for (const [name, cell] of Object.entries(context)) {
      try {
        addCellEntry(name, cell);
      } catch (e) {
        logger.warn("llm", `Failed to document context cell ${name}:`, e);
      }
    }
  }

  // Then, process pinned cells (may override context entries if they have schema)
  const currentPinnedCells = pinnedCells.get() || [];
  for (const pinnedCell of currentPinnedCells) {
    try {
      // Parse the path using the same parser as read/run tools
      const link = parseLLMFriendlyLink(pinnedCell.path, space);

      // Get cell from link
      const cell = runtime.getCellFromLink(link);
      if (!cell) {
        logger.warn(
          "llm",
          `Could not resolve pinned cell ${pinnedCell.path} to a cell`,
        );
        continue;
      }

      addCellEntry(pinnedCell.name, cell);
    } catch (e) {
      logger.warn(
        "llm",
        `Failed to document pinned cell ${pinnedCell.name} (${pinnedCell.path}):`,
        e,
      );
    }
  }

  if (seenPaths.size === 0) {
    return {
      docs: "",
      observedConfidentiality: [],
    };
  }

  const entries = [...seenPaths.values()].map((v) => v.entry);
  return {
    docs: "\n\n# Available Cells\n\n" + entries.join("\n\n"),
    observedConfidentiality: joinCfcObservedConfidentiality(
      [...seenPaths.values()].map((value) => value.observedConfidentiality),
    ),
  };
}

function buildAvailableCellsDocumentation(
  runtime: Runtime,
  space: MemorySpace,
  context: Record<string, unknown> | undefined,
  pinnedCells: Cell<PinnedCell[]>,
  observationMaxConfidentiality?: readonly CfcConfClause[],
): string {
  return buildAvailableCellsDocumentationWithObservation(
    runtime,
    space,
    context,
    pinnedCells,
    observationMaxConfidentiality,
  ).docs;
}

function getObservedDialogMessages(
  messagesCell: Cell<any>,
  messages: readonly BuiltInLLMMessage[],
  messageObservations: DialogMessageObservationMap,
): {
  messages: readonly BuiltInLLMMessage[];
  observedConfidentiality: readonly CfcConfClause[];
} {
  const labelView = cfcLabelViewForCellFailClosed(messagesCell);
  const observedConfidentiality = joinCfcObservedConfidentiality(
    messages.map((_message, index) => {
      const stored = messageObservations[index.toString()];
      if (Array.isArray(stored)) {
        return stored;
      }
      return cfcConfidentialityForObservationNode({
        labelView,
        logicalPath: [index.toString()],
      });
    }),
  );

  return { messages, observedConfidentiality };
}

function mergeDialogMessageObservations(
  current: DialogMessageObservationMap | undefined,
  updates: Array<
    { index: number; observedConfidentiality: readonly CfcConfClause[] }
  >,
): DialogMessageObservationMap {
  const merged: Record<string, unknown[]> = {
    ...(current ?? {}),
  };
  for (const update of updates) {
    const key = update.index.toString();
    merged[key] = uniqueCfcAtoms([
      ...(merged[key] ?? []),
      ...(update.observedConfidentiality ?? []),
    ]) as unknown[];
  }
  return merged;
}

function recordDialogMessageObservations(
  tx: IExtendedStorageTransaction,
  internal: Cell<Schema<typeof internalSchema>>,
  updates: Array<
    { index: number; observedConfidentiality: readonly CfcConfClause[] }
  >,
): void {
  if (updates.length === 0) {
    return;
  }
  const current = internal.withTx(tx).key("messageObservations").get() as
    | DialogMessageObservationMap
    | undefined;
  internal.withTx(tx).key("messageObservations").set(
    mergeDialogMessageObservations(current, updates),
  );
}

// Discriminated union separating external tools from built-in tools
type ResolvedToolCall =
  // Tools provided from outside (by the pattern calling llm-dialog)
  | {
    type: "external";
    call: LLMToolCall;
    toolDef: Cell<Schema<typeof LLMToolSchema>>;
  }
  // Built-in tools provided by llm-dialog itself
  | { type: "pin"; call: LLMToolCall; path: string; name: string }
  | { type: "unpin"; call: LLMToolCall; path: string }
  | { type: "schema"; call: LLMToolCall; cellRef: Cell<any> }
  | { type: "read"; call: LLMToolCall; cellRef: Cell<any> }
  | { type: "presentResult"; call: LLMToolCall; result: unknown }
  | {
    type: "updateArgument";
    call: LLMToolCall;
    cellRef: Cell<any>;
    updates: Record<string, unknown>;
  }
  | {
    type: "invoke";
    call: LLMToolCall;
    // Implementation details for how to invoke the target
    pattern?: Readonly<Pattern>;
    handler?: Stream<any>;
    extraParams?: Record<string, unknown>;
    piece?: Cell<any>;
  };

function resolveToolCall(
  runtime: Runtime,
  space: MemorySpace,
  toolCallPart: BuiltInLLMToolCallPart,
  catalog: ToolCatalog,
): ResolvedToolCall {
  const name = toolCallPart.toolName;
  const id = toolCallPart.toolCallId;
  const externalTool = catalog.dynamicToolCells.get(name);
  if (externalTool) {
    return {
      type: "external",
      toolDef: externalTool,
      call: { id, name, input: toolCallPart.input },
    };
  }

  if (
    name === READ_TOOL_NAME || name === INVOKE_TOOL_NAME ||
    name === SCHEMA_TOOL_NAME || name === PIN_TOOL_NAME ||
    name === UNPIN_TOOL_NAME || name === PRESENT_RESULT_TOOL_NAME ||
    name === UPDATE_ARGUMENT_TOOL_NAME
  ) {
    // Handle pin
    if (name === PIN_TOOL_NAME) {
      const path = extractStringField(
        toolCallPart.input,
        "path",
        "/of:bafyabc123",
      );
      const pinnedCellName = extractStringField(
        toolCallPart.input,
        "name",
        "My Cell",
      );
      return {
        type: "pin",
        call: { id, name, input: { path, name: pinnedCellName } },
        path,
        name: pinnedCellName,
      };
    }

    // Handle unpin
    if (name === UNPIN_TOOL_NAME) {
      const path = extractStringField(
        toolCallPart.input,
        "path",
        "/of:bafyabc123",
      );
      return {
        type: "unpin",
        call: { id, name, input: { path } },
        path,
      };
    }

    // Handle presentResult (builtin tool for generateObject)
    if (name === PRESENT_RESULT_TOOL_NAME) {
      return {
        type: "presentResult",
        call: { id, name, input: toolCallPart.input },
        result: toolCallPart.input,
      };
    }

    // Handle updateArgument
    if (name === UPDATE_ARGUMENT_TOOL_NAME) {
      const target = extractStringField(
        toolCallPart.input,
        "path",
        "/of:bafyabc123",
      );
      const link = parseLLMFriendlyLink(target, space);
      const cellRef = runtime.getCellFromLink(link);

      const updates = toolCallPart.input?.updates;
      if (!updates || typeof updates !== "object") {
        throw new Error(
          "updates must be an object with field names and values",
        );
      }

      return {
        type: "updateArgument",
        cellRef,
        call: { id, name, input: { path: target, updates } },
        updates: updates as Record<string, unknown>,
      };
    }

    const target = extractStringField(
      toolCallPart.input,
      "path",
      "/of:bafyabc123/path",
    );

    const link = parseLLMFriendlyLink(target, space);
    const cellRef = runtime.getCellFromLink(link);

    if (name === SCHEMA_TOOL_NAME) {
      const pieceName = extractStringField(
        toolCallPart.input,
        "path",
        "/of:bafyabc123/path",
      );
      return {
        type: "schema",
        cellRef,
        call: { id, name, input: { piece: pieceName } },
      };
    }

    // A path arrives as an address with no schema, and a stream holds nothing,
    // so something stored has to say what the target is. Three things can. A
    // path through a piece's result crosses a stored link that declares the
    // stream. A path into a result document that keeps its result schema (a
    // builtin's handlers are fields of its own result document) is typed from
    // that schema. A path an observation handed out names a stream's own
    // document, and its owner's manifest declares it.
    //
    // They are tried in that order because the handle chosen is also what the
    // integrity gate reads its floors from (`integrityGateTarget`): a stored
    // link and a manifest link carry the handler's event schema, floors
    // included, where a result schema may say no more than "a stream". The
    // handle returned carries that schema on its own link.
    const streamHandle = (): Cell<unknown> | undefined => {
      const resolved = cellRef.resolveAsCell();
      if (isStream(resolved)) return resolved;
      const typedRef = getResultCellWithSourceSchema(cellRef);
      if (isStream(typedRef.resolveAsCell())) return typedRef;
      const ownerSchema = ownerStreamSchema(resolved);
      return ownerSchema === undefined
        ? undefined
        : cellRef.asSchema(ownerSchema);
    };
    const handler = streamHandle();
    const targetsStream = handler !== undefined;

    if (name === READ_TOOL_NAME) {
      // Get cell reference from the link - works for any valid handle
      if (targetsStream) {
        throw new Error(`Path resolves to a handler; use invoke() instead.`);
      }

      return {
        type: "read",
        cellRef,
        call: { id, name, input: { path: target } },
      };
    }

    if (targetsStream) {
      return {
        type: "invoke",
        // A send decides stream or write off the handle, so the handle
        // carries the declaration that was found for it.
        handler: handler as unknown as Stream<any>,
        call: {
          id,
          name,
          input: extractRunArguments(toolCallPart.input),
        },
      };
    }

    const pattern = cellRef.key("pattern")
      .getRaw() as unknown as Readonly<Pattern> | undefined;
    if (pattern) {
      return {
        type: "invoke",
        pattern,
        extraParams: cellRef.key("extraParams").get() ?? {},
        call: {
          id,
          name,
          input: extractRunArguments(toolCallPart.input),
        },
      };
    }

    throw new Error("target does not resolve to a handler stream or pattern.");
  }

  throw new Error("Tool has neither pattern nor handler");
}

function extractToolCallParts(
  content: BuiltInLLMMessage["content"],
): BuiltInLLMToolCallPart[] {
  if (!Array.isArray(content)) return [];
  return content.filter((part): part is BuiltInLLMToolCallPart =>
    (part as BuiltInLLMToolCallPart).type === "tool-call"
  );
}

/**
 * Validates whether message content is non-empty and valid for the Anthropic API.
 * Returns true if the content contains at least one non-empty text block or tool call.
 */
function hasValidContent(content: BuiltInLLMMessage["content"]): boolean {
  if (typeof content === "string") {
    return content.trim().length > 0;
  }

  if (Array.isArray(content)) {
    return content.some((part) => {
      if (part.type === "tool-call" || part.type === "tool-result") {
        return true;
      }
      if (part.type === "text") {
        return (part as BuiltInLLMTextPart).text?.trim().length > 0;
      }
      return false;
    });
  }

  return false;
}

function buildAssistantMessage(
  content: BuiltInLLMMessage["content"],
  toolCallParts: BuiltInLLMToolCallPart[],
): BuiltInLLMMessage {
  const assistantContentParts: Array<
    BuiltInLLMTextPart | BuiltInLLMToolCallPart
  > = [];

  if (typeof content === "string" && content) {
    assistantContentParts.push({
      type: "text",
      text: content,
    });
  } else if (Array.isArray(content)) {
    assistantContentParts.push(
      ...content.filter((part) => part.type === "text") as BuiltInLLMTextPart[],
    );
  }

  assistantContentParts.push(...toolCallParts);

  return {
    role: "assistant",
    content: assistantContentParts,
  };
}

type ToolCallExecutionResult = {
  id: string;
  toolName: string;
  result?: any;
  error?: string;
  observedConfidentiality?: readonly CfcConfClause[];
};

/**
 * Fold the deployment's per-sink confidentiality ceiling into a
 * pattern-supplied observation bound, yielding the EFFECTIVE bound the LLM
 * builtins enforce while serializing reads for the model.
 *
 * The pattern-supplied `observationMaxConfidentiality` is adversary-controlled
 * in the CFC threat model (and unbounded when omitted), so a deployment that
 * declares a ceiling for this sink must additionally bound every value that can
 * reach the model — including the post-commit tool-loop reads, which carry no
 * `sink-request` input and so are never gated by `prepareBoundaryCommit`
 * (#3993 review). The meet (`pattern ∧ deployment`) admits exactly the values
 * both allowlists admit: pattern omitted → deployment ceiling alone; sink has no
 * deployment ceiling → pattern bound alone (unchanged behavior); declared empty
 * deployment ceiling → public-only regardless of the pattern bound.
 */
function effectiveObservationCeiling(
  runtime: Runtime,
  sink: string,
  patternBound: readonly CfcConfClause[] | undefined,
): readonly CfcConfClause[] | undefined {
  // The pattern's bound arrives as a view of the builtin's input. The bound
  // this returns is carried into request snapshots and read by post-commit
  // tool reads, after the transaction that read the input has finished, so it
  // is detached here, once.
  const ownBound = snapshotQueryResult(patternBound);
  const ceilings = runtime.cfcSinkMaxConfidentiality;
  // Object.hasOwn guard: the sink name is a runner-controlled literal today, but
  // a name colliding with an Object.prototype member must resolve to "no
  // ceiling", not an inherited function.
  const deploymentCeiling = Object.hasOwn(ceilings, sink)
    ? ceilings[sink]
    : undefined;
  return meetCfcObservationCeilings(ownBound, deploymentCeiling);
}

function toolAllowsObservedConfidentiality(
  toolCatalog: ToolCatalog,
  toolName: string,
  observedConfidentiality: readonly CfcConfClause[] | undefined,
): boolean {
  if (!observedConfidentiality || observedConfidentiality.length === 0) {
    return true;
  }

  const toolSchema = toolCatalog.llmTools[toolName]?.inputSchema;
  const maxConfidentiality =
    isObjectOrArray(toolSchema) && isObjectOrArray(toolSchema.ifc)
      ? toolSchema.ifc.maxConfidentiality
      : undefined;
  // A non-array ceiling means none was declared. A declared (even empty) ceiling
  // is enforced: an empty array is "public only". Delegate to
  // cfcObservationFitsCeiling rather than special-casing empty as allow-all,
  // which would skip the empty-ceiling protection (review follow-up to W0.7).
  if (!Array.isArray(maxConfidentiality)) {
    return true;
  }

  return cfcObservationFitsCeiling(observedConfidentiality, maxConfidentiality);
}

// The integrity a model-supplied tool-input value carries (Epic D2). A value
// the model passed BY REFERENCE (a `{"@link":…}` to a cell) carries that
// cell's stored integrity; a value the model emitted as a plain literal
// carries none — it is model output (stamped at most `LlmDerived`, D1), which
// by construction lacks any endorsement family. `traverseAndCellify` is the
// same resolver the invoke path uses, so a reference is read identically here.
function toolInputValueIntegrity(
  runtime: Runtime,
  space: MemorySpace,
  value: unknown,
): unknown[] {
  const cellified = traverseAndCellify(runtime, space, value);
  if (!isCell(cellified)) {
    return [];
  }
  const view = cfcLabelViewForCellFailClosed(cellified);
  return (view?.entries ?? []).flatMap((entry) => entry.label.integrity ?? []);
}

// Walk a tool's `inputSchema` for fields declaring `ifc.requiredIntegrity` and
// verify the model-supplied value at each carries every required atom (Epic D2,
// docs/history/specs/cfc-trusted-agent-tool-integrity.md piece A/C). A control/routing
// field (e.g. `sendMail.recipient`) declaring the agent-kernel integrity floor
// can only be satisfied by an integrity-bearing reference the model passed, not
// by a string it copied out of a hostile briefing — that fails closed. Returns
// the first failing field's reason, or undefined if all floors are satisfied.
function toolInputRequiredIntegrityFailure(
  runtime: Runtime,
  space: MemorySpace,
  schema: unknown,
  value: unknown,
  path: string,
  trust: CfcFloorTrustContext,
  root?: unknown,
  visited?: Set<unknown>,
): string | undefined {
  if (!isObjectOrArray(schema)) {
    return undefined;
  }
  // A reference-form schema resolves before the walk, through the
  // fail-closed resolver: this is a security gate, so an unresolvable
  // reference refuses the call — a floor could hide behind it. Deliberately
  // NOT resolveExternalRootRefForStructure, whose reference-unchanged miss
  // would read as nothing-to-refuse. A LOCAL reference resolves against the
  // owning document (`root`) the recursion carries — a member of a recursive
  // group arrives as a bare pointer with its floor behind it — and following
  // an external reference makes the resolved document the owning root for
  // everything under it.
  let structural = schema;
  let structuralRoot: JSONSchema = (root ?? schema) as JSONSchema;
  const ref = structural.$ref;
  if (typeof ref === "string") {
    try {
      const resolved = ContextualFlowControl.resolveSchemaRefsOrThrow(
        structural,
        structuralRoot,
      );
      if (!isObjectOrArray(resolved)) return undefined;
      structural = resolved;
      if (isExternalSchemaRef(ref)) {
        structuralRoot = resolved;
      }
      structuralRoot = cfcSchemaResolvedRoot(
        structural as JSONSchema,
        structuralRoot,
      );
    } catch {
      return `field "${
        path || "(root)"
      }" carries a schema reference this session cannot resolve; ` +
        `refusing the call (fail closed)`;
    }
  }
  // A compound branch recurses on the SAME value, so a self-referential
  // group could otherwise walk forever. Everything reachable at this value
  // position is gated the first time its (interned, identity-stable)
  // resolution appears; a repeat is the cycle closing.
  const seen = visited ?? new Set<unknown>();
  if (seen.has(structural)) return undefined;
  seen.add(structural);
  const ifc = structural.ifc;
  if (isObjectOrArray(ifc) && Array.isArray(ifc.requiredIntegrity)) {
    const required = ifc.requiredIntegrity;
    if (required.length > 0) {
      const integrity = toolInputValueIntegrity(runtime, space, value);
      // The single shared floor predicate (observation.ts) — the same
      // membership the commit-boundary gates use. `trust` carries the acting
      // principal's closure so a CONCEPT-valued floor accepts any concrete
      // atom above the concept (D5), consistently with the read/write gates.
      const satisfied = cfcIntegritySatisfiesFloor(
        integrity as readonly CfcAtom[],
        required,
        trust,
      );
      if (!satisfied) {
        return `field "${path || "(root)"}" requires integrity the ` +
          `model-supplied value does not carry (pass an integrity-bearing ` +
          `reference, not a literal)`;
      }
    }
  }
  if (isObjectOrArray(structural.properties)) {
    for (const [key, childSchema] of Object.entries(structural.properties)) {
      // Only gate fields the model actually supplied. An absent (e.g. optional)
      // field carries no value to gate; treating it as `undefined` would fail
      // an optional field's floor and over-block the call. A required field the
      // model omitted is a structural error handled by ordinary input
      // validation, not a floor bypass — there is no injected value to gate.
      if (!isObjectOrArray(value) || !Object.hasOwn(value, key)) {
        continue;
      }
      const failure = toolInputRequiredIntegrityFailure(
        runtime,
        space,
        childSchema,
        value[key],
        path ? `${path}.${key}` : key,
        trust,
        structuralRoot,
      );
      if (failure !== undefined) {
        return failure;
      }
    }
  }
  // Array elements: a tuple slot's floor gates its exact position, and a
  // floor under `items` gates the positions past the slots (2020-12,
  // matching the sanitizer's semantics — e.g.
  // `recipients: { items: { ifc: { requiredIntegrity } } }`). Tuple slots
  // previously went entirely ungated: this walk never descended
  // prefixItems.
  if (Array.isArray(value)) {
    const prefixItems = Array.isArray(structural.prefixItems)
      ? structural.prefixItems
      : undefined;
    for (let index = 0; index < value.length; index++) {
      const slotSchema = prefixItems !== undefined && index < prefixItems.length
        ? prefixItems[index]
        : structural.items;
      if (!isObjectOrArray(slotSchema)) continue;
      const failure = toolInputRequiredIntegrityFailure(
        runtime,
        space,
        slotSchema,
        value[index],
        `${path}[${index}]`,
        trust,
        structuralRoot,
      );
      if (failure !== undefined) {
        return failure;
      }
    }
  }
  // Compound schemas: mirror the IFC schema walker — descend into every
  // branch. For a required-integrity FLOOR, requiring the union across
  // branches is the fail-safe (over-require) direction, matching walkIfcSchema.
  for (const key of ["anyOf", "oneOf", "allOf"] as const) {
    const branches = structural[key];
    if (Array.isArray(branches)) {
      for (const branch of branches) {
        const failure = toolInputRequiredIntegrityFailure(
          runtime,
          space,
          branch,
          value,
          path,
          trust,
          structuralRoot,
          seen,
        );
        if (failure !== undefined) {
          return failure;
        }
      }
    }
  }
  return undefined;
}

// The (schema, input) the D2 integrity gate checks for a resolved tool call.
// For the generic `invoke` builtin the target is the resolved handler /
// pattern, whose ARGUMENT schema carries the requiredIntegrity floors — its
// own `path`/`args` builtin schema declares none — and the value is the
// resolved args (path stripped). External tools keep the catalog input schema
// and the raw model input. Other management builtins (pin/read/schema/…) have
// fixed floor-free schemas, so their check is a no-op.
function integrityGateTarget(
  resolved: ResolvedToolCall,
  part: BuiltInLLMToolCallPart,
  toolCatalog: ToolCatalog,
): { schema: unknown; input: unknown } {
  if (resolved.type === "invoke") {
    const schema = resolved.pattern?.argumentSchema ??
      (resolved.handler as unknown as { schema?: unknown } | undefined)
        ?.schema;
    return { schema, input: resolved.call.input };
  }
  return {
    schema: toolCatalog.llmTools[part.toolName]?.inputSchema,
    input: part.input,
  };
}

async function executeToolCalls(
  runtime: Runtime,
  space: MemorySpace,
  toolCatalog: ToolCatalog,
  toolCallParts: BuiltInLLMToolCallPart[],
  pinnedCells?: Cell<PinnedCell[]>,
  observedConfidentiality?: readonly CfcConfClause[],
  observationMaxConfidentiality?: readonly CfcConfClause[],
  // The turn's abort signal. A tool that runs a pattern waits for that pattern,
  // and cancelling the turn has to reach that wait: without it the tool runs on
  // after the user has cancelled, and only its writeback is discarded.
  abortSignal?: AbortSignal,
): Promise<ToolCallExecutionResult[]> {
  const results: ToolCallExecutionResult[] = [];
  for (const part of toolCallParts) {
    try {
      // A model turn can call several tools at once, and they run one after
      // another here. Checking the signal per tool rather than only inside the
      // wait is what keeps a cancel from starting the ones not reached yet:
      // `handleInvoke` runs the pattern or sends to the handler before it
      // reaches its own wait, so a tool entered after the cancel would fire its
      // side effects and only then notice.
      if (abortSignal?.aborted) {
        results.push({
          id: part.toolCallId,
          toolName: part.toolName,
          error: "Tool call cancelled",
        });
        continue;
      }

      if (
        !toolAllowsObservedConfidentiality(
          toolCatalog,
          part.toolName,
          observedConfidentiality,
        )
      ) {
        results.push({
          id: part.toolCallId,
          toolName: part.toolName,
          error:
            `Tool call denied: observed confidentiality exceeds maxConfidentiality for ${part.toolName}`,
        });
        continue;
      }

      const resolved = resolveToolCall(runtime, space, part, toolCatalog);

      // Epic D2: gate the model-supplied input against the TARGET's
      // requiredIntegrity floors before the handler runs, so an injected
      // control-field value (e.g. a recipient copied from a hostile briefing)
      // is refused rather than executed. Runs AFTER resolveToolCall so the
      // generic `invoke` builtin is checked against the resolved handler /
      // pattern argument schema (its own path/args schema declares no floors),
      // closing the invoke bypass. Only DENIES in enforcing modes — observe is
      // diagnostic and must not block — and is a no-op for tools declaring no
      // requiredIntegrity.
      if (
        cfcEnforcementStrictness(runtime.cfcEnforcementMode) >=
          CFC_ENFORCING_STRICTNESS
      ) {
        const gate = integrityGateTarget(resolved, part, toolCatalog);
        // Acting principal's trust closure for CONCEPT-valued floors (D5),
        // built from the runtime's frozen trust config + acting principal —
        // the same inputs the tx-side gates use via cfcFloorTrustContext.
        const trust: CfcFloorTrustContext = {
          trustResolver: createTrustResolver(runtime.cfcTrustConfig),
          actingPrincipal: runtime.trustSnapshotProvider()?.actingPrincipal,
        };
        const integrityFailure = toolInputRequiredIntegrityFailure(
          runtime,
          space,
          gate.schema,
          gate.input,
          "",
          trust,
        );
        if (integrityFailure !== undefined) {
          results.push({
            id: part.toolCallId,
            toolName: part.toolName,
            error: `Tool call denied: ${integrityFailure}`,
          });
          continue;
        }
      }

      const resultValue = await invokeToolCall(
        runtime,
        space,
        resolved,
        toolCatalog,
        pinnedCells,
        observationMaxConfidentiality,
        abortSignal,
      );
      results.push({
        id: part.toolCallId,
        toolName: part.toolName,
        result: resultValue.result,
        observedConfidentiality: resultValue.observedConfidentiality,
      });
    } catch (error) {
      console.error(`Tool ${part.toolName} failed:`, error);
      results.push({
        id: part.toolCallId,
        toolName: part.toolName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

function createToolResultMessages(
  results: ToolCallExecutionResult[],
): BuiltInLLMMessage[] {
  return results.map((toolResult) => {
    // Ensure output is never undefined/null - Anthropic API requires valid tool_result
    // for every tool_use, even if the tool returns nothing
    let output: any;
    if (toolResult.error) {
      output = { type: "error-text", value: toolResult.error };
    } else if (toolResult.result === undefined || toolResult.result === null) {
      // Tool returned nothing - use explicit null value
      output = { type: "json", value: null };
    } else {
      output = toolResult.result;
    }

    return {
      role: "tool",
      content: [{
        type: "tool-result",
        toolCallId: toolResult.id,
        toolName: toolResult.toolName || "unknown",
        output,
      }],
    };
  });
}

export const llmDialogTestHelpers = {
  REQUEST_TIMEOUT,
  getCellSchema,
  parseLLMFriendlyLink,
  traverseAndSerialize,
  serializeForLLMObservation,
  traverseAndCellify,
  extractStringField,
  extractRunArguments,
  extractToolCallParts,
  buildAssistantMessage,
  createToolResultMessages,
  hasValidContent,
  PRESENT_RESULT_TOOL_NAME,
  simplifySchemaForContext,
  prepareSchemaForLLM,
  resolveRefsForLLM,
  resolveToolCall,
  toolAllowsObservedConfidentiality,
};

/**
 * Shared tool execution utilities for use by other LLM built-ins (llm, generateText).
 * These functions handle tool catalog building, tool call resolution, and execution.
 */
export const llmToolExecutionHelpers = {
  PRESENT_RESULT_TOOL_NAME,
  buildToolCatalog,
  flattenTools,
  executeToolCalls,
  extractToolCallParts,
  buildAssistantMessage,
  createToolResultMessages,
  hasValidContent,
  buildAvailableCellsDocumentation,
  buildAvailableCellsDocumentationWithObservation,
  traverseAndCellify,
  prepareSchemaForLLM,
  serializeForLLMObservation,
  toolAllowsObservedConfidentiality,
  effectiveObservationCeiling,
  stripFrameworkProvidedFields,
  applyAutoProvidedSandboxId,
  toolInputRequiredIntegrityFailure,
};

/**
 * Performs a mutation on the storage if the pending flag is active and the
 * request ID matches. This ensures the pending flag has final say over whether
 * the LLM continues generating.
 *
 * @param runtime - The runtime instance
 * @param pending - Cell containing the pending state
 * @param internal - Cell containing the internal state
 * @param requestId - The request ID
 * @param action - The mutation action to perform if pending is true
 * @returns true if the action was performed, false otherwise
 */
async function safelyPerformUpdate(
  runtime: Runtime,
  pending: Cell<boolean>,
  internal: Cell<Schema<typeof internalSchema>>,
  requestId: string,
  identity: ScopeKeyIdentity | undefined,
  action: (tx: IExtendedStorageTransaction) => void,
) {
  const { ok } = await runtime.editWithRetry((tx) => {
    if (identity) tx.tx.scopeKeyIdentity = identity;
    if (
      pending.withTx(tx).get() &&
      internal.withTx(tx).key("requestId").get() === requestId
    ) {
      // Marked on the arm that writes (round-2 thread 6): a bail-out
      // (pending=false or a superseded requestId) writes nothing and
      // must not commit as a spurious no-op effect-completion for
      // `llmDialog:<requestId>` on every canceled/superseded turn. The
      // marker still precedes every write of this arm.
      markEffectCompletion(tx, `llmDialog:${requestId}`);
      action(tx);
      internal.withTx(tx).key("lastActivity").set(Date.now());
      return true;
    } else {
      // We might have flagged success as true in a previous call, but if the
      // retry flow lands us here, it means it wasn't written and that now
      // the requestId has changed.
      return false;
    }
  });

  return !!ok;
}

/**
 * `editWithRetry` bound to the turn's abort signal (round-2 thread 14):
 * a stopped or replaced turn must not persist pin/unpin/argument state
 * from a tool call that was mid-flight when the cancel landed. Checked
 * before starting AND inside the callback (a retry attempt after the
 * cancel aborts too — the throw makes editWithRetry abort the tx and
 * return the error without committing).
 */
function editWithRetryUnlessAborted(
  runtime: Runtime,
  abortSignal: AbortSignal | undefined,
  fn: (tx: IExtendedStorageTransaction) => void,
): ReturnType<Runtime["editWithRetry"]> {
  if (abortSignal?.aborted) {
    return Promise.resolve({
      error: {
        name: "StorageTransactionAborted" as const,
        message: "Tool call cancelled",
        reason: new Error("turn-aborted"),
      },
    });
  }
  return runtime.editWithRetry((tx) => {
    if (abortSignal?.aborted) {
      throw new Error("Tool call cancelled");
    }
    fn(tx);
  });
}

/**
 * Handles the pin tool call.
 */
async function handlePin(
  runtime: Runtime,
  resolved: ResolvedToolCall & { type: "pin" },
  pinnedCells: Cell<PinnedCell[]>,
  abortSignal?: AbortSignal,
): Promise<{ type: string; value: any }> {
  const current = pinnedCells.get() || [];

  // Check if already pinned
  if (current.some((p) => p.path === resolved.path)) {
    return {
      type: "json",
      value: { success: false, message: "Already pinned" },
    };
  }

  // Add new pinned cell using a transaction. AWAITED and surfaced (the
  // stage-G review's Flag 4): fire-and-forget discarded the outcome, so
  // ON-arm the serving posture's unstamped-seal refusal (serving-loop.md
  // §3d) vanished as an unhandled rejection while the tool reported
  // success. Classification (RULED 2026-08-05; IMPLEMENTED with
  // Phase 3): pin is COMPLETION-CLASS turn-lifecycle state — the mark
  // routes the commit through the effect-completion path (its own
  // derived-class commit under the serving posture; a no-op elsewhere).
  // The lifecycle subkey is deliberately NOT the turn's own effect key:
  // retiring `llmDialog:<requestId>` mid-turn would tear the turn's
  // in-flight dedupe entry.
  // NOTE (review 2026-08-11; T17 pinned 2026-08-14): the completion
  // path's identity annotations fall back to the WAVE-LEVEL identity
  // when no outbox carriage is live (space-server.ts's
  // effect-completion comment) — and these lifecycle subkeys carry no
  // carriage by construction. Sound while `pinnedCells` is
  // space-scope. If it is ever SCOPED (per-user/per-session), this
  // commit would resolve against the serving session's identity, not
  // the acting user's instance — the T17 lifecycle-carriage pin in
  // executor-serving-loop.test.ts binds exactly that fallback (scoped
  // op under the wave key, no attribution) and is the test such a
  // change must flip. Applies to unpin below identically.
  const committed = await editWithRetryUnlessAborted(runtime, abortSignal, (
    tx,
  ) => {
    markEffectCompletion(tx, "llmDialog:lifecycle:pin");
    const currentInTx = pinnedCells.withTx(tx).get() || [];
    pinnedCells.withTx(tx).set([
      ...currentInTx,
      { path: resolved.path, name: resolved.name },
    ]);
  });
  if (committed.error !== undefined) {
    logger.warn("pin-commit-failed", () => [
      `pin of ${resolved.path} failed to commit`,
      committed.error,
    ]);
    return {
      type: "json",
      value: {
        success: false,
        message: `Pin failed to commit: ${committed.error.message}`,
      },
    };
  }

  return { type: "json", value: { success: true } };
}

/**
 * Handles the unpin tool call.
 */
async function handleUnpin(
  runtime: Runtime,
  resolved: ResolvedToolCall & { type: "unpin" },
  pinnedCells: Cell<PinnedCell[]>,
  abortSignal?: AbortSignal,
): Promise<{ type: string; value: any }> {
  const current = pinnedCells.get() || [];
  const filtered = current.filter((p) => p.path !== resolved.path);

  if (filtered.length === current.length) {
    return {
      type: "json",
      value: { success: false, message: "Not found" },
    };
  }

  // Remove pinned cell using a transaction. Awaited and surfaced — see
  // handlePin (Flag 4). Classification (RULED 2026-08-05;
  // IMPLEMENTED with Phase 3): unpin is COMPLETION-CLASS
  // turn-lifecycle state.
  const committed = await editWithRetryUnlessAborted(runtime, abortSignal, (
    tx,
  ) => {
    markEffectCompletion(tx, "llmDialog:lifecycle:unpin");
    const currentInTx = pinnedCells.withTx(tx).get() || [];
    const filteredInTx = currentInTx.filter((p) => p.path !== resolved.path);
    pinnedCells.withTx(tx).set(filteredInTx);
  });
  if (committed.error !== undefined) {
    logger.warn("unpin-commit-failed", () => [
      `unpin of ${resolved.path} failed to commit`,
      committed.error,
    ]);
    return {
      type: "json",
      value: {
        success: false,
        message: `Unpin failed to commit: ${committed.error.message}`,
      },
    };
  }

  return { type: "json", value: { success: true } };
}

/**
 * Handles the schema tool call.
 */
function handleSchema(
  resolved: ResolvedToolCall & { type: "schema" },
): { type: string; value: any } {
  const schema = getCellSchema(resolved.cellRef) ?? {};
  // Deep-frozen clone: `schema` may be a query-result proxy, so de-proxy and
  // preserve `FabricValue` leaves rather than mangling them through JSON. The
  // result is a read-only `"json"` tool payload, so freezing is fine.
  const value = toDeepFrozenSchema(schema);
  return { type: "json", value };
}

/**
 * Handles the read tool call.
 */
async function handleRead(
  resolved: ResolvedToolCall & { type: "read" },
  space: MemorySpace,
  observationMaxConfidentiality?: readonly CfcConfClause[],
): Promise<
  {
    result: { type: string; value: unknown };
    observedConfidentiality: readonly CfcConfClause[];
  }
> {
  let cell = resolved.cellRef.resolveAsCell().asSchemaFromLinks();
  await cell.pull();
  let schema = cell.schema ?? getCellSchema(cell);
  if (!cell.schema && schema) {
    cell = cell.asSchema(schema);
  }
  schema = cell.schema ?? schema;
  let value = schema ? cell.get() : cell.getRaw();
  if (value === undefined) {
    // If our cell is an intermediate with a parent result, follow that
    const parentLink = getMetaLink(cell, "result");
    if (parentLink !== undefined) {
      const parentCell = cell.runtime.getCellFromLink(parentLink);
      await parentCell.pull();
      schema = parentCell.schema ?? getCellSchema(parentCell);
      cell = schema ? parentCell.asSchema(schema) : parentCell;
      value = schema ? cell.get() : cell.getRaw();
    }
  }
  const serialized = serializeForLLMObservation({
    value,
    schema,
    seen: new Set(),
    contextSpace: space,
    rootLink: cell.getAsNormalizedFullLink(),
    labelView: cfcLabelViewForCellFailClosed(cell),
    observationMaxConfidentiality,
  });

  // Handle undefined by returning null (valid JSON) instead
  return {
    result: {
      type: "json",
      value: serialized.value ?? null,
      ...(schema !== undefined && { schema }),
    },
    observedConfidentiality: serialized.observedConfidentiality,
  };
}

/**
 * Handles the update Argument tool call.
 */
async function handleUpdateArgument(
  runtime: Runtime,
  resolved: ResolvedToolCall & { type: "updateArgument" },
  abortSignal?: AbortSignal,
): Promise<{ type: string; value: any }> {
  const cell = resolved.cellRef;
  const updates = resolved.updates;

  const argumentLink = getMetaLink(cell, "argument");
  if (argumentLink === undefined) {
    throw new Error(
      "Target is not a pattern instance - no argument cell found. " +
        "updateArgument only works with running patterns (e.g., from invoke() or attached patterns).",
    );
  }

  // Access the argument cell
  const argumentCell = runtime.getCellFromLink(argumentLink);
  const cellifiedValue = traverseAndCellify(
    runtime,
    argumentCell.space,
    updates,
  );

  // Apply updates to argument fields. Awaited and surfaced — see
  // handlePin (Flag 4): the discarded outcome silently swallowed the
  // ON-arm unstamped-seal refusal while reporting success.
  // Classification (RULED 2026-08-05; IMPLEMENTED with Phase 3):
  // updateArgument is a HANDLER-CLASS consequence — the stamp seals it
  // into the wave as a non-re-derivable event-handler contribution
  // (§3d's rebase-don't-drop class). No eventId: the mutation is a
  // tool-call consequence, not a stream event — a raced rebase that
  // conflicts semantically rolls it back with nothing to requeue,
  // which is the class's inherent no-event corner.
  const committed = await editWithRetryUnlessAborted(runtime, abortSignal, (
    tx,
  ) => {
    runtime.stampServerRun(tx, {
      // Keyed per TARGET instance (round-2 thread T28): one global id
      // made the wave's §3b overwrite unit treat CONCURRENT
      // updateArgument calls against different targets as re-runs of
      // one action — a later contribution's basis/rebase rows replaced
      // an earlier unrelated one's as a set. The argument doc id is
      // durable and retry-stable.
      actionId:
        `llm-dialog/update-argument:${argumentCell.getAsNormalizedFullLink().id}`,
      kind: "event-handler",
    });
    if (
      isObjectNotArray(cellifiedValue) &&
      !isCell(cellifiedValue)
    ) {
      argumentCell.withTx(tx).update(cellifiedValue);
    } else {
      argumentCell.withTx(tx).set(cellifiedValue);
    }
  });
  if (committed.error !== undefined) {
    logger.warn("update-argument-commit-failed", () => [
      "updateArgument failed to commit",
      committed.error,
    ]);
    return {
      type: "json",
      value: {
        success: false,
        message: `Argument update failed to commit: ${committed.error.message}`,
      },
    };
  }

  return {
    type: "json",
    value: {
      success: true,
      message: "Arguments updated. Pattern will re-execute automatically.",
    },
  };
}

/**
 * Auto-provides the `sandboxId` input for tools that declare it (the bash tool
 * and anything sharing its contract). The framework OWNS this field: a pattern
 * that declares `sandboxId` never chooses its value, and neither does the model.
 *
 * The value is the content-addressed entity id of the tool's own definition
 * cell. That id is unique to this pattern instance, constant for the life of the
 * instance, and the same for every call the instance makes — so repeated bash
 * calls reuse one persistent server-side sandbox, while two instances (or two
 * users) never land on the same one. The id comes from the instance's identity
 * rather than the clock or randomness.
 *
 * The server names sandboxes by this id (`/v1/sandboxes/<id>`), so any
 * caller-chosen value is a cross-instance leak vector: two patterns that pin the
 * same id would share a sandbox, and a pattern could name another instance's (or
 * another user's). A pattern that pre-fills `sandboxId` through patternTool's
 * extraParams is rejected outright — a chosen value can never take effect, so
 * silently dropping it would hide an authoring mistake; this throws instead. A
 * model-supplied value (untrusted, not an authoring mistake) is overwritten. If
 * the pattern declares `sandboxId` but no stable id can be derived, this also
 * throws rather than fall through to an empty, shared name.
 */
function applyAutoProvidedSandboxId(
  args: Record<string, unknown>,
  pattern: Readonly<Pattern> | undefined,
  extraParams: Record<string, unknown>,
  identityCell: Cell<any> | undefined,
): void {
  const properties = (pattern?.argumentSchema as
    | { properties?: Record<string, unknown> }
    | undefined)?.properties;
  if (!properties || !("sandboxId" in properties)) return;
  if (extraParams.sandboxId !== undefined) {
    throw new Error(
      "sandboxId is framework-provided for tools that declare it; " +
        "remove it from patternTool's extraParams",
    );
  }
  // getEntityId does the heavy lifting the key needs (content-hashing data:
  // URIs, path-qualifying sub-cell identities so two tools in one document
  // get distinct sandboxes) but it ERASES the URI scheme — and the scheme is
  // part of the identity, so a computed: cell's bare hash would alias its
  // of: sibling's sandbox. Re-apply the sourceURI's entity scheme (of: or
  // computed:) as a prefix, so the key is the full schemed id. data:-derived
  // identities have no entity scheme and stay as their bare content hash.
  const ref = identityCell ? getEntityId(identityCell) : undefined;
  const bare = ref && isEntityRef(ref) ? entityRefToString(ref) : undefined;
  const scheme = entityUriSchemePrefix(identityCell?.sourceURI ?? "") ?? "";
  const entityId = bare ? scheme + bare : undefined;
  if (typeof entityId !== "string" || entityId.length === 0) {
    throw new Error(
      "Cannot auto-provide sandboxId: tool instance has no stable entity id",
    );
  }
  // The entity id carries URI scheme separators (e.g. "fid1:<hash>",
  // "computed:fid1:<hash>"). The id names a server-side resource at
  // `/v1/sandboxes/<id>`, so map the only unsafe character (the colon) to a
  // hyphen. The hash body is base64url and is preserved exactly, so distinct
  // entity ids stay distinct.
  args.sandboxId = entityId.replace(/[^A-Za-z0-9_-]/g, "-");
}

/**
 * Handles the invoke tool call (both pattern and handler execution).
 */
async function handleInvoke(
  runtime: Runtime,
  space: MemorySpace,
  resolved: ResolvedToolCall,
  observationMaxConfidentiality?: readonly CfcConfClause[],
  abortSignal?: AbortSignal,
): Promise<{
  result: { type: string; value: any };
  observedConfidentiality: readonly CfcConfClause[];
}> {
  const toolCall = resolved.call;

  // Extract pattern/handler/params based on the resolved type
  let pattern: Readonly<Pattern> | undefined;
  let extraParams: Record<string, unknown> = {};
  let handler: any;
  let useResultSchemaForObservation = false;
  // The cell the tool was resolved from. Its content-addressed entity id is the
  // running instance's identity, used to auto-provide a per-instance sandbox id.
  let identityCell: Cell<any> | undefined;

  if (resolved.type === "external") {
    pattern = resolved.toolDef.key("pattern").getRaw() as unknown as
      | Readonly<Pattern>
      | undefined;
    extraParams = resolved.toolDef.key("extraParams").get() ?? {};
    handler = resolved.toolDef.key("handler");
    useResultSchemaForObservation = Boolean(
      resolved.toolDef.key("useResultSchemaForObservation").get(),
    );
    identityCell = resolved.toolDef;
  } else if (resolved.type === "invoke") {
    pattern = resolved.pattern;
    extraParams = resolved.extraParams ?? {};
    handler = resolved.handler;
    // No identity cell for invoke-by-path: a tool that declares `sandboxId` and
    // is invoked this way fails closed in applyAutoProvidedSandboxId rather than
    // run with an unprovided id.
  }

  // A pattern read raw from a cell is the boundary serialization (refs-only
  // since identity E4): resolve the live canonical pattern via its
  // $patternRef — sync from the session-lifetime artifact index, async from
  // the space's persisted compiled artifacts when the module never evaluated
  // here — with stored graph vintages passing through unchanged.
  pattern = await resolveStoredPatternAsync(runtime, pattern, space) as
    | Readonly<Pattern>
    | undefined;

  const input = traverseAndCellify(runtime, space, toolCall.input) as object;

  // The model input is the lowest-priority layer; extraParams (author pre-fills)
  // override it, and the framework-owned sandbox id overrides both.
  const invocationArgs = {
    ...input as Record<string, unknown>,
    ...extraParams,
  };
  applyAutoProvidedSandboxId(
    invocationArgs,
    pattern,
    extraParams,
    identityCell,
  );

  const { resolve, promise } = Promise.withResolvers<any>();

  // Create result cell reference that will be set in the transaction
  let result: Cell<any> = null as any;

  await runtime.editWithRetry((tx) => {
    // Create the result cell within the transaction context
    result = runtime.getCell<any>(
      space,
      toolCall.id,
      pattern ? pattern.resultSchema : undefined,
      tx,
    );

    if (pattern) {
      // The model's tool call instantiates the pattern, in a continuation of
      // the dialog's action: no principal's act attributes what its setup
      // initializes.
      runtime.run(tx, pattern, invocationArgs, result, {
        attributeInitialization: false,
      });
    } else if (handler) {
      // Inject the result cell only when the caller's input does not carry a
      // `result` of its own. Overwriting would silently DISCARD caller data
      // before the closed-world gate could see it — the accepted-and-ignored
      // failure mode C5 kills — so a caller-supplied `result` flows through
      // UNMARKED instead: against a closed schema that does not declare it,
      // the gate refuses the call; against an open or declaring schema it is
      // the caller's ordinary field. The advertised schema hides `result`
      // (stripInjectedResult), so a well-behaved caller never sends one and
      // always gets the injected cell.
      const injectResult =
        !(isObjectOrArray(input) && Object.hasOwn(input, "result"));
      handler.withTx(tx).send(
        injectResult
          ? {
            ...input,
            result, // doesn't HAVE to be used, but can be
          }
          : input,
        (completedTx: IExtendedStorageTransaction) => {
          const summary = formatTransactionSummary(completedTx, space);
          const value = result.withTx(completedTx);
          resolve({ value, summary });
        },
        // Provenance for the closed-world gate: `result` is OUR injection,
        // named through the mint-gated internal options bag (see
        // markRuntimeInjectedEventKeys) — never inferable from the payload's
        // shape, so nothing a caller sends can claim the exemption.
        injectResult
          ? {
            runtimeInjectedEventKeys: markRuntimeInjectedEventKeys(["result"]),
          }
          : undefined,
      );
    } else {
      throw new Error("Tool has neither pattern nor handler");
    }
  });

  await runtime.idle();

  // Wait for the pattern/handler to complete and write the result
  const cancel = result.sink((r) => {
    r !== undefined && resolve(r);
  });

  // Ends three ways, each of them an event: the result lands, the run quiesces,
  // or the turn is cancelled.
  //
  // The middle one is what makes the wait above determinate. "The result cell
  // became defined" conflates two questions — has the run finished, and did it
  // produce anything — so a run that finishes having written nothing looks the
  // same as one still working. `settledFor` answers the first question directly
  // for the run this tool call started, so a tool that produced nothing ends
  // here with the cell still undefined rather than waiting for a value that is
  // never coming.
  const aborted = abortSignal
    ? new Promise<void>((resolveAborted) => {
      if (abortSignal.aborted) return resolveAborted();
      abortSignal.addEventListener("abort", () => resolveAborted(), {
        once: true,
      });
    })
    : undefined;

  // The barrier keeps re-checking until the run goes quiet, so a race the result
  // wins would otherwise leave it looping with nobody waiting.
  const quiescence = new AbortController();
  try {
    await Promise.race(
      [promise, runtime.settledFor(result, quiescence.signal), aborted]
        .filter(Boolean),
    );
  } finally {
    quiescence.abort();
    cancel();
  }

  // Cancelling stops this wait; without stopping the run the pattern behind it
  // keeps computing and keeps its own model calls in flight, so the tool would
  // go on working after the user has cancelled the turn.
  if (abortSignal?.aborted) {
    if (pattern) runtime.runner.stop(result);
    throw new Error("Tool call cancelled");
  }

  // Get the actual entity ID from the result cell
  const resultLink = createLLMFriendlyLink(
    result.getAsNormalizedFullLink(),
    space,
  );

  const resultSchema = getCellSchema(result);

  // Patterns always write to the result cell, so always return the link
  if (pattern) {
    const concreteResult = result.resolveAsCell();
    const concreteResultSchema = getCellSchema(concreteResult) ?? resultSchema;
    const serialized = serializeForLLMObservation({
      value: concreteResult.get(),
      schema: concreteResultSchema,
      seen: new Set(),
      contextSpace: space,
      rootLink: concreteResult.getAsNormalizedFullLink(),
      labelView: useResultSchemaForObservation
        ? undefined
        : cfcLabelViewForCellFailClosed(concreteResult),
      observationMaxConfidentiality,
    });
    return {
      result: {
        type: "json",
        value: {
          "@resultLocation": resultLink,
          result: serialized.value,
          schema: concreteResultSchema,
        },
      },
      observedConfidentiality: serialized.observedConfidentiality,
    };
  }

  // Handlers may or may not write to the result cell
  // Only return a link if the handler actually wrote something
  if (handler) {
    const resultValue = result.get();

    if (resultValue !== undefined && resultValue !== null) {
      const serialized = serializeForLLMObservation({
        value: resultValue,
        schema: resultSchema,
        seen: new Set(),
        contextSpace: space,
        rootLink: result.getAsNormalizedFullLink(),
        labelView: cfcLabelViewForCellFailClosed(result),
        observationMaxConfidentiality,
      });
      return {
        result: {
          type: "json",
          value: {
            "@resultLocation": resultLink,
            result: serialized.value,
            schema: resultSchema,
          },
        },
        observedConfidentiality: serialized.observedConfidentiality,
      };
    }
    // Handler didn't write anything, return null
    return {
      result: { type: "json", value: null },
      observedConfidentiality: [],
    };
  }

  throw new Error("Tool has neither pattern nor handler");
}

/**
 * Executes a tool call by invoking its handler function and returning the
 * result. Creates a new transaction, sends the tool call arguments to the
 * handler, and waits for the result to be available before returning it.
 *
 * @param runtime - The runtime instance for creating transactions and cells
 * @param space - The memory space for the tool execution
 * @param resolved - The resolved tool call containing type and metadata
 * @param catalog - Optional tool catalog for lookups
 * @returns Promise that resolves to the tool execution result
 */
async function invokeToolCall(
  runtime: Runtime,
  space: MemorySpace,
  resolved: ResolvedToolCall,
  _catalog?: ToolCatalog,
  pinnedCells?: Cell<PinnedCell[]>,
  observationMaxConfidentiality?: readonly CfcConfClause[],
  abortSignal?: AbortSignal,
) {
  // Handle pinned cell tools
  if (resolved.type === "pin") {
    return {
      result: await handlePin(runtime, resolved, pinnedCells!, abortSignal),
      observedConfidentiality: [],
    };
  }

  if (resolved.type === "unpin") {
    return {
      result: await handleUnpin(runtime, resolved, pinnedCells!, abortSignal),
      observedConfidentiality: [],
    };
  }

  if (resolved.type === "schema") {
    return {
      result: handleSchema(resolved),
      observedConfidentiality: [],
    };
  }

  if (resolved.type === "read") {
    return await handleRead(resolved, space, observationMaxConfidentiality);
  }

  if (resolved.type === "presentResult") {
    // Cellify to get live references, then serialize back to @link for the
    // conversation message. The caller (startRequest) cellifies separately
    // from the raw tool call input to store on the dialog's result cell.
    const cellified = traverseAndCellify(runtime, space, resolved.result);
    return {
      result: {
        type: "json",
        value: traverseAndSerialize(cellified, undefined, new Set(), space),
      },
      observedConfidentiality: [],
    };
  }

  // Handle run-type tools (external, run with pattern/handler)
  if (resolved.type === "updateArgument") {
    return {
      result: await handleUpdateArgument(runtime, resolved, abortSignal),
      observedConfidentiality: [],
    };
  }

  // Handle invoke-type tools (external, invoke with pattern/handler)
  return await handleInvoke(
    runtime,
    space,
    resolved,
    observationMaxConfidentiality,
    abortSignal,
  );
}

/**
 * Run a (tool using) dialog with an LLM.
 *
 * @param messages - list of messages representing the conversation. This is mutated by the internal process.
 * @param model - A doc to store the model to use.
 * @param system - A doc to store the system message.
 * @param stop - A doc to store (optional) stop sequence.
 * @param maxTokens - A doc to store the maximum number of tokens to generate.
 *
 * @returns { pending: boolean, addMessage: (message: BuiltInLLMMessage) => void } - As individual
 *   docs, representing `pending` state, final `result` and incrementally
 *   updating `partial` result.
 */
export function llmDialog(
  inputsCell: Cell<BuiltInLLMParams>,
  sendResult: (tx: IExtendedStorageTransaction, result: any) => void,
  addCancel: (cancel: () => void) => void,
  cause: any,
  parentCell: Cell<any>,
  runtime: Runtime, // Runtime will be injected by the registration function
  _outputBinding?: NormalizedFullLink,
  _awaitSync?: unknown,
  publicationBinding?: NormalizedFullLink,
): RawBuiltinResult {
  const inputs = inputsCell.asSchema(LLMParamsSchema);

  // Helper function to create and register handlers
  const createHandler = <T>(
    stream: Stream<T>,
    handler: (tx: IExtendedStorageTransaction, event: T) => void,
  ) => {
    addCancel(
      runtime.scheduler.addEventHandler(handler, parseLink(stream)),
    );
  };

  const cellsByScope = new Map<CellScope, DialogCells>();
  const activeTurns = new Map<string, DialogTurn>();
  const served = runtime.servingPosture && runtime.experimental.serverExecution;
  const identityFor = (tx: IExtendedStorageTransaction) =>
    served ? tx.tx.scopeKeyIdentity ?? runtime.scopeKeyIdentity : undefined;
  const turnKey = (scope: CellScope, tx: IExtendedStorageTransaction) =>
    resolveScopeKey(scope, identityFor(tx) ?? runtime.scopeKeyIdentity);

  const acceptedTurns = new Map<string, DialogTurn>();
  const publications = new Map<string, {
    binding: string;
    scope: CellScope;
    sequence: number;
  }>();
  let publicationSequence = 0;
  let stopped = false;
  const bindingKey = (tx: IExtendedStorageTransaction, scope: CellScope) =>
    publicationBinding
      ? resolveScopeKey(
        publicationBinding.scope ?? "space",
        identityFor(tx) ?? runtime.scopeKeyIdentity,
      )
      : turnKey(scope, tx);
  const onAcceptance = (
    tx: IExtendedStorageTransaction,
    accepted: () => void,
  ) => {
    requireWaveAcceptance(tx);
    tx.addCommitCallback((committed, outcome) => {
      if (outcome.error) return;
      const settlement = waveSettlementOf(committed) ?? waveSettlementOf(tx);
      if (settlement) {
        settlement.then((verdict) => {
          if (!verdict.error) accepted();
        });
      } else accepted();
    });
  };
  const recordPublication = (
    tx: IExtendedStorageTransaction,
    scope: CellScope,
    binding: string,
    sequence: number,
  ) =>
    onAcceptance(tx, () => {
      if (!publicationBinding) return;
      for (const [key, previous] of publications) {
        if (
          previous.binding === binding && previous.scope !== scope &&
          previous.sequence < sequence
        ) {
          publications.delete(key);
        }
      }
    });
  const clearClaim = (turn: DialogTurn) => {
    let tx: IExtendedStorageTransaction | undefined;
    try {
      tx = runtime.edit();
      if (turn.identity) tx.tx.scopeKeyIdentity = turn.identity;
      runtime.stampServerRun(tx, {
        actionId: `llmDialog/claim-release/${parentCell.sourceURI}`,
        kind: "bookkeeping",
        scopeKeyIdentity: turn.identity,
      });
      if (turn.internal.withTx(tx).key("requestId").get() === turn.requestId) {
        turn.result.withTx(tx).key("pending").set(false);
        turn.internal.withTx(tx).key("requestId").set("");
      }
      runtime.prepareTxForCommit(tx);
      return tx.commit().then((outcome) => {
        if (outcome.error) {
          logger.warn(
            "dialog-claim-cleanup-failed",
            () => [turn.requestId, outcome.error],
          );
        }
      });
    } catch (error) {
      tx?.abort(error);
      logger.warn("dialog-claim-cleanup-failed", () => [turn.requestId, error]);
      return Promise.resolve();
    }
  };

  addCancel(() => {
    stopped = true;
    const turns = new Set([...acceptedTurns.values(), ...activeTurns.values()]);
    acceptedTurns.clear();
    activeTurns.clear();
    publications.clear();
    for (const turn of turns) turn.abortController.abort("Pattern stopped");
    runtime.trackAsyncWork(Promise.all([...turns].map(clearClaim)), parentCell);
  });

  const action: Action = (tx: IExtendedStorageTransaction) => {
    if (stopped) return;
    tx.resetNarrowestReadScope();
    inputs.withTx(tx).get();
    const outputScope = tx.getNarrowestReadScope();
    let cells = cellsByScope.get(outputScope);

    if (!cells) {
      // Create result cell. The predictable cause means that it'll map to
      // previously existing results. Note that we might not yet have it loaded
      // and that this function will be called again once the data is loaded
      // (but this if branch will be skipped then).
      const result: DialogCells["result"] = ownedCell(
        runtime,
        tx,
        parentCell,
        { llmDialog: { result: cause } },
        resultSchema,
        outputScope,
      );
      result.sync(); // Kick off sync, no need to await

      // Create another cell to store the internal state. This isn't returned to
      // the caller. But again, the predictable cause means all instances tied
      // to the same input cells will coordinate via the same cell.
      const internal: DialogCells["internal"] = ownedCell(
        runtime,
        tx,
        parentCell,
        { llmDialog: { internal: cause } },
        internalSchema,
        outputScope,
      );
      internal.sync(); // Kick off sync, no need to await

      // Create pinnedCells cell to store the internal pinned cells state
      const pinnedCellsSchema = {
        type: "array",
        items: {
          type: "object",
          properties: {
            path: { type: "string" },
            name: { type: "string" },
          },
          required: ["path", "name"],
        },
      } as const;
      const pinnedCells: DialogCells["pinnedCells"] = ownedCell(
        runtime,
        tx,
        parentCell,
        { llmDialog: { pinnedCells: cause } },
        pinnedCellsSchema,
        outputScope,
      );
      pinnedCells.sync(); // Kick off sync, no need to await

      const pending = result.key("pending");

      // Declare `addMessage` handler and register
      createHandler<BuiltInLLMMessage>(
        // Cast is necessary as .key doesn't yet correctly handle Stream<>
        result.key("addMessage") as unknown as Stream<BuiltInLLMMessage>,
        (tx: IExtendedStorageTransaction, event: BuiltInLLMMessage) => {
          if (stopped) return;
          const key = turnKey(outputScope, tx);
          if (pending.withTx(tx).get()) {
            // A message added while a turn is running is dropped. The add
            // message UI should either be disabled or change the send button
            // to be a stop button.
            const activeRequestId = internal.withTx(tx).key("requestId").get();
            if (
              activeRequestId !== undefined &&
              (activeTurns.get(key)?.requestId === activeRequestId ||
                acceptedTurns.has(activeRequestId))
            ) {
              // An accepted turn belongs to this replica while awaiting
              // dispatch or running, so the heartbeat is not consulted. A turn
              // can run longer than the heartbeat's staleness bound without a
              // durable write, and the heartbeat reads stale for a turn that is
              // plainly alive. The writes bracket a round of tool calls rather
              // than falling between them, and nothing bounds a tool call, so a
              // single one that runs long enough is already such a gap.
              //
              // Nothing bounds a turn on this branch. A local turn that never
              // settles keeps dropping messages until `cancelGeneration` sets
              // `pending` false, which is the stop button `cf-prompt-input`
              // shows in place of send for as long as `pending` holds.
              return;
            }
            // The turn belongs to another replica. `lastActivity` is that
            // replica's heartbeat, refreshed by `safelyPerformUpdate` on every
            // durable write of the turn, and a stale one is the only sign
            // available that the tab which started the turn went away.
            //
            // This `Date.now()` is a latent hazard under the runner's fake
            // clock, whose auto-advance can carry logical time past the
            // five-minute mark in a test that never meant to model elapsed
            // time. The branch it then takes accepts a message into a dialog
            // whose turn is still running.
            if (
              internal.withTx(tx).key("lastActivity").get() >
                Date.now() - REQUEST_TIMEOUT
            ) {
              return;
            }
          }

          // Before starting request, set pending and append the new message.
          pending.withTx(tx).set(true);
          // Each message becomes its own document, which the LlmDerived
          // stamping downstream relies on. Pushing a plain message would also
          // produce one, since `Cell.push` anchors objects in arrays; the
          // document is made explicitly to control its identity -- a
          // deliberate cause rather than a frame-relative counter.
          // TODO(seefeld): Once we have event ids, the cause should be that.
          //
          // Space AND scope come from the RESOLVED messages link -- the array
          // document itself, not the input slot that points at it, which can
          // sit at a different scope. `push()` resolves the same way before it
          // writes; a document minted at the slot's scope instead lands in a
          // partition the array's readers never look in.
          //
          // The document is left schema-less: the schema it would carry ends
          // up inlined in every link written to it, and the array's own items
          // schema already describes what a reader finds there.
          const messagesForPush = inputs.key("messages");
          const messagesBase = resolveLink(
            runtime,
            tx,
            messagesForPush.getAsNormalizedFullLink(),
          );
          const messageCell = runtime.getCell<Schema<typeof LLMMessageSchema>>(
            messagesBase.space,
            { llmDialog: { message: cause, id: crypto.randomUUID() } },
            undefined,
            tx,
            messagesBase.scope,
          );
          // Each message is its own document, minted from this node's cause
          // and named by nobody's schema. It is filled by the transaction that
          // mints it, so the marker alone reaches it — enrolling a per-message
          // store would grow the runtime's set for as long as the piece runs
          // (`runtime-owned-store.ts`).
          //
          // The document is minted in the resolved messages array's space,
          // which need not be this node's. Where it is not, the marker names
          // nothing: a store in another space belongs to whoever holds that
          // space's replicas, so this node's flow join has no business
          // becoming its declared policy. A labeled write to such a transcript
          // is refused, as it was before this route existed; admitting it
          // needs a cross-space release decision, which is not a write-side
          // fit check's to make.
          recordRuntimeOwnedStore(tx, result, messageCell);
          messageCell.withTx(tx).set(
            // Cast because we can't yet express ArrayBuffer in JSON Schema
            { ...event } as Schema<typeof LLMMessageSchema>,
          );
          messagesForPush.withTx(tx).push(messageCell);

          const nextRequestId = crypto.randomUUID();
          internal.withTx(tx).set({
            requestId: nextRequestId,
            lastActivity: Date.now(),
            messageObservations:
              internal.withTx(tx).key("messageObservations").get() ?? {},
          });

          const capturedRequest = materializeDialogRequestSnapshot(
            runtime,
            parentCell.space,
            inputs,
            pinnedCells,
            tx,
          );
          const requestSnapshot = createFrozenRequestSnapshot({
            ...capturedRequest.llmParams,
            resultSchema: capturedRequest.userResultSchema,
          });

          const identity = capturedRequest.scopeKeyIdentity;
          const turn: DialogTurn = {
            result,
            internal,
            pinnedCells,
            identity,
            requestId: nextRequestId,
            abortController: new AbortController(),
          };
          const publication = {
            binding: bindingKey(tx, outputScope),
            scope: outputScope,
            sequence: ++publicationSequence,
          };
          const publicationKey = `${outputScope}/${publication.binding}`;
          publications.set(publicationKey, publication);
          const ownsPublication = () =>
            !stopped && publications.get(publicationKey) === publication;
          const finishPublication = () => {
            if (publications.get(publicationKey) === publication) {
              publications.delete(publicationKey);
            }
          };
          let finished = false;
          const finish = () => {
            finished = true;
            if (acceptedTurns.get(nextRequestId) === turn) {
              acceptedTurns.delete(nextRequestId);
            }
            finishPublication();
          };
          onAcceptance(tx, () => {
            finishPublication();
            if (finished) return;
            if (stopped) {
              runtime.trackAsyncWork(
                clearClaim(turn).finally(finish),
                parentCell,
              );
            } else if (activeTurns.get(key) !== turn) {
              acceptedTurns.set(nextRequestId, turn);
            }
          });

          enqueueSinkRequestPostCommitEffect(
            tx,
            "llmDialog",
            `llmDialog:${nextRequestId}`,
            requestSnapshot,
            "llmDialog-start",
            () => {
              const read = runtime.readTx();
              if (identity) read.tx.scopeKeyIdentity = identity;
              if (stopped) {
                runtime.trackAsyncWork(
                  clearClaim(turn).finally(finish),
                  parentCell,
                );
                return;
              }
              if (
                !pending.withTx(read).get() ||
                internal.withTx(read).key("requestId").get() !== nextRequestId
              ) {
                finish();
                return;
              }

              activeTurns.get(key)?.abortController.abort(
                "New request started",
              );
              if (acceptedTurns.get(nextRequestId) === turn) {
                acceptedTurns.delete(nextRequestId);
              }
              activeTurns.set(key, turn);
              runtime.trackAsyncWork(
                startRequest(
                  runtime,
                  parentCell.space,
                  cause,
                  inputs,
                  pending,
                  internal,
                  pinnedCells,
                  result,
                  nextRequestId,
                  turn.abortController.signal,
                  capturedRequest,
                ).finally(() => {
                  if (activeTurns.get(key) === turn) activeTurns.delete(key);
                  finish();
                }),
                parentCell,
              );
            },
            {
              onReleaseRejected: () => {
                if (activeTurns.get(key)?.requestId === nextRequestId) {
                  finishPublication();
                  return;
                }
                runtime.trackAsyncWork(
                  clearClaim(turn).finally(finish),
                  parentCell,
                );
              },
              onRejected: () => {
                // The turn is not in the conversation: the user's message, the
                // pending flag and the request id all rode the transaction
                // that was abandoned, so appending an assistant error message
                // here would answer a turn no reader can see. What is left to
                // do is put the announcement back, since it rode that
                // transaction too, and take the pending flag down so nothing
                // waits on a turn that will not run. The seam reports the
                // refusal itself.
                runtime.trackAsyncWork(
                  settleAbandonedRequest(
                    runtime,
                    "llmDialog",
                    `llmDialog:${nextRequestId}`,
                    (settleTx) => {
                      if (capturedRequest.scopeKeyIdentity) {
                        settleTx.tx.scopeKeyIdentity =
                          capturedRequest.scopeKeyIdentity;
                      }
                      // An accepted publication owns the physical binding.
                      // Legacy callers without that coordinate can only check
                      // whether their input scope still selects this target.
                      settleTx.resetNarrowestReadScope();
                      inputs.withTx(settleTx).get();
                      if (
                        ownsPublication() &&
                        (publicationBinding !== undefined ||
                          settleTx.getNarrowestReadScope() === outputScope)
                      ) {
                        sendResult(settleTx, result);
                        recordPublication(
                          settleTx,
                          outputScope,
                          publication.binding,
                          publication.sequence,
                        );
                      }
                      // Decided here rather than when this callback ran: a
                      // newer turn can start in between, and taking its
                      // pending flag down would report it as finished.
                      const claim = internal.withTx(settleTx).key("requestId")
                        .get();
                      if (claim !== undefined && claim !== nextRequestId) {
                        return;
                      }
                      pending.withTx(settleTx).set(false);
                    },
                  ).finally(finish),
                  parentCell,
                );
              },
            },
          );
        },
      );

      // Declare `cancelGeneration` handler and register
      createHandler<void>(
        result.key("cancelGeneration") as unknown as Stream<any>,
        (tx: IExtendedStorageTransaction, _event: void) => {
          // Cancel request by setting pending to false. This will trigger the
          // code below to be executed in all tabs.
          pending.withTx(tx).set(false);
        },
      );

      // Declare `pinCell` handler and register
      createHandler<{ path: string; name: string }>(
        result.key("pinCell") as unknown as Stream<
          { path: string; name: string }
        >,
        (
          tx: IExtendedStorageTransaction,
          event: { path: string; name: string },
        ) => {
          const current = pinnedCells.withTx(tx).get() || [];

          // Check if already pinned
          if (current.some((p) => p.path === event.path)) {
            return;
          }

          // Add new pinned cell
          const updated = [
            ...current,
            { path: event.path, name: event.name },
          ];
          pinnedCells.withTx(tx).set(updated);
          // Merge with existing result pins (which include context-derived
          // pins) so we don't clobber them. Deduplicate by path.
          const existingResult = result.withTx(tx).key("pinnedCells").get() ||
            [];
          const existingPaths = new Set(
            existingResult.map((p: any) => p.path),
          );
          if (!existingPaths.has(event.path)) {
            result
              .withTx(tx)
              .key("pinnedCells")
              .set([
                ...existingResult,
                { path: event.path, name: event.name },
              ] as any);
          }
        },
      );

      // Declare `unpinAllCells` handler and register
      createHandler<void>(
        result.key("unpinAllCells") as unknown as Stream<void>,
        (tx: IExtendedStorageTransaction, _event: void) => {
          // Clear user-pinned cells
          const userPaths = new Set(
            (pinnedCells.withTx(tx).get() || []).map(
              (p: PinnedCell) => p.path,
            ),
          );
          pinnedCells.withTx(tx).set([]);
          // Keep context-derived pins in result, remove only user pins
          const existingResult = result.withTx(tx).key("pinnedCells").get() ||
            [];
          result
            .withTx(tx)
            .key("pinnedCells")
            .set(
              existingResult.filter(
                (p: any) => !userPaths.has(p.path),
              ) as any,
            );
        },
      );

      cells = { result, internal, pinnedCells };
      cellsByScope.set(outputScope, cells);
    }
    const { result, internal } = cells;

    // An empty `pinnedCells` belongs to every resolved instance; an
    // initialized symbolic handle does not establish another actor's stored
    // state. Stored pins are written back as stored: a pin a handler wrote may
    // sit in a document of its own, and the raw write keeps the link to it.
    const stored = result.withTx(tx).getRaw() as
      | Record<string, FabricValue>
      | undefined;
    result.withTx(tx).setRawUntyped({
      ...stored,
      pinnedCells: stored?.pinnedCells ?? [],
    } as FabricValue);
    // The dialog's handlers are fields of this document, and a stream holds
    // nothing, so the document keeps its result schema the way a piece's
    // result document does: an address into it that arrives with no schema,
    // as a tool call's does, is typed from there.
    writeResultSchemaMeta(result.withTx(tx), resultSchema);

    sendResult(tx, result);
    recordPublication(
      tx,
      outputScope,
      bindingKey(tx, outputScope),
      ++publicationSequence,
    );

    // Update flattened tools whenever tools change
    // `flattenedTools` is for now just used in the UI, and so we only need
    // inputSchema and description. This makes retrieving the tools much faster.
    const toolsCell = inputs.key("tools").withTx(tx) as Cell<
      Record<string, Schema<typeof LLMToolSchema>>
    >;
    const builtinTools = inputs.key("builtinTools").withTx(tx).get() !== false;
    const flattened = flattenTools(toolsCell, builtinTools);

    // Runtime already makes this a no-op if there are no changes
    result.withTx(tx).key("flattenedTools").set(flattened);

    const active = activeTurns.get(turnKey(outputScope, tx));
    if (
      active &&
      (!result.withTx(tx).key("pending").get() ||
        active.requestId !== internal.withTx(tx).key("requestId").get())
    ) {
      const key = turnKey(outputScope, tx);
      const cancelAcceptedTurn = () => {
        if (activeTurns.get(key) === active) {
          active.abortController.abort("Another request started");
        }
      };
      // A sealed cancellation can still be withdrawn with its wave.
      requireWaveAcceptance(tx);
      tx.addCommitCallback((committed, outcome) => {
        if (outcome.error) return;
        const settlement = waveSettlementOf(committed) ?? waveSettlementOf(tx);
        if (settlement) {
          settlement.then((verdict) => {
            if (!verdict.error) cancelAcceptedTurn();
          });
        } else cancelAcceptedTurn();
      });
    }
  };

  // The dialog writes its turns into the caller's `messages` cell, and a
  // pattern may render that cell without ever reading the dialog's own
  // result. Declaring the write makes this node a materializer: it holds
  // standing demand and runs when its inputs change, whether or not anything
  // reads what it returns.
  Object.assign(action, {
    materializerWriteEnvelopes: [
      inputs.key("messages").resolveAsCell().getAsNormalizedFullLink(),
    ],
  });

  return { action };
}

async function startRequest(
  runtime: Runtime,
  space: MemorySpace,
  cause: any,
  inputs: Cell<Schema<typeof LLMParamsSchema>>,
  pending: Cell<boolean>,
  internal: Cell<Schema<typeof internalSchema>>,
  pinnedCells: Cell<PinnedCell[]>,
  result: Cell<Schema<typeof resultSchema>>,
  requestId: string,
  abortSignal: AbortSignal,
  capturedRequest?: DialogRequestSnapshot,
) {
  let messagesCell = inputs.key("messages");
  /** Reads each asynchronous phase from the current actor instance. */
  const refreshRead = () => {
    if (!capturedRequest?.scopeKeyIdentity) return;
    const read = runtime.readTx();
    read.tx.scopeKeyIdentity = capturedRequest.scopeKeyIdentity;
    inputs = inputs.withTx(read);
    pinnedCells = pinnedCells.withTx(read);
    internal = internal.withTx(read);
    messagesCell = inputs.key("messages");
  };
  refreshRead();
  // Served inputs were demanded by the accepted handler. Ambient pull
  // actions would demand the service instance instead of the issuing actor.
  // Local execution still drives dependencies through pull scheduling.
  if (!capturedRequest?.scopeKeyIdentity) {
    await inputs.pull();
    await pinnedCells.pull();
  }

  // Also pull individual context cells and pinned cell targets
  const contextCellsForPull = inputs.key("context").get() ?? {};
  for (const cell of Object.values(contextCellsForPull)) {
    await resolveContextCellRef(cell)?.pull();
  }
  const pinnedCellsForPull = pinnedCells.get() ?? [];
  for (const pinnedCell of pinnedCellsForPull) {
    try {
      const link = parseLLMFriendlyLink(pinnedCell.path, space);
      const cell = runtime.getCellFromLink(link);
      if (cell) {
        await cell.resolveAsCell().pull();
      }
    } catch {
      // Ignore errors - cell might not exist
    }
  }

  refreshRead();
  const { system, maxTokens, model } = inputs.get();
  const queueName = capturedRequest?.queueName ??
    (inputs.key("queue").get() as unknown as string | undefined);
  // The snapshot already carries the deployment-bounded ceiling. When there is
  // no snapshot, fold the deployment llmDialog ceiling in here too so a
  // direct/recovery path can't observe past it (#3993 review).
  const observationMaxConfidentiality = capturedRequest
    ?.observationMaxConfidentiality ??
    effectiveObservationCeiling(
      runtime,
      "llmDialog",
      inputs.key("observationMaxConfidentiality").get() as
        | readonly CfcConfClause[]
        | undefined,
    );
  const builtinTools = inputs.key("builtinTools").get() !== false;

  // Epic D1 (docs/history/specs/cfc-trusted-agent-tool-integrity.md piece B): model-
  // produced bytes — assistant content and tool results entering the dialog
  // transcript — are stamped `LlmDerived` at the point they enter the store,
  // so "untrusted model output" is explicit provenance rather than absence of
  // integrity. The stamp rides the item schema's `ifc.addIntegrity`, which
  // persists a labelMap entry on exactly the pushed message; the plain-schema
  // pushes (user messages via `addMessage`, builtin-authored error literals)
  // stay unstamped. The write is attributed to the builtin because
  // `LlmDerived` is a runtime-minted evidence family: the persist-time gate
  // (`gateRuntimeMintedIntegrity`, audit S4) strips it from any other author,
  // which is also what stops pattern code from forging the stamp.
  const pushModelMessages = (
    tx: IExtendedStorageTransaction,
    messages: Schema<typeof LLMMessageSchema>[],
  ) => {
    const startIndex = (messagesCell.withTx(tx).get() as
      | readonly CfcConfClause[]
      | undefined)?.length ?? 0;
    // Each message becomes its own document, which the stamping below reads
    // back. Pushing plain messages would also produce them, since `Cell.push`
    // anchors objects in arrays; they are made explicitly to control their
    // identity -- a deliberate cause rather than a frame-relative counter.
    // TODO(seefeld): Once we have event ids, the cause should be that.
    //
    // Space, scope and schema follow the user-message push: resolved link,
    // schema-less document.
    const base = resolveLink(
      runtime,
      tx,
      messagesCell.getAsNormalizedFullLink(),
    );
    messagesCell.withTx(tx).push(
      ...messages.map((message) => {
        const messageCell = runtime.getCell<Schema<typeof LLMMessageSchema>>(
          base.space,
          { llmDialog: { message: cause, id: crypto.randomUUID() } },
          undefined,
          tx,
          base.scope,
        );
        // Per-message store: named for this transaction, not enrolled. See
        // the sibling in `addMessage` and `runtime-owned-store.ts`.
        recordRuntimeOwnedStore(tx, result, messageCell);
        messageCell.withTx(tx).set(message);
        return messageCell;
      }),
    );
    if (runtime.cfcEnforcementMode === "disabled") {
      return;
    }
    // Attribute the writes to the builtin: `LlmDerived` is a runtime-minted
    // evidence family, so the persist-time gate (`gateRuntimeMintedIntegrity`,
    // audit S4) admits it only from builtin authors — the same gating that
    // stops pattern code from forging the stamp.
    setCfcImplementationIdentity(tx, {
      kind: "builtin",
      builtinId: "llmDialog",
    });
    // Record the stamping schema for each pushed message's own entity doc
    // (every message is appended as a link to a document of its own, so each
    // one is separately addressable). The messages link carries its own schema, which wins over
    // an `asSchema` handle inside `push()` (`resolvedLink.schema ?? ...`), so
    // the stamp cannot ride the array handle — instead this mirrors the
    // split-entity idiom in data-updating.ts (`recordRelevantSchemaWrite-
    // PolicyInput` on the child doc), which also marks the transaction
    // CFC-relevant so `prepareTxForCommit` runs the persist pass that mints
    // the labelMap entry.
    for (let index = 0; index < messages.length; index++) {
      const raw = messagesCell.withTx(tx).key(startIndex + index).getRaw();
      const link = parseLink(raw);
      const id = link?.id;
      if (link === undefined || id === undefined) {
        logger.warn(
          "llm",
          "model message did not split into its own doc; LlmDerived stamp skipped",
        );
        continue;
      }
      recordRelevantSchemaWritePolicyInput(tx, {
        ...link,
        id,
        space: link.space ?? base.space ?? space,
        scope: resolveLinkScope(link.scope, base.scope),
        path: [],
        schema: LLM_DERIVED_MESSAGE_SCHEMA,
      }, LLM_DERIVED_MESSAGE_SCHEMA);
    }
  };

  const toolsCell = inputs.key("tools") as Cell<
    Record<string, Schema<typeof LLMToolSchema>>
  >;

  // Update merged pinnedCells in case context or internal pinnedCells changed
  const contextCells = inputs.key("context").get() ?? {};
  const toolPinnedCells = pinnedCells.get() ?? [];

  const contextAsPinnedCells: PinnedCell[] = Object.entries(contextCells)
    // Convert context cells to PinnedCell format
    .map(
      ([name, cell]) => {
        const link = resolveContextCellRef(cell)?.getAsNormalizedFullLink();
        if (!link) {
          throw new Error(`Context entry "${name}" is not a cell`);
        }
        const path = createLLMFriendlyLink(link, space);
        return { name, path };
      },
    )
    // Remove pinned cells that are already in the context
    .filter(({ path }) => !toolPinnedCells.some((cell) => cell.path === path));

  // Merge context cells and tool-pinned cells
  const mergedPinnedCells = [...contextAsPinnedCells, ...toolPinnedCells];

  // Write to result cell using editWithRetry since we're outside handler tx
  await runtime.editWithRetry((tx) => {
    if (capturedRequest?.scopeKeyIdentity) {
      tx.tx.scopeKeyIdentity = capturedRequest.scopeKeyIdentity;
    }
    markEffectCompletion(tx, `llmDialog:${requestId}`);
    result.withTx(tx).key("pinnedCells").set(mergedPinnedCells as any);
  });

  refreshRead();
  const toolCatalog = capturedRequest?.toolCatalog ?? buildToolCatalog(
    toolsCell,
    builtinTools,
  );

  // If resultSchema is provided, inject presentResult built-in tool.
  // TODO(danfuzz): `resultSchema` is untrusted input, so this `as` is an
  // unchecked assertion. Replace with a runtime validating guard, e.g.
  // `asSchemaOrThrow(schema: unknown): schema is JSONSchema`.
  const userResultSchema = capturedRequest?.userResultSchema ??
    (inputs.key("resultSchema").get() as JSONSchema | undefined);
  if (userResultSchema && capturedRequest === undefined) {
    // collectToolEntries refuses this name, so nothing else holds it.
    toolCatalog.llmTools[PRESENT_RESULT_TOOL_NAME] = {
      description:
        "Call this tool to present a structured result. This stores the result for the caller.",
      inputSchema: prepareSchemaForLLM(
        toDeepFrozenSchema(userResultSchema),
      ),
    };
  }

  // Build available cells documentation (both context and pinned cells).
  // This rebuild happens POST-COMMIT (no sink-request input gates these
  // reads), so a declared bound — including the empty "public only" one the
  // deployment sink ceiling can fold in — must engage observation-aware
  // serialization; only the truly absent bound may skip it (#3993 review).
  const context = inputs.key("context").get();
  const cellsDocs = observationMaxConfidentiality !== undefined
    ? buildAvailableCellsDocumentationWithObservation(
      runtime,
      space,
      context,
      pinnedCells,
      observationMaxConfidentiality,
    )
    : {
      docs: buildAvailableCellsDocumentation(
        runtime,
        space,
        context,
        pinnedCells,
      ),
      observedConfidentiality: [],
    };

  const linkModelDocs = builtinTools
    ? `

# Link and Cell Model

The system organizes all data and computation into **cells**:

- **Data cells**: Contain JSON data that can be read and written
- **Handler cells (streams)**: Executable functions that can be invoked but not read directly
- **Pattern cells**: Running program instances that may contain both data fields and handler fields

## Links

Links are universal identifiers that point to cells. They use the format:

\`\`\`json
{ "@link": "/of:bafyabc123/path/to/cell" }
\`\`\`

Where:
- \`of:bafyabc123\` is the handle/ID of the root entity (piece, pattern instance, etc.)
- \`/path/to/cell\` is the path within that entity to a specific cell

## Tool Composition

Tools work together by passing links between them:

1. \`invoke({ "@link": "/of:abc/handler" }, args)\` → Returns \`{ "@link": "/of:xyz/result" }\`
2. \`read({ "@link": "/of:xyz/result" })\` → Returns the data, which may contain nested links
3. \`updateArgument({ "@link": "/of:pattern" }, { field: value })\` → Updates running pattern arguments
4. Data often contains links to other cells: \`{ items: [{ "@link": "/of:123" }, { "@link": "/of:456" }] }\`

## Pages

Some operations (especially \`invoke()\` with patterns) create "Pages" - running pattern instances that:
- Have their own identity accessible via a link
- Contain data fields that can be read with \`read()\`
- Contain handler fields that can be invoked with \`invoke()\`
- Arguments can be updated with \`updateArgument()\` to change pattern behavior dynamically
- May link to other cells in the system

**Use links to navigate between related data and compose operations.**`
    : "";

  const augmentedSystem = (system ?? "") + linkModelDocs + cellsDocs.docs;

  const liveMessages = messagesCell.get() as readonly BuiltInLLMMessage[];
  const visibleMessages = getObservedDialogMessages(
    messagesCell,
    liveMessages,
    (internal.key("messageObservations")
      .get() as DialogMessageObservationMap) ??
      {},
  );
  const requestObservedConfidentiality = joinCfcObservedConfidentiality([
    visibleMessages.observedConfidentiality,
    cellsDocs.observedConfidentiality,
  ]);
  const llmParams: LLMRequest = capturedRequest
    ? {
      ...capturedRequest.llmParams,
      system: augmentedSystem,
      messages: visibleMessages.messages,
    }
    : {
      system: augmentedSystem,
      messages: visibleMessages.messages,
      maxTokens: maxTokens,
      stream: true,
      model: model ?? DEFAULT_MODEL_NAME,
      metadata: { context: "piece" },
      cache: true,
      tools: toolCatalog.llmTools,
    };

  // TODO(bf): sendRequest must be given a callback, even if it does nothing
  const mappedLlmHost = runtime.mappedHostFor(space);
  const doWork = () =>
    client.sendRequest(
      llmParams,
      () => {},
      abortSignal,
      mappedLlmHost
        ? { endpoint: new URL("/api/ai/llm", mappedLlmHost) }
        : undefined,
    );

  const resultPromise = queueName
    ? runtime.getOrCreateQueue(queueName).enqueue(doWork)
    : doWork();

  // Returned, not fired and forgotten: the caller hands this promise to
  // `runtime.trackAsyncWork`, so it is what makes `runtime.settled()` span the
  // model call, the tool calls it makes, and the writeback of their results.
  return resultPromise
    .then(async (llmResult) => {
      // Validate that the response has valid content
      if (!hasValidContent(llmResult.content)) {
        // LLM returned empty or invalid content (e.g., stream aborted mid-flight,
        // or AI SDK bug with empty text blocks). Insert a proper error message
        // instead of storing invalid content.
        logger.warn(
          "llm",
          "LLM returned invalid/empty content, adding error message",
        );
        const errorMessage = {
          role: "assistant",
          content:
            "I encountered an error generating a response. Please try again.",
        } satisfies BuiltInLLMMessage;

        await safelyPerformUpdate(
          runtime,
          pending,
          internal,
          requestId,
          capturedRequest?.scopeKeyIdentity,
          (tx) => {
            // As above: made explicitly for identity control, in the resolved
            // messages document's space and scope, schema-less.
            const errorBase = resolveLink(
              runtime,
              tx,
              messagesCell.getAsNormalizedFullLink(),
            );
            const errorCell = runtime.getCell<Schema<typeof LLMMessageSchema>>(
              errorBase.space,
              { llmDialog: { message: cause, id: crypto.randomUUID() } },
              undefined,
              tx,
              errorBase.scope,
            );
            // Per-message store: named for this transaction, not enrolled.
            recordRuntimeOwnedStore(tx, result, errorCell);
            errorCell.withTx(tx).set(
              errorMessage as Schema<typeof LLMMessageSchema>,
            );
            messagesCell.withTx(tx).push(errorCell);
            pending.withTx(tx).set(false);
          },
        );
        return;
      }

      // Extract tool calls from content if it's an array
      const hasToolCalls = Array.isArray(llmResult.content) &&
        llmResult.content.some((part) => part.type === "tool-call");

      if (hasToolCalls) {
        try {
          const llmContent = llmResult.content as BuiltInLLMMessage["content"];
          const toolCallParts = extractToolCallParts(llmContent);
          const assistantMessage = buildAssistantMessage(
            llmContent,
            toolCallParts,
          );

          await safelyPerformUpdate(
            runtime,
            pending,
            internal,
            requestId,
            capturedRequest?.scopeKeyIdentity,
            (tx) => {
              const nextIndex = (messagesCell.withTx(tx).get() as
                | readonly BuiltInLLMMessage[]
                | undefined)?.length ?? 0;
              recordDialogMessageObservations(tx, internal, [
                {
                  index: nextIndex,
                  observedConfidentiality: requestObservedConfidentiality,
                },
              ]);
              pushModelMessages(tx, [
                assistantMessage as Schema<typeof LLMMessageSchema>,
              ]);
            },
          );

          // Now execute the tool calls
          const toolResults = await executeToolCalls(
            runtime,
            space,
            toolCatalog,
            toolCallParts,
            pinnedCells,
            requestObservedConfidentiality,
            observationMaxConfidentiality,
            abortSignal,
          );

          // If presentResult was called, cellify the raw input so we can
          // store it on the dialog's result cell (guarded by requestId below).
          let cellifiedResult: unknown | undefined;
          if (userResultSchema) {
            const presentResultPart = toolCallParts.find(
              (p) => p.toolName === PRESENT_RESULT_TOOL_NAME,
            );
            if (presentResultPart) {
              cellifiedResult = traverseAndCellify(
                runtime,
                space,
                presentResultPart.input,
              );
            }
          }

          // Validate that we have a result for every tool call with matching IDs
          const toolCallIds = new Set(toolCallParts.map((p) => p.toolCallId));
          const resultIds = new Set(toolResults.map((r) => r.id));
          const mismatch = toolResults.length !== toolCallParts.length ||
            !toolCallParts.every((p) => resultIds.has(p.toolCallId));

          if (mismatch) {
            logger.error(
              "llm-error",
              `Tool execution mismatch: ${toolCallParts.length} calls [${
                Array.from(toolCallIds)
              }] but ${toolResults.length} results [${Array.from(resultIds)}]`,
            );
            // Add error message instead of invalid partial results
            const errorMessage = {
              role: "assistant",
              content: "Some tool calls failed to execute. Please try again.",
            } satisfies BuiltInLLMMessage;

            await safelyPerformUpdate(
              runtime,
              pending,
              internal,
              requestId,
              capturedRequest?.scopeKeyIdentity,
              (tx) => {
                messagesCell.withTx(tx).push(
                  errorMessage as Schema<typeof LLMMessageSchema>,
                );
                pending.withTx(tx).set(false);
              },
            );
            return;
          }

          // Create and publish tool result messages
          const toolResultMessages = createToolResultMessages(toolResults);

          const success = await safelyPerformUpdate(
            runtime,
            pending,
            internal,
            requestId,
            capturedRequest?.scopeKeyIdentity,
            (tx) => {
              // Write presentResult atomically with tool result messages,
              // guarded by requestId to prevent stale writes from canceled requests.
              if (cellifiedResult !== undefined) {
                result.withTx(tx).key("result").set(cellifiedResult);
              }
              const nextIndex = (messagesCell.withTx(tx).get() as
                | readonly BuiltInLLMMessage[]
                | undefined)?.length ?? 0;
              recordDialogMessageObservations(
                tx,
                internal,
                toolResultMessages.map((_, index) => ({
                  index: nextIndex + index,
                  observedConfidentiality:
                    toolResults[index]?.observedConfidentiality ?? [],
                })),
              );
              pushModelMessages(
                tx,
                toolResultMessages as Schema<typeof LLMMessageSchema>[],
              );
            },
          );

          refreshRead();

          // Optionally record to suggestion history via the default pattern's
          // recordSuggestion handler. This is intentionally best-effort: spaces
          // whose default pattern doesn't export recordSuggestion simply skip
          // recording (caught below) rather than failing the suggestion flow.
          if (
            success && cellifiedResult !== undefined &&
            queueName === "suggestions"
          ) {
            try {
              const spaceCell = runtime.getCell(space, space, spaceCellSchema);
              const handler = spaceCell
                .key("defaultPattern")
                .key("recordSuggestion");
              handler.send({
                result: (cellifiedResult as any)?.cell ?? cellifiedResult,
                messages: messagesCell.get() ?? [],
                timestamp: new Date().toISOString(),
              });
            } catch (e) {
              logger.warn(
                "llm",
                "Failed to record suggestion history entry",
                e,
              );
            }
          }

          if (success) {
            logger.info("llm", "Continuing conversation after tool calls...");

            // Awaited so the turn that follows the tool calls stays inside this
            // turn's promise, and so the conversation settles as one unit
            // rather than one hop at a time.
            await startRequest(
              runtime,
              space,
              cause,
              inputs,
              pending,
              internal,
              pinnedCells,
              result,
              requestId,
              abortSignal,
              capturedRequest,
            );
          } else {
            logger.info(
              "llm",
              "Skipping write: pending=false or request changed",
            );
          }
        } catch (error: unknown) {
          console.error(error);
        }
      } else {
        // No tool calls, just add the assistant message
        const assistantMessage = {
          role: "assistant",
          content: llmResult.content,
        } satisfies BuiltInLLMMessage;

        // Ignore errors here, it probably means something else took over.
        await safelyPerformUpdate(
          runtime,
          pending,
          internal,
          requestId,
          capturedRequest?.scopeKeyIdentity,
          (tx) => {
            const nextIndex = (messagesCell.withTx(tx).get() as
              | readonly BuiltInLLMMessage[]
              | undefined)?.length ?? 0;
            recordDialogMessageObservations(tx, internal, [
              {
                index: nextIndex,
                observedConfidentiality: requestObservedConfidentiality,
              },
            ]);
            pushModelMessages(tx, [
              assistantMessage as Schema<typeof LLMMessageSchema>,
            ]);
            pending.withTx(tx).set(false);
          },
        );
      }
    })
    .catch((error: unknown) => {
      console.error("Error generating data", error);
      const errorMessageText = error instanceof Error
        ? error.message
        : String(error);
      const errorMessage = {
        role: "assistant",
        content:
          `I encountered an error generating a response: ${errorMessageText}`,
      } satisfies BuiltInLLMMessage;

      return safelyPerformUpdate(
        runtime,
        pending,
        internal,
        requestId,
        capturedRequest?.scopeKeyIdentity,
        (tx) => {
          messagesCell.withTx(tx).push(
            errorMessage as Schema<typeof LLMMessageSchema>,
          );
          pending.withTx(tx).set(false);
        },
      );
    });
}

function getSchemaTypeString(schema: JSONSchema): string {
  let defs;
  if (isObjectOrArray(schema)) {
    // Convert schema to TypeScript-like string for readability
    defs = (schema as Record<string, unknown>).$defs as
      | Record<string, JSONSchema>
      | undefined;
  }
  let schemaStr = schemaToTypeString(schema, { defs });
  const MAX_SCHEMA_LENGTH = 1000;
  if (schemaStr.length > MAX_SCHEMA_LENGTH) {
    schemaStr = schemaStr.substring(0, MAX_SCHEMA_LENGTH) +
      "\n  // ... truncated";
  }
  return schemaStr;
}
