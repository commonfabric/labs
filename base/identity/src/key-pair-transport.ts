import type { RealmEncodedValue } from "@commonfabric/data-model/codec-realm";
import {
  fabricFromRealmValue,
  realmFromFabricValue,
} from "@commonfabric/data-model/codecs";
import { FabricKeyPair } from "@commonfabric/data-model/fabric-primitives";

/**
 * Encodes a key pair for a realm crossing. This is the format a key pair
 * travels in wherever the transport is structured cloning: the other formats
 * write bytes down, and a pair holding handles has none to write.
 */
export function realmValueFromKeyPair(
  keyPair: FabricKeyPair,
): RealmEncodedValue {
  return realmFromFabricValue(keyPair);
}

/**
 * Decodes what {@link realmValueFromKeyPair} produced. `encoded` is ceded to
 * the decode rather than copied for it, per the format's own contract, so a
 * caller must not use it afterwards.
 *
 * `what` names the carrier, and reaches only the not-a-key-pair error: a
 * malformed encoding is the codec's own to report, and it throws before this
 * has anything to add.
 *
 * @throws If `encoded` is not a well-formed encoding, or if it decodes to
 *   anything but a key pair.
 */
export function keyPairFromRealmValue(
  encoded: RealmEncodedValue,
  what: string,
): FabricKeyPair {
  const decoded = fabricFromRealmValue(encoded);

  if (!(decoded instanceof FabricKeyPair)) {
    throw new Error(`${what} is not a key pair.`);
  }

  return decoded;
}
