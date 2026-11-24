import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { internSchemaAsTaggedHashString } from "@commonfabric/data-model-schema";
import { Identity } from "@commonfabric/identity";
import type { URI } from "@commonfabric/memory/interface";

import type { JSONSchema } from "../../src/builder/types.ts";
import { legacyPieceCreatorEvidence } from "../../src/cfc/piece-creator-evidence.ts";
import type { LabelMapEntry } from "../../src/cfc/types.ts";
import type { NormalizedFullLink } from "../../src/link-types.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import { seedStoredEnvelope } from "../cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("piece creator evidence");
const space = signer.did();
const alice = (await Identity.fromPassphrase("piece creator evidence alice"))
  .did();
const bob = (await Identity.fromPassphrase("piece creator evidence bob")).did();

/** A document schema whose `notes` field the acting principal owns. */
const SCHEMA = {
  type: "object",
  properties: {
    notes: {
      type: "array",
      items: { type: "string" },
      ifc: { ownerPrincipal: { __ctCurrentPrincipal: true } },
    },
    other: { type: "string" },
  },
} as const satisfies JSONSchema;
const SCHEMA_HASH = internSchemaAsTaggedHashString(SCHEMA);

const represents = (subject: string) => ({
  integrity: [{ kind: "represents-principal", subject }],
});

describe("legacyPieceCreatorEvidence()", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let documents = 0;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /**
   * Stores a document labeled by `entries` under `SCHEMA`, in an envelope of
   * `version`, and returns its address.
   */
  const seed = async (
    entries: LabelMapEntry[],
    version = 1,
  ): Promise<NormalizedFullLink> => {
    const id = `of:piece-creator-evidence-${documents++}` as URI;
    const tx = runtime.edit();
    tx.writeOrThrow({
      space,
      scope: "space",
      id: `cid:${SCHEMA_HASH}` as URI,
      path: [],
    }, { value: SCHEMA });
    seedStoredEnvelope(tx, { space, scope: "space", id, path: [] }, {
      value: { notes: [], other: "" },
      cfc: {
        version,
        schemaHash: SCHEMA_HASH,
        labelMap: { version: 1, entries },
      },
    });
    expect((await tx.commit().settled).error).toBeUndefined();
    return { space, scope: "space", id, path: [] };
  };

  const evidence = (documents: NormalizedFullLink[]): string | undefined => {
    const tx = runtime.edit();
    try {
      return legacyPieceCreatorEvidence(tx, documents);
    } finally {
      tx.abort();
    }
  };

  it("returns the principal declared claims at owned fields name, whatever else names someone else", async () => {
    const document = await seed([
      { path: ["notes"], label: represents(alice), origin: "declared" },
      { path: ["notes"], label: represents(bob), origin: "derived" },
      { path: ["other"], label: represents(bob), origin: "declared" },
    ]);
    expect(evidence([document])).toBe(alice);
  });

  it("returns `undefined` for owned fields that name two principals", async () => {
    const first = await seed([
      { path: ["notes"], label: represents(alice), origin: "declared" },
    ]);
    const second = await seed([{ path: ["notes"], label: represents(bob) }]);
    expect(evidence([first])).toBe(alice);
    expect(evidence([first, second])).toBeUndefined();
  });

  it("returns `undefined` when one document's envelope cannot be read", async () => {
    const readable = await seed([
      { path: ["notes"], label: represents(alice), origin: "declared" },
    ]);
    const unreadable = await seed([
      { path: ["notes"], label: represents(alice), origin: "declared" },
    ], 3);
    expect(evidence([readable])).toBe(alice);
    expect(evidence([readable, unreadable])).toBeUndefined();
  });
});
