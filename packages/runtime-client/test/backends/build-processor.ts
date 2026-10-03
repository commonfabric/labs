/**
 * A `RuntimeProcessor` built over stand-ins, for a test that drives one
 * handler at a time. It goes through the constructor the class keeps to
 * itself, so that what a test gets is a real instance, and what a test does
 * not supply is inert: an empty object where a handler never touches the
 * collaborator, a fresh telemetry hub, and a signer minted for these tests.
 */

import { Identity } from "@commonfabric/identity";
import type { MemorySpace } from "@commonfabric/memory/interface";
import { PiecesController } from "@commonfabric/piece/ops";
import { Runtime, RuntimeTelemetry } from "@commonfabric/runner";
import { RuntimeProcessor } from "@/backends/runtime-processor.ts";
import type { InitializationData } from "@/protocol/mod.ts";

/** The signer a processor acts as when a test supplies no identity. */
const standInSigner = await Identity.fromPassphrase(
  "runtime-processor-stand-in",
);

/**
 * Builds a processor over `parts`. Each part is declared as what the class
 * holds where it is handed over; `cc` is the piece context of `space`, the
 * home space, which is where a handler naming that space finds it.
 *
 * The parts are `unknown` rather than `Partial<Runtime>` and the like: a
 * stand-in here fakes one or two members with signatures of its own, which
 * a `Partial` of the real type would refuse. The cost is that a stand-in
 * drifting from the shape a handler reads is found by the handler, not here.
 */
export function buildProcessor(parts: {
  runtime?: unknown;
  cc?: unknown;
  space?: MemorySpace;
  identity?: unknown;
  telemetry?: RuntimeTelemetry;
  renderConfidentialityCeiling?: InitializationData[
    "renderConfidentialityCeiling"
  ];
} = {}): RuntimeProcessor {
  const space = parts.space ?? standInSigner.did();
  const identity = (parts.identity ?? standInSigner) as Identity;
  return RuntimeProcessor.accessForTestingOnly.construct(
    (parts.runtime ?? {}) as Runtime,
    (parts.cc ?? {}) as PiecesController,
    space,
    identity,
    parts.telemetry ?? new RuntimeTelemetry(),
    {
      identity: identity.did(),
      apiUrl: "http://localhost/",
      spaceDid: space,
    },
    { renderConfidentialityCeiling: parts.renderConfidentialityCeiling },
  );
}
