/**
 * Validates and detaches standalone CFC labels received at untrusted JSON
 * boundaries. The parser checks the common atom and clause grammar without
 * assigning semantics to registered or extension atom families.
 */

import type { CfcAtom, CfcJsonValue } from "@commonfabric/api/cfc";
import { encodePointer } from "@commonfabric/memory/v2/path";

import type { CfcConfClause } from "./clause.ts";
import type { IFCLabel } from "./label-view-core.ts";

const LABEL_KEYS = new Set(["confidentiality", "integrity"]);

/** Refusal produced when an untrusted value is not an IFC label. */
export class InvalidIfcLabelError extends Error {
  #path: string;
  #reason: string;

  /** Constructs a refusal at the JSON-pointer-like `path`. */
  constructor(path: string, reason: string) {
    super(`Invalid IFC label at ${path}: ${reason}`);
    this.#path = path;
    this.#reason = reason;
    Object.defineProperty(this, "name", {
      configurable: true,
      value: "InvalidIfcLabelError",
    });
  }

  /** Path of the refused value. `/` denotes the label root. */
  get path(): string {
    return this.#path;
  }

  /** Stable explanation of why the value was refused. */
  get reason(): string {
    return this.#reason;
  }
}

/** Throws an {@link InvalidIfcLabelError} for `path`. */
const invalid = (path: readonly string[], reason: string): never => {
  throw new InvalidIfcLabelError(encodePointer(path) || "/", reason);
};

type DataProperty = readonly [key: string, value: unknown];

/**
 * Returns the inert data properties of a JSON object without evaluating an
 * accessor.
 */
const objectProperties = (
  value: unknown,
  path: readonly string[],
): DataProperty[] => {
  if (
    value === null || typeof value !== "object" || Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return invalid(path, "expected a JSON object");
  }

  const properties: DataProperty[] = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      return invalid(path, "JSON objects cannot contain symbol properties");
    }
    const memberPath = [...path, key];
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    if (!descriptor.enumerable) {
      return invalid(memberPath, "JSON object properties must be enumerable");
    }
    if (!("value" in descriptor)) {
      return invalid(
        memberPath,
        "JSON object properties must not be accessors",
      );
    }
    properties.push([key, descriptor.value]);
  }
  return properties;
};

/**
 * Returns the inert items of a dense JSON array without evaluating an
 * accessor.
 */
const arrayItems = (
  value: unknown,
  path: readonly string[],
): unknown[] => {
  if (
    !Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
  ) {
    return invalid(path, "expected a JSON array");
  }

  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (key === "length") continue;
    if (typeof key !== "string") {
      return invalid(path, "JSON arrays cannot contain symbol properties");
    }
    const index = Number(key);
    if (
      !Number.isInteger(index) || index < 0 || index >= value.length ||
      String(index) !== key
    ) {
      return invalid(
        [...path, key],
        "JSON arrays cannot contain named properties",
      );
    }
  }

  const items: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const itemPath = [...path, String(index)];
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) {
      return invalid(itemPath, "JSON arrays must not be sparse");
    }
    if (!("value" in descriptor)) {
      return invalid(itemPath, "JSON array items must not be accessors");
    }
    items.push(descriptor.value);
  }
  return items;
};

/** Deep-validates and detaches an arbitrary JSON value. */
const cloneJsonValue = (
  value: unknown,
  path: readonly string[],
  ancestors: Set<object>,
): CfcJsonValue => {
  if (
    value === null || typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      return invalid(path, "JSON numbers must be finite");
    }
    return value;
  }
  if (typeof value !== "object") {
    return invalid(path, "expected a JSON value");
  }
  if (ancestors.has(value)) {
    return invalid(path, "JSON values must not contain cycles");
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return arrayItems(value, path).map((item, index) =>
        cloneJsonValue(item, [...path, String(index)], ancestors)
      );
    }
    return Object.fromEntries(
      objectProperties(value, path).map(([key, member]) => [
        key,
        cloneJsonValue(member, [...path, key], ancestors),
      ]),
    );
  } finally {
    ancestors.delete(value);
  }
};

/** Whether `value` is an absolute URI usable as an atom type identifier. */
const isAtomTypeUri = (value: string): boolean => {
  try {
    return new URL(value).protocol !== "";
  } catch {
    return false;
  }
};

/** Validates and detaches an object atom at `path`. */
const parseAtom = (
  value: unknown,
  path: readonly string[],
): CfcAtom => {
  const properties = objectProperties(value, path);
  if (properties.some(([key]) => key === "anyOf")) {
    return invalid(path, "nested or malformed `anyOf` clause");
  }
  const type = properties.find(([key]) => key === "type")?.[1];
  if (typeof type !== "string" || !isAtomTypeUri(type)) {
    return invalid([...path, "type"], "atom `type` must be an absolute URI");
  }
  const ancestors = new Set<object>([value as object]);
  return Object.fromEntries(
    properties.map(([key, member]) => [
      key,
      cloneJsonValue(member, [...path, key], ancestors),
    ]),
  );
};

/** Validates and detaches one confidentiality clause. */
const parseConfidentialityClause = (
  value: unknown,
  path: readonly string[],
): CfcConfClause => {
  const properties = objectProperties(value, path);
  const anyOf = properties.find(([key]) => key === "anyOf");
  if (anyOf === undefined) return parseAtom(value, path);
  if (properties.length !== 1) {
    return invalid(path, "an `anyOf` clause must contain no other properties");
  }
  const alternatives = arrayItems(anyOf[1], [...path, "anyOf"]);
  return {
    anyOf: alternatives.map((alternative, index) =>
      parseAtom(alternative, [...path, "anyOf", String(index)])
    ),
  };
};

/**
 * Parses a standalone IFC label received from an untrusted JSON boundary.
 * The returned label shares no object or array identity with `value`.
 *
 * @throws {InvalidIfcLabelError} If `value` is not a canonical label.
 */
export const parseIfcLabel = (value: unknown): IFCLabel => {
  const properties = objectProperties(value, []);
  const label: IFCLabel = {};

  for (const [key, member] of properties) {
    if (!LABEL_KEYS.has(key)) {
      return invalid([key], "unknown label property");
    }
    const items = arrayItems(member, [key]);
    if (key === "confidentiality") {
      label.confidentiality = items.map((item, index) =>
        parseConfidentialityClause(item, [key, String(index)])
      );
    } else {
      label.integrity = items.map((item, index) => {
        const path = [key, String(index)];
        const properties = objectProperties(item, path);
        if (properties.some(([memberKey]) => memberKey === "anyOf")) {
          return invalid(path, "`anyOf` clauses are not allowed in integrity");
        }
        return parseAtom(item, path);
      });
    }
  }

  return label;
};
