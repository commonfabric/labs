/**
 * Placement of spaces a Mode A directory does not list. Its optional
 * `unlisted` rule assigns such a DID to a toolshed by the DID's last
 * character, as the nginx per-process table does, so a space can be created
 * without first being listed. The router and every toolshed apply the same
 * rule; changing it moves every space it placed, so it stays fixed for a
 * deployment's lifetime.
 */
import { routedObject } from "./routed-parser.ts";
import { requireRouted } from "./routed-wire.ts";

/** The base58btc alphabet: the characters an Ed25519 `did:key` can end with. */
export const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** The directory's rule for DIDs its `spaces` map does not list. */
export interface UnlistedPlacement {
  /** The owning epoch of every space the rule places. */
  epoch: number;
  /** The toolshed index for each possible last character. */
  lastCharacter: ReadonlyMap<string, number>;
}

/**
 * Validates a directory's `unlisted` value, which must name a toolshed below
 * `toolsheds` for every base58btc character and a positive epoch. An absent
 * or null value means the directory places only the spaces it lists.
 */
export function parseUnlistedPlacement(
  value: unknown,
  toolsheds: number,
): UnlistedPlacement | undefined {
  if (value === undefined || value === null) return undefined;
  const rule = routedObject(value);
  requireRouted(Object.keys(rule).sort().join(",") === "epoch,last_character");
  requireRouted(
    typeof rule.epoch === "number" && Number.isSafeInteger(rule.epoch) &&
      rule.epoch > 0,
  );
  const table = routedObject(rule.last_character);
  requireRouted(Object.keys(table).length === BASE58_ALPHABET.length);
  const lastCharacter = new Map<string, number>();
  for (const character of BASE58_ALPHABET) {
    const index = table[character];
    requireRouted(
      typeof index === "number" && Number.isSafeInteger(index) && index >= 0 &&
        index < toolsheds,
    );
    lastCharacter.set(character, index);
  }
  return { epoch: rule.epoch, lastCharacter };
}

/**
 * The toolshed index `rule` assigns `did`, which the caller has validated as
 * a canonical DID: this reads only its last character.
 */
export function unlistedToolshed(
  rule: UnlistedPlacement,
  did: string,
): number | undefined {
  return rule.lastCharacter.get(did.at(-1) ?? "");
}
