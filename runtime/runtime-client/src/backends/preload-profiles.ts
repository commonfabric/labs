/** Warms profile selection data for an authenticated browser session. */

import type { Cancel, JSONSchema, Runtime } from "@commonfabric/runner";

const profileDisplayListSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      name: { type: "string" },
      picture: { type: "FabricBytes" },
      avatar: { type: "string" },
      initialNameApplied: { type: "string" },
    },
  },
} as const satisfies JSONSchema;

/**
 * Starts a read-only subscription to the active user's profile roster and
 * display fields. It follows roster changes until canceled and returns before
 * storage loads finish. Canceling ends the runtime subscription, not the
 * storage watch it opened on Home: that watch stays as long as the storage
 * manager does and, on a server that reports the links a watch crosses into
 * other spaces, goes on loading the profiles a changed roster links to.
 * The browser runtime's identity owns the subscription; selecting another
 * space leaves that identity and its Home unchanged.
 */
export function preloadProfiles(runtime: Runtime): Cancel {
  return runtime.getHomeSpaceCell()
    .key("defaultPattern")
    .key("profiles")
    .asSchema(profileDisplayListSchema)
    .sink(() => {}, { readOnly: true });
}
