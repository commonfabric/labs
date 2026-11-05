import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { rawMetaWriteAuthorization } from "../src/meta-seam.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("read-only-sink");
const space = signer.did();
const schema = {
  type: "object",
  properties: {
    trigger: { type: "number" },
    child: { type: "number", asCell: ["cell"] },
  },
  required: ["trigger", "child"],
} as const;

/** Constructs a labeled source and records the transactions sinks prepare. */
const setup = async (separateChild = false) => {
  const storage = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    storageManager: storage,
    apiUrl: new URL(import.meta.url),
  });
  const source = runtime.getCell<{ trigger: number; child: number }>(
    space,
    "source",
  );
  const address = source.getAsNormalizedFullLink();
  const child = runtime.getCell<number>(space, "child");
  const write = async (trigger: number, integrity: string) => {
    const tx = runtime.edit();
    writeSeedEnvelopeDoc(tx, space);
    if (separateChild) child.withTx(tx).set(1);
    seedStoredEnvelope(tx, { ...address, path: [] }, {
      value: { trigger, child: separateChild ? child.getAsLink() : 1 },
      cfc: {
        version: 1,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: {
          version: 1,
          entries: [{ path: [], label: { integrity: [integrity] } }],
        },
      },
    });
    expect((await tx.commit().settled).error).toBeUndefined();
    await runtime.idle();
  };
  await write(0, "first-author");
  const prepared: IExtendedStorageTransaction[] = [];
  const prepare = runtime.prepareTxForCommit.bind(runtime);
  runtime.prepareTxForCommit = (tx) => {
    prepared.push(tx);
    prepare(tx);
  };
  return {
    runtime,
    source,
    child,
    prepared,
    write,
    dispose: async () => {
      await storage.synced();
      await runtime.dispose({ closeStorage: false });
      await storage.close();
    },
  };
};

describe("read-only Cell subscriptions", () => {
  it("keeps initial and rerun transactions read-only while preserving child dependency isolation and cancellation", async () => {
    const { runtime, source, child, prepared, dispose } = await setup(true);
    try {
      const seen: number[] = [];
      const cancel = source.asSchema(schema).sink((value) => {
        seen.push(value.trigger);
        expect(value.child.get()).toBeGreaterThan(0);
        expect(() => value.child.set(99)).toThrow("read-only transaction");
      }, { readOnly: true });
      expect(seen).toEqual([0]);
      expect(prepared).toHaveLength(2);
      expect(prepared.some((tx) => tx.getCfcState().relevant)).toBe(true);
      for (const tx of prepared) {
        expect(tx.isReadOnly?.()).toBe(true);
        expect(tx.getCfcState().prepare.status).toBe("unprepared");
      }
      const childWrite = runtime.edit();
      child.withTx(childWrite).set(2);
      expect((await childWrite.commit().settled).error).toBeUndefined();
      await runtime.idle();
      expect(seen).toEqual([0]);
      const triggerWrite = runtime.edit();
      source.withTx(triggerWrite).key("trigger").set(1);
      expect((await triggerWrite.commit().settled).error).toBeUndefined();
      await runtime.idle();
      expect(seen).toEqual([0, 1]);
      expect(prepared.length).toBeGreaterThanOrEqual(4);
      for (const tx of prepared) {
        expect(tx.isReadOnly?.()).toBe(true);
        expect(tx.getCfcState().prepare.status).toBe("unprepared");
      }
      expect(source.key("child").get()).toBe(2);
      cancel();
      const afterCancel = runtime.edit();
      source.withTx(afterCancel).key("trigger").set(2);
      expect((await afterCancel.commit().settled).error).toBeUndefined();
      await runtime.idle();
      expect(seen).toEqual([0, 1]);
    } finally {
      await dispose();
    }
  });

  it("rejects unsupported read-only transactions before delivering a callback", async () => {
    const { runtime, source, dispose } = await setup();
    const edit = runtime.edit.bind(runtime);
    const opened: IExtendedStorageTransaction[] = [];
    runtime.edit = (...args) => {
      const tx = edit(...args);
      opened.push(tx);
      return new Proxy(tx, {
        get(target, prop) {
          if (prop === "setReadOnly") return undefined;
          const member = Reflect.get(target, prop, target);
          return typeof member === "function" ? member.bind(target) : member;
        },
      });
    };
    try {
      let deliveries = 0;
      expect(() =>
        source.sink(() => {
          deliveries++;
        }, { readOnly: true })
      )
        .toThrow(
          "Read-only subscriptions require transaction read-only support.",
        );
      expect(deliveries).toBe(0);
      expect(opened.length).toBeGreaterThan(0);
      expect(opened.at(-1)!.getCfcState().prepare.status).toBe("unprepared");
    } finally {
      runtime.edit = edit;
      for (const tx of opened) tx.abort();
      await dispose();
    }
  });

  it("keeps ordinary sink callback child writes writable and committed", async () => {
    const { runtime, source, dispose } = await setup();
    try {
      const cancel = source.asSchema(schema).sink((value) => {
        value.child.set(9);
      });
      await runtime.idle();
      expect(source.key("child").get()).toBe(9);
      cancel();
    } finally {
      await dispose();
    }
  });

  it("re-fires on label-only changes without preparing its read-only transactions", async () => {
    const { source, prepared, write, dispose } = await setup();
    try {
      const labels: unknown[] = [];
      const values: unknown[] = [];
      const cancel = source.sink((value, label) => {
        values.push(value);
        labels.push(label);
      }, { readOnly: true, includeCfcLabel: true });
      expect(labels).toHaveLength(1);
      await write(0, "second-author");
      expect(labels).toHaveLength(2);
      expect(values).toEqual([{ trigger: 0, child: 1 }, {
        trigger: 0,
        child: 1,
      }]);
      expect(JSON.stringify(labels[0])).toContain("first-author");
      expect(JSON.stringify(labels[1])).toContain("second-author");
      for (const tx of prepared) {
        expect(tx.isReadOnly?.()).toBe(true);
        expect(tx.getCfcState().prepare.status).toBe("unprepared");
      }
      cancel();
    } finally {
      await dispose();
    }
  });
  it("keeps metadata subscription transactions read-only on initial delivery and updates", async () => {
    const { runtime, prepared, dispose } = await setup();
    try {
      const cell = runtime.getCell(space, "metadata");
      const write = async (identity: string) => {
        const tx = runtime.edit();
        cell.withTx(tx).setMetaRaw("patternIdentity", {
          identity,
          symbol: "default",
        }, rawMetaWriteAuthorization);
        expect((await tx.commit().settled).error).toBeUndefined();
        await runtime.idle();
      };
      await write("first");
      const seen: unknown[] = [];
      const cancel = cell.sinkMeta("patternIdentity", (value) => {
        seen.push(value);
      }, { readOnly: true });
      expect(prepared).toHaveLength(1);
      await write("second");
      expect(seen).toEqual([
        { identity: "first", symbol: "default" },
        { identity: "second", symbol: "default" },
      ]);
      expect(prepared.length).toBeGreaterThanOrEqual(2);
      for (const tx of prepared) expect(tx.isReadOnly?.()).toBe(true);
      cancel();
    } finally {
      await dispose();
    }
  });
});
