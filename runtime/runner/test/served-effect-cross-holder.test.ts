/**
 * Exercises the holder rule of §8.12.5.1 on a served effect: a fetch whose
 * request the serving loop issues and whose completion it writes back
 * unstamped, as an effect completion, once the response arrives.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { addCfcDenialListener } from "../src/cfc/denial-report.ts";
import { ExecutorHost } from "../src/executor/host.ts";
import { Runtime } from "../src/runtime.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const spaceSigner = await Identity.fromPassphrase("served effect cross holder");
const service = await Identity.fromPassphrase("served effect service");
const alice = await Identity.fromPassphrase("served effect alice");
const owner = await Identity.fromPassphrase("served effect owner");
const space = spaceSigner.did() as MemorySpace;
const ownerSpace = owner.did() as MemorySpace;
const url = "https://example.test/served-effect";

describe("served-effect-cross-holder", () => {
  it("refuses a served fetch run over another space's private URL before its request goes out", async () => {
    // Alice's piece takes its URL through a link to a document of the
    // owner's space, labeled for the owner. The serving loop runs the fetch
    // node, which reads that URL and would issue the request and later write
    // the response back into Alice's space, unstamped. The rule refuses the
    // node's own run, which writes its pending state there, before the
    // request goes out, so no completion exists to write anything back.
    // The case ends on the refusal itself and checks that no request had
    // gone out by then; what the node does after it is refused is not what
    // this case pins.

    const server = newSharedServer({ subscriptionRefreshDelayMs: 0 });
    const originalFetch = globalThis.fetch;
    const managers: EmulatedStorageManager[] = [];
    const runtimes: Runtime[] = [];
    let host: ExecutorHost | undefined;
    const requested = Promise.withResolvers<string>();
    const requests: string[] = [];
    const denied = Promise.withResolvers<readonly string[]>();
    const stopListening = addCfcDenialListener((denial) => {
      const reasons = (denial.inputs.reasons ?? []) as readonly string[];
      if (reasons.some((reason) => reason.includes("§8.12.5.1"))) {
        denied.resolve(reasons);
      }
    });
    try {
      globalThis.fetch = (input, init) => {
        const requestedUrl = input instanceof Request
          ? input.url
          : String(input);
        if (!requestedUrl.startsWith(url)) return originalFetch(input, init);
        requests.push(requestedUrl);
        requested.resolve(requestedUrl);
        return Promise.resolve(new Response("the response"));
      };

      // The owner's private document.
      const ownerManager = EmulatedStorageManager.connectTo(server, {
        as: owner,
      });
      managers.push(ownerManager);
      const ownerRuntime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: ownerManager,
      });
      runtimes.push(ownerRuntime);
      const privateCell = ownerRuntime.getCell<{ url: string }>(
        ownerSpace,
        "served-effect-private",
      );
      const seed = ownerRuntime.edit();
      writeSeedEnvelopeDoc(seed, ownerSpace);
      seedStoredEnvelope(seed, {
        space: ownerSpace,
        scope: "space",
        id: privateCell.getAsNormalizedFullLink().id,
        path: [],
      }, {
        value: { url: `${url}?private` },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["url"],
              label: {
                confidentiality: [{
                  type: "https://commonfabric.org/cfc/atom/User",
                  subject: owner.did(),
                }],
              },
            }],
          },
        },
      });
      expect((await seed.commit().settled).error).toBeUndefined();

      host = new ExecutorHost({
        server,
        serviceIdentity: service.did(),
        // The execution host owns an asynchronous factory contract.
        // deno-lint-ignore require-await
        createRuntime: async () => {
          const manager = EmulatedStorageManager.connectTo(server, {
            as: service,
          });
          const runtime = new Runtime({
            apiUrl: new URL(import.meta.url),
            storageManager: manager,
            servingPosture: true,
            experimental: { serverExecution: true },
          });
          return {
            runtime,
            dispose: async () => {
              await runtime.dispose();
              await manager.close();
            },
          };
        },
        policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
      });

      const manager = EmulatedStorageManager.connectTo(server, { as: alice });
      managers.push(manager);
      const client = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager: manager,
        experimental: { serverExecution: true },
      });
      runtimes.push(client);
      const pattern = await client.patternManager.compilePattern({
        main: "/main.tsx",
        files: [{
          name: "/main.tsx",
          contents: `
import { fetchText, pattern, Writable } from "commonfabric";
export default pattern<{ url: Writable<string> }, { fetched: any }>(
  ({ url }) => ({ fetched: fetchText({ url }) }),
);
`,
        }],
      }, { space });
      const argument = client.getCell<{ url: string }>(
        space,
        "served-effect-input",
        pattern.argumentSchema,
      );
      const result = client.getCell<{ fetched: unknown }>(
        space,
        "served-effect-result",
        pattern.resultSchema,
      );
      await argument.sync();
      await result.sync();
      const link = client.getCellFromLink(
        { ...privateCell.getAsNormalizedFullLink(), path: ["url"] },
      );
      const start = client.edit();
      argument.withTx(start).key("url").set(link as never);
      client.run(start, pattern, argument, result);
      expect((await start.commit().settled).error).toBeUndefined();
      const cancel = result.sink(() => {});
      try {
        const first = await Promise.race([
          requested.promise.then((issued) => ({ issued })),
          denied.promise.then((reasons) => ({ reasons })),
        ]);

        expect(first).toMatchObject({
          reasons: expect.arrayContaining([
            expect.stringContaining("(cross-holder, §8.12.5.1)"),
          ]),
        });
        expect(requests).toEqual([]);
      } finally {
        cancel();
      }
    } finally {
      stopListening();
      globalThis.fetch = originalFetch;
      await host?.close();
      for (const runtime of runtimes) {
        await runtime.dispose({ closeStorage: false });
      }
      for (const manager of managers) await manager.close();
      await server.close();
    }
  });
});
