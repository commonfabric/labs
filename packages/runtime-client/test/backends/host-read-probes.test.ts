/**
 * The worker's own answers to a host, under the ceiling a viewer's worker is
 * initialized with: what a host could read past the gate before the gate was
 * turned on, and must not now. Each document the visitor may not see carries
 * a key and a value that appear nowhere else, so a search of what the host
 * was sent for either is a search for the document having escaped.
 */

import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { cfcAtom } from "@commonfabric/api/cfc";
import type { FabricValue } from "@commonfabric/data-model";
import { fabricFromRealmValue } from "@commonfabric/data-model/codecs";
import { Identity } from "@commonfabric/identity";
import { defaultRenderConfidentialityCeiling } from "@commonfabric/lib-shell/runtime";
import { type Cell, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../../../runner/test/cfc-seed-envelope.ts";
import type { RuntimeProcessor } from "@/backends/runtime-processor.ts";
import { createCellRef } from "@/backends/utils.ts";
import { RequestType } from "@/protocol/mod.ts";
import { buildProcessor } from "./build-processor.ts";

const owner = await Identity.fromPassphrase("host read probes owner");
const visitor = await Identity.fromPassphrase("host read probes visitor");
const space = owner.did();
const ownerOnly = cfcAtom.user(owner.did());
const SECRET_KEY = "alice-secret-key@example.invalid";
const SECRET_VALUE = "telemetry-secret-value";

/** A runtime holding documents the owner wrote, labeled as each case asks. */
function shelf() {
  const storageManager = StorageManager.emulate({ as: owner });
  const runtime = new Runtime({
    storageManager,
    apiUrl: new URL("http://localhost"),
  });
  const write = async (
    id: string,
    value: unknown,
    labels: readonly [string[], readonly unknown[]][],
  ): Promise<Cell<unknown>> => {
    const tx = runtime.edit();
    const cell = runtime.getCell(space, id, undefined, tx);
    writeSeedEnvelopeDoc(tx, space);
    seedStoredEnvelope(tx, {
      space,
      id: cell.getAsNormalizedFullLink().id!,
      type: "application/json",
      path: [],
    }, {
      value,
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: labels.map(([path, confidentiality]) => ({
            path,
            label: { confidentiality },
          })),
        },
      },
    } as FabricValue);
    expect((await tx.commit()).ok).toBeDefined();
    return runtime.getCell(space, id);
  };
  return {
    runtime,
    write,
    async [Symbol.asyncDispose]() {
      await runtime.dispose();
      await storageManager.close();
    },
  };
}

/** A worker's processor for `viewer`, with the shell's default ceiling. */
function processorFor(runtime: Runtime, viewer: Identity): RuntimeProcessor {
  const processor = buildProcessor({
    runtime,
    identity: viewer,
    space: viewer.did(),
    telemetry: runtime.telemetry,
  });
  processor.accessForTestingOnly.renderConfidentialityCeiling =
    defaultRenderConfidentialityCeiling(viewer.did()) as never;
  return processor;
}

/** Whether `text` appears anywhere in `answer`. */
function holds(answer: unknown, text: string): boolean {
  return JSON.stringify(answer ?? null).includes(text);
}

describe("a worker initialized with the display ceiling", () => {
  it("refuses a visitor a read of a document only its owner may see", async () => {
    await using docs = shelf();
    const sealed = await docs.write("sealed", { note: SECRET_VALUE }, [
      [[], [ownerOnly]],
    ]);
    await docs.runtime.idle();

    const toVisitor = processorFor(docs.runtime, visitor).handleCellGet({
      type: RequestType.CellGet,
      cell: createCellRef(sealed, true),
    });
    const toOwner = processorFor(docs.runtime, owner).handleCellGet({
      type: RequestType.CellGet,
      cell: createCellRef(sealed, true),
    });

    expect(toVisitor).toEqual({ refused: { refusedBy: "display-ceiling" } });
    expect(holds(toOwner, SECRET_VALUE)).toBe(true);
  });

  it("gives a visitor's label read of such a document none of its field names", async () => {
    await using docs = shelf();
    const sealed = await docs.write("contacts", { [SECRET_KEY]: "x" }, [
      [[], [ownerOnly]],
      [[SECRET_KEY], [ownerOnly]],
    ]);
    await docs.runtime.idle();
    const request = {
      type: RequestType.CellGetCfcLabel,
      cell: createCellRef(sealed, true),
    } as const;

    const toVisitor = processorFor(docs.runtime, visitor).handleCellGetCfcLabel(
      request,
    );
    const toOwner = processorFor(docs.runtime, owner).handleCellGetCfcLabel(
      request,
    );

    expect(holds(toVisitor, SECRET_KEY)).toBe(false);
    expect(toVisitor.cfcLabel).toBeDefined();
    expect(holds(toOwner, SECRET_KEY)).toBe(true);
  });

  it("posts a visitor no telemetry that carries a value only its owner may see", async () => {
    await using docs = shelf();
    const posted: unknown[] = [];
    const original = (globalThis as { postMessage?: unknown }).postMessage;
    (globalThis as { postMessage: (message: unknown) => void }).postMessage = (
      message,
    ) => posted.push(fabricFromRealmValue(message as never));
    try {
      const processor = processorFor(docs.runtime, visitor);
      processor.setTelemetryEnabled({
        type: RequestType.SetTelemetryEnabled,
        enabled: true,
      });
      const cell = await docs.write("sealed-later", { note: "public" }, [
        [[], [ownerOnly]],
      ]);
      await docs.runtime.idle();
      const tx = docs.runtime.edit();
      cell.withTx(tx).set({ note: SECRET_VALUE });
      await tx.commit();
      await docs.runtime.idle();

      expect(posted.length).toBeGreaterThan(0);
      expect(holds(posted, SECRET_VALUE)).toBe(false);
    } finally {
      if (original === undefined) {
        delete (globalThis as { postMessage?: unknown }).postMessage;
      } else {
        (globalThis as { postMessage?: unknown }).postMessage = original;
      }
    }
  });
});
