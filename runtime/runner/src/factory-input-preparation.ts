import type { JSONSchema } from "@commonfabric/api";
import { isAdmittedFabricFactory } from "@commonfabric/data-model/fabric-factory";
import { resolveLocalSchemaRef } from "@commonfabric/data-model-schema";
import { deepEqual } from "@commonfabric/js-values/deep-equal";
import { isObjectNotArray } from "@commonfabric/js-values/types";

import type { Cell } from "./builder/types.ts";
import { ContextualFlowControl } from "./cfc.ts";
import { factoryContractFromSchema } from "./factory-contract.ts";
import {
  FactoryArtifactUnavailableError,
  factoryMatchesExpectedContract,
  type FactoryMaterializationContext,
  materializeFactory,
  prepareFactory,
} from "./factory-materialization.ts";
import { resolveLink } from "./link-resolution.ts";
import { isSigilLink } from "./link-utils.ts";
import type { Runtime } from "./runtime.ts";
import { RetryWhenReady } from "./scheduler/retry-when-ready.ts";
import type { IExtendedStorageTransaction } from "./storage/interface.ts";
import { canBranchMatch } from "./traverse.ts";

export interface FactoryInputPreparationContext {
  readonly runtime: Runtime;
  readonly tx: IExtendedStorageTransaction;
  /** The exact cell whose schema read produced `value`. */
  readonly inputsCell: Cell<unknown>;
}

function inputLinkAtPath(root: Cell<unknown>, path: readonly string[]) {
  const rootLink = root.getAsNormalizedFullLink();
  return { ...rootLink, path: [...rootLink.path, ...path] };
}

/**
 * Clone one argument container without evaluating unrelated property values.
 * Only schema-selected children are subsequently read/replaced.
 */
function shallowDescriptorClone<T extends object>(value: T): T {
  const clone = Array.isArray(value)
    ? new Array(value.length)
    : Object.create(Object.getPrototypeOf(value));
  for (const key of Reflect.ownKeys(value)) {
    if (Array.isArray(value) && key === "length") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) continue;
    Object.defineProperty(clone, key, {
      ...descriptor,
      ...(Object.hasOwn(descriptor, "value") ? { writable: true } : {}),
      configurable: true,
    });
  }
  return clone as T;
}

function replaceChild(
  original: Record<string, unknown> | unknown[],
  currentResult: Record<string, unknown> | unknown[],
  key: string,
  value: unknown,
): Record<string, unknown> | unknown[] {
  const result = currentResult === original
    ? shallowDescriptorClone(original)
    : currentResult;
  const descriptor = Object.getOwnPropertyDescriptor(result, key);
  Object.defineProperty(result, key, {
    value,
    enumerable: descriptor?.enumerable ?? true,
    writable: true,
    configurable: true,
  });
  return result;
}

/**
 * Resolve only local refs that belong to the scheduled input's own schema.
 * Factory discovery is auxiliary and must not ask the CFC resolver to interpret
 * unrelated embedded schemas against the wrong outer `$defs` root.
 */
function resolveFactoryDiscoverySchema(
  candidate: JSONSchema | undefined,
  root: JSONSchema | undefined,
): JSONSchema | undefined {
  let current = candidate;
  const seen = new Set<string>();
  while (
    isObjectNotArray(current) && typeof current.$ref === "string" &&
    !("asFactory" in current) && root !== undefined
  ) {
    const ref = current.$ref;
    if (seen.has(ref)) return current;
    seen.add(ref);
    const target = resolveLocalSchemaRef(ref, root);
    if (target === undefined) return current;
    const { $ref: _, ...siblings } = current;
    if (target === false) return false;
    if (target === true) {
      current = Object.keys(siblings).length === 0 ? true : siblings;
      continue;
    }
    current = {
      ...target,
      ...siblings,
      ...(isObjectNotArray(root) && target.$defs === undefined &&
          root.$defs !== undefined
        ? { $defs: root.$defs }
        : {}),
      ...(isObjectNotArray(root) && target.definitions === undefined &&
          root.definitions !== undefined
        ? { definitions: root.definitions }
        : {}),
    };
  }
  return current;
}

/**
 * Strengthen the shared conservative branch precheck only for discriminator
 * values that are already concrete. The general traverser deliberately ignores
 * const/enum because a link may resolve later; scheduled callback inputs have
 * already been read, so a non-link discriminator can safely exclude a branch
 * before its factory contract is enforced.
 */
function canFactoryBranchMatch(
  branch: JSONSchema,
  value: unknown,
  root: JSONSchema,
): boolean {
  const resolvedBranch = resolveFactoryDiscoverySchema(branch, root) ?? branch;
  if (!canBranchMatch(resolvedBranch, value)) return false;
  if (!isObjectNotArray(resolvedBranch) || isSigilLink(value)) return true;

  if (
    "const" in resolvedBranch && !deepEqual(resolvedBranch.const, value)
  ) {
    return false;
  }
  if (
    Array.isArray(resolvedBranch.enum) &&
    !resolvedBranch.enum.some((candidate) => deepEqual(candidate, value))
  ) {
    return false;
  }

  if (
    isObjectNotArray(value) && isObjectNotArray(resolvedBranch.properties)
  ) {
    for (
      const [key, childSchema] of Object.entries(resolvedBranch.properties)
    ) {
      if (
        key in value &&
        !canFactoryBranchMatch(childSchema, value[key], root)
      ) {
        return false;
      }
    }
  }
  return true;
}

/**
 * Replace only schema-declared `asFactory` leaves with warm executable
 * factories immediately before a lift/handler callback runs.
 *
 * The ordinary schema read remains authoritative for validation, reactivity,
 * and CFC provenance. This pass uses the same input cell and transaction only
 * to resolve each selected leaf's trusted source space. It deliberately does
 * not inspect opaque or undeclared values. A cold leaf becomes a
 * `RetryWhenReady` scheduler signal; the callback is retried only after the
 * runner has warmed the trusted artifact source.
 */
export function materializeScheduledFactoryInputs(
  value: unknown,
  schema: JSONSchema | undefined,
  context: FactoryInputPreparationContext,
): unknown {
  // Defer starting cold loads until the entire schema walk has completed.
  // A later leaf may fail terminally (wrong kind/schema); in that case no
  // earlier load should escape unobserved or do needless work.
  const readiness: Array<() => Promise<void>> = [];
  const fullSchema = schema;
  const resolvedSchemaMemo = new WeakMap<object, JSONSchema | undefined>();
  const resolvedSchemaFor = (
    candidate: JSONSchema | undefined,
  ): JSONSchema | undefined => {
    if (!isObjectNotArray(candidate)) {
      return resolveFactoryDiscoverySchema(candidate, fullSchema);
    }
    if (resolvedSchemaMemo.has(candidate)) {
      return resolvedSchemaMemo.get(candidate);
    }
    const resolved = resolveFactoryDiscoverySchema(candidate, fullSchema);
    resolvedSchemaMemo.set(candidate, resolved);
    return resolved;
  };
  const factorySchemaMemo = new WeakMap<object, boolean>();
  const factorySchemaVisiting = new WeakSet<object>();
  const inspectFactorySchema = (
    candidate: JSONSchema | undefined,
  ): { contains: boolean; complete: boolean } => {
    const resolved = resolvedSchemaFor(candidate);
    if (!isObjectNotArray(resolved)) {
      return { contains: false, complete: true };
    }
    const cached = factorySchemaMemo.get(resolved);
    if (cached !== undefined) return { contains: cached, complete: true };
    if (factorySchemaVisiting.has(resolved)) {
      // The answer for this edge is provisional. Its caller may still find a
      // factory through a later branch, but must not memoize `false` based on
      // this cycle break.
      return { contains: false, complete: false };
    }
    if ("asFactory" in resolved) {
      factorySchemaMemo.set(resolved, true);
      return { contains: true, complete: true };
    }
    factorySchemaVisiting.add(resolved);
    let complete = true;
    const children: Array<JSONSchema | undefined> = [];
    if (isObjectNotArray(resolved.properties)) {
      for (const child of Object.values(resolved.properties)) {
        children.push(child);
      }
    }
    children.push(resolved.items);
    if (Array.isArray(resolved.prefixItems)) {
      for (const child of resolved.prefixItems) children.push(child);
    }
    children.push(resolved.additionalProperties);
    for (const compound of ["allOf", "anyOf", "oneOf"] as const) {
      if (Array.isArray(resolved[compound])) {
        for (const child of resolved[compound]) children.push(child);
      }
    }
    try {
      for (const child of children) {
        const inspected = inspectFactorySchema(child);
        if (inspected.contains) {
          factorySchemaMemo.set(resolved, true);
          return { contains: true, complete: true };
        }
        complete &&= inspected.complete;
      }
      if (complete) factorySchemaMemo.set(resolved, false);
      return { contains: false, complete };
    } finally {
      factorySchemaVisiting.delete(resolved);
    }
  };
  const schemaContainsFactory = (candidate: JSONSchema | undefined): boolean =>
    inspectFactorySchema(candidate).contains;

  const visit = (
    currentValue: unknown,
    currentSchema: JSONSchema | undefined,
    path: readonly string[],
  ): unknown => {
    const resolvedSchema = resolvedSchemaFor(currentSchema);
    if (!isObjectNotArray(resolvedSchema)) return currentValue;

    // An explicit Cell<Factory> remains a Cell. Its contents are read under
    // ordinary Cell semantics by authored code; this preparation pass only
    // replaces by-value factory leaves delivered to the callback.
    if (ContextualFlowControl.getAsCellValues(resolvedSchema).length > 0) {
      return currentValue;
    }

    const expected = factoryContractFromSchema(resolvedSchema);
    if (expected !== undefined) {
      if (currentValue === undefined) return currentValue;
      const resolvedInput = resolveLink(
        context.runtime,
        context.tx,
        inputLinkAtPath(context.inputsCell, path),
      );
      const materializationContext = {
        runtime: context.runtime,
        artifactSpace: resolvedInput.space,
        expected,
      } satisfies FactoryMaterializationContext;
      try {
        return materializeFactory(currentValue, materializationContext);
      } catch (error) {
        if (!(error instanceof FactoryArtifactUnavailableError)) throw error;
        readiness.push(() =>
          prepareFactory(currentValue, materializationContext).then(() => {})
        );
        return currentValue;
      }
    }

    let result = currentValue;
    if (
      isObjectNotArray(currentValue) &&
      isObjectNotArray(resolvedSchema.properties)
    ) {
      const container = currentValue as Record<string, unknown>;
      for (
        const [key, childSchema] of Object.entries(
          resolvedSchema.properties,
        )
      ) {
        if (!schemaContainsFactory(childSchema)) continue;
        const child = container[key];
        const prepared = visit(
          child,
          childSchema as JSONSchema,
          [...path, key],
        );
        if (!Object.is(prepared, child)) {
          result = replaceChild(
            currentValue as Record<string, unknown>,
            result as Record<string, unknown>,
            key,
            prepared,
          );
        }
      }
    }

    if (Array.isArray(currentValue)) {
      const prefixItems = Array.isArray(resolvedSchema.prefixItems)
        ? resolvedSchema.prefixItems
        : [];
      for (let index = 0; index < currentValue.length; index++) {
        if (!(index in currentValue)) continue;
        const itemSchema = prefixItems[index] ?? resolvedSchema.items;
        if (!schemaContainsFactory(itemSchema)) continue;
        const child = currentValue[index];
        const prepared = visit(
          child,
          itemSchema,
          [...path, String(index)],
        );
        if (!Object.is(prepared, child)) {
          result = replaceChild(
            currentValue,
            result as unknown[],
            String(index),
            prepared,
          );
        }
      }
    }

    if (
      isObjectNotArray(currentValue) &&
      schemaContainsFactory(resolvedSchema.additionalProperties)
    ) {
      const declared = isObjectNotArray(resolvedSchema.properties)
        ? new Set(Object.keys(resolvedSchema.properties))
        : undefined;
      for (const key of Object.keys(currentValue)) {
        if (declared?.has(key)) continue;
        const child = currentValue[key];
        const prepared = visit(
          child,
          resolvedSchema.additionalProperties,
          [...path, key],
        );
        if (!Object.is(prepared, child)) {
          result = replaceChild(
            currentValue,
            result as Record<string, unknown>,
            key,
            prepared,
          );
        }
      }
    }

    for (const compound of ["allOf", "anyOf", "oneOf"] as const) {
      const branches = resolvedSchema[compound];
      if (!Array.isArray(branches)) continue;
      for (const branch of branches) {
        if (!schemaContainsFactory(branch)) continue;
        const resolvedBranch = resolvedSchemaFor(branch);
        if (
          compound !== "allOf" && resolvedBranch !== undefined &&
          !canFactoryBranchMatch(
            resolvedBranch,
            result,
            fullSchema ?? resolvedBranch,
          )
        ) {
          continue;
        }
        if (
          compound !== "allOf" && isObjectNotArray(resolvedBranch) &&
          "asFactory" in resolvedBranch
        ) {
          const expected = factoryContractFromSchema(resolvedBranch)!;
          if (
            !isAdmittedFabricFactory(result) ||
            !factoryMatchesExpectedContract(result, expected, context.runtime)
          ) {
            // `asFactory` is a leaf alternative, not permission to inspect or
            // reject a value selected by a sibling union branch.
            continue;
          }
        }
        result = visit(result, branch, path);
        if (compound !== "allOf") break;
      }
    }
    return result;
  };

  const prepared = visit(value, schema, []);
  if (readiness.length > 0) {
    throw new RetryWhenReady(
      Promise.all(readiness.map((start) => start())),
      "Factory inputs are waiting for artifact readiness",
    );
  }
  return prepared;
}
