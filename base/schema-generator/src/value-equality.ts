import { type FabricValue, hashStringOf } from "@commonfabric/data-model";

/**
 * Deduplicate `items` by value-model equality, keeping the first of each equal
 * group, in order.
 *
 * Equality is decided by canonical content hash (`hashStringOf`) rather than
 * pairwise comparison: the hash IS the value model's identity — `valueEqual`'s
 * own object path compares `hashStringOf(a) === hashStringOf(b)` — so grouping
 * by hash string in a `Set` yields the same result as O(N²) pairwise
 * `valueEqual`, hashing each item just once within this call instead.
 *
 * That "once" is per call, not per generation: these schemas are still mutable
 * when deduped, and `value-hash`'s object-hash cache is keyed on deep-frozen
 * identity, so each hash is computed fresh, and content nested in an item is
 * hashed again whenever an enclosing schema is hashed at an outer step. That is
 * inherent to hashing a mutable tree and is immaterial at the sizes here (a
 * union's members, an enum's values); if these values were deep-frozen the
 * cache would remove the repeat work.
 *
 * This is the honest comparison for schema and enum values, where a
 * `JSON.stringify` key or a `Set` of the values is not: stringify renders `NaN`
 * and `±Infinity` as `null` and drops the sign of `-0` (distinct values
 * collide), and is key-order sensitive (equal values do not collide); a `Set`
 * uses SameValueZero, which conflates `-0` with `0`. The content hash makes the
 * value model's distinctions -- `-0` ≠ `0`, `NaN` = `NaN`, key-order-independent
 * -- exactly.
 */
export function dedupeByValueEqual<T extends FabricValue>(
  items: readonly T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const hash = hashStringOf(item);
    if (!seen.has(hash)) {
      seen.add(hash);
      out.push(item);
    }
  }
  return out;
}
