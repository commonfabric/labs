import type { FabricPrimitive } from "@commonfabric/data-model";
import { BaseFabricPrimitive } from "@commonfabric/data-model/fabric-bases";
import { FrozenMap, FrozenSet } from "@commonfabric/data-model/frozen-builtins";

// Resolve `entries`/`values` from the prototype chain so own-property shadows
// on Map/Set instances cannot interfere, while still working correctly for
// FrozenMap/FrozenSet (which lack native internal slots and provide their own
// prototype methods).
function protoEntries(
  value: ReadonlyMap<unknown, unknown>,
): Iterable<[unknown, unknown]> {
  const entries = Object.getPrototypeOf(value)?.entries;
  if (typeof entries !== "function") {
    throw new TypeError(
      "Map-like value has no entries method on its prototype",
    );
  }
  return entries.call(value);
}

function protoValues(
  value: ReadonlySet<unknown>,
): Iterable<unknown> {
  const values = Object.getPrototypeOf(value)?.values;
  if (typeof values !== "function") {
    throw new TypeError("Set-like value has no values method on its prototype");
  }
  return values.call(value);
}

export interface ModuleSafeRecord {
  readonly [key: string]: ModuleSafeValue;
  readonly [key: symbol]: ModuleSafeValue;
}

export type ModuleSafeValue =
  | null
  | undefined
  | boolean
  | number
  | string
  | bigint
  | FabricPrimitive
  | RegExp
  | readonly ModuleSafeValue[]
  | ModuleSafeRecord
  | ReadonlyMap<ModuleSafeValue, ModuleSafeValue>
  | ReadonlySet<ModuleSafeValue>;

const verifiedPlainData = new WeakSet<object>();

export class PlainDataValidationError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "PlainDataValidationError";
  }
}

export function assertPlainData(
  value: unknown,
  path = "<root>",
): asserts value is ModuleSafeValue {
  validateModuleSafeValue(value, path, new WeakSet());
}

export function freezeVerifiedPlainData<T>(
  value: T,
): T {
  return freezeModuleSafeValue(value, "<root>", new WeakMap()) as T;
}

function validateModuleSafeValue(
  value: unknown,
  path: string,
  visited: WeakSet<object>,
): void {
  switch (typeof value) {
    case "undefined":
    case "boolean":
    case "number":
    case "string":
    case "bigint":
      return;
    case "object":
      if (value === null) return;
      break;
    default:
      throw validationError(
        path,
        `Unsupported value type '${typeof value}'`,
      );
  }

  const objectValue = value as object;
  if (verifiedPlainData.has(objectValue) || visited.has(objectValue)) {
    return;
  }
  visited.add(objectValue);

  // TODO(danfuzz): This part of the code admits `FabricPrimitive`s, and will
  // probably have to gain the ability to reason specifically about
  // `FabricInstance`s too in order to fully support the data model.
  try {
    // A `FabricPrimitive` acts like a JavaScript primitive: it is frozen when
    // it is constructed, and its state is private, so it is inert as it stands.
    if (BaseFabricPrimitive.isInstance(objectValue)) return;

    if (Array.isArray(objectValue)) {
      validateOwnProperties(objectValue, path, visited, { skipLength: true });
      return;
    }

    // Authored SES code cannot construct new proxies because Proxy is removed
    // from the compartment globals, but host/runtime values may still be
    // proxy-backed. We intentionally validate the one-time inert snapshot that
    // survives module load rather than rejecting those inputs outright.
    const proto = Object.getPrototypeOf(objectValue);
    if (proto === Object.prototype || proto === null) {
      validateOwnProperties(objectValue, path, visited);
      return;
    }

    if (proto === Map.prototype || proto === FrozenMap.prototype) {
      validateMap(
        objectValue as ReadonlyMap<unknown, unknown>,
        path,
        visited,
      );
      validateOwnProperties(objectValue, path, visited);
      return;
    }

    if (proto === Set.prototype || proto === FrozenSet.prototype) {
      validateSet(objectValue as ReadonlySet<unknown>, path, visited);
      validateOwnProperties(objectValue, path, visited);
      return;
    }

    if (proto === RegExp.prototype) {
      validatePlainRegExp(objectValue as RegExp, path);
      validateOwnProperties(objectValue, path, visited);
      return;
    }

    throw validationError(
      path,
      `Unsupported object prototype '${proto?.constructor?.name ?? "null"}'`,
    );
  } finally {
    visited.delete(objectValue);
  }
}

function validateOwnProperties(
  value: object,
  path: string,
  visited: WeakSet<object>,
  options: { skipLength?: boolean } = {},
): void {
  for (const key of Reflect.ownKeys(value)) {
    if (options.skipLength && key === "length") continue;

    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      throw validationError(
        pathForKey(path, key),
        "Own property descriptor is missing",
      );
    }

    validateModuleSafeValue(
      Reflect.get(value, key),
      pathForKey(path, key),
      visited,
    );
  }
}

function validateMap(
  value: ReadonlyMap<unknown, unknown>,
  path: string,
  visited: WeakSet<object>,
): void {
  let index = 0;
  for (const [key, entryValue] of protoEntries(value)) {
    validateModuleSafeValue(
      key,
      `${path}<map-key:${index}>`,
      visited,
    );
    validateModuleSafeValue(
      entryValue,
      `${path}<map-value:${index}>`,
      visited,
    );
    index += 1;
  }
}

function validateSet(
  value: ReadonlySet<unknown>,
  path: string,
  visited: WeakSet<object>,
): void {
  let index = 0;
  for (const entryValue of protoValues(value)) {
    validateModuleSafeValue(
      entryValue,
      `${path}<set:${index}>`,
      visited,
    );
    index += 1;
  }
}

function freezeModuleSafeValue(
  value: unknown,
  path: string,
  converted: WeakMap<object, ModuleSafeValue>,
): ModuleSafeValue {
  switch (typeof value) {
    case "undefined":
    case "boolean":
    case "number":
    case "string":
    case "bigint":
      return value as ModuleSafeValue;
    case "object":
      if (value === null) return null;
      break;
    default:
      throw validationError(
        path,
        `Unsupported value type '${typeof value}'`,
      );
  }

  const objectValue = value as object;
  if (verifiedPlainData.has(objectValue)) {
    return objectValue as ModuleSafeValue;
  }

  const existing = converted.get(objectValue);
  if (existing !== undefined) {
    return existing;
  }

  // Inert as it stands (see `validateModuleSafeValue()`), so kept as is.
  if (BaseFabricPrimitive.isInstance(objectValue)) {
    return objectValue;
  }

  if (Array.isArray(objectValue)) {
    return freezeArray(objectValue, path, converted);
  }

  const proto = Object.getPrototypeOf(objectValue);
  if (proto === Object.prototype || proto === null) {
    return freezeObject(objectValue, path, converted);
  }

  if (proto === Map.prototype || proto === FrozenMap.prototype) {
    return freezeMap(
      objectValue as ReadonlyMap<unknown, unknown>,
      path,
      converted,
    );
  }

  if (proto === Set.prototype || proto === FrozenSet.prototype) {
    return freezeSet(
      objectValue as ReadonlySet<unknown>,
      path,
      converted,
    );
  }

  if (proto === RegExp.prototype) {
    return freezeRegExp(objectValue as RegExp, path, converted);
  }

  throw validationError(
    path,
    `Unsupported object prototype '${proto?.constructor?.name ?? "null"}'`,
  );
}

function freezeArray(
  value: unknown[],
  path: string,
  converted: WeakMap<object, ModuleSafeValue>,
): readonly ModuleSafeValue[] {
  const result = new Array(value.length) as ModuleSafeValue[];
  converted.set(value, result as unknown as ModuleSafeValue);

  copyOwnProperties(value, result, path, converted, { skipLength: true });

  Object.freeze(result);
  verifiedPlainData.add(result);
  return result;
}

function freezeObject(
  value: object,
  path: string,
  converted: WeakMap<object, ModuleSafeValue>,
): ModuleSafeRecord {
  // A record leaves here in the one shape a `FabricPlainObject` has.
  // `assertPlainData` admits a null-prototype object, that being an ordinary
  // way to build a dictionary, and this is where it becomes canonical -- so
  // what a pattern receives stays inside `FabricValue`, which a null-prototype
  // record is not.
  const result = {} as ModuleSafeRecord;
  converted.set(value, result as ModuleSafeValue);

  copyOwnProperties(value, result, path, converted);

  Object.freeze(result);
  verifiedPlainData.add(result as object);
  return result;
}

function freezeMap(
  value: ReadonlyMap<unknown, unknown>,
  path: string,
  converted: WeakMap<object, ModuleSafeValue>,
): ReadonlyMap<ModuleSafeValue, ModuleSafeValue> {
  const builder = FrozenMap.createBuilder<ModuleSafeValue, ModuleSafeValue>();
  const result = builder.wrapper;
  converted.set(value as object, result as unknown as ModuleSafeValue);

  let index = 0;
  for (const [key, entryValue] of protoEntries(value)) {
    builder.set(
      freezeModuleSafeValue(
        key,
        `${path}<map-key:${index}>`,
        converted,
      ),
      freezeModuleSafeValue(
        entryValue,
        `${path}<map-value:${index}>`,
        converted,
      ),
    );
    index += 1;
  }

  copyOwnProperties(value as object, result, path, converted);

  builder.finish();
  verifiedPlainData.add(result);
  return result;
}

function freezeSet(
  value: ReadonlySet<unknown>,
  path: string,
  converted: WeakMap<object, ModuleSafeValue>,
): ReadonlySet<ModuleSafeValue> {
  const builder = FrozenSet.createBuilder<ModuleSafeValue>();
  const result = builder.wrapper;
  converted.set(value as object, result as unknown as ModuleSafeValue);

  let index = 0;
  for (const entryValue of protoValues(value)) {
    builder.add(
      freezeModuleSafeValue(
        entryValue,
        `${path}<set:${index}>`,
        converted,
      ),
    );
    index += 1;
  }

  copyOwnProperties(value as object, result, path, converted);

  builder.finish();
  verifiedPlainData.add(result);
  return result;
}

function freezeRegExp(
  value: RegExp,
  path: string,
  converted: WeakMap<object, ModuleSafeValue>,
): RegExp {
  validatePlainRegExp(value, path);
  const result = new RegExp(value.source, value.flags);
  converted.set(value, result);
  result.lastIndex = value.lastIndex;

  for (const key of Reflect.ownKeys(value)) {
    if (key === "lastIndex") continue;

    const descriptor = Reflect.getOwnPropertyDescriptor(value, key);
    if (!descriptor) {
      throw validationError(
        pathForKey(path, key),
        "Own property descriptor is missing",
      );
    }

    defineSnapshotProperty(
      result,
      key,
      freezeModuleSafeValue(
        Reflect.get(value, key),
        pathForKey(path, key),
        converted,
      ),
      descriptor.enumerable ?? true,
    );
  }

  Object.freeze(result);
  verifiedPlainData.add(result);
  return result;
}

function validatePlainRegExp(
  value: RegExp,
  path: string,
): void {
  // `global` and `sticky` regexes expose mutable `lastIndex` state, so they do
  // not belong in the verified inert-data subset.
  if (value.global || value.sticky) {
    throw validationError(
      path,
      "Stateful RegExp values are not allowed in verified plain data",
    );
  }
}

function copyOwnProperties(
  source: object,
  target: object,
  path: string,
  converted: WeakMap<object, ModuleSafeValue>,
  options: { skipLength?: boolean } = {},
): void {
  for (const key of Reflect.ownKeys(source)) {
    if (options.skipLength && key === "length") continue;

    const descriptor = Reflect.getOwnPropertyDescriptor(source, key);
    if (!descriptor) {
      throw validationError(
        pathForKey(path, key),
        "Own property descriptor is missing",
      );
    }

    defineSnapshotProperty(
      target,
      key,
      freezeModuleSafeValue(
        Reflect.get(source, key),
        pathForKey(path, key),
        converted,
      ),
      descriptor.enumerable ?? true,
    );
  }
}

function defineSnapshotProperty(
  target: object,
  key: PropertyKey,
  value: ModuleSafeValue,
  enumerable: boolean,
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable,
    configurable: true,
    writable: true,
  });
}

function pathForKey(
  path: string,
  key: PropertyKey,
): string {
  if (typeof key === "symbol") {
    return `${path}[${String(key)}]`;
  }

  const keyString = String(key);
  const index = Number(keyString);
  if (Number.isInteger(index) && String(index) === keyString) {
    return pathForIndex(path, index);
  }

  return pathForProperty(path, keyString);
}

function pathForIndex(path: string, index: number): string {
  return `${path}[${index}]`;
}

function pathForProperty(path: string, name: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name)
    ? `${path}.${name}`
    : `${path}[${JSON.stringify(name)}]`;
}

function validationError(
  path: string,
  message: string,
): PlainDataValidationError {
  return new PlainDataValidationError(path, message);
}
