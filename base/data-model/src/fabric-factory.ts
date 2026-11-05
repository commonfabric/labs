import { isArrayWithOnlyIndexProperties } from "@commonfabric/js-values/arrays";
import { isPlainObject } from "@commonfabric/js-values/types";
import {
  fromBase64url,
  toUnpaddedBase64url,
} from "@commonfabric/bytes/base64url";

import type {
  FabricFactory,
  FabricPlainObject,
  FabricValue,
} from "./interface.ts";
import { FabricInstance, FabricPrimitive } from "./interface.ts";
import {
  BaseFabricInstance,
  IS_DEEP_FROZEN,
} from "./fabric-bases/BaseFabricInstance.ts";
import { BaseFabricSpecialObject } from "./fabric-bases/BaseFabricSpecialObject.ts";

// The wire protocol owns structural schema and scope types at the data-model
// layer. Author-facing API types are assignable to these shapes, while the
// protocol remains independent of the higher API package.
type FactoryCellScope = "space" | "user" | "session";

type FactoryJsonValue =
  | null
  | boolean
  | number
  | string
  | FactoryJsonArray
  | FactoryJsonObject;

interface FactoryJsonArray extends ReadonlyArray<FactoryJsonValue> {}

interface FactoryJsonObject
  extends Readonly<Record<string, FactoryJsonValue>> {}

type EmbeddedFactorySchema =
  | boolean
  | Readonly<Record<string, FactoryJsonValue>>;

type LiveFactorySchema = boolean | Readonly<Record<string, unknown>>;

/** Content-addressed reference to a builder factory artifact. */
export interface FactoryArtifactRef extends FabricPlainObject {
  readonly identity: string;
  readonly symbol: string;
}

interface FactoryStateBaseV1 extends FabricPlainObject {
  readonly ref: FactoryArtifactRef;
}

/** Canonical options retained from a pattern factory's `inSpace()` modifier. */
export interface PatternFactorySpaceRequestV1 extends FabricPlainObject {
  readonly grants?: Readonly<
    Record<string, "READ" | "WRITE" | "OWNER">
  >;
  readonly root?: true;
  readonly spaceKind?: string;
  readonly selfOwned?: true;
}

/** Canonical serialized state for a pattern factory. */
export interface PatternFactoryStateV1 extends FactoryStateBaseV1 {
  readonly kind: "pattern";
  readonly argumentSchema: EmbeddedFactorySchema;
  readonly resultSchema: EmbeddedFactorySchema;
  readonly paramsSchema?: EmbeddedFactorySchema;
  readonly params?: FabricPlainObject;
  readonly defaultScope?: FactoryCellScope;
  readonly spaceSelector?: FabricValue;
  readonly spaceRequest?: PatternFactorySpaceRequestV1;
}

/** Canonical serialized state for a module or lift factory. */
export interface ModuleFactoryStateV1 extends FactoryStateBaseV1 {
  readonly kind: "module";
  readonly argumentSchema?: EmbeddedFactorySchema;
  readonly resultSchema?: EmbeddedFactorySchema;
  readonly defaultScope?: FactoryCellScope;
}

/** Canonical serialized state for a handler factory. */
export interface HandlerFactoryStateV1 extends FactoryStateBaseV1 {
  readonly kind: "handler";
  readonly contextSchema?: EmbeddedFactorySchema;
  readonly eventSchema?: EmbeddedFactorySchema;
}

/** Complete canonical `Factory@1` state. */
export type FactoryStateV1 =
  | PatternFactoryStateV1
  | ModuleFactoryStateV1
  | HandlerFactoryStateV1;

interface LiveFactoryStateBase {
  readonly rootToken: object;
  readonly ref?: FactoryArtifactRef;
}

/**
 * Unsealed pattern state held while builder inputs may still contain runner
 * values such as Cells and Reactives.
 */
export interface LivePatternFactoryState extends LiveFactoryStateBase {
  readonly kind: "pattern";
  readonly argumentSchema: LiveFactorySchema;
  readonly resultSchema: LiveFactorySchema;
  readonly paramsSchema?: LiveFactorySchema;
  readonly params?: unknown;
  readonly defaultScope?: FactoryCellScope;
  readonly spaceSelector?: unknown;
  readonly spaceRequest?: PatternFactorySpaceRequestV1;
}

/** Unsealed module state whose complete artifact ref may still be pending. */
export interface LiveModuleFactoryState extends LiveFactoryStateBase {
  readonly kind: "module";
  readonly argumentSchema?: LiveFactorySchema;
  readonly resultSchema?: LiveFactorySchema;
  readonly defaultScope?: FactoryCellScope;
}

/** Unsealed handler state whose complete artifact ref may still be pending. */
export interface LiveHandlerFactoryState extends LiveFactoryStateBase {
  readonly kind: "handler";
  readonly contextSchema?: LiveFactorySchema;
  readonly eventSchema?: LiveFactorySchema;
}

/** Internal, not-yet-canonical state for a live builder factory. */
export type LiveFactoryState =
  | LivePatternFactoryState
  | LiveModuleFactoryState
  | LiveHandlerFactoryState;

/** State visible to the runner and codec protocol. */
export type FactoryStateView = LiveFactoryState | FactoryStateV1;

/** Hidden pattern-state fields whose values participate in Fabric traversal. */
export type FactoryStateValueField = "params" | "spaceSelector";

/**
 * Map the value-bearing portion of factory state without interpreting runner
 * values or sealing live state.
 *
 * Schemas, kind, scopes, artifact refs, and the runner-private root token are
 * metadata and pass through by identity. Only a pattern's hidden closure
 * params and raw execution-space selector are graph values. Recursion and
 * callable reconstruction remain with the caller so the data model does not
 * depend on Cells, Reactives, or runner execution trust.
 */
export function mapFactoryStateValues<T extends FactoryStateView>(
  state: T,
  mapper: (value: unknown, field: FactoryStateValueField) => unknown,
): T {
  if (state.kind !== "pattern") return state;

  const hasParams = Object.hasOwn(state, "params");
  const hasSpaceSelector = Object.hasOwn(state, "spaceSelector");
  const mappedParams = hasParams ? mapper(state.params, "params") : undefined;
  const mappedSpaceSelector = hasSpaceSelector
    ? mapper(state.spaceSelector, "spaceSelector")
    : undefined;

  if (
    (!hasParams || Object.is(mappedParams, state.params)) &&
    (!hasSpaceSelector || Object.is(mappedSpaceSelector, state.spaceSelector))
  ) {
    return state;
  }

  return {
    ...state,
    ...(hasParams ? { params: mappedParams } : {}),
    ...(hasSpaceSelector ? { spaceSelector: mappedSpaceSelector } : {}),
  } as T;
}

type Callable = (...args: never[]) => unknown;
type FactoryStateAccessor = () => FactoryStateView;
type FactoryKind = FactoryStateV1["kind"];
type FactoryStateForKind<K extends FactoryKind> = Extract<
  FactoryStateView,
  { kind: K }
>;

/** Callback used to harden Fabric values encountered while sealing state. */
export type FactoryStateValueHardener = (
  value: FabricValue,
) => FabricValue;

type FactoryAdmissionSource =
  | Readonly<{ source: "builder"; expectedKind: FactoryKind }>
  | Readonly<{ source: "codec" }>;

interface FactoryAdmission {
  readonly source: FactoryAdmissionSource;
  readonly stateAccessor: FactoryStateAccessor;
  canonicalState?: FactoryStateV1;
}

const FABRIC_FACTORY = Symbol.for("common.fabricFactory");
const FACTORY_STATE = Symbol.for("common.factoryState");

// This table, rather than the copyable symbol properties, is the admission
// authority. It deliberately carries no runner execution-trust information.
const factoryAdmissions = new WeakMap<Callable, FactoryAdmission>();

const CONTENT_IDENTITY_RE = /^[A-Za-z0-9_-]{43}$/;
const FACTORY_SCOPES = new Set<FactoryCellScope>([
  "space",
  "user",
  "session",
]);

function validationError(path: string, message: string): never {
  throw new TypeError(`Invalid Factory@1 state at ${path}: ${message}`);
}

function ownEnumerableStringKeys(
  value: object,
  path: string,
): readonly string[] {
  const keys = Object.keys(value);
  if (Reflect.ownKeys(value).length !== keys.length) {
    validationError(path, "properties must be enumerable strings");
  }
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      validationError(path, "properties must be enumerable data fields");
    }
  }
  return keys;
}

function exactKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of ownEnumerableStringKeys(value, path)) {
    if (!allowed.has(key)) {
      validationError(path, `unexpected field ${JSON.stringify(key)}`);
    }
  }
}

function requiredField(
  value: Record<string, unknown>,
  key: string,
  path: string,
): unknown {
  if (!Object.hasOwn(value, key)) {
    validationError(path, `missing required field ${JSON.stringify(key)}`);
  }
  return value[key];
}

function beginVisit(
  value: object,
  path: string,
  visiting: Set<object>,
): () => void {
  if (visiting.has(value)) {
    validationError(path, "cyclic state is not allowed");
  }
  visiting.add(value);
  return () => visiting.delete(value);
}

function canonicalJsonValue(
  value: unknown,
  path: string,
  visiting: Set<object>,
): unknown {
  if (
    value === null || typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      validationError(path, "schema numbers must be finite");
    }
    return value;
  }
  if (typeof value !== "object") {
    validationError(path, "expected a JSON value");
  }

  const finish = beginVisit(value as object, path, visiting);
  try {
    if (Array.isArray(value)) {
      if (!isArrayWithOnlyIndexProperties(value)) {
        validationError(path, "array has non-index properties");
      }
      const result: unknown[] = [];
      for (let i = 0; i < value.length; i++) {
        if (!(i in value)) {
          validationError(`${path}[${i}]`, "sparse arrays are not JSON");
        }
        result.push(canonicalJsonValue(value[i], `${path}[${i}]`, visiting));
      }
      return Object.freeze(result);
    }
    if (!isPlainObject(value)) {
      validationError(path, "expected a plain JSON object");
    }
    const entries: [string, unknown][] = [];
    for (const key of ownEnumerableStringKeys(value, path)) {
      entries.push([
        key,
        canonicalJsonValue(
          (value as Record<string, unknown>)[key],
          `${path}.${key}`,
          visiting,
        ),
      ]);
    }
    return Object.freeze(Object.fromEntries(entries));
  } finally {
    finish();
  }
}

function canonicalSchema(
  value: unknown,
  path: string,
  visiting: Set<object>,
): EmbeddedFactorySchema {
  if (typeof value === "boolean") return value;
  if (!isPlainObject(value)) {
    validationError(path, "expected a boolean or plain schema object");
  }
  return canonicalJsonValue(value, path, visiting) as EmbeddedFactorySchema;
}

function isCanonicallyDeepFrozenValue(
  value: unknown,
  visiting: Set<object>,
): boolean {
  switch (typeof value) {
    case "undefined":
    case "boolean":
    case "string":
    case "number":
    case "bigint":
      return true;
    case "symbol":
      return Symbol.keyFor(value) !== undefined;
    case "function":
      if (!factoryAdmissions.has(value as Callable)) return false;
      try {
        const state = canonicalFactoryStateOf(value, visiting);
        return Object.isFrozen(value) &&
          isCanonicallyDeepFrozenValue(state, visiting);
      } catch {
        return false;
      }
    case "object":
      if (value === null) return true;
      break;
  }

  if (visiting.has(value)) return false;
  visiting.add(value);
  try {
    if (value instanceof FabricPrimitive) {
      return Object.isFrozen(value);
    }
    if (value instanceof BaseFabricInstance) {
      return value[IS_DEEP_FROZEN]((nested) =>
        isCanonicallyDeepFrozenValue(nested, visiting)
      );
    }
    if (Array.isArray(value)) {
      if (!Object.isFrozen(value) || !isArrayWithOnlyIndexProperties(value)) {
        return false;
      }
      for (let i = 0; i < value.length; i++) {
        if (i in value && !isCanonicallyDeepFrozenValue(value[i], visiting)) {
          return false;
        }
      }
      return true;
    }
    if (!isPlainObject(value) || !Object.isFrozen(value)) return false;
    if (Reflect.ownKeys(value).length !== Object.keys(value).length) {
      return false;
    }
    return Object.values(value).every((nested) =>
      isCanonicallyDeepFrozenValue(nested, visiting)
    );
  } finally {
    visiting.delete(value);
  }
}

function canonicalFabricValue(
  value: unknown,
  path: string,
  visiting: Set<object>,
  hardenValue?: FactoryStateValueHardener,
): FabricValue {
  switch (typeof value) {
    case "undefined":
    case "boolean":
    case "string":
    case "number":
    case "bigint":
      return value;
    case "symbol":
      if (Symbol.keyFor(value) === undefined) {
        validationError(path, "unique symbols are not Fabric values");
      }
      return value;
    case "function": {
      const admission = factoryAdmissions.get(value as Callable);
      if (admission === undefined) {
        validationError(path, "arbitrary functions are not Fabric values");
      }
      canonicalFactoryStateOf(value, visiting, hardenValue);
      if (hardenValue !== undefined) {
        const hardened = hardenValue(value as FabricFactory);
        if (hardened !== value) {
          validationError(path, "factory hardening must preserve identity");
        }
      }
      if (!isCanonicallyDeepFrozenValue(value, visiting)) {
        validationError(path, "factories must be deeply frozen");
      }
      return value as FabricFactory;
    }
    case "object":
      if (value === null) return null;
      break;
  }

  if (value instanceof FabricPrimitive) {
    if (!Object.isFrozen(value)) {
      validationError(path, "Fabric primitives must be frozen");
    }
    return value as FabricValue;
  }
  if (value instanceof FabricInstance) {
    if (hardenValue !== undefined) {
      const hardened = hardenValue(value as FabricValue);
      if (hardened !== value) {
        validationError(path, "Fabric hardening must preserve identity");
      }
    }
    if (!isCanonicallyDeepFrozenValue(value, visiting)) {
      validationError(
        path,
        "Fabric instances must be deeply frozen",
      );
    }
    return value as FabricValue;
  }
  if (value instanceof BaseFabricSpecialObject) {
    validationError(path, "unknown Fabric special value kind");
  }

  const finish = beginVisit(value, path, visiting);
  try {
    if (Array.isArray(value)) {
      if (!isArrayWithOnlyIndexProperties(value)) {
        validationError(path, "array has non-index properties");
      }
      const result = new Array<FabricValue>(value.length);
      for (let i = 0; i < value.length; i++) {
        if (i in value) {
          result[i] = canonicalFabricValue(
            value[i],
            `${path}[${i}]`,
            visiting,
            hardenValue,
          );
        }
      }
      return Object.freeze(result) as FabricValue;
    }
    if (!isPlainObject(value)) {
      validationError(path, "expected a Fabric value");
    }
    const entries: [string, FabricValue][] = [];
    for (const key of ownEnumerableStringKeys(value, path)) {
      entries.push([
        key,
        canonicalFabricValue(
          (value as Record<string, unknown>)[key],
          `${path}.${key}`,
          visiting,
          hardenValue,
        ),
      ]);
    }
    return Object.freeze(Object.fromEntries(entries)) as FabricValue;
  } finally {
    finish();
  }
}

function canonicalRef(
  value: unknown,
  path: string,
): FactoryArtifactRef {
  if (!isPlainObject(value)) {
    validationError(path, "expected a ref object");
  }
  const ref = value as Record<string, unknown>;
  exactKeys(ref, new Set(["identity", "symbol"]), path);
  const identity = requiredField(ref, "identity", path);
  const symbol = requiredField(ref, "symbol", path);
  if (typeof identity !== "string" || !CONTENT_IDENTITY_RE.test(identity)) {
    validationError(
      `${path}.identity`,
      "expected a 43-character base64url content identity",
    );
  }
  let identityBytes: Uint8Array;
  try {
    identityBytes = fromBase64url(identity);
  } catch {
    validationError(
      `${path}.identity`,
      "expected a canonical 32-byte base64url content identity",
    );
  }
  if (
    identityBytes.length !== 32 ||
    toUnpaddedBase64url(identityBytes) !== identity
  ) {
    validationError(
      `${path}.identity`,
      "expected a canonical 32-byte base64url content identity",
    );
  }
  if (typeof symbol !== "string" || symbol.length === 0) {
    validationError(`${path}.symbol`, "expected a non-empty string");
  }
  return Object.freeze({ identity, symbol });
}

function canonicalScope(value: unknown, path: string): FactoryCellScope {
  if (
    typeof value !== "string" ||
    !FACTORY_SCOPES.has(value as FactoryCellScope)
  ) {
    validationError(path, "expected space, user, or session");
  }
  return value as FactoryCellScope;
}

function optionalCanonical<T>(
  source: Record<string, unknown>,
  key: string,
  path: string,
  canonicalize: (value: unknown, path: string) => T,
): T | undefined {
  if (!Object.hasOwn(source, key)) return undefined;
  const value = source[key];
  if (value === undefined) {
    validationError(`${path}.${key}`, "optional fields must be omitted");
  }
  return canonicalize(value, `${path}.${key}`);
}

function canonicalSpaceRequest(
  value: unknown,
  path: string,
  visiting: Set<object>,
): PatternFactorySpaceRequestV1 {
  if (!isPlainObject(value)) {
    validationError(path, "expected a plain inSpace request object");
  }
  const finish = beginVisit(value as object, path, visiting);
  try {
    const request = value as Record<string, unknown>;
    exactKeys(
      request,
      new Set(["grants", "root", "spaceKind", "selfOwned"]),
      path,
    );
    const grants = optionalCanonical(
      request,
      "grants",
      path,
      (item, itemPath) => {
        if (!isPlainObject(item)) {
          validationError(itemPath, "expected a plain grants object");
        }
        const entries: Array<[string, "READ" | "WRITE" | "OWNER"]> = [];
        for (const principal of ownEnumerableStringKeys(item, itemPath)) {
          const capability = (item as Record<string, unknown>)[principal];
          if (
            capability !== "READ" && capability !== "WRITE" &&
            capability !== "OWNER"
          ) {
            validationError(
              `${itemPath}.${principal}`,
              "expected READ, WRITE, or OWNER",
            );
          }
          entries.push([principal, capability]);
        }
        return Object.freeze(Object.fromEntries(entries));
      },
    );
    const trueFlag = (item: unknown, itemPath: string): true => {
      if (item !== true) validationError(itemPath, "expected true");
      return true;
    };
    const root = optionalCanonical(request, "root", path, trueFlag);
    const spaceKind = optionalCanonical(
      request,
      "spaceKind",
      path,
      (item, itemPath) => {
        if (typeof item !== "string") {
          validationError(itemPath, "expected a string");
        }
        return item;
      },
    );
    const selfOwned = optionalCanonical(
      request,
      "selfOwned",
      path,
      trueFlag,
    );
    return Object.freeze({
      ...(grants === undefined ? {} : { grants }),
      ...(root === undefined ? {} : { root }),
      ...(spaceKind === undefined ? {} : { spaceKind }),
      ...(selfOwned === undefined ? {} : { selfOwned }),
    });
  } finally {
    finish();
  }
}

function canonicalFactoryState(
  value: unknown,
  visiting: Set<object>,
  hardenValue?: FactoryStateValueHardener,
): FactoryStateV1 {
  const path = "state";
  if (!isPlainObject(value)) {
    validationError(path, "expected a plain object");
  }
  const state = value as Record<string, unknown>;
  if (Object.hasOwn(state, "rootToken")) {
    validationError(path, "live factory state is not encodable");
  }

  const finish = beginVisit(value as object, path, visiting);
  try {
    const kind = requiredField(state, "kind", path);
    const ref = canonicalRef(requiredField(state, "ref", path), "state.ref");

    switch (kind) {
      case "pattern": {
        exactKeys(
          state,
          new Set([
            "kind",
            "ref",
            "argumentSchema",
            "resultSchema",
            "paramsSchema",
            "params",
            "defaultScope",
            "spaceSelector",
            "spaceRequest",
          ]),
          path,
        );
        const argumentSchema = canonicalSchema(
          requiredField(state, "argumentSchema", path),
          "state.argumentSchema",
          visiting,
        );
        const resultSchema = canonicalSchema(
          requiredField(state, "resultSchema", path),
          "state.resultSchema",
          visiting,
        );
        const paramsSchema = optionalCanonical(
          state,
          "paramsSchema",
          path,
          (item, itemPath) => canonicalSchema(item, itemPath, visiting),
        );
        const params = optionalCanonical(
          state,
          "params",
          path,
          (item, itemPath) => {
            if (!isPlainObject(item)) {
              validationError(itemPath, "expected a plain params object");
            }
            return canonicalFabricValue(
              item,
              itemPath,
              visiting,
              hardenValue,
            ) as FabricPlainObject;
          },
        );
        if (params !== undefined && paramsSchema === undefined) {
          validationError(
            "state.params",
            "params requires a pattern paramsSchema",
          );
        }
        const defaultScope = optionalCanonical(
          state,
          "defaultScope",
          path,
          canonicalScope,
        );
        const spaceSelector = optionalCanonical(
          state,
          "spaceSelector",
          path,
          (item, itemPath) =>
            canonicalFabricValue(item, itemPath, visiting, hardenValue),
        );
        const spaceRequest = optionalCanonical(
          state,
          "spaceRequest",
          path,
          (item, itemPath) => canonicalSpaceRequest(item, itemPath, visiting),
        );
        return Object.freeze({
          kind,
          ref,
          argumentSchema,
          resultSchema,
          ...(paramsSchema === undefined ? {} : { paramsSchema }),
          ...(params === undefined ? {} : { params }),
          ...(defaultScope === undefined ? {} : { defaultScope }),
          ...(spaceSelector === undefined ? {} : { spaceSelector }),
          ...(spaceRequest === undefined ? {} : { spaceRequest }),
        });
      }

      case "module": {
        exactKeys(
          state,
          new Set([
            "kind",
            "ref",
            "argumentSchema",
            "resultSchema",
            "defaultScope",
          ]),
          path,
        );
        const argumentSchema = optionalCanonical(
          state,
          "argumentSchema",
          path,
          (item, itemPath) => canonicalSchema(item, itemPath, visiting),
        );
        const resultSchema = optionalCanonical(
          state,
          "resultSchema",
          path,
          (item, itemPath) => canonicalSchema(item, itemPath, visiting),
        );
        const defaultScope = optionalCanonical(
          state,
          "defaultScope",
          path,
          canonicalScope,
        );
        return Object.freeze({
          kind,
          ref,
          ...(argumentSchema === undefined ? {} : { argumentSchema }),
          ...(resultSchema === undefined ? {} : { resultSchema }),
          ...(defaultScope === undefined ? {} : { defaultScope }),
        });
      }

      case "handler": {
        exactKeys(
          state,
          new Set(["kind", "ref", "contextSchema", "eventSchema"]),
          path,
        );
        const contextSchema = optionalCanonical(
          state,
          "contextSchema",
          path,
          (item, itemPath) => canonicalSchema(item, itemPath, visiting),
        );
        const eventSchema = optionalCanonical(
          state,
          "eventSchema",
          path,
          (item, itemPath) => canonicalSchema(item, itemPath, visiting),
        );
        return Object.freeze({
          kind,
          ref,
          ...(contextSchema === undefined ? {} : { contextSchema }),
          ...(eventSchema === undefined ? {} : { eventSchema }),
        });
      }

      default:
        validationError("state.kind", "expected pattern, module, or handler");
    }
  } finally {
    finish();
  }
}

/**
 * Convert trusted live builder state into the canonical codec view. The
 * runner-only root token is deliberately omitted, but only after the complete
 * content-addressed artifact ref is available.
 */
function canonicalFactoryStateView(
  value: unknown,
  visiting: Set<object>,
  hardenValue?: FactoryStateValueHardener,
): FactoryStateV1 {
  if (!isPlainObject(value)) {
    validationError("state", "expected a plain object");
  }
  const state = value as Record<string, unknown>;
  if (!Object.hasOwn(state, "rootToken")) {
    return canonicalFactoryState(value, visiting, hardenValue);
  }
  if (
    state.rootToken === null || typeof state.rootToken !== "object"
  ) {
    validationError("state.rootToken", "expected a runner root token object");
  }
  if (!Object.hasOwn(state, "ref") || state.ref === undefined) {
    validationError("state.ref", "artifact ref is not available");
  }

  const finish = beginVisit(value as object, "state", visiting);
  try {
    const entries: [string, unknown][] = [];
    for (const key of ownEnumerableStringKeys(value as object, "state")) {
      if (key !== "rootToken") entries.push([key, state[key]]);
    }
    return canonicalFactoryState(
      Object.fromEntries(entries),
      visiting,
      hardenValue,
    );
  } finally {
    finish();
  }
}

/**
 * Admit a callable created by a trusted builder constructor or the factory
 * codec. This protocol admission does not make a decoded shell executable.
 *
 * @internal
 */
function admitFabricFactory<T extends Callable>(
  value: T,
  stateAccessor: FactoryStateAccessor,
  source: FactoryAdmissionSource,
  canonicalState?: FactoryStateV1,
): T & FabricFactory<Parameters<T>, ReturnType<T>> {
  if (factoryAdmissions.has(value)) {
    throw new TypeError("Callable is already an admitted FabricFactory");
  }
  if (!Object.isExtensible(value)) {
    throw new TypeError("FabricFactory must be admitted before hardening");
  }
  if (
    Object.hasOwn(value, FABRIC_FACTORY) || Object.hasOwn(value, FACTORY_STATE)
  ) {
    throw new TypeError(
      "Callable already has FabricFactory protocol properties",
    );
  }

  Object.defineProperties(value, {
    [FABRIC_FACTORY]: {
      configurable: false,
      enumerable: false,
      value: true,
      writable: false,
    },
    [FACTORY_STATE]: {
      configurable: false,
      enumerable: false,
      value: stateAccessor,
      writable: false,
    },
  });
  factoryAdmissions.set(value, {
    source,
    stateAccessor,
    ...(canonicalState === undefined ? {} : { canonicalState }),
  });
  return value as T & FabricFactory<Parameters<T>, ReturnType<T>>;
}

/**
 * Admit a callable produced by a trusted builder with an independently fixed
 * expected kind. This protocol fact does not grant runner execution trust.
 * The state accessor remains lazy so late artifact refs can resolve after
 * verified module registration without touching runner state at module init.
 *
 * @internal
 */
export function registerFabricFactory<
  T extends Callable,
  K extends FactoryKind,
>(
  value: T,
  expectedKind: K,
  state:
    | FactoryStateForKind<K>
    | (() => FactoryStateForKind<K>),
): T & FabricFactory<Parameters<T>, ReturnType<T>> {
  const stateAccessor: FactoryStateAccessor = typeof state === "function"
    ? state as () => FactoryStateView
    : () => state;
  return admitFabricFactory(
    value,
    stateAccessor,
    Object.freeze({ source: "builder", expectedKind }),
  );
}

/** Return whether a callable was admitted by the trusted factory protocol. */
export function isAdmittedFabricFactory(
  value: unknown,
): value is FabricFactory {
  return typeof value === "function" &&
    factoryAdmissions.has(value as Callable);
}

function readCheckedFactoryState(
  admission: FactoryAdmission,
): FactoryStateView {
  const state = admission.stateAccessor();
  if (admission.source.source === "builder") {
    const actualKind = isPlainObject(state)
      ? (state as unknown as Record<string, unknown>).kind
      : undefined;
    if (actualKind !== admission.source.expectedKind) {
      validationError(
        "state.kind",
        `trusted builder kind ${
          JSON.stringify(admission.source.expectedKind)
        } does not match state kind ${JSON.stringify(actualKind)}`,
      );
    }
  }
  return state;
}

/** Return admitted factory state, or `undefined` for every other value. */
export function tryFactoryState(value: unknown): FactoryStateView | undefined {
  if (typeof value !== "function") return undefined;
  const admission = factoryAdmissions.get(value as Callable);
  return admission?.canonicalState ??
    (admission === undefined ? undefined : readCheckedFactoryState(admission));
}

/** Return already-sealed canonical state without reading a live accessor. */
export function trySealedFactoryState(
  value: unknown,
): FactoryStateV1 | undefined {
  if (typeof value !== "function") return undefined;
  return factoryAdmissions.get(value as Callable)?.canonicalState;
}

/** Return admitted factory state, failing closed for arbitrary callables. */
export function factoryStateOf(value: unknown): FactoryStateView {
  const state = tryFactoryState(value);
  if (state === undefined) {
    throw new TypeError("Value is not an admitted FabricFactory");
  }
  return state;
}

/** Validate and deeply freeze an alleged canonical wire state. */
export function validateFactoryStateV1(
  value: unknown,
  hardenValue?: FactoryStateValueHardener,
): FactoryStateV1 {
  return canonicalFactoryState(value, new Set<object>(), hardenValue);
}

function canonicalFactoryStateOf(
  value: unknown,
  visiting: Set<object>,
  hardenValue?: FactoryStateValueHardener,
): FactoryStateV1 {
  if (typeof value !== "function") {
    throw new TypeError("Value is not an admitted FabricFactory");
  }
  const callable = value as Callable;
  const admission = factoryAdmissions.get(callable);
  if (admission === undefined) {
    throw new TypeError("Value is not an admitted FabricFactory");
  }
  if (admission.canonicalState !== undefined) {
    return admission.canonicalState;
  }

  const finish = beginVisit(callable, "factory", visiting);
  try {
    const canonical = canonicalFactoryStateView(
      readCheckedFactoryState(admission),
      visiting,
      hardenValue,
    );
    if (
      admission.source.source === "builder" &&
      canonical.kind !== admission.source.expectedKind
    ) {
      validationError(
        "state.kind",
        `trusted builder kind ${
          JSON.stringify(admission.source.expectedKind)
        } does not match state kind ${JSON.stringify(canonical.kind)}`,
      );
    }
    admission.canonicalState = canonical;
    return canonical;
  } finally {
    finish();
  }
}

/** Return the memoized canonical codec state of an admitted factory. */
export function sealFactoryState(
  value: unknown,
  hardenValue?: FactoryStateValueHardener,
): FactoryStateV1 {
  return canonicalFactoryStateOf(value, new Set<object>(), hardenValue);
}

/** Create a context-free, data-admitted shell from validated canonical state. */
export function createFactoryShell(
  state: unknown,
  hardenValue?: FactoryStateValueHardener,
): FabricFactory<never[], never> {
  const canonicalState = validateFactoryStateV1(state, hardenValue);
  const shell = admitFabricFactory(
    (..._args: never[]): never => {
      throw new Error("factory requires runner materialization");
    },
    () => canonicalState,
    Object.freeze({ source: "codec" }),
    canonicalState,
  );
  return Object.freeze(shell);
}
