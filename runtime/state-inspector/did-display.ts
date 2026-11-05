// Turning a DID into something a person can read in a terminal or a table.

import { parseDID } from "@commonfabric/identity/did";

/**
 * The method-specific identifier of a DID — what `did:key:` or `did:web:`
 * introduces. A string that is not a DID comes back whole, which is what the
 * display paths want: they are handed principals, space ids and entity ids
 * alike, and only some of those are DIDs.
 *
 * A DID naming no identifier — `did:` and `did:key` are both DIDs — comes back
 * whole for the same reason. Its identifier is the empty string, and a label
 * showing nothing at all says less about which principal it stands for than
 * the DID does.
 */
export function didTail(did: string): string {
  const id = parseDID(did)?.id;
  return id === undefined || id === "" ? did : id;
}

/**
 * A DID as a short label: its method-specific identifier, keeping `head`
 * characters from the front and `tail` from the back and eliding the middle
 * once the identifier runs more than two characters past what those keep.
 */
export function shortDid(did: string, head = 6, tail = 4): string {
  const id = didTail(did);
  return id.length > head + tail + 2
    ? `${id.slice(0, head)}…${id.slice(-tail)}`
    : id;
}
