/**
 * What the language-neutral conformance fixtures have in common: the
 * descriptor notation their values are written in, the cases every concrete
 * class contributes, and the layout of a fixture file. An implementation in
 * another language reads a fixture through the notation, which
 * `test/fixtures/value-descriptors.md` defines.
 *
 * This is reached through `for-testing-only.ts` and the modules that write the
 * fixtures, and has no place in any barrel.
 */

import { utf8Compare } from "@commonfabric/utils/utf8";

import type { FabricValue } from "@/interface.ts";
import { ProblematicValue, UnknownValue } from "@/codec-common";
import {
  FabricError,
  type FabricInstanceClassesByName,
  FabricLink,
  FabricMap,
  FabricSet,
} from "@/fabric-instances";
import {
  FabricBytes,
  FabricDurationDay,
  FabricDurationNsec,
  FabricEpochDay,
  FabricEpochNsec,
  FabricHash,
  FabricKeyPair,
  type FabricPrimitiveClassesByName,
  FabricRegExp,
  FabricUnavailable,
  UNAVAILABLE_ERROR_KINDS,
  UNAVAILABLE_REASONS,
} from "@/fabric-primitives";
import { isFabricArray, isFabricPlainObject } from "@/types";

//
// Types
//

/**
 * A value in the descriptor notation `test/fixtures/value-descriptors.md`
 * defines. It is JSON, so that any language can read it.
 */
export type ValueDescriptor =
  | null
  | boolean
  | number
  | string
  | readonly ValueDescriptor[]
  | { readonly [key: string]: ValueDescriptor };

/** Makers of examples of each class in one of the class tables. */
export type ExampleMakers<ClassesByName> = {
  readonly [Name in keyof ClassesByName]: readonly (() => FabricValue)[];
};

/**
 * What a class's examples need beyond their makers: the spec section, or a
 * note saying why the class's examples are not cases.
 */
export type ClassCaseNotes =
  | { readonly section: string }
  | { readonly excluded: string };

/** A case made from one class example: its name, its section, and its maker. */
export type ClassCase = {
  readonly name: string;
  readonly section: string;
  readonly make: () => FabricValue;
};

//
// Cases
//

/** Why the classes whose codecs are stubs have no cases. */
export const STUB_CODEC_EXCLUSION = "Its codec is a stub, pending general " +
  "`FabricInstance` support (1-fabric-values.md sections 1.4.3 and 1.4.4).";

/**
 * Returns one case for each maker in `makers`, named for its class and its
 * place among that class's makers.
 */
export function classCasesOf<Name extends string>(
  makers: { readonly [N in Name]: readonly (() => FabricValue)[] },
  notes: { readonly [N in Name]: ClassCaseNotes },
): ClassCase[] {
  const cases: ClassCase[] = [];
  for (const name in notes) {
    const classNotes = notes[name];
    if ("excluded" in classNotes) continue;
    makers[name].forEach((make, index) => {
      cases.push({
        name: `${name}, example ${index + 1}`,
        section: classNotes.section,
        make,
      });
    });
  }
  return cases;
}

/**
 * Returns an array of length `length` holding `entries`, each an index and the
 * value there, and a hole at every other index.
 */
export function sparseArrayOf(
  length: number,
  entries: readonly (readonly [number, FabricValue])[],
): FabricValue[] {
  const result: FabricValue[] = new Array(length);
  for (const [index, value] of entries) {
    result[index] = value;
  }
  return result;
}

//
// The fixture file
//

/**
 * Throws if two of `cases` share a name, a fixture naming each case once.
 *
 * @throws If two cases share a name.
 */
export function assertDistinctCaseNames(
  cases: readonly { readonly name: string }[],
): void {
  const names = new Set<string>();
  for (const { name } of cases) {
    if (names.has(name)) {
      throw new Error(`Two cases are named ${name}.`);
    }
    names.add(name);
  }
}

/**
 * Returns the text of a fixture file: `about`, which says what the file is,
 * and `entries`, one per case. Each entry is one line, and every character
 * past ASCII is escaped, so that the file is unchanged by any tool that
 * normalizes text.
 */
export function fixtureTextOf(
  about: string,
  entries: readonly ValueDescriptor[],
): string {
  const lines = entries.map(asciiJsonOf);
  return `{\n  "about": ${asciiJsonOf(about)},\n  "cases": [\n    ` +
    `${lines.join(",\n    ")}\n  ]\n}\n`;
}

/** Returns the JSON text of `value`, with every non-ASCII code unit escaped. */
function asciiJsonOf(value: ValueDescriptor): string {
  return JSON.stringify(value).replace(
    /[\u007f-￿]/g,
    (unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

//
// Descriptors
//

/**
 * Returns the descriptor of `value`, in the notation
 * `test/fixtures/value-descriptors.md` defines.
 *
 * @throws If `value` is a key pair holding `CryptoKey` handles rather than
 *   key material, which no descriptor can write down, or holds a cycle that
 *   closes at an instance or passes through one, which the notation's cycle
 *   references do not reach.
 */
export function descriptorOf(value: FabricValue): ValueDescriptor {
  return describe(value, []);
}

/**
 * Helper for {@link descriptorOf}, which describes `value` where `path` holds
 * the arrays, records, and instances enclosing it, outermost first.
 */
function describe(
  value: FabricValue,
  path: readonly FabricValue[],
): ValueDescriptor {
  switch (typeof value) {
    case "undefined": {
      return { undefined: null };
    }
    case "boolean": {
      return value;
    }
    case "string": {
      return stringDescriptorOf(value);
    }
    case "bigint": {
      return { bigint: value.toString() };
    }
    case "symbol": {
      const key = Symbol.keyFor(value);
      return (key === undefined)
        ? {
          unregisteredSymbol: (value.description === undefined)
            ? null
            : stringDescriptorOf(value.description),
        }
        : { symbol: stringDescriptorOf(key) };
    }
    case "number": {
      if (Number.isFinite(value) && !Object.is(value, -0)) {
        return value;
      }
      const special = SPECIAL_NUMBER_NAMES.find(([, number]) =>
        Object.is(number, value)
      );
      return { number: (special === undefined) ? "NaN" : special[0] };
    }
  }

  if (value === null) {
    return null;
  }

  const at = path.lastIndexOf(value);
  if (at >= 0) {
    if (!path.slice(at).every(isPlainContainer)) {
      throw new Error("No descriptor for a cycle through an instance.");
    }
    return { cycle: path.length - at };
  }

  const inner = [...path, value];
  if (isFabricArray(value)) {
    return { array: arrayEntriesOf(value, inner) };
  } else if (isFabricPlainObject(value)) {
    return { record: recordEntriesOf(value, inner) };
  }

  for (const notation of Object.values(CLASS_NOTATIONS)) {
    const described = notation.describe(value, inner);
    if (described !== undefined) {
      return described;
    }
  }
  throw new Error("No descriptor for a value of an unknown class.");
}

/** Indicates whether `value` is an array or a record. */
function isPlainContainer(value: FabricValue): boolean {
  return isFabricArray(value) || isFabricPlainObject(value);
}

/**
 * Returns the value `descriptor` describes. The inverse of
 * {@link descriptorOf}: the descriptor of the result is `descriptor`.
 *
 * @throws If `descriptor` is not one the notation defines.
 */
export function fabricValueOfDescriptor(
  descriptor: ValueDescriptor,
): FabricValue {
  return make(descriptor, []);
}

/**
 * Helper for {@link fabricValueOfDescriptor}, which makes the value
 * `descriptor` describes where `building` holds the arrays and records being
 * made around it, outermost first. A cycle reference is to one of those.
 */
function make(
  descriptor: ValueDescriptor,
  building: FabricValue[],
): FabricValue {
  if (
    descriptor === null || typeof descriptor === "boolean" ||
    typeof descriptor === "number" || typeof descriptor === "string"
  ) {
    return descriptor;
  }

  const [kind, payload] = soleEntryOf(descriptor);
  switch (kind) {
    case "undefined": {
      return undefined;
    }
    case "number": {
      const found = SPECIAL_NUMBER_NAMES.find(([name]) => name === payload);
      if (found === undefined) {
        throw new Error(`Not a special number: ${JSON.stringify(payload)}`);
      }
      return found[1];
    }
    case "utf16": {
      return stringOf(descriptor);
    }
    case "bigint": {
      return BigInt(stringOf(payload));
    }
    case "symbol": {
      return Symbol.for(stringOf(payload));
    }
    case "unregisteredSymbol": {
      return (payload === null) ? Symbol() : Symbol(stringOf(payload));
    }
    case "array": {
      return arrayOf(payload, building);
    }
    case "record": {
      return recordOf(payload, building);
    }
    case "cycle": {
      if (
        !(typeof payload === "number" && Number.isSafeInteger(payload) &&
          payload >= 1 && payload <= building.length)
      ) {
        throw new Error(`Not a cycle distance: ${JSON.stringify(payload)}`);
      }
      return building[building.length - payload];
    }
  }

  for (const notation of Object.values(CLASS_NOTATIONS)) {
    if (notation.key === kind) {
      return notation.make(payload);
    }
  }
  throw new Error(`Not a descriptor kind: ${kind}`);
}

/** The special numbers, under the names their descriptors use. */
const SPECIAL_NUMBER_NAMES: readonly (readonly [string, number])[] = [
  ["-0", -0],
  ["NaN", NaN],
  ["+Infinity", Infinity],
  ["-Infinity", -Infinity],
];

/**
 * How one class's instances are described, and made back from a descriptor.
 * `cls` is there for its type, which ties the entry to the class it is keyed
 * under in {@link CLASS_NOTATIONS}.
 */
interface ClassNotation<Class> {
  readonly cls: Class;
  readonly key: string;

  /**
   * The descriptor of `value`, where `path` holds what encloses it and
   * `value` itself, or `undefined` if it is not of this class.
   */
  readonly describe: (
    value: FabricValue,
    path: readonly FabricValue[],
  ) => ValueDescriptor | undefined;

  readonly make: (payload: ValueDescriptor) => FabricValue;
}

/**
 * Returns the notation for instances of `cls`, under the descriptor key `key`.
 * `describeInstance` returns the payload a descriptor holds under that key,
 * describing each value the instance holds with the `describeHeld` it is
 * passed, and `makeInstance` returns the instance a payload describes.
 */
function notate<Class extends abstract new (...args: never) => object>(
  cls: Class,
  key: string,
  describeInstance: (
    value: InstanceType<Class>,
    describeHeld: (held: FabricValue) => ValueDescriptor,
  ) => ValueDescriptor,
  makeInstance: (payload: ValueDescriptor) => InstanceType<Class>,
): ClassNotation<Class> {
  return {
    cls,
    key,
    describe: (value, path) =>
      isInstanceOf(cls, value)
        ? {
          [key]: describeInstance(value, (held) => describe(held, path)),
        }
        : undefined,
    make: makeInstance,
  };
}

/** Indicates whether `value` is an instance of `cls`. */
function isInstanceOf<Class extends abstract new (...args: never) => object>(
  cls: Class,
  value: unknown,
): value is InstanceType<Class> {
  return value instanceof cls;
}

/**
 * The notation for every concrete class, keyed the way the two class tables
 * key the classes. Its type is what holds it complete.
 */
const CLASS_NOTATIONS:
  & {
    readonly [Name in keyof FabricPrimitiveClassesByName]: ClassNotation<
      FabricPrimitiveClassesByName[Name]
    >;
  }
  & {
    readonly [Name in keyof FabricInstanceClassesByName]: ClassNotation<
      FabricInstanceClassesByName[Name]
    >;
  } = {
    FabricBytes: notate(
      FabricBytes,
      "Bytes",
      (value) => hexOf(value.slice()),
      (payload) => new FabricBytes(bytesOf(payload)),
    ),
    FabricDurationDay: notate(
      FabricDurationDay,
      "DurationDay",
      (value) => value.value.toString(),
      (payload) => new FabricDurationDay(BigInt(stringOf(payload))),
    ),
    FabricDurationNsec: notate(
      FabricDurationNsec,
      "DurationNsec",
      (value) => value.value.toString(),
      (payload) => new FabricDurationNsec(BigInt(stringOf(payload))),
    ),
    FabricEpochDay: notate(
      FabricEpochDay,
      "EpochDay",
      (value) => value.value.toString(),
      (payload) => new FabricEpochDay(BigInt(stringOf(payload))),
    ),
    FabricEpochNsec: notate(
      FabricEpochNsec,
      "EpochNsec",
      (value) => value.value.toString(),
      (payload) => new FabricEpochNsec(BigInt(stringOf(payload))),
    ),
    FabricHash: notate(
      FabricHash,
      "Hash",
      (value) => ({
        tag: stringDescriptorOf(value.tag),
        hash: hexOf(value.bytes),
      }),
      (payload) => {
        const fields = fieldsOf(payload);
        return new FabricHash(
          bytesOf(fieldOf(fields, "hash")),
          stringOf(fieldOf(fields, "tag")),
        );
      },
    ),
    FabricKeyPair: notate(
      FabricKeyPair,
      "KeyPair",
      (value) => {
        if (!value.hasMaterial) {
          throw new Error(
            "No descriptor for a key pair holding `CryptoKey` handles.",
          );
        }
        return {
          algorithm: stringDescriptorOf(value.algorithm),
          publicKey: hexOf(value.publicKeyBytes.slice()),
          privateKey: hexOf(value.privateKeyBytes.slice()),
        };
      },
      (payload) => {
        const fields = fieldsOf(payload);
        return new FabricKeyPair(
          stringOf(fieldOf(fields, "algorithm")),
          bytesOf(fieldOf(fields, "publicKey")),
          bytesOf(fieldOf(fields, "privateKey")),
        );
      },
    ),
    FabricRegExp: notate(
      FabricRegExp,
      "RegExp",
      (value) => ({
        flavor: stringDescriptorOf(value.flavor),
        source: stringDescriptorOf(value.source),
        flags: stringDescriptorOf(value.flags),
      }),
      (payload) => {
        const fields = fieldsOf(payload);
        return new FabricRegExp(
          stringOf(fieldOf(fields, "flavor")),
          stringOf(fieldOf(fields, "source")),
          stringOf(fieldOf(fields, "flags")),
        );
      },
    ),
    FabricUnavailable: notate(
      FabricUnavailable,
      "Unavailable",
      (value) => ({
        reason: value.reason,
        ...(value.errorKind === null ? {} : { errorKind: value.errorKind }),
        ...(value.rawErrorMessage === null
          ? {}
          : { errorMessage: stringDescriptorOf(value.rawErrorMessage) }),
      }),
      (payload) => {
        const fields = fieldsOf(payload);
        const reasonName = stringOf(fieldOf(fields, "reason"));
        const reason = Object.values(UNAVAILABLE_REASONS).find((r) =>
          r === reasonName
        );
        if (reason === undefined) {
          throw new Error(`Not an unavailable reason: ${reasonName}`);
        }
        const kindName = fields.errorKind;
        const errorKind = (kindName === undefined)
          ? null
          : Object.values(UNAVAILABLE_ERROR_KINDS).find((k) =>
            k === stringOf(kindName)
          );
        if (errorKind === undefined) {
          throw new Error(`Not an error kind: ${JSON.stringify(kindName)}`);
        }
        const message = fields.errorMessage;
        return new FabricUnavailable(
          reason,
          errorKind,
          (message === undefined) ? null : stringOf(message),
        );
      },
    ),
    FabricError: notate(
      FabricError,
      "Error",
      (value, describeHeld) => ({
        type: stringDescriptorOf(value.type),
        name: stringDescriptorOf(value.name),
        message: stringDescriptorOf(value.message),
        ...(value.stack === undefined
          ? {}
          : { stack: stringDescriptorOf(value.stack) }),
        ...(value.cause === undefined
          ? {}
          : { cause: describeHeld(value.cause) }),
        extras: [...value.extraEntries()]
          .sort(([a], [b]) => utf8Compare(a, b))
          .map(([key, extra]) => [
            stringDescriptorOf(key),
            describeHeld(extra),
          ]),
      }),
      (payload) => {
        const fields = fieldsOf(payload);
        const { stack, cause } = fields;
        return new FabricError({
          type: stringOf(fieldOf(fields, "type")),
          name: stringOf(fieldOf(fields, "name")),
          message: stringOf(fieldOf(fields, "message")),
          stack: (stack === undefined) ? undefined : stringOf(stack),
          cause: (cause === undefined)
            ? undefined
            : fabricValueOfDescriptor(cause),
          extras: listOf(fieldOf(fields, "extras")).map((pair) => {
            const [key, extra] = pairOf(pair);
            return [stringOf(key), fabricValueOfDescriptor(extra)] as const;
          }),
        });
      },
    ),
    FabricLink: notate(
      FabricLink,
      "Link",
      (value, describeHeld) => describeHeld(value.payload),
      (payload) => {
        const linkPayload = fabricValueOfDescriptor(payload);
        if (!isFabricPlainObject(linkPayload)) {
          throw new Error("A link's payload must be a record.");
        }
        return new FabricLink(linkPayload);
      },
    ),
    FabricMap: notate(
      FabricMap,
      "Map",
      (value, describeHeld) =>
        [...value.map].map(([key, entry]) => [
          describeHeld(key),
          describeHeld(entry),
        ]),
      (payload) =>
        new FabricMap(
          new Map(
            listOf(payload).map((pair) => {
              const [key, entry] = pairOf(pair);
              return [
                fabricValueOfDescriptor(key),
                fabricValueOfDescriptor(entry),
              ];
            }),
          ),
        ),
    ),
    FabricSet: notate(
      FabricSet,
      "Set",
      (value, describeHeld) => [...value.set].map(describeHeld),
      (payload) =>
        new FabricSet(
          new Set(listOf(payload).map(fabricValueOfDescriptor)),
        ),
    ),
    ProblematicValue: notate(
      ProblematicValue,
      "Problematic",
      (value, describeHeld) => ({
        tag: stringDescriptorOf(value.wireTypeTag),
        state: describeHeld(value.state),
        error: stringDescriptorOf(value.error),
      }),
      (payload) => {
        const fields = fieldsOf(payload);
        return new ProblematicValue(
          stringOf(fieldOf(fields, "tag")),
          fabricValueOfDescriptor(fieldOf(fields, "state")),
          stringOf(fieldOf(fields, "error")),
        );
      },
    ),
    UnknownValue: notate(
      UnknownValue,
      "Unknown",
      (value, describeHeld) => ({
        tag: value.wireTypeTag,
        state: describeHeld(value.state),
      }),
      (payload) => {
        const fields = fieldsOf(payload);
        return new UnknownValue(
          stringOf(fieldOf(fields, "tag")),
          fabricValueOfDescriptor(fieldOf(fields, "state")),
        );
      },
    ),
  };

/**
 * Returns the descriptor of a string: the string itself when it is well
 * formed, and its UTF-16 code units when it holds a lone surrogate, which not
 * every JSON reader keeps.
 */
function stringDescriptorOf(value: string): ValueDescriptor {
  return value.isWellFormed()
    ? value
    : { utf16: Array.from(value, (_, i) => value.charCodeAt(i)) };
}

/**
 * Returns the entries of an array's descriptor, holes as maximal runs, where
 * `path` holds what encloses the array and the array itself.
 */
function arrayEntriesOf(
  value: readonly FabricValue[],
  path: readonly FabricValue[],
): ValueDescriptor[] {
  const entries: ValueDescriptor[] = [];
  let index = 0;
  while (index < value.length) {
    if (index in value) {
      entries.push(describe(value[index], path));
      index++;
    } else {
      let count = 0;
      for (; index < value.length && !(index in value); index++) {
        count++;
      }
      entries.push({ hole: count });
    }
  }
  return entries;
}

/**
 * Returns the entries of a record's descriptor, in UTF-8 order of key, where
 * `path` holds what encloses the record and the record itself.
 */
function recordEntriesOf(
  value: { readonly [key: string]: FabricValue },
  path: readonly FabricValue[],
): ValueDescriptor[] {
  return Object.keys(value).sort(utf8Compare).map((key) => [
    stringDescriptorOf(key),
    describe(value[key], path),
  ]);
}

/**
 * Returns the array an array descriptor's payload describes, where `building`
 * holds what is being made around it.
 */
function arrayOf(
  payload: ValueDescriptor,
  building: FabricValue[],
): FabricValue[] {
  const result: FabricValue[] = [];
  building.push(result);
  let index = 0;
  for (const entry of listOf(payload)) {
    const hole = holeCountOf(entry);
    if (hole === undefined) {
      result[index] = make(entry, building);
      index++;
    } else {
      index += hole;
    }
  }
  building.pop();
  result.length = index;
  return result;
}

/**
 * Returns the record a record descriptor's payload describes, where `building`
 * holds what is being made around it.
 */
function recordOf(
  payload: ValueDescriptor,
  building: FabricValue[],
): FabricValue {
  const result: { [key: string]: FabricValue } = {};
  building.push(result);
  for (const pair of listOf(payload)) {
    const [key, value] = pairOf(pair);
    // Defined rather than assigned, so that a key such as `__proto__` is an
    // own property rather than a write to the prototype.
    Object.defineProperty(result, stringOf(key), {
      value: make(value, building),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  building.pop();
  return result;
}

/**
 * Returns the count of a `hole` entry, or `undefined` for any other entry.
 *
 * @throws If a `hole` entry's count is not an integer of at least one, the
 *   least run the wire format writes.
 */
function holeCountOf(entry: ValueDescriptor): number | undefined {
  if (entry === null || typeof entry !== "object" || isList(entry)) {
    return undefined;
  }
  const [kind, count] = soleEntryOf(entry);
  if (kind !== "hole") {
    return undefined;
  } else if (
    !(typeof count === "number" && Number.isSafeInteger(count) && count >= 1)
  ) {
    throw new Error(`Not a hole count: ${JSON.stringify(count)}`);
  }
  return count;
}

/** Returns the string a string descriptor describes. */
function stringOf(descriptor: ValueDescriptor): string {
  if (typeof descriptor === "string") {
    return descriptor;
  }
  const [kind, units] = soleEntryOf(fieldsOf(descriptor));
  if (kind !== "utf16") {
    throw new Error(`Not a string descriptor: ${JSON.stringify(descriptor)}`);
  }
  return listOf(units).map((unit) => {
    if (typeof unit !== "number") {
      throw new Error(`Not a code unit: ${JSON.stringify(unit)}`);
    }
    return String.fromCharCode(unit);
  }).join("");
}

/** Returns the bytes a lowercase hexadecimal string descriptor describes. */
function bytesOf(descriptor: ValueDescriptor): Uint8Array {
  return bytesOfHex(stringOf(descriptor));
}

/**
 * Returns the bytes `hex` writes in lowercase hexadecimal.
 *
 * @throws If `hex` is not lowercase hexadecimal, two digits to a byte.
 */
export function bytesOfHex(hex: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/.test(hex)) {
    throw new Error(`Not lowercase hexadecimal bytes: ${hex}`);
  }
  return Uint8Array.from(
    { length: hex.length / 2 },
    (_, i) => parseInt(hex.slice(i * 2, i * 2 + 2), 16),
  );
}

/** Returns `bytes` as lowercase hexadecimal. */
export function hexOf(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** Returns `descriptor` as a list, throwing if it is not one. */
function listOf(descriptor: ValueDescriptor): readonly ValueDescriptor[] {
  if (!isList(descriptor)) {
    throw new Error(`Not a list: ${JSON.stringify(descriptor)}`);
  }
  return descriptor;
}

/**
 * Indicates whether `descriptor` is a list. `Array.isArray()` narrows to a
 * mutable array, which leaves a read-only one in the other branch.
 */
function isList(
  descriptor: ValueDescriptor,
): descriptor is readonly ValueDescriptor[] {
  return Array.isArray(descriptor);
}

/** Returns `descriptor` as a two-element list, throwing if it is not one. */
function pairOf(
  descriptor: ValueDescriptor,
): readonly [ValueDescriptor, ValueDescriptor] {
  const [first, second, ...rest] = listOf(descriptor);
  if (first === undefined || second === undefined || rest.length > 0) {
    throw new Error(`Not a pair: ${JSON.stringify(descriptor)}`);
  }
  return [first, second];
}

/** Returns `descriptor` as a JSON object, throwing if it is not one. */
function fieldsOf(
  descriptor: ValueDescriptor,
): { readonly [key: string]: ValueDescriptor } {
  if (
    descriptor === null || typeof descriptor !== "object" || isList(descriptor)
  ) {
    throw new Error(`Not an object: ${JSON.stringify(descriptor)}`);
  }
  return descriptor;
}

/** Returns the field `key` of `fields`, throwing if it is absent. */
function fieldOf(
  fields: { readonly [key: string]: ValueDescriptor },
  key: string,
): ValueDescriptor {
  const field = fields[key];
  if (field === undefined) {
    throw new Error(`No field \`${key}\` in ${JSON.stringify(fields)}`);
  }
  return field;
}

/** Returns the one key and value of `descriptor`, throwing unless one. */
function soleEntryOf(
  descriptor: ValueDescriptor,
): readonly [string, ValueDescriptor] {
  const entries = Object.entries(fieldsOf(descriptor));
  const [entry] = entries;
  if (entry === undefined || entries.length > 1) {
    throw new Error(`Not a single-key object: ${JSON.stringify(descriptor)}`);
  }
  return entry;
}
