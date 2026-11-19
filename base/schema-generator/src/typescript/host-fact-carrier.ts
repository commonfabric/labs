/**
 * Recognizes the carrier `HostFact<T, K>` intersects its payload with: a
 * member holding the fact's key under `__ct_host_fact__` and nothing else
 * (`HostFact` in `base/api/index.ts`). The checker drops the alias's name where
 * it reduces the alias's type, and then the carrier is all that says a value
 * is a host fact.
 */

import type { MutableJSONSchema } from "@commonfabric/api";
import ts from "typescript";

/**
 * The member a host fact carrier holds. It is a phantom: no value holds it.
 */
export const HOST_FACT_CARRIER_PROPERTY = "__ct_host_fact__";

/**
 * The key of the host fact `member` carries, when `member`, a member of an
 * intersection, is a host fact carrier: the `__ct_host_fact__` member alone,
 * typed as one string literal. `resolve` reads a key written as a type
 * parameter as its argument where a reading binds it. `undefined` for any
 * other member.
 */
export const hostFactKey = (
  member: ts.Type,
  checker: ts.TypeChecker,
  resolve: (key: ts.Type) => ts.Type = (key) => key,
): string | undefined => {
  if (!isHostFactCarrier(member)) return undefined;
  // The member is optional, so its type holds `undefined` beside the key.
  const declared = resolve(
    checker.getNonNullableType(
      checker.getTypeOfSymbol(member.getProperties()[0]!),
    ),
  );
  return declared.isStringLiteral() ? declared.value : undefined;
};

/**
 * Whether `member`, a member of an intersection, is a host fact carrier: the
 * `__ct_host_fact__` member alone, whatever its key reads as. It holds no part
 * of the value.
 */
export const isHostFactCarrier = (member: ts.Type): boolean => {
  if ((member.flags & ts.TypeFlags.Object) === 0) return false;
  const properties = member.getProperties();
  return properties.length === 1 &&
    properties[0]!.name === HOST_FACT_CARRIER_PROPERTY;
};

/**
 * The error for a value marked as two different host facts, `keys`: a host
 * fills a value from one fact.
 */
export function hostFactKeysError(keys: readonly string[]): Error {
  return new Error(
    `A value is marked as the host fact \`${keys[0]}\` and as the host ` +
      `fact \`${keys[1]}\`. A host fills a value from one fact, so mark it ` +
      `with one \`HostFact\`.`,
  );
}

/**
 * The host fact the intersection `type` carries, and the members that hold
 * its value, which are the rest: `undefined` for a type that carries none.
 * `resolve` is as `hostFactKey()` takes it. Throws where its members carry
 * two different facts.
 */
export const hostFactCarried = (
  type: ts.Type,
  checker: ts.TypeChecker,
  resolve?: (key: ts.Type) => ts.Type,
): { key: string; payload: readonly ts.Type[] } | undefined => {
  if (!type.isIntersection()) return undefined;
  const keys = new Set<string>();
  const payload: ts.Type[] = [];
  for (const member of type.types) {
    const key = hostFactKey(member, checker, resolve);
    if (key === undefined) payload.push(member);
    else keys.add(key);
  }
  if (keys.size > 1) throw hostFactKeysError([...keys]);
  const [key] = keys;
  return key === undefined ? undefined : { key, payload };
};

/**
 * `schema` marked as filled from the host fact `key`: the `hostFact` keyword
 * beside what `schema` says of the value. A schema that accepts nothing stays
 * as it is.
 */
export function withHostFact(
  schema: MutableJSONSchema,
  key: string,
): MutableJSONSchema {
  if (schema === false) return schema;
  return schema === true ? { hostFact: key } : { ...schema, hostFact: key };
}
