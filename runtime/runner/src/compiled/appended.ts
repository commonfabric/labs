/**
 * Whether an array a handler put in the place of a stored array is the
 * stored one with members added behind its last, and whether a splice the
 * executor made of a stored array added members behind its last.
 */
import { type FabricValue, valueEqual } from "@commonfabric/data-model";

/**
 * Returns the splice that makes `stored`, what the storage holds at a path,
 * into `next`, what the executor holds there now, where `next` is an array
 * that begins with the members of the array `stored`, or `stored` is
 * absent, and has more: the
 * position of the first added member, and how many were added. Returns
 * `undefined` for anything else. `encode` gives a member of `next` as the
 * storage holds one. The comparison reads every member the two share.
 */
export const appendedBehind = (
  stored: unknown,
  next: unknown,
  encode: (member: unknown) => FabricValue,
): { start: number; removed: number; inserted: number } | undefined => {
  stored ??= [];
  if (
    !Array.isArray(stored) || !Array.isArray(next) ||
    next.length <= stored.length
  ) return undefined;
  for (let index = 0; index < stored.length; index++) {
    if (!valueEqual(stored[index], encode(next[index]))) return undefined;
  }
  return {
    start: stored.length,
    removed: 0,
    inserted: next.length - stored.length,
  };
};

/**
 * Returns `made`, the splice the executor made of a stored array that now
 * has `length` members, where it added members behind the last one and
 * removed none, and `undefined` for any other splice and for none. The
 * executor splices a stored array where a handler pushes to it, so no
 * member is compared.
 */
export const appendedBySplice = (
  made: { start: number; removed: number; inserted: number } | undefined,
  length: number,
): { start: number; removed: number; inserted: number } | undefined =>
  made !== undefined && made.removed === 0 && made.inserted > 0 &&
    made.start + made.inserted === length
    ? made
    : undefined;
