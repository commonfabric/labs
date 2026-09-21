/**
 * Where each field of an `InitializationData` lands inside the worker.
 *
 * The host builds that payload field by field and the worker takes it apart in
 * three places: `browserWorkerParamsFromInitializationData` hands part of it
 * to the runtime preset, `RuntimeProcessor.initialize` reads the rest, and the
 * message loop in `client-registry.ts` reads one field before the processor
 * exists. A field none of the three reads crosses `postMessage` whole and then
 * configures nothing, so the host declares one posture and the worker runs
 * another.
 *
 * `REACH` is keyed by `keyof Required<InitializationData>`, which is what
 * closes the claim: a field added to the type is a type error here until it
 * names what the worker builds from it and takes a case asserting that. Every
 * field the payload declares reaches the worker, so there is no arm for one
 * that does not.
 *
 * The key set is that type's own, so the claim is over the payload's top
 * level, which is where the hazard is: a top-level field travels only because
 * a hand-written literal names it. A flag added inside `experimental` needs no
 * case of its own, because that record crosses as one value and is spread into
 * the runtime's resolved flags whole.
 */

import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";

import { cfcAtom } from "@commonfabric/api/cfc";
import { realmFromFabricValue } from "@commonfabric/data-model/codecs";
import { type DID, Identity } from "@commonfabric/identity";
import type { Runtime } from "@commonfabric/runner";
import type { Options as StorageOptions } from "@commonfabric/runner/storage/cache";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { RuntimeClients } from "@/backends/client-registry.ts";
import { RuntimeProcessor } from "@/backends/runtime-processor.ts";
import type { WorkerClient } from "@/backends/worker-client.ts";
import { type InitializationData, RequestType } from "@/protocol/mod.ts";
import { stubWorkerBoot } from "./stub-worker-boot.ts";

const signer = await Identity.fromPassphrase("initialization-data-reach-user");
const spaceSigner = await Identity.fromPassphrase(
  "initialization-data-reach-space",
);
const space = spaceSigner.did();
const federatedSpace = "did:key:z6MkInitializationDataReachFederated" as DID;
const apiUrl = "http://initialization-data-reach.test/";
const federatedHost = "http://federated.initialization-data-reach.test/";

/**
 * A payload whose every field carries a value the worker does not arrive at on
 * its own, so that a field nothing reads reads back as the worker's default
 * rather than as what was sent.
 */
const SENT = {
  apiUrl,
  spaceHostMap: { [federatedSpace]: federatedHost },
  identity: signer.keyPair,
  spaceDid: space,
  spaceName: "reach",
  spaceIdentity: spaceSigner.keyPair,
  experimental: {
    agentBuiltin: false,
    webViewScopedReplication: true,
    contentAddressedSchemas: false,
  },
  cfcEnforcementMode: "enforce-strict",
  cfcFlowLabels: "persist",
  cfcReadMaxConfidentiality: [cfcAtom.user(signer.did())],
  cfcReadOnExceed: "skip",
  renderDeclassificationPolicy: "deny",
  renderConfidentialityCeiling: {
    atoms: [cfcAtom.user(signer.did())],
    caveatKinds: ["reach"],
  },
  trustSnapshot: {
    id: `principal:${signer.did()}`,
    actingPrincipal: signer.did(),
    revision: "reach-revision",
  },
  forwardWorkerConsole: true,
  patternCoverage: true,
  concurrentWatchRefresh: true,
} satisfies
  & InitializationData
  & Record<keyof Required<InitializationData>, unknown>;

/** What one worker-side initialization built, as the cases read it back. */
type Observed = {
  /** The runtime the worker stood up. */
  runtime: Runtime;

  /** The processor, for what it holds rather than what the runtime does. */
  processor: RuntimeProcessor;

  /** What the worker opened storage with. */
  storage: StorageOptions;

  /** Each value the message loop set the console bridge to, in order. */
  consoleBridge: readonly boolean[];
};

/** What the worker builds from one field, and where to read it back from. */
type FieldReach = {
  reads: (observed: Observed) => unknown;
  expected: unknown;
};

const REACH = {
  apiUrl: {
    reads: (o) => o.runtime.apiUrl.href,
    expected: apiUrl,
  },
  spaceHostMap: {
    reads: (o) => o.runtime.spaceHostMap,
    expected: { [federatedSpace]: federatedHost },
  },
  identity: {
    reads: (o) => o.runtime.userIdentityDID,
    expected: signer.did(),
  },
  spaceDid: {
    reads: (o) => o.processor.accessForTestingOnly.cc.getSpace(),
    expected: space,
  },
  spaceName: {
    reads: (o) => o.processor.accessForTestingOnly.cc.getSpaceName(),
    expected: "reach",
  },
  spaceIdentity: {
    // A space's key pair derives the space, so this reads back the same DID
    // `spaceDid` does. What the case pins is that the key pair reached
    // storage, not which space it names.
    reads: (o) => o.storage.spaceIdentity?.did(),
    expected: space,
  },
  experimental: {
    // Read back as a pair, so the case turns on the record arriving with its
    // contents rather than on one key of it.
    reads: (o) => ({
      agentBuiltin: o.runtime.experimental.agentBuiltin,
      webViewScopedReplication: o.runtime.experimental.webViewScopedReplication,
      contentAddressedSchemas: o.runtime.experimental.contentAddressedSchemas,
    }),
    expected: {
      agentBuiltin: false,
      webViewScopedReplication: true,
      contentAddressedSchemas: false,
    },
  },
  cfcEnforcementMode: {
    reads: (o) => o.runtime.cfcEnforcementMode,
    expected: "enforce-strict",
  },
  cfcFlowLabels: {
    reads: (o) => o.runtime.cfcFlowLabels,
    expected: "persist",
  },
  cfcReadMaxConfidentiality: {
    reads: (o) => o.runtime.cfcReadMaxConfidentiality,
    expected: [cfcAtom.user(signer.did())],
  },
  cfcReadOnExceed: {
    reads: (o) => o.runtime.cfcReadOnExceed,
    expected: "skip",
  },
  renderDeclassificationPolicy: {
    reads: (o) => o.processor.accessForTestingOnly.renderDeclassificationPolicy,
    expected: "deny",
  },
  renderConfidentialityCeiling: {
    reads: (o) => o.processor.accessForTestingOnly.renderConfidentialityCeiling,
    expected: {
      atoms: [cfcAtom.user(signer.did())],
      caveatKinds: ["reach"],
    },
  },
  trustSnapshot: {
    reads: (o) => o.runtime.trustSnapshotProvider()?.revision,
    expected: "reach-revision",
  },
  forwardWorkerConsole: {
    reads: (o) => o.consoleBridge,
    expected: [true],
  },
  patternCoverage: {
    reads: (o) => o.runtime.patternCoverage !== undefined,
    expected: true,
  },
  concurrentWatchRefresh: {
    reads: (o) => o.storage.settings?.experimentalConcurrentWatchRefresh,
    expected: true,
  },
} satisfies Record<keyof Required<InitializationData>, FieldReach>;

/** The client that owns the worker. What the worker posts back is not read. */
const owner: WorkerClient = { id: 0, post: () => true };

/**
 * Drives one initialization the way a worker's own message loop does -- the
 * payload encoded as a transport sends it, the real `RuntimeClients` loop, and
 * the real `RuntimeProcessor.initialize` behind it -- and returns what it
 * built along with its teardown.
 *
 * Storage is emulated and the backend is stood down, since what these cases
 * turn on is where each declared value arrives rather than whether a backend
 * answers. The options storage is opened with are recorded, which is the only
 * place two of the fields reach.
 */
async function observeWorkerInitialization(): Promise<{
  observed: Observed;
  teardown: () => Promise<void>;
}> {
  const openedWith: StorageOptions[] = [];
  const consoleBridge: boolean[] = [];
  const restoreBoot = stubWorkerBoot((options) => {
    openedWith.push(options);
    return StorageManager.emulate({ as: options.as });
  });

  let processor: RuntimeProcessor | undefined;
  try {
    const clients = new RuntimeClients({
      owner,
      setConsoleBridge: (enabled) => consoleBridge.push(enabled),
      initializeRuntime: async (data) => {
        processor = await RuntimeProcessor.initialize(data);
        return processor;
      },
    });
    await clients.handleMessage(
      owner,
      new MessageEvent("message", {
        // Encoded and cloned, as a real transport delivers it. The encoding is
        // what carries the `FabricKeyPair` this payload holds; the clone is
        // what makes it a copy, since the loop decodes what arrives and an
        // encode alone hands back the sender's own tree.
        data: structuredClone(
          realmFromFabricValue(
            { msgId: 0, data: { type: RequestType.Initialize, data: SENT } },
          ),
        ),
      }),
    );
  } finally {
    restoreBoot();
  }

  const built = processor;
  if (!built) throw new Error("The worker stood no processor up.");
  if (openedWith.length !== 1) {
    throw new Error(
      `The worker opened storage ${openedWith.length} times, not once.`,
    );
  }
  return {
    observed: {
      runtime: built.accessForTestingOnly.runtime,
      processor: built,
      storage: openedWith[0],
      consoleBridge,
    },
    teardown: () => built.dispose(),
  };
}

describe("initialization-data-reach", () => {
  let observed: Observed;
  let teardown: () => Promise<void>;

  beforeAll(async () => {
    ({ observed, teardown } = await observeWorkerInitialization());
  });

  afterAll(() => teardown());

  describe("what the worker builds from the payload", () => {
    for (const [field, reach] of Object.entries(REACH)) {
      it(`carries \`${field}\` into the worker's configuration`, () => {
        expect(reach.reads(observed)).toEqual(reach.expected);
      });
    }
  });
});
