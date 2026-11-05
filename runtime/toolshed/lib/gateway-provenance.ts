// What caused the requests toolshed sends to the LLM gateway.
//
// The gateway attributes spend by the `x-cf-harness-*` headers a caller sends.
// It copies them into its access log and then removes them from the request,
// so a model vendor sees none of them. Both steps work from an explicit list
// of header names, which is why the fields here are the ones
// `@commonfabric/cf-harness/provenance` already defines: a name outside that
// list reaches the vendor and appears in no log.
//
// Only requests to the gateway carry these values. The other providers in
// `routes/ai/llm/models.ts` address a vendor's own API, with nothing in front
// of it to strip a header, so they carry none of this.

import { AsyncLocalStorage } from "@node/async_hooks";
import {
  detectProvenance,
  type EnvReader,
  type HarnessProvenance,
  processEnv,
  provenanceHeaders,
  provenanceUserAgent,
} from "@commonfabric/cf-harness/provenance";
import env from "@/env.ts";

/**
 * What toolshed was doing when it called the gateway, reported as the
 * provenance `command`. Three of these name a route toolshed serves and the
 * fourth names the model list it asks for as it starts up. Every one of them
 * is written here, so nothing a request carries — a prompt, a message, a tool
 * argument, a piece of metadata — can reach the header.
 */
export type GatewayOperation =
  | "generate-text"
  | "generate-object"
  | "list-models"
  | "web-search";

/** The program the gateway's access log records toolshed's requests under. */
const PRODUCT = "toolshed";

/**
 * The environment provenance is read from. `OTEL_SERVICE_NAME` comes from the
 * parsed configuration rather than the raw environment, so the service is
 * named even where the variable is unset and `env.ts` supplied the default.
 */
const provenanceEnv: EnvReader = (name) =>
  name === "OTEL_SERVICE_NAME" ? env.OTEL_SERVICE_NAME : processEnv(name);

/** One process reports one provenance, so it is resolved once and shared. */
let processProvenance: HarnessProvenance | undefined;

const currentOperation = new AsyncLocalStorage<GatewayOperation>();

/**
 * Reports `operation` as the command on the gateway requests `body` makes,
 * including the ones it makes after awaiting. A request made from a callback
 * the runtime invokes later — a stream pulled by whoever is reading it, after
 * `body` has returned — runs outside this and reports no command.
 */
export function withGatewayOperation<T>(
  operation: GatewayOperation,
  body: () => T,
): T {
  return currentOperation.run(operation, body);
}

/**
 * The headers a gateway request carries. `operation` names what the request is
 * for; without one, the operation from the surrounding
 * {@link withGatewayOperation} is used.
 */
export function gatewayProvenanceHeaders(
  operation?: GatewayOperation,
): Record<string, string> {
  processProvenance ??= detectProvenance({ env: provenanceEnv });
  const command = operation ?? currentOperation.getStore();
  const provenance = command === undefined
    ? processProvenance
    : { ...processProvenance, command };
  return {
    "User-Agent": provenanceUserAgent(provenance, PRODUCT),
    ...provenanceHeaders(provenance),
  };
}

/**
 * Wraps a fetch so every request it sends carries provenance. The values are
 * resolved per request, so each one reports the operation in hand when it was
 * made. Headers already on the request are kept, apart from the ones
 * provenance sets: the AI SDK sends a User-Agent naming itself, and that is
 * the one the access log would otherwise record.
 *
 * Which headers those are follows what `fetch` itself would use. An `init`
 * that names headers replaces whatever a `Request` argument carried, so the
 * headers on the request are read only where the caller passed a `Request` and
 * left `init` silent about them. Silent means absent: an `init` naming
 * something that is no header list, `null` among them, reaches `Headers` and
 * is refused there, which is what `fetch` does with it too.
 *
 * The parameter types are written out because `typeof fetch` is not stable
 * here: with `@types/node`'s globals in the type graph, its `init` becomes a
 * union of two `RequestInit` declarations, and `headers` cannot be read from
 * that union.
 */
export function withGatewayProvenance(inner: typeof fetch): typeof fetch {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(
      init?.headers !== undefined
        ? init.headers
        : (input instanceof Request ? input.headers : undefined),
    );
    for (const [name, value] of Object.entries(gatewayProvenanceHeaders())) {
      headers.set(name, value);
    }
    return inner(input, { ...init, headers });
  };
}
