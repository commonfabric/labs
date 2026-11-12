import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";

import { VerifierMetadataResolver } from "../../src/cfc/prepare.ts";
import type { CfcMetadata } from "../../src/cfc/types.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../../src/storage/interface.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cfc-verifier-metadata-resolver");
const space = signer.did();
const id = "of:resolver-source" as URI;
const document = { space, id, scope: "space" as const };

/** A stored envelope labeling `a` and `b` through links and `c` directly. */
const metadata: CfcMetadata = {
  version: 1,
  schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
  labelMap: {
    version: 1,
    entries: [
      { path: ["a"], label: { confidentiality: ["a-secret"] }, origin: "link" },
      { path: ["b"], label: { confidentiality: ["b-secret"] }, origin: "link" },
      { path: ["c"], label: { confidentiality: ["c-secret"] } },
    ],
  },
};

/** A link write of `path` in the source document. */
const linkWriteAt = (path: readonly string[]) => ({
  kind: "link-write" as const,
  target: { ...document, path },
  source: { ...document, id: "of:elsewhere" as URI, path: [] },
});

describe("VerifierMetadataResolver", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let tx: IExtendedStorageTransaction;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "enforce-explicit",
    });
    const seed = runtime.edit();
    writeSeedEnvelopeDoc(seed, space);
    seedStoredEnvelope(seed, { ...document, path: [] }, {
      value: { a: "1", b: "2", c: "3" },
      cfc: metadata,
    });
    expect((await seed.commit().settled).error).toBeUndefined();
    tx = runtime.edit();
  });

  afterEach(async () => {
    tx.abort();
    await runtime.dispose();
    await storageManager.close();
  });

  describe("instance members", () => {
    describe("linkSource()", () => {
      it("returns the envelope without the link entries a link write in this transaction replaces", () => {
        const resolver = new VerifierMetadataResolver(tx);
        const projected = resolver.linkSource(
          metadata,
          "source",
          undefined,
          [linkWriteAt(["a"])],
        );
        expect(projected.labelMap.entries.map((entry) => entry.path))
          .toEqual([["b"], ["c"]]);
        expect(projected.schemaHash).toBe(metadata.schemaHash);
        expect(metadata.labelMap.entries).toHaveLength(3);
      });

      it("returns the same projection for the same envelope and key", () => {
        const resolver = new VerifierMetadataResolver(tx);
        const first = resolver.linkSource(metadata, "source", undefined, [
          linkWriteAt(["a"]),
        ]);
        expect(
          resolver.linkSource(metadata, "source", undefined, [
            linkWriteAt(["a"]),
          ]),
        ).toBe(first);
      });

      it("returns the envelope itself where no link entry is replaced", () => {
        const resolver = new VerifierMetadataResolver(tx);
        // A write at `c` replaces a slot no link labels.
        expect(
          resolver.linkSource(metadata, "source", undefined, [
            linkWriteAt(["c"]),
          ]),
        ).toBe(metadata);
        expect(resolver.linkSource(metadata, "other", undefined, []))
          .toBe(metadata);
      });

      it("returns the envelope itself for a document whose envelope was already prepared", () => {
        const resolver = new VerifierMetadataResolver(tx);
        resolver.didPrepare("source");
        expect(
          resolver.linkSource(metadata, "source", undefined, [
            linkWriteAt(["a"]),
          ]),
        ).toBe(metadata);
      });
    });

    describe("refresh()", () => {
      it("retires the envelope and its projections once the transaction writes the document", () => {
        const resolver = new VerifierMetadataResolver(tx);
        const stored = resolver.read(space, id, "space", "application/json");
        expect(stored?.labelMap.entries).toHaveLength(3);
        // One projection of a path the envelope labels, and one of a path it
        // says nothing about, which holds no view.
        const labeled = resolver.projection(stored, ["c"]);
        const unlabeled = resolver.projection(stored, ["unlabeled"]);
        expect(labeled?.view).toBeDefined();
        expect(unlabeled?.view).toBeUndefined();

        resolver.refresh();
        expect(resolver.generation).toBe(0);
        expect(resolver.read(space, id, "space", "application/json"))
          .toBe(stored);
        expect(resolver.projection(stored, ["c"])).toBe(labeled);

        tx.writeValueOrThrow({ ...document, path: ["c"] }, "changed");
        resolver.refresh();
        expect(resolver.generation).toBe(1);
        expect(resolver.read(space, id, "space", "application/json"))
          .not.toBe(stored);
        const reprojected = resolver.projection(stored, ["c"]);
        expect(reprojected).not.toBe(labeled);
        expect(reprojected?.view).toEqual(labeled?.view);
        expect(resolver.projection(stored, ["unlabeled"])?.view)
          .toBeUndefined();
      });
    });
  });
});
