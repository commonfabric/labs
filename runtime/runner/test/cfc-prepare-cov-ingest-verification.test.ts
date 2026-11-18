import { afterEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { CFC_ATOM_TYPE } from "@commonfabric/api/cfc";
import { Identity } from "@commonfabric/identity";

import type { JSONSchema } from "../src/builder/types.ts";
import { stampExternalIngest } from "../src/cfc/external-ingest.ts";
import { readStoredCfcMetadata } from "../src/cfc/metadata.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase(
  "runner-cfc-prepare-cov-ingest-verification",
);
const space = signer.did();

const MARK = {
  type: CFC_ATOM_TYPE.ExternalIngest,
  channel: "did:key:channel",
  audience: "did:key:presenter",
  receivedAt: "2026-06-26T12:00:00.000Z",
  valueDigest: "sha256:payload",
};

describe("prepare", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate> | undefined;
  let runtime: Runtime | undefined;

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    runtime = undefined;
    storageManager = undefined;
  });

  // Ingests `value` into a cell typed by a schema whose `copy` field declares
  // `ifc` beside a confidentiality label, with CFC enforcement disabled, so
  // the commit lands whatever the verification found. Returns the entries
  // the ingest target then stores.
  const ingest = async (ifc: Record<string, unknown>, value: unknown) => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager,
      cfcEnforcementMode: "disabled",
    });
    const schema = {
      type: "object",
      properties: {
        source: { type: "string" },
        copy: {
          type: "string",
          ifc: { confidentiality: ["secret"], ...ifc },
        },
      },
      required: ["source", "copy"],
    } as JSONSchema;
    const target = runtime.getCell(space, "ingested");
    const { id } = target.getAsNormalizedFullLink();
    const { error } = await runtime.editWithRetry((tx) => {
      stampExternalIngest(tx, {
        channel: MARK.channel,
        audience: MARK.audience,
        receivedAt: MARK.receivedAt,
        valueDigest: MARK.valueDigest,
        target: { space, id, scope: "space", path: [] },
      });
      runtime!.getCell(space, "ingested", schema, tx).set(value as never);
    });
    expect(error).toBeUndefined();
    const read = runtime.edit();
    const entries =
      readStoredCfcMetadata(read, target.getAsNormalizedFullLink())
        ?.labelMap.entries ?? [];
    read.abort();
    return entries;
  };

  describe("an ingest whose payload fails a write-side claim", () => {
    // The ingest mark is the runtime's provenance for the value, whatever the
    // payload's own schema says of it, so it persists; the payload's
    // unverified declared policy does not.

    for (
      const [name, ifc, value] of [
        ["its click claim", {
          uiContract: {
            helper: "UiAction",
            action: "Confirm",
            trustedPattern: "ConfirmSurface",
            requiredEventIntegrity: ["ConfirmSurface"],
          },
        }, { source: "a", copy: "a" }],
        ["its copy claim", { exactCopyOf: ["source"] }, {
          source: "a",
          copy: "b",
        }],
      ] as const
    ) {
      it(`persists the mark and no declared policy where the payload fails ${name}`, async () => {
        const entries = await ingest(ifc, value);
        expect(entries.flatMap((entry) => entry.label.integrity ?? []))
          .toContainEqual(MARK);
        expect(entries.filter((entry) => entry.origin === "declared"))
          .toEqual([]);
      });
    }

    it("persists the mark and the declared policy where the payload meets its copy claim", async () => {
      const entries = await ingest({ exactCopyOf: ["source"] }, {
        source: "a",
        copy: "a",
      });
      expect(entries.flatMap((entry) => entry.label.integrity ?? []))
        .toContainEqual(MARK);
      expect(
        entries.filter((entry) => entry.origin === "declared").map((entry) =>
          entry.path
        ),
      ).toContainEqual(["copy"]);
    });
  });
});
