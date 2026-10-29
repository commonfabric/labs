/**
 * The text a delegation chain travels in between processes: what `cf
 * delegation issue` writes, and what a runtime holding chains from a file
 * reads. The format is this repository's own, a JSON object naming itself
 * and listing chains, each a list of delegations' envelope bytes root first
 * in base64url; the delegations inside are UCAN envelopes as
 * `delegation.ts` encodes them, so the text adds nothing a holder has to
 * verify beyond the delegations themselves.
 */

import {
  fromBase64url,
  toUnpaddedBase64url,
} from "@commonfabric/utils/base64url";
import { isObjectNotArray } from "@commonfabric/utils/types";

import { DelegationError } from "./delegation.ts";

/**
 * What a chain file names itself, in its `format` field. A name rather than
 * a version: a reader tolerates fields it does not know, and a change it
 * could not tolerate would be another format under another name.
 */
export const DELEGATION_CHAIN_FORMAT = "commonfabric/delegation-chains";

/**
 * Encodes `chains`, each a list of delegations' bytes root first, as the
 * text {@link decodeDelegationChains} reads back. Encodes nothing about the
 * delegations: a chain is written as given, so one that would not verify is
 * written here and refused where it is held. No chains are an empty list.
 *
 * @throws A `DelegationError` for an empty chain, which no reader accepts.
 */
export function encodeDelegationChains(
  chains: readonly (readonly Uint8Array[])[],
): string {
  return JSON.stringify(
    {
      format: DELEGATION_CHAIN_FORMAT,
      chains: chains.map((chain, i) => {
        if (chain.length === 0) {
          throw new DelegationError(`chain ${i} is empty`);
        }
        return chain.map(toUnpaddedBase64url);
      }),
    },
    null,
    2,
  ) + "\n";
}

/**
 * Decodes the chains `text` holds, each a list of delegations' bytes root
 * first. Throws a `DelegationError` for text that is not what
 * {@link encodeDelegationChains} writes: anything but a JSON object naming
 * {@link DELEGATION_CHAIN_FORMAT} and listing non-empty lists of base64url
 * strings. The contract is that a text written as the encoder writes it
 * reads everywhere; a looser spelling, padded or with whitespace, reads
 * where the runtime's decoder admits it and is refused where it does not,
 * which is no loss, since nothing writes one. Decodes none of the
 * delegations; a holder decodes and verifies them.
 */
export function decodeDelegationChains(text: string): Uint8Array[][] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new DelegationError("the chain text is not JSON");
  }
  if (!isObjectNotArray(parsed)) {
    throw new DelegationError("the chain text is not a JSON object");
  }
  const { format, chains } = parsed;
  if (format !== DELEGATION_CHAIN_FORMAT) {
    throw new DelegationError(
      `the chain text names a format other than ${DELEGATION_CHAIN_FORMAT}`,
    );
  }
  if (!Array.isArray(chains)) {
    throw new DelegationError("the chain text lists no chains");
  }
  return chains.map((chain, i) => {
    if (!Array.isArray(chain) || chain.length === 0) {
      throw new DelegationError(`chain ${i} is not a non-empty list`);
    }
    return chain.map((link, j) => {
      if (typeof link !== "string") {
        throw new DelegationError(`chain ${i} link ${j} is not a string`);
      }
      try {
        return fromBase64url(link);
      } catch {
        throw new DelegationError(`chain ${i} link ${j} is not base64url`);
      }
    });
  });
}
