import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import { type Cell, Runtime, writtenPrincipalAt } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "../../runner/test/cfc-seed-envelope.ts";
import { createCellRef } from "@/backends/utils.ts";
import type { CellHandle } from "@/cell-handle.ts";
import {
  observeRepresentedPrincipal,
  observeWrittenPrincipal,
  type WrittenValue,
} from "@/written-principal.ts";
import { attachedClient } from "./attached-client.ts";

const signer = await Identity.fromPassphrase("written-principal owner", {
  implementation: "noble",
});
const OWNER = signer.did();
const VISITOR = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";

const picture = new FabricBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

/** What a cell refused, or held without its principal, reports. */
const NOTHING = { value: undefined, principal: undefined };

/** The part of a profile these cases read. */
const PROFILE_SCHEMA = {
  type: "object",
  properties: { picture: { type: "FabricBytes" } },
} as const;

/** A label whose root says its value represents each of `subjects`. */
const representing = (...subjects: string[]) => ({
  version: 1 as const,
  entries: [{
    path: [],
    label: {
      integrity: subjects.map((subject) => ({
        kind: "represents-principal",
        subject,
      })),
    },
  }],
});

/**
 * A runtime holding a profile in `OWNER`'s space, with a client attached over
 * a channel. `store()` stores a document with a root label representing each
 * of `by`, or with no label for none; `point()` stores what the profile's
 * `picture` field holds. `field()` is a new handle on that field, as a host
 * binds one.
 */
async function profileSpace() {
  const storage = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("http://localhost/"),
    storageManager: storage,
  });
  const cause = `written-principal-${crypto.randomUUID()}`;
  const cellAt = (name: string) =>
    runtime.getCell<unknown>(OWNER, `${cause}-${name}`);
  const store = async (
    name: string,
    value: FabricValue,
    ...by: string[]
  ): Promise<Cell<unknown>> => {
    const cell = cellAt(name);
    const tx = runtime.edit();
    writeSeedEnvelopeDoc(tx, OWNER);
    seedStoredEnvelope(tx, { ...cell.getAsNormalizedFullLink(), path: [] }, {
      value,
      ...(by.length === 0 ? {} : {
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: representing(...by),
        },
      }),
    } as FabricValue);
    const { error } = await tx.commit().settled;
    if (error) throw new Error(`The commit failed: ${error.name}`);
    await runtime.scheduler.idleWithPendingCommits();
    return cell;
  };
  const point = (held: FabricValue) =>
    store("profile", { name: "Ada", picture: held }, OWNER);
  const client = await attachedClient(runtime, signer, OWNER);
  return {
    runtime,
    store,
    point,
    field: () =>
      client.getCellFromRef(createCellRef(cellAt("profile")))
        .asSchema<{ picture?: FabricBytes }>(PROFILE_SCHEMA)
        .key("picture"),
    /** The principal the runtime itself reads for the profile's field. */
    writtenPrincipal: () => {
      const tx = runtime.edit();
      try {
        return writtenPrincipalAt(
          tx,
          cellAt("profile").asSchema(PROFILE_SCHEMA).key("picture"),
        );
      } finally {
        tx.abort();
      }
    },
    [Symbol.asyncDispose]: async () => {
      await client.dispose();
      await runtime.dispose();
      await storage.close();
    },
  };
}

/**
 * Observes `cell`, collecting every report: `reported(n)` resolves once
 * there have been `n`, at once when there have already.
 */
const observe = (cell: CellHandle<FabricBytes | undefined>) => {
  const reports: WrittenValue<FabricBytes | undefined>[] = [];
  const checks: (() => void)[] = [];
  const cancel = observeWrittenPrincipal(cell, (written) => {
    reports.push(written);
    for (const check of checks) check();
  });
  const reported = (count: number): Promise<void> =>
    new Promise((resolve) => {
      const check = () => {
        if (reports.length >= count) resolve();
      };
      check();
      checks.push(check);
    });
  return { reports, reported, cancel };
};

/**
 * A stand-in handle whose subscribers hear `value` with `label` at once, as
 * the label the worker read with it only when `current`, and hear `refuse()`
 * and the deliveries `deliver()` and `writeLocally()` send.
 */
const fakeCell = (value: unknown, label: unknown, current: boolean) => {
  const subscribers = new Set<{
    onValue: (
      value: unknown,
      label?: unknown,
      delivery?: { cfcLabelCurrent: boolean },
    ) => void;
    onRefused: () => void;
  }>();
  let held: [unknown, unknown] = [value, label];
  const handle = {
    asSchema: () => handle,
    subscribe: (
      onValue: (
        value: unknown,
        label?: unknown,
        delivery?: { cfcLabelCurrent: boolean },
      ) => void,
      options: { onRefused: () => void },
    ) => {
      const subscriber = { onValue, onRefused: options.onRefused };
      subscribers.add(subscriber);
      onValue(held[0], held[1], { cfcLabelCurrent: current });
      return () => subscribers.delete(subscriber);
    },
  };
  return {
    handle: handle as unknown as CellHandle<unknown>,
    deliver: (value: unknown, label: unknown) => {
      held = [value, label];
      for (const { onValue } of subscribers) {
        onValue(value, label, { cfcLabelCurrent: true });
      }
    },
    writeLocally: (value: unknown) => {
      held = [value, held[1]];
      for (const { onValue } of subscribers) {
        onValue(value, held[1], { cfcLabelCurrent: false });
      }
    },
    refuse: () => {
      for (const { onRefused } of subscribers) onRefused();
    },
  };
};

describe("written-principal", () => {
  describe("observeWrittenPrincipal()", () => {
    it("reports the value with the principal its own cell's label names, once the worker has read both", async () => {
      await using profile = await profileSpace();
      const cell = await profile.store("picture", picture, OWNER);
      await profile.point(cell.getAsWriteRedirectLink());
      const { reports, reported } = observe(profile.field());
      await reported(1);

      expect(reports).toEqual([{ value: picture, principal: OWNER }]);
    });

    it("reports the visitor for a value a visitor wrote", async () => {
      await using profile = await profileSpace();
      const cell = await profile.store("picture", picture, VISITOR);
      await profile.point(cell.getAsWriteRedirectLink());
      const { reports, reported } = observe(profile.field());
      await reported(1);

      expect(reports).toEqual([{ value: picture, principal: VISITOR }]);
    });

    it("reports no principal for a value stored without a label, or one said to represent two principals", async () => {
      for (const by of [[], [OWNER, VISITOR]]) {
        await using profile = await profileSpace();
        const cell = await profile.store("picture", picture, ...by);
        await profile.point(cell.getAsWriteRedirectLink());
        const { reports, reported } = observe(profile.field());
        await reported(1);

        expect(reports).toEqual([{ value: picture, principal: undefined }]);
      }
    });

    it("reports no principal for a value held in the profile's own document, whose label names the owner", async () => {
      await using profile = await profileSpace();
      await profile.point(picture);
      const { reports, reported } = observe(profile.field());
      await reported(1);

      expect(reports).toEqual([{ value: picture, principal: undefined }]);
    });

    it("reports no principal for a cell holding a link to a value its owner wrote", async () => {
      await using profile = await profileSpace();
      const elsewhere = await profile.store("elsewhere", picture, OWNER);
      const cell = await profile.store("picture", elsewhere.getAsLink(), OWNER);
      await profile.point(cell.getAsWriteRedirectLink());
      const { reports, reported } = observe(profile.field());
      await reported(1);

      expect(reports).toEqual([{ value: picture, principal: undefined }]);
    });

    it("reports the principal of the cell a relinked field then writes to, and of a cell relabeled under it", async () => {
      await using profile = await profileSpace();
      const visitors = await profile.store("by-visitor", picture, VISITOR);
      await profile.point(visitors.getAsWriteRedirectLink());
      const { reports, reported } = observe(profile.field());
      await reported(1);

      const owners = await profile.store("by-owner", picture, OWNER);
      await profile.point(owners.getAsWriteRedirectLink());
      await reported(2);
      expect(reports.at(-1)).toEqual({ value: picture, principal: OWNER });

      await profile.store("by-owner", picture, VISITOR);
      await reported(3);

      expect(reports).toEqual([
        { value: picture, principal: VISITOR },
        { value: picture, principal: OWNER },
        { value: picture, principal: VISITOR },
      ]);
    });

    it("reports no principal once the field holds a plain link to the cell it wrote to", async () => {
      await using profile = await profileSpace();
      const cell = await profile.store("picture", picture, OWNER);
      await profile.point(cell.getAsWriteRedirectLink());
      const { reports, reported } = observe(profile.field());
      await reported(1);

      await profile.point(cell.getAsLink());
      await reported(2);

      expect(reports).toEqual([
        { value: picture, principal: OWNER },
        { value: picture, principal: undefined },
      ]);
    });

    it("reports the principal to a handle that joins a subscription another handle opened without it", async () => {
      await using profile = await profileSpace();
      const cell = await profile.store("picture", picture, OWNER);
      await profile.point(cell.getAsWriteRedirectLink());
      const labeled = Promise.withResolvers<void>();
      const cancelLabeled = profile.field().subscribe((_value, _label, at) => {
        if (at?.cfcLabelCurrent === true) labeled.resolve();
      }, { includeCfcLabel: true, onRefused: () => {} });
      await labeled.promise;

      const { reports, cancel } = observe(profile.field());
      // A read answered over the channel the worker delivers on comes after
      // what the worker delivered for the requests sent before it.
      await profile.field().sync();

      expect(reports).toEqual([{ value: picture, principal: OWNER }]);
      cancel();
      cancelLabeled();
    });

    it("reports the principal through a handle already subscribed without it", async () => {
      await using profile = await profileSpace();
      const cell = await profile.store("picture", picture, OWNER);
      await profile.point(cell.getAsWriteRedirectLink());
      const field = profile.field();
      const valued = Promise.withResolvers<void>();
      const cancelValued = field.subscribe((value) => {
        if (value !== undefined) valued.resolve();
      }, { onRefused: () => {} });
      await valued.promise;

      const { reports, cancel } = observe(field);
      // A read answered over the channel the worker delivers on comes after
      // what the worker delivered for the requests sent before it.
      await profile.field().sync();

      expect(reports).toEqual([{ value: picture, principal: OWNER }]);
      cancel();
      cancelValued();
    });

    it("reports neither once a write through the handle holds a value the worker has not read, and what the worker reads once it has", async () => {
      await using profile = await profileSpace();
      const cell = await profile.store("picture", picture, OWNER);
      await profile.point(cell.getAsWriteRedirectLink());
      const field = profile.field();
      const { reports, reported } = observe(field);
      await reported(1);

      const written = new FabricBytes(new Uint8Array([1, 2]));
      field.set(written);
      expect(reports.at(-1)).toEqual(NOTHING);

      await field.sync();
      await profile.runtime.scheduler.idleWithPendingCommits();
      await reported(3);
      expect(reports.at(-1)).toEqual({
        value: written,
        principal: profile.writtenPrincipal(),
      });
    });

    it("reports nothing once cancelled", async () => {
      await using profile = await profileSpace();
      const cell = await profile.store("picture", picture, OWNER);
      await profile.point(cell.getAsWriteRedirectLink());
      const cancelled = observe(profile.field());
      const witness = observe(profile.field());
      await Promise.all([cancelled.reported(1), witness.reported(1)]);

      cancelled.cancel();
      await profile.store("picture", picture, VISITOR);
      // The witness hears the relabel over the channel the cancelled
      // observation would have heard it on.
      await witness.reported(2);

      expect(cancelled.reports).toEqual([{ value: picture, principal: OWNER }]);
      witness.cancel();
    });

    it("reports neither for a cell the worker refuses, and nothing for a delivery without the label the worker read before that", () => {
      const cell = fakeCell(undefined, undefined, false);
      const reports: WrittenValue<unknown>[] = [];
      observeWrittenPrincipal(cell.handle, (written) => reports.push(written));
      expect(reports).toEqual([]);

      cell.refuse();

      expect(reports).toEqual([NOTHING]);
    });
  });

  describe("observeRepresentedPrincipal()", () => {
    /** Observes `cell`, and returns every principal it reported. */
    const observeOwner = (cell: CellHandle<unknown>) => {
      const owners: (string | undefined)[] = [];
      observeRepresentedPrincipal(cell, (owner) => owners.push(owner));
      return owners;
    };

    it("reports the principal a profile's label names", () => {
      const profile = fakeCell({ name: "Bob" }, representing(OWNER), true);

      expect(observeOwner(profile.handle)).toEqual([OWNER]);
    });

    it("reports no principal for a label naming two, and none once refused", () => {
      const profile = fakeCell(
        { name: "Bob" },
        representing(OWNER, VISITOR),
        true,
      );
      const owners = observeOwner(profile.handle);

      profile.refuse();

      expect(owners).toEqual([undefined, undefined]);
    });

    it("reports nothing until the label the worker read has arrived, no principal after a write through the handle, and the principal again once the worker delivers the label", () => {
      const profile = fakeCell(undefined, undefined, false);
      const owners = observeOwner(profile.handle);
      expect(owners).toEqual([]);

      profile.deliver({ name: "Bob" }, representing(OWNER));
      expect(owners).toEqual([OWNER]);

      profile.writeLocally({ name: "Robert" });
      expect(owners).toEqual([OWNER, undefined]);

      profile.deliver({ name: "Robert" }, representing(OWNER));

      expect(owners).toEqual([OWNER, undefined, OWNER]);
    });

    it("reports no principal for a cell the worker refuses before its label arrives", () => {
      const profile = fakeCell(undefined, undefined, false);
      const owners = observeOwner(profile.handle);

      profile.refuse();

      expect(owners).toEqual([undefined]);
    });
  });
});
