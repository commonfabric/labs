import env from "@/env.ts";
import { identity } from "@/lib/identity.ts";
import { isValidSpaceDid } from "@/lib/space-authority.ts";

/** Helper for `ingestServiceSpace`, which reads and checks the setting. */
const configuredServiceSpace = (): string => {
  const configured = env.INGEST_SERVICE_SPACE.trim();
  if (configured === "") return identity.did();
  if (!isValidSpaceDid(configured)) {
    throw new Error("`INGEST_SERVICE_SPACE` is not a space DID.");
  }
  return configured;
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
export const ingestServiceSpace: string = configuredServiceSpace();
