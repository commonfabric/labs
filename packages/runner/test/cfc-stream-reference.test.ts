import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { cfcAtom } from "@commonfabric/api/cfc";
import {
  fabricFromJsonValue,
  jsonFromFabricValue,
} from "@commonfabric/data-model/codecs";
import { Identity } from "@commonfabric/identity";

import { normalizeClause } from "../src/cfc/clause.ts";
import {
  restoreRuntimeEventDispatch,
  serializeRuntimeEvent,
} from "../src/cfc/event-reference-context.ts";
import { immutableReferenceEntries } from "../src/cfc/immutable-reference.ts";
import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import { getCfcReferenceView } from "../src/cfc/reference-provenance.ts";
import { Runtime } from "../src/runtime.ts";
import { MAX_EVENT_BACKLOG_PER_STREAM } from "../src/scheduler/constants.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("stream-reference");
const space = signer.did();
const secret = normalizeClause({ anyOf: ["selection", cfcAtom.space(space)] });

describe("CFC stream references", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storage,
      cfcFlowLabels: "persist",
      cfcWriteFloor: "enforce",
    });
  });

  afterEach(async () => {
    await storage.synced();
    await runtime.dispose();
    await storage.close();
  });

  async function selectedStream(version: 1 | 2 | 3) {
    const tx = runtime.edit();
    const stream = runtime.getCell(space, "stream", undefined, tx);
    stream.setRaw({ $stream: true });
    const source = runtime.getCell(space, "selected-stream", undefined, tx);
    writeSeedEnvelopeDoc(tx, space);
    seedStoredEnvelope(tx, { ...source.getAsNormalizedFullLink(), path: [] }, {
      value: { selected: stream.getAsLink() },
      cfc: {
        version,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: version === 1 ? [] : [{
            path: ["selected"],
            origin: "link",
            observes: "followRef",
            referenceAcquisition: "complete",
            label: { confidentiality: [secret] },
          }],
        },
      },
    });
    expect((await tx.commit()).ok).toBeDefined();
    await storage.synced();
    return {
      stream: stream.withTx(undefined),
      selected: source.withTx(undefined).key("selected"),
    };
  }

  for (const explicitTx of [false, true]) {
    for (const serverExecution of [false, true]) {
      it(`refuses an incomplete stored stream before dispatch (transaction=${explicitTx}, server=${serverExecution})`, async () => {
        const { stream, selected } = await selectedStream(1);
        runtime.experimental.serverExecution = serverExecution;
        const append = spy(storage.open(space).replica, "enqueueEventAppend");
        let runs = 0;
        runtime.scheduler.addEventHandler(() => {
          runs++;
        }, stream.getAsNormalizedFullLink());
        const tx = explicitTx ? runtime.edit() : undefined;
        try {
          expect(() => selected.withTx(tx).send(7)).toThrow(
            "Reference acquisition lacks complete legacy provenance",
          );
        } finally {
          tx?.abort();
          append.restore();
        }
        await runtime.scheduler.idle();
        expect(runs).toBe(0);
        expect(append.calls).toHaveLength(0);
      });
    }
  }

  for (const held of [false, true]) {
    it(`carries stream selection into a handler with a primitive event (held=${held})`, async () => {
      const { stream, selected } = await selectedStream(3);
      const acquire = runtime.edit();
      const acquired = held
        ? selected.withTx(acquire).resolveAsCell().withTx(undefined)
        : selected;
      acquire.abort();
      const result = runtime.getCell<number>(space, "result");
      let runs = 0;
      let confidentiality: readonly unknown[] = [];
      runtime.scheduler.addEventHandler((tx, event: number) => {
        runs++;
        confidentiality = deriveFlowJoin(tx).confidentiality;
        result.withTx(tx).set(event);
      }, stream.getAsNormalizedFullLink());
      acquired.send(7);
      await runtime.scheduler.idle();
      expect(runs).toBe(1);
      expect(confidentiality).toContainEqual(secret);
      expect(await result.pull()).toBe(7);
    });
  }

  it("retains dispatch confidentiality through durable encoding and local cascades", async () => {
    const { stream, selected } = await selectedStream(3);
    const send = runtime.edit();
    const acquired = selected.withTx(send).resolveAsCell()
      .getAsNormalizedFullLink();
    const encoded = serializeRuntimeEvent(7, send, space, acquired);
    send.abort();
    const { payload, target } = restoreRuntimeEventDispatch(
      fabricFromJsonValue(jsonFromFabricValue(encoded.payload)),
      encoded.runtimeReferenceContext,
      stream.getAsNormalizedFullLink(),
    );
    const create = runtime.edit();
    const next = runtime.getCell(space, "cascade", undefined, create);
    next.setRaw({ $stream: true });
    expect((await create.commit()).ok).toBeDefined();
    const observed: Array<readonly unknown[]> = [];
    const result = runtime.getCell<number>(space, "cascade-result");
    runtime.scheduler.addEventHandler((tx, event: number) => {
      observed.push(deriveFlowJoin(tx).confidentiality);
      next.withTx(tx).send(event + 1);
    }, stream.getAsNormalizedFullLink());
    runtime.scheduler.addEventHandler((tx, event: number) => {
      observed.push(deriveFlowJoin(tx).confidentiality);
      result.withTx(tx).set(event);
    }, next.getAsNormalizedFullLink());
    runtime.scheduler.queueEvent(target, payload);
    await runtime.scheduler.idle();
    expect(observed).toHaveLength(2);
    for (const confidentiality of observed) {
      expect(confidentiality).toContainEqual(secret);
    }
    expect(await result.pull()).toBe(8);
  });

  for (const readContent of [false, true]) {
    it(`carries stream content confidentiality only when the sender reads it (read=${readContent})`, async () => {
      const { stream } = await selectedStream(3);
      const seed = runtime.edit();
      seedStoredEnvelope(
        seed,
        { ...stream.getAsNormalizedFullLink(), path: [] },
        {
          value: { $stream: true },
          cfc: {
            version: 3,
            schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
            labelMap: {
              version: 1,
              entries: [{ path: [], label: { confidentiality: [secret] } }],
            },
          },
        },
      );
      expect((await seed.commit()).ok).toBeDefined();
      const observed: Array<readonly unknown[]> = [];
      runtime.scheduler.addEventHandler((tx) => {
        observed.push(deriveFlowJoin(tx).confidentiality);
      }, stream.getAsNormalizedFullLink());
      const sender = runtime.edit();
      if (readContent) {
        expect(stream.withTx(sender).getRaw()).toEqual({ $stream: true });
      }
      stream.withTx(sender).send(7);
      expect((await sender.commit()).ok).toBeDefined();
      await runtime.scheduler.idle();
      expect(observed).toHaveLength(1);
      if (readContent) expect(observed[0]).toContainEqual(secret);
      else expect(observed[0]).toEqual([]);
    });
  }

  it("carries a resolved immutable-container stream's selection through dispatch", async () => {
    // The container's acquisition table proves the hop before serialization.
    // Dispatch consumes the resolved stream's identity and sends only the
    // event payload to the handler.

    const { stream, selected } = await selectedStream(3);
    const acquire = runtime.edit();
    const box = runtime.getImmutableCell(
      space,
      {
        stream: selected.withTx(acquire).resolveAsCell(),
      },
      undefined,
      acquire,
    );
    const target = box.key("stream").resolveAsCell().getAsNormalizedFullLink();
    expect(immutableReferenceEntries(getCfcReferenceView(target)).length)
      .toBeGreaterThan(0);
    const event = serializeRuntimeEvent(7, acquire, space, target);
    acquire.abort();
    const restored = restoreRuntimeEventDispatch(
      fabricFromJsonValue(jsonFromFabricValue(event.payload)),
      event.runtimeReferenceContext,
      stream.getAsNormalizedFullLink(),
    );
    const observed: Array<readonly unknown[]> = [];
    runtime.scheduler.addEventHandler((tx) => {
      observed.push(deriveFlowJoin(tx).confidentiality);
    }, stream.getAsNormalizedFullLink());
    runtime.scheduler.queueEvent(restored.target, restored.payload);
    await runtime.scheduler.idle();
    expect(observed).toHaveLength(1);
    expect(observed[0]).toContainEqual(secret);
  });

  it("retains a private selection when its event replaces a public backlog entry", async () => {
    const { stream, selected } = await selectedStream(3);
    const observed: Array<
      { event: number; confidentiality: readonly unknown[] }
    > = [];
    runtime.scheduler.addEventHandler((tx, event: number) => {
      observed.push({
        event,
        confidentiality: deriveFlowJoin(tx).confidentiality,
      });
    }, stream.getAsNormalizedFullLink());
    for (let i = 0; i < MAX_EVENT_BACKLOG_PER_STREAM; i++) stream.send(i);
    selected.send(999);
    await runtime.scheduler.idle();
    expect(observed).toHaveLength(MAX_EVENT_BACKLOG_PER_STREAM);
    expect(observed.at(-1)?.event).toBe(999);
    expect(observed.at(-1)?.confidentiality).toContainEqual(secret);
  });
});
