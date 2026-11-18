import env from "@/env.ts";
import { identity } from "@/lib/identity.ts";
import { isValidSpaceDid } from "@/lib/space-authority.ts";

/**
 * Returns the space an `INGEST_SERVICE_SPACE` setting of `configured` names,
 * or `fallback` where the setting is blank.
 *
 * @throws If `configured` is neither blank nor a space DID.
 */
export const serviceSpaceFrom = (
  configured: string,
  fallback: string,
): string => {
  const trimmed = configured.trim();
  if (trimmed === "") return fallback;
  if (!isValidSpaceDid(trimmed)) {
    throw new Error("`INGEST_SERVICE_SPACE` is not a space DID.");
  }
  return trimmed;
};

/**
 * The space this deployment keeps its ingest registry in: channel
 * registrations, their indexes, and Gmail mailbox bindings. It is the one
 * `INGEST_SERVICE_SPACE` names, or with that unset, the space named by this
 * deployment's own identity.
 *
 * A route that reaches the registry without naming a user's space carries
 * this space in its path instead, so that whatever dispatches requests by
 * space sends it to the deployment holding the registry.
 */
export const ingestServiceSpace: string = serviceSpaceFrom(
  env.INGEST_SERVICE_SPACE,
  identity.did(),
);
