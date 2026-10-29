import type { PlaidError } from "plaid";
import { isObjectNotArray } from "@commonfabric/utils/types";

/**
 * The Plaid error document carried by a failed SDK call, or `undefined` when
 * the thrown value carries none.
 *
 * The SDK rejects with an axios error whose `response.data` holds the document.
 * Anything else reaching a handler's `catch` carries no such document: a
 * `TypeError` raised by the handler's own code, or a transport failure that
 * never produced a response. A caller getting `undefined` has nothing more
 * specific to report than the thrown value's own message.
 */
export const plaidErrorFrom = (error: unknown): PlaidError | undefined => {
  if (!isObjectNotArray(error)) return undefined;
  const response = error.response;
  if (!isObjectNotArray(response)) return undefined;
  const data = response.data;
  return data ? data as PlaidError : undefined;
};
