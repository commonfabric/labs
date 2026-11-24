// A commit that changes which links a watch schema follows is not COVERED
// until the newly-followed target has arrived (CT-1950 "watch-set
// consequences"). Two real Runtimes share one in-process MemoryV2Server
// (harness recipe from commit-conflict-reconcile.test.ts):
//
// - A writes doc1 (plain text) and doc2 ({ content: link -> doc1 }), with
//   NO mediaType property.
// - B watches doc2 under a schema whose link-following anyOf branch
//   REQUIRES mediaType. Branch matching discriminates on required-property
//   PRESENCE (canBranchMatch checks Object.hasOwn; const/enum values are
//   deliberately not checked — they may sit behind unresolved links), so
//   with mediaType absent the follow branch is skipped and doc1 never
//   loads.
// - B then writes mediaType = "text/plain". The schema now follows the
//   link, so the commit's watch-set consequence is doc1 entering B's view.
//   At the VERDICT the fate is sealed but doc1 has not arrived, so a
//   verdict-time read still lacks the linked doc; the expansion is
//   delivered between verdict and coverage (the client's own follow-up
//   pull, with the server fan-out as the backstop). When the commit
//   PROMISE resolves (coverage), the linked doc must be readable with no
//   further sync.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";
import { Runtime } from "../src/runtime.ts";
import { newSharedServer } from "./memory-v2-test-utils.ts";

const signer = await Identity.fromPassphrase("schema-gated-link-coverage");
const space = signer.did();

type LinkedDoc = { text?: string };
type GatedDoc = { mediaType?: string; content?: LinkedDoc };

// The follow branch demands mediaType PRESENT (required) and then gives
// content a real schema, which traversal dereferences. The fallback branch
// gives content the false schema, which traversal never follows.
const gatedSchema = {
  type: "object",
  anyOf: [
    {
      type: "object",
      required: ["mediaType"],
      properties: {
        mediaType: { type: "string" },
        content: {
          type: "object",
          properties: { text: { type: "string" } },
        },
      },
    },
    {
      type: "object",
      properties: {
        content: false,
      },
    },
  ],
  // deno-lint-ignore no-explicit-any
} as any;

describe("schema-gated link expansion at coverage", () => {
  let server: MemoryV2Server.Server;
  let storageA: EmulatedStorageManager;
  let storageB: EmulatedStorageManager;
  let rtA: Runtime;
  let rtB: Runtime;

  beforeEach(() => {
    // Manual fan-out: the held state below is a gated state, not a timing
    // accident — frames spread only when the test flushes.
    server = newSharedServer({ subscriptionRefreshDelayMs: "manual" });
    storageA = EmulatedStorageManager.connectTo(server, { as: signer });
    storageB = EmulatedStorageManager.connectTo(server, { as: signer });
    rtA = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageA,
    });
    rtB = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storageB,
    });
  });

  afterEach(async () => {
    await rtB.dispose();
    await rtA.dispose();
    await storageB.close();
    await storageA.close();
    await server.close();
  });

  it("delivers the newly-followed link at commit-promise coverage, not at the verdict", async () => {
    // A seeds doc1 and doc2-with-link (no mediaType yet).
    const doc1A = rtA.getCell<LinkedDoc>(space, "gated-linked-doc", undefined);
    const doc2A = rtA.getCell<GatedDoc>(space, "gated-holder-doc", undefined);
    {
      const tx = rtA.edit();
      doc1A.withTx(tx).set({ text: "hello from doc1" });
      doc2A.withTx(tx).set({});
      doc2A.withTx(tx).key("content").setRawUntyped(doc1A.getAsLink());
      rtA.prepareTxForCommit(tx);
      const res = await tx.commit({ holdSyncedUntilCovered: false }).verdict;
      expect(res.error, `seed: ${JSON.stringify(res.error)}`).toBeUndefined();
    }

    // B watches doc2 under the gated schema. mediaType is absent, so the
    // follow branch cannot match and doc1 must not be included.
    const doc2B = rtB.getCell<GatedDoc>(
      space,
      "gated-holder-doc",
      gatedSchema,
    );
    await doc2B.sync();
    await doc2B.pull();
    expect(
      doc2B.get()?.content?.text,
      "link not followed while mediaType is absent",
    ).toBeUndefined();

    // B makes mediaType defined — the watch-set consequence of this commit
    // is that the schema now follows the link.
    const txB = rtB.edit();
    doc2B.withTx(txB).key("mediaType").set("text/plain");
    rtB.prepareTxForCommit(txB);

    let verdictContent: string | undefined = "unset";
    txB.addVerdictCallback(() => {
      verdictContent = doc2B.get()?.content?.text;
    });
    let promiseSettled = false;
    const commitP = txB.commit().settled.then((result) => {
      promiseSettled = true;
      return result;
    });

    // Drain without moving the clock: the verdict arrives promptly, but
    // the fan-out frame carrying doc1 (and the coverage marker) rides the
    // batched fan-out, which this manual server withholds until the test
    // flushes.
    await clock.settle();
    expect(verdictContent, "verdict callback ran").not.toBe("unset");
    expect(
      verdictContent,
      "linked doc not yet readable at the verdict",
    ).toBeUndefined();
    // Between the verdict and coverage the client notices the expansion
    // against its own optimistic state and pulls doc1 itself — the linked
    // doc can be readable well before coverage. The commit promise still
    // waits for its coverage marker, which rides the withheld
    // fan-out and cannot arrive before the test's flush.
    expect(promiseSettled, "commit promise still waiting for coverage")
      .toBe(false);

    // The test releases the fan-out: it delivers doc1 with the marker. A
    // resolved commit means the subscribed view reflects the write AND its
    // watch-set consequences — the linked doc reads without any further
    // sync or pull.
    await server.flushSessions([space]);
    await clock.settle();
    const res = await commitP;
    expect(res.error, `commit: ${JSON.stringify(res.error)}`).toBeUndefined();
    expect(
      doc2B.get()?.content?.text,
      "linked doc readable at commit-promise coverage",
    ).toBe("hello from doc1");
  });
});
