/**
 * Requests `cf` signs as the person (`CF1`,
 * `@commonfabric/runner/toolshed-http-auth`), in one place. `firstPartySigner`
 * only signs; `cf inspect --remote` uses it when an identity is configured and
 * otherwise sends its request unsigned, as it always has. `signedFetch`
 * (`cf fetch`) and `cf id pair` add two rules:
 *
 * - **Cleartext only on this machine.** A signed request, or a redeem that
 *   answers with a key, goes over `https:`, or `http:` to a loopback host.
 * - **No redirects followed.** `fetch` would carry the signature headers to
 *   whatever host a redirect names; a redirect is reported instead.
 */

import { ValidationError } from "@cliffy/command";
import { isLoopbackHostname } from "@commonfabric/platform/loopback";
import { signFirstPartyHttpRequest } from "@commonfabric/runner/toolshed-http-auth";
import { loadIdentity } from "./identity.ts";

/** A signed request a service refused or redirected: its words, never a stack. */
export class FirstPartyError extends Error {
  override name = "FirstPartyError";
}

/** Signs one request: the headers it carries. */
export type FirstPartySigner = (input: {
  url: string | URL;
  method: string;
  headers?: HeadersInit;
  body?: string | null;
}) => Promise<Headers>;

/** The signer for the keyfile at `path`. */
export async function firstPartySigner(
  path: string,
): Promise<FirstPartySigner> {
  const identity = await loadIdentity(path);
  return ({ url, method, headers, body }) =>
    signFirstPartyHttpRequest({
      url: new URL(url),
      method,
      headers,
      body: body ?? null,
      signer: identity,
    });
}

/**
 * `text` as a URL a signed request or a key may travel to, or a refusal that
 * says why not.
 */
export function firstPartyUrl(text: string): URL {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new ValidationError(`${text} is not a URL.`);
  }
  if (url.protocol === "https:") return url;
  if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) return url;
  throw new ValidationError(
    `${text} is not an https: URL; plain http: is only for this machine.`,
  );
}

/** `fetch`, refusing to follow a redirect anywhere. */
export async function fetchNoRedirect(
  url: URL,
  init: RequestInit,
  fetcher: typeof globalThis.fetch = fetch,
): Promise<Response> {
  const response = await fetcher(url, { ...init, redirect: "manual" });
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new FirstPartyError(
      `${url.origin} answered with a redirect (${response.status}` +
        `${
          response.headers.get("location")
            ? ` to ${response.headers.get("location")}`
            : ""
        }); cf does not follow one with a signed request. Use the address ` +
        "it names.",
    );
  }
  return response;
}

export interface SignedFetchOptions {
  url: string;
  method: string;
  /** The body, sent as JSON; none for GET and HEAD. */
  body?: string;
  identity: string;
  fetch?: typeof globalThis.fetch;
}

/** The answer, as text, or the refusal: a status outside 2xx throws with the body. */
export async function signedFetch(
  options: SignedFetchOptions,
): Promise<string> {
  const method = options.method.toUpperCase();
  const url = firstPartyUrl(options.url);
  const bodyless = method === "GET" || method === "HEAD";
  if (bodyless && options.body !== undefined) {
    throw new ValidationError(`A ${method} request carries no body.`);
  }
  const sign = await firstPartySigner(options.identity);
  const headers = await sign({
    url,
    method,
    headers: bodyless ? {} : { "Content-Type": "application/json" },
    body: options.body,
  });
  const response = await fetchNoRedirect(url, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  }, options.fetch);
  const text = await response.text();
  if (!response.ok) {
    throw new FirstPartyError(
      `${response.status} ${response.statusText}: ${text}`,
    );
  }
  return text;
}
