import { isObjectOrArray } from "@commonfabric/utils/types";
import { createNodeFactory } from "./builder/module.ts";
import {
  type CellScope,
  type JSONSchema,
  Module,
  type ModuleFactory,
} from "./builder/types.ts";
import type { Cell } from "./cell.ts";
import type { Action, ReactivityLog } from "./scheduler.ts";
import type { AddCancel } from "./cancel.ts";
import type { Runtime } from "./runtime.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";
import type { NormalizedFullLink } from "./link-types.ts";

/**
 * Result returned by a raw builtin implementation.
 *
 * - action: The action to be scheduled
 * - isEffect: If true, this action is side-effectful (optional, can also be passed via RawModuleOptions)
 * - dependencies: Optional static scheduler dependencies for first-run demand/ordering.
 * - useDeclaredReadsAsDependencies: Register binding links as static read evidence.
 * - debounce/throttle/noDebounce: Optional scheduler timing controls.
 */
export interface RawBuiltinResult {
  action: Action;
  isEffect?: boolean;
  dependencies?: ReactivityLog;
  useDeclaredReadsAsDependencies?: boolean;

  /** Defers a computation with declared outputs until a consumer demands them. */
  deferUntilDemand?: boolean;

  debounce?: number;
  noDebounce?: boolean;
  throttle?: number;

  /**
   * Receives the Action the runner actually registers with the scheduler —
   * a wrapper around `action`, so `action`'s own identity is not the
   * scheduler's key. A builtin whose asynchronous work must re-arm its own
   * reconcile (Scheduler.invalidateAction) captures the wrapper here.
   */
  onActionRegistered?: (action: Action) => void;
}

/**
 * A raw builtin implementation can return either:
 * - Just an Action (legacy format, for backwards compatibility)
 * - A RawBuiltinResult object with action, optional isEffect, and scheduler timing options
 */
export type RawBuiltinReturnType = Action | RawBuiltinResult;

/**
 * Type guard to check if a builtin result is the new object format
 */
export function isRawBuiltinResult(
  result: RawBuiltinReturnType,
): result is RawBuiltinResult {
  return (
    isObjectOrArray(result) &&
    "action" in result &&
    typeof result.action === "function"
  );
}

export class ModuleRegistry {
  #moduleMap = new Map<string, Module>();
  readonly runtime: Runtime;

  constructor(runtime: Runtime) {
    this.runtime = runtime;
  }

  addModuleByRef(ref: string, module: Module): void {
    const target = Object.isExtensible(module)
      ? module
      : cloneModuleRecord(module);
    defineDebugName(target, ref);
    this.#moduleMap.set(ref, target);
  }

  /**
   * The module registered under `ref`.
   *
   * A `defaultScope` is applied to a COPY: the registered module is shared by
   * every node that names the ref, while a scope belongs to the one call site
   * that declared it (`.asScope("user")`, or the `PerUser<>` annotation the
   * transformer lowers to it).
   *
   * The copy restates `debugName` through {@link defineDebugName}, which is
   * what proves the module's `{ kind: "builtin", builtinId }` policy identity
   * to `resolvePolicyFacingImplementationIdentity`. Being non-enumerable, the
   * name is not among the members a spread carries, and a scoped module with
   * no name on it writes unattributed.
   */
  getModule(ref: string, defaultScope?: CellScope): Module {
    if (typeof ref !== "string") throw new Error(`Unknown module ref: ${ref}`);
    const module = this.#moduleMap.get(ref);
    if (!module) throw new Error(`Unknown module ref: ${ref}`);
    if (defaultScope === undefined) return module;
    const scoped: Module = { ...module, defaultScope };
    defineDebugName(scoped, ref);
    return scoped;
  }

  clear(): void {
    this.#moduleMap.clear();
  }
}

/**
 * Name a module with the ref it is registered under.
 *
 * The name is the module's policy identity: it is what
 * `resolvePolicyFacingImplementationIdentity` reads to resolve
 * `{ kind: "builtin", builtinId }`, so the writes a builtin's node makes are
 * attributable to it.
 *
 * It is defined rather than assigned, and every attribute is stated rather
 * than left to default, because `Object.defineProperty` carries forward the
 * attributes an existing property already had. A module carrying an ordinary
 * `debugName` of its own would otherwise keep it enumerable, which puts the
 * name in `moduleToEncodableForm`'s key set and so into every content-derived
 * id built from that module.
 */
function defineDebugName(module: Module, ref: string): void {
  Object.defineProperty(module, "debugName", {
    value: ref,
    writable: false,
    enumerable: false,
    configurable: true,
  });
}

function cloneModuleRecord(module: Module): Module {
  const clone: Record<PropertyKey, unknown> = {};
  for (const key of Reflect.ownKeys(module as object)) {
    const descriptor = Object.getOwnPropertyDescriptor(module as object, key);
    if (!descriptor) {
      continue;
    }
    Object.defineProperty(clone, key, descriptor);
  }
  return clone as unknown as Module;
}

export interface RawModuleOptions {
  /** If true, this module is an effect (side-effectful) rather than a computation */
  isEffect?: boolean;

  /** Optional scheduler debounce delay in milliseconds */
  debounce?: number;

  /** Opt out of scheduler auto-debounce */
  noDebounce?: boolean;

  /** Optional scheduler throttle period in milliseconds */
  throttle?: number;

  /**
   * Optional argument schema for the raw module's inputs. Threaded into input
   * binding resolution so the emitted links carry per-key schema annotations
   * (e.g. an `asCell: ["opaque"]` marker on a forwarded reference), which the
   * scheduler uses to decide whether an input is a declared read.
   */
  argumentSchema?: JSONSchema;
}

/**
 * The inputs, owner, and output coordinates supplied to a raw builtin.
 *
 * `outputSpot` identifies the write redirect the output binding resolves to.
 * A result store keyed on the owner and these coordinates keeps its identity
 * while the output spot is unchanged. Renaming or reordering nodes can change
 * their output coordinates and therefore their result-store identities.
 *
 * `inputs` is content-addressed on the serialized inputs, so its identity can
 * change with branch literals, link schemas, or runtime serialization.
 */
export interface RawNodeCause {
  /** The node's immutable inputs document. */
  inputs: Cell<any>;

  /** The piece's result cell, which owns every store the node mints. */
  parents: Cell<any>["entityId"];

  /**
   * The node's output spot, scope and schema dropped. Absent only for a node
   * whose output binding reaches no write redirect.
   */
  outputSpot?: { space: string; id: string; path: readonly unknown[] };
}

// This corresponds to the node factory factories in common-builder:module.ts.
// But it's here, because the signature depends on implementation details of the
// runner, and won't work with any other runners.
export function raw<T, R>(
  implementation: (
    inputsCell: Cell<T>,
    sendResult: (tx: IExtendedStorageTransaction, result: R) => void,
    addCancel: AddCancel,
    cause: any,
    parentCell: Cell<any>,
    runtime: Runtime,
    // Fully-resolved normalized link of the output spot this node writes
    // through (a write redirect at the top, always present for a real node).
    // Carries the binding's declared `scope` (folded from the result schema /
    // `.asScope()` default) and `schema`, so a builtin can mint its result
    // container at the author-declared scope. Replaces the scope-less
    // `cause.outputSpot` for scope-aware builtins; `cause.outputSpot` stays for
    // identity (it is hashed into result-cell causes and must not churn).
    outputBinding?: NormalizedFullLink,
    // Whether this node is resuming from synced storage and should defer its
    // initial run until sync completes. Passed out-of-band (like `outputBinding`
    // above) rather than folded into `cause`: it is transient (present only on
    // resume), so hashing it into the result-cell id would diverge a fresh
    // runtime from a resumed one for the same logical node. Container-minting
    // builtins (map/filter/flatMap) read it to defer their per-element
    // sub-pattern runs until sync completes too.
    awaitSync?: boolean,
    // The resolved coordinate where sendResult publishes, including its actual
    // storage scope. Publication ownership uses this scope; outputBinding's
    // declared scope controls where a builtin mints its result container.
    publicationBinding?: NormalizedFullLink,
  ) => RawBuiltinReturnType,
  options?: RawModuleOptions,
): ModuleFactory<T, R> {
  return createNodeFactory({
    type: "raw",
    implementation,
    isEffect: options?.isEffect,
    debounce: options?.debounce,
    noDebounce: options?.noDebounce,
    throttle: options?.throttle,
    ...(options?.argumentSchema !== undefined
      ? { argumentSchema: options.argumentSchema }
      : {}),
  });
}
