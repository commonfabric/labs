/**
 * Recognizes a writer policy from a type alone: a CFC metadata carrier whose
 * metadata holds a `writeAuthorizedBy` or a `writePolicyAnyOf`. Only a
 * `typeof` node names a writer, so a type says that a value carries one but
 * never which.
 */

import ts from "typescript";

import {
  carrierStamps,
  cfcCarrierProperty,
  memberValueType,
} from "./cfc-carrier.ts";
import { isCellType } from "./cell-brand.ts";

/**
 * The writer policy `metadata`, a CFC carrier's metadata type, holds, by the
 * alias that writes it: a `writeAuthorizedBy` or a `writePolicyAnyOf`, whose
 * writers only `typeof` nodes name, so no reading of the type alone mints
 * them. `undefined` for metadata holding neither.
 */
export const writerPolicyHeldBy = (
  metadata: ts.Type,
  checker: ts.TypeChecker,
): "WriteAuthorizedBy" | "WritePolicyAnyOf" | undefined => {
  const value = checker.getNonNullableType(metadata);
  return value.getProperty("writePolicyAnyOf")
    ? "WritePolicyAnyOf"
    : value.getProperty("writeAuthorizedBy")
    ? "WriteAuthorizedBy"
    : undefined;
};

/** A writer policy, by the alias that writes it (`writerPolicyHeldBy()`). */
type WriterPolicyAlias = NonNullable<ReturnType<typeof writerPolicyHeldBy>>;

/** The first alias `read` gives for `items`, read in order. */
const firstWriterPolicy = <T>(
  items: readonly T[],
  read: (item: T) => WriterPolicyAlias | undefined,
): WriterPolicyAlias | undefined => {
  for (const item of items) {
    const alias = read(item);
    if (alias !== undefined) return alias;
  }
  return undefined;
};

/**
 * The writer policy `carrier`, a CFC carrier's `__ct_cfc__` member, records
 * among the policies it records (`carrierStamps()`), by the alias that writes
 * it: the first one it records, or `undefined` where it records none.
 */
const recordedWriterPolicy = (
  carrier: ts.Symbol,
  checker: ts.TypeChecker,
): WriterPolicyAlias | undefined =>
  firstWriterPolicy(
    carrierStamps(
      memberValueType(carrier, checker.getTypeOfSymbol(carrier), checker),
      checker,
    ),
    (stamp) => writerPolicyHeldBy(stamp.meta, checker),
  );

/**
 * Whether `type` itself carries a writer policy: a member of an intersection
 * that is a CFC carrier holding one, read through unions and intersections
 * but not into the values the type holds.
 */
export const carriesWriterPolicy = (
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean =>
  type.isUnionOrIntersection() &&
  type.types.some((member) => {
    const carrier = cfcCarrierProperty(member);
    return carrier
      ? recordedWriterPolicy(carrier, checker) !== undefined
      : carriesWriterPolicy(member, checker);
  });

/**
 * How many object types a reading reads inside each other before it stops
 * (`readWriterPolicy()`). A recursion that instantiates its declaration
 * without end, as `Nest<T[]>` inside `Nest<T>` does, never returns to a type
 * it has read, so only a bound ends its reading: this one where it recurses
 * down one path. It is the depth at which the checker stops instantiating a
 * type inside itself, and far past what patterns write: no writer-policy
 * reading over the pattern corpus reads past nine deep.
 */
const MAX_READING_DEPTH = 100;

/**
 * How many types a reading reads in all before it stops: the bound that ends
 * a recursion without end that branches, which `MAX_READING_DEPTH` would let
 * read a number of types exponential in that depth. No writer-policy reading
 * over the pattern corpus reads seventy.
 */
const MAX_TYPES_READ = 10_000;

/**
 * What reading `type`, and the values it holds, finds of a writer policy: the
 * alias that writes the first one a part of it carries; `"unread"` where no
 * part read carries one, but the reading stopped at a bound before it read
 * all of it, so a part past the bound may; and `undefined` where the whole of
 * it was read and no part carries one.
 */
export type WriterPolicyReading = WriterPolicyAlias | "unread" | undefined;

/**
 * The writer policy `type`, or a value it holds, carries, by the alias that
 * writes it: the first a reading finds (`readWriterPolicy()`), or `undefined`
 * where it finds none, a reading stopped at a bound included.
 */
export const writerPolicyHeldWithin = (
  type: ts.Type,
  checker: ts.TypeChecker,
): WriterPolicyAlias | undefined => {
  const reading = readWriterPolicy(type, checker);
  return reading === "unread" ? undefined : reading;
};

/**
 * Whether `type`, or a value it holds, may carry a writer policy: one it holds
 * (`writerPolicyHeldWithin()`), or one past the bound a reading of it stopped
 * at (`readWriterPolicy()` is `"unread"`).
 */
export const holdsWriterPolicy = (
  type: ts.Type,
  checker: ts.TypeChecker,
): boolean => readWriterPolicy(type, checker) !== undefined;

/**
 * Reads the writer policies `type`, or a value it holds, carries: a member of
 * an intersection that is a CFC carrier holding one, read through unions,
 * intersections, object properties and index signatures, and array and tuple
 * elements. Each type is read once, which is what ends the reading of a
 * recursive type that returns to a type it has read; any other reading ends
 * at `MAX_READING_DEPTH` object types deep or `MAX_TYPES_READ` types read. A
 * function's signature holds no value, and is not read. Nor is a cell, a
 * stream or another reactive reference: it holds a link to a document of its
 * own, and a policy inside the type it links to is that document's. A policy
 * on the link itself, a carrier around the reference, is read as any
 * intersection member's is.
 */
export const readWriterPolicy = (
  type: ts.Type,
  checker: ts.TypeChecker,
): WriterPolicyReading => readWithin(type, checker, new Set(), 0);

/**
 * `readWriterPolicy()` for `type`, read inside `depth` object types, where
 * `seen` holds the types read already.
 */
const readWithin = (
  type: ts.Type,
  checker: ts.TypeChecker,
  seen: Set<ts.Type>,
  depth: number,
): WriterPolicyReading => {
  if (seen.has(type)) return undefined;
  if (seen.size >= MAX_TYPES_READ) return "unread";
  seen.add(type);
  if (type.isUnionOrIntersection()) {
    return readAll(type.types, (member) => {
      const carrier = cfcCarrierProperty(member);
      return carrier
        ? recordedWriterPolicy(carrier, checker)
        : readWithin(member, checker, seen, depth);
    });
  }
  if ((type.flags & ts.TypeFlags.Object) === 0) return undefined;
  if (type.getCallSignatures().length > 0) return undefined;
  if (isCellType(type, checker)) return undefined;
  if (depth >= MAX_READING_DEPTH) return "unread";
  const within = (inner: ts.Type) =>
    readWithin(inner, checker, seen, depth + 1);
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    return readAll(checker.getTypeArguments(type as ts.TypeReference), within);
  }
  const fromProperties = readAll(
    type.getProperties(),
    (property) => within(checker.getTypeOfSymbol(property)),
  );
  if (fromProperties !== undefined && fromProperties !== "unread") {
    return fromProperties;
  }
  return readAll(
    checker.getIndexInfosOfType(type),
    (info) => within(info.type),
  ) ??
    fromProperties;
};

/**
 * What reading each of `items` with `read`, in order, finds: the first alias
 * any reading gives, otherwise `"unread"` if any reading is. Each item is
 * read only once those before it have given no alias.
 */
const readAll = <T>(
  items: readonly T[],
  read: (item: T) => WriterPolicyReading,
): WriterPolicyReading => {
  let reading: WriterPolicyReading;
  for (const item of items) {
    const found = read(item);
    if (found !== undefined && found !== "unread") return found;
    reading ??= found;
  }
  return reading;
};
