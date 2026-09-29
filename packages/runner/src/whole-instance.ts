import {
  FabricInstance,
  FabricPrimitive,
  isDeepFrozen,
  isValidFabricValue,
  isValidFabricValueLayer,
} from "@commonfabric/data-model";
import { isLinkRef } from "@commonfabric/data-model/cell-rep";
import {
  codecOf,
  NULL_LIVE_ENVIRONMENT,
} from "@commonfabric/data-model/codec-common";
import { FabricLink } from "@commonfabric/data-model/fabric-instances";
import { isObjectOrArray } from "@commonfabric/utils/types";

/**
 * Whether a walk that maps the links and cells in a value, and cannot descend
 * a `FabricInstance`, may carry `instance` whole: it is deep-frozen, and its
 * codec contents, descended at every depth, hold nothing but fabric data --
 * valid `FabricValue`s, none of them a link. Such an instance holds nothing
 * the walk would have mapped, so carrying it loses nothing.
 *
 * A link in either representation counts, a `FabricLink` whatever the active
 * regime, and `instance` itself being one returns `false`. Deep-frozen is what
 * rules out a query-result view inside: a view over a record has the shape of
 * a plain object, and is never frozen. The contents are read by encoding each
 * instance the walk reaches, which is the snapshot its codec gives, so the
 * answer is about the instance as it stands, and holds for as long as it
 * stays deep-frozen, which is for good.
 *
 * @throws What a class throws whose freeze protocol or codec is not yet
 *   implemented, rather than an answer about contents nothing can read.
 */
export function canCarryFabricInstanceWhole(
  instance: FabricInstance,
): boolean {
  if (!isDeepFrozen(instance)) return false;

  // A container reached twice is data either way, and a cycle closes on one
  // already being checked, so each is checked once.
  const visited = new Set<object>();
  const holdsOnlyData = (value: unknown): boolean => {
    if (!isObjectOrArray(value)) return isValidFabricValue(value);
    if (value instanceof FabricPrimitive) return true;
    if (value instanceof FabricLink || isLinkRef(value)) return false;
    if (visited.has(value)) return true;
    visited.add(value);

    if (value instanceof FabricInstance) {
      return holdsOnlyData(codecOf(value).encode(value, NULL_LIVE_ENVIRONMENT));
    }

    return isValidFabricValueLayer(value) &&
      Object.values(value).every(holdsOnlyData);
  };

  return holdsOnlyData(instance);
}
