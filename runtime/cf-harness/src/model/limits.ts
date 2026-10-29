/** Host model limits, inherited by every call through a bounded client. */
import type { HarnessModelClient, HarnessModelLimits } from "./client.ts";
import { OPENAI_COMPATIBLE_GATEWAY_PROVIDER_ID } from "./openai-compatible-gateway.ts";

export const assertHarnessModelLimits = (limits: HarnessModelLimits): void => {
  for (const [name, value] of Object.entries(limits)) {
    if (name !== "maxInputBytes" && name !== "maxOutputTokens") continue;
    const minimum = name === "maxOutputTokens" ? 16 : 1;
    if (
      value !== undefined && (typeof value !== "number" ||
        !Number.isSafeInteger(value) || value < minimum)
    ) {
      throw new Error(
        `${name} must be a safe whole number of ${minimum} or more`,
      );
    }
  }
};

/** The final wire body includes prompt, history, instructions and tool schemas. */
export const assertHarnessModelInputBound = (
  body: string,
  maximum: number | undefined,
): void => {
  if (
    maximum !== undefined && new TextEncoder().encode(body).byteLength > maximum
  ) {
    throw new Error(
      `model input exceeds maxInputBytes (${maximum}); fit the context before retrying`,
    );
  }
};

const narrower = (host: number | undefined, request: number | undefined) =>
  host === undefined
    ? request
    : request === undefined
    ? host
    : Math.min(host, request);

/**
 * A child retains its parent's limits even when it selects another model.
 *
 * @throws Error when a limit is set and `client` is the gateway provider,
 * which cannot verify either bound: refused here, as the client is built,
 * rather than on the first model turn.
 */
export const limitHarnessModelClient = (
  client: HarnessModelClient,
  limits: HarnessModelLimits,
): HarnessModelClient => {
  assertHarnessModelLimits(limits);
  if (
    limits.maxInputBytes === undefined && limits.maxOutputTokens === undefined
  ) return client;
  if (client.providerId === OPENAI_COMPATIBLE_GATEWAY_PROVIDER_ID) {
    throw new Error(
      "maxInputBytes and maxOutputTokens require the openai-codex provider; the openai-compatible-gateway provider cannot verify them",
    );
  }
  const { maxInputBytes, maxOutputTokens } = limits;
  const listModels = client.listModels?.bind(client);
  return {
    providerId: client.providerId,
    ...(client.credentialOwner !== undefined
      ? { credentialOwner: client.credentialOwner }
      : {}),
    ...(listModels !== undefined ? { listModels } : {}),
    complete: (request) => {
      assertHarnessModelLimits(request);
      return client.complete({
        ...request,
        maxInputBytes: narrower(maxInputBytes, request.maxInputBytes),
        maxOutputTokens: narrower(maxOutputTokens, request.maxOutputTokens),
      });
    },
  };
};
