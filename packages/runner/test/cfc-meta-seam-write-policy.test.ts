import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";

import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { isCfcEnforcementRejection } from "../src/storage/rejection.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";
import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";

const signer = await Identity.fromPassphrase("runner-cfc-meta-seam");

describe("cfc-meta-seam-write-policy", () => {
  // The prepare pass requires a schema write-policy input for every write it
  // records on a document carrying stored label metadata. A raw meta write
  // (`setMetaRaw`) lands on a document-root sibling of `value` — `slug`,
  // `patternIdentity`, and the rest of the `MetaField` union — and no schema
  // describes that seam, so no writer can supply the input the requirement
  // asks for. Such a write must therefore commit without a "missing schema
  // write-policy input" reason, or every runtime flow that stamps meta on a
  // labeled piece document (slug assignment, the pattern updater's identity
  // swap, setup over an existing piece) rejects under the enforcing modes.
  //
  // The exemption reaches the schema-policy requirement and nothing else. A
  // meta write is still a flow-label target: it carries the writing
  // transaction's join onto the document it lands on, so a value read from a
  // labeled document and parked in a meta field arrives labeled.
  //
  // The exemption is recorded per RAW storage path. A user field literally
  // named `slug` lives under `["value", "slug"]` and canonicalizes to the
  // same logical path as the meta field's raw `["slug"]`, so keying on the
  // canonical path would exempt the user field too; it must stay a
  // policy-targeted value write.

  const setup = async () => {
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
    });

    // Seed a doc whose stored ["cfc"] metadata labels the whole document:
    // the root entry applies to every written path, meta or value. Seeding
    // uses the ungated path-[] full-document write (the shape hydration
    // delivers); the seeding transaction itself stays non-relevant because
    // self-minted metadata does not make a transaction flow-relevant.
    const cause = "cfc-meta-seam-doc";
    const id = runtime.getCell(signer.did(), cause)
      .getAsNormalizedFullLink().id as URI;
    const seed = runtime.edit();
    writeSeedEnvelopeDoc(seed, signer.did());
    seedStoredEnvelope(seed, {
      space: signer.did(),
      scope: "space",
      id,
      path: [],
    }, {
      value: { note: "labeled" },
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [
            { path: [], label: { confidentiality: ["seed-label"] } },
          ],
        },
      },
    });
    expect((await seed.commit()).ok).toBeDefined();

    return { storageManager, runtime, cause, id };
  };

  it("commits a raw `setMetaRaw` write on a labeled document with no missing-policy reason", async () => {
    const { storageManager, runtime, cause } = await setup();
    try {
      const tx = runtime.edit();
      const cell = runtime.getCell(signer.did(), cause, undefined, tx);
      await cell.sync();
      cell.setMetaRaw("slug", "piece-slug", rawMetaWriteAuthorization);
      cell.setMetaRaw("patternIdentity", {
        identity: "cid:pattern",
        symbol: "main",
      }, rawMetaWriteAuthorization);
      tx.prepareCfc();
      // Prepared (not invalidated): the prepare pass recorded no reasons at
      // all for the meta writes.
      expect(tx.getCfcState().prepare.status).toBe("prepared");
      const result = await tx.commit();
      expect(result.ok).toBeDefined();
      expect(
        tx.getCfcState().diagnostics.filter((d) =>
          d.includes("missing schema write-policy input")
        ),
      ).toEqual([]);

      // The meta writes landed: a fresh read sees the committed slug.
      const readCell = runtime.getCell(signer.did(), cause);
      await readCell.sync();
      expect(readCell.getMetaRaw("slug")).toBe("piece-slug");
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("rejects a schema-less user write to a `value` field literally named `slug` on the same labeled document", async () => {
    const { storageManager, runtime, id } = await setup();
    try {
      const tx = runtime.edit();
      tx.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id,
        path: ["value", "slug"],
      }, "user-slug");
      tx.prepareCfc();
      const result = await tx.commit();
      expect(isCfcEnforcementRejection(result.error)).toBe(true);
      expect(String((result.error as Error).message)).toContain(
        "missing schema write-policy input",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("stamps the writing transaction's confidentiality onto a document a raw meta write lands on", async () => {
    // The policy exemption must not become a laundering channel: a value
    // read out of a labeled document and written into an unlabeled
    // document's meta field arrives carrying the label, exactly as a value
    // write would.
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      // The assertion at the end of this test reads the sink document's
      // stored labelMap. Persisting flow labels is what puts the writing
      // transaction's confidentiality into it.
      cfcFlowLabels: "persist",
    });
    try {
      const secretId = runtime.getCell(signer.did(), "cfc-meta-seam-secret")
        .getAsNormalizedFullLink().id as URI;
      const seedSecret = runtime.edit();
      writeSeedEnvelopeDoc(seedSecret, signer.did());
      seedStoredEnvelope(seedSecret, {
        space: signer.did(),
        scope: "space",
        id: secretId,
        path: [],
      }, {
        value: { secret: "classified" },
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [
              { path: [], label: { confidentiality: ["secret-label"] } },
            ],
          },
        },
      });
      expect((await seedSecret.commit()).ok).toBeDefined();

      const sinkCause = "cfc-meta-seam-sink";
      const sinkId = runtime.getCell(signer.did(), sinkCause)
        .getAsNormalizedFullLink().id as URI;
      const seedSink = runtime.edit();
      seedSink.writeOrThrow({
        space: signer.did(),
        scope: "space",
        id: sinkId,
        path: [],
      }, { value: { plain: "public" } });
      expect((await seedSink.commit()).ok).toBeDefined();

      const tx = runtime.edit();
      const secret = tx.readOrThrow({
        space: signer.did(),
        scope: "space",
        id: secretId,
        path: ["value", "secret"],
      });
      const sink = runtime.getCell(signer.did(), sinkCause, undefined, tx);
      await sink.sync();
      sink.setMetaRaw("slug", secret as string, rawMetaWriteAuthorization);
      tx.prepareCfc();
      expect((await tx.commit()).ok).toBeDefined();

      const replica = storageManager.open(signer.did()).replica as unknown as {
        getDocument(id: string): {
          cfc?: {
            labelMap?: {
              entries: Array<
                { path: string[]; label: { confidentiality?: unknown[] } }
              >;
            };
          };
        } | undefined;
      };
      const entries = replica.getDocument(sinkId)?.cfc?.labelMap?.entries ?? [];
      const stamped = entries.filter((entry) =>
        entry.path.length === 1 && entry.path[0] === "slug" &&
        (entry.label.confidentiality ?? []).includes("secret-label")
      );
      expect(stamped.length).toBeGreaterThan(0);
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });
});
