import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";

import type { CellHandle } from "@/cell-handle.ts";
import {
  observeRepresentedPrincipal,
  observeWrittenPrincipal,
  type WrittenValue,
} from "@/written-principal.ts";

const OWNER = "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
const VISITOR = "did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuBV8xRoAnwWsdvktH";

const picture = new FabricBytes(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));

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

/** Something a fake cell delivers: a value, and its label. */
type Delivery = [value: unknown, label?: unknown];

/** What {@link fakeCell} returns. */
interface FakeCell {
  space(): string;
  id(): string;
  ref(): { space: string; id: string; path: string[] };
  runtime(): { signal: AbortSignal };
  asSchema(): FakeCell;
  resolveAsCellWithWriteTarget(): Promise<
    { cell: FakeCell; writeTarget: FakeCell }
  >;
  subscribe(
    onValue: (
      value: unknown,
      label?: unknown,
      delivery?: { cfcLabelCurrent: boolean },
    ) => void,
    options: { onRefused: () => void },
  ): () => void;
  deliver(next: Delivery): void;
  writeLocally(value: unknown): void;
  refuse(): void;
  subscriberCount(): number;
  subscribeCalls(): number;
  resolveTo(target: FakeCell | Promise<FakeCell>, written?: FakeCell): void;
}

/**
 * A fake cell handle with the id `id`, addressing `path` within its document,
 * whose subscribers hear `delivery` at once and each later one `deliver()`
 * sends, and hear `refuse()`. Its first delivery to a subscriber carries the
 * label the worker read with the value only when `loaded`; later ones always
 * do, except one `writeLocally()` sends, which carries the label the handle
 * last heard, as a write through a handle does. It resolves to itself until `resolveTo()` names the cell its links lead
 * to and, when different, the one a write to it lands in.
 */
const fakeCell = (
  id: string,
  delivery: Delivery,
  path: string[] = [],
  loaded = true,
): FakeCell => {
  const subscribers = new Set<{
    onValue: (
      value: unknown,
      label?: unknown,
      delivery?: { cfcLabelCurrent: boolean },
    ) => void;
    onRefused: () => void;
  }>();
  let current = delivery;
  let calls = 0;
  let target: FakeCell | Promise<FakeCell> | undefined;
  let written: FakeCell | undefined;
  const cell: FakeCell = {
    space: () => "did:key:zSpace",
    id: () => id,
    ref: () => ({ space: "did:key:zSpace", id, path }),
    runtime: () => ({ signal: new AbortController().signal }),
    asSchema: () => cell,
    resolveAsCellWithWriteTarget: async () => {
      // Each resolve answers with the links as they were when it began.
      const writtenTo = written;
      const to = await (target ?? cell);
      return { cell: to, writeTarget: writtenTo ?? to };
    },
    subscribe: (onValue, options) => {
      const subscriber = { onValue, onRefused: options.onRefused };
      subscribers.add(subscriber);
      calls++;
      onValue(current[0], current[1], { cfcLabelCurrent: loaded });
      return () => {
        subscribers.delete(subscriber);
      };
    },
    deliver: (next) => {
      current = next;
      for (const subscriber of subscribers) {
        subscriber.onValue(next[0], next[1], { cfcLabelCurrent: true });
      }
    },
    writeLocally: (value) => {
      current = [value, current[1]];
      for (const subscriber of subscribers) {
        subscriber.onValue(value, current[1], { cfcLabelCurrent: false });
      }
    },
    refuse: () => {
      for (const subscriber of subscribers) subscriber.onRefused();
    },
    subscriberCount: () => subscribers.size,
    subscribeCalls: () => calls,
    resolveTo: (to, writtenTo) => {
      target = to;
      written = writtenTo;
    },
  };
  return cell;
};

/**
 * A profile's `picture` field, which resolves through a write redirect to a
 * cell of its own holding the bytes, labeled as written by each of `by`.
 */
const pictureField = (...by: string[]) => {
  const field = fakeCell("of:profile", [picture], ["picture"]);
  const cell = fakeCell("of:picture", [picture, representing(...by)]);
  field.resolveTo(cell);
  return { field, cell };
};

/**
 * Lets every resolve the observation has started finish: the fakes answer
 * through settled promises, so one zero-delay turn runs them all.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Observes `cell`, and returns everything it reported and the cancel. */
const observe = (cell: FakeCell) => {
  const reports: WrittenValue<unknown>[] = [];
  const cancel = observeWrittenPrincipal(
    cell as unknown as CellHandle<unknown>,
    (written) => reports.push(written),
  );
  return { reports, cancel };
};

describe("written-principal", () => {
  describe("observeWrittenPrincipal()", () => {
    it("reports the value with the principal its own cell's label names", async () => {
      const { reports } = observe(pictureField(OWNER).field);
      await settle();

      expect(reports.at(-1)).toEqual({ value: picture, principal: OWNER });
    });

    it("reports the visitor for a value a visitor wrote", async () => {
      const { reports } = observe(pictureField(VISITOR).field);
      await settle();

      expect(reports.at(-1)).toEqual({ value: picture, principal: VISITOR });
    });

    it("reports no principal for a value stored without a label, or one said to represent two principals", async () => {
      for (const by of [[], [OWNER, VISITOR]]) {
        const { reports } = observe(pictureField(...by).field);
        await settle();

        expect(reports.at(-1)).toEqual({
          value: picture,
          principal: undefined,
        });
      }
    });

    it("reports neither for a value that is not the whole of a cell of its own", async () => {
      const field = fakeCell("of:profile", [picture, representing(OWNER)], [
        "picture",
      ]);
      const { reports } = observe(field);
      await settle();

      expect(reports.at(-1)).toEqual({
        value: undefined,
        principal: undefined,
      });
    });

    it("reports neither for a cell that holds a link to a value its owner wrote", async () => {
      const { field, cell } = pictureField(OWNER);
      const elsewhere = fakeCell("of:elsewhere", [
        picture,
        representing(OWNER),
      ]);
      field.resolveTo(elsewhere, cell);
      const { reports } = observe(field);
      await settle();

      expect(reports.at(-1)).toEqual({
        value: undefined,
        principal: undefined,
      });
      expect(elsewhere.subscriberCount()).toBe(0);
    });

    it("reports the value a relinked cell resolves to, and stops watching the old one", async () => {
      const { field, cell } = pictureField(VISITOR);
      const { reports } = observe(field);
      await settle();
      expect(reports.at(-1)?.principal).toBe(VISITOR);

      const relinked = fakeCell("of:new-picture", [
        picture,
        representing(OWNER),
      ]);
      field.resolveTo(relinked);
      field.deliver([picture]);
      await settle();

      expect(reports.at(-1)).toEqual({ value: picture, principal: OWNER });
      expect(cell.subscriberCount()).toBe(0);
    });

    it("reports what the latest resolve found when an earlier one finishes after it", async () => {
      const { field } = pictureField(OWNER);
      const late = Promise.withResolvers<FakeCell>();
      field.resolveTo(late.promise);
      const { reports } = observe(field);

      const current = fakeCell("of:current", [picture, representing(OWNER)]);
      field.resolveTo(current);
      field.deliver([picture]);
      await settle();
      const stale = fakeCell("of:stale", [picture, representing(VISITOR)]);
      late.resolve(stale);
      await settle();

      expect(reports.some((written) => written.principal === VISITOR)).toBe(
        false,
      );
      expect(reports.at(-1)).toEqual({ value: picture, principal: OWNER });
      expect(stale.subscribeCalls()).toBe(0);
    });

    it("reports nothing until the cell holding the value has loaded its label", async () => {
      const field = fakeCell("of:profile", [undefined], ["picture"]);
      const unloaded = fakeCell(
        "of:picture",
        [undefined, undefined],
        [],
        false,
      );
      field.resolveTo(unloaded);
      const { reports } = observe(field);
      await settle();
      expect(reports).toEqual([]);

      unloaded.deliver([picture, representing(OWNER)]);
      await settle();

      expect(reports).toEqual([{ value: picture, principal: OWNER }]);
    });

    it("reports nothing for a cell that has not loaded", async () => {
      const field = fakeCell("of:profile", [undefined], ["picture"], false);
      field.resolveTo(fakeCell("of:picture", [picture, representing(OWNER)]));
      const { reports } = observe(field);
      await settle();

      expect(reports).toEqual([]);
    });

    it("never reports the value of a cell found before it loaded that holds a link", async () => {
      // Before the cell loads, both resolves stop at it, since the link it
      // holds is not yet known.
      const field = fakeCell("of:profile", [undefined], ["picture"]);
      const unloaded = fakeCell(
        "of:picture",
        [undefined, undefined],
        [],
        false,
      );
      field.resolveTo(unloaded);
      const { reports } = observe(field);
      await settle();

      const elsewhere = fakeCell("of:elsewhere", [
        picture,
        representing(OWNER),
      ]);
      field.resolveTo(elsewhere, unloaded);
      unloaded.deliver([picture, representing(OWNER)]);
      await settle();

      expect(reports.some((written) => written.value !== undefined)).toBe(
        false,
      );
      expect(reports.at(-1)).toEqual({
        value: undefined,
        principal: undefined,
      });
    });

    it("reports neither once a write through the cell's handle holds a value the worker has not labeled, and the value again once it has", async () => {
      const { field, cell } = pictureField(OWNER);
      const { reports } = observe(field);
      await settle();
      expect(reports.at(-1)).toEqual({ value: picture, principal: OWNER });

      const written = new FabricBytes(new Uint8Array([1, 2]));
      cell.writeLocally(written);
      await settle();
      expect(reports.at(-1)).toEqual({
        value: undefined,
        principal: undefined,
      });

      cell.deliver([written, representing(VISITOR)]);
      await settle();

      expect(
        reports.some((each) =>
          each.value === written && each.principal === OWNER
        ),
      ).toBe(false);
      expect(reports.at(-1)).toEqual({ value: written, principal: VISITOR });
    });

    it("reports neither once the cell is refused, and ends its watch", async () => {
      const { field, cell } = pictureField(OWNER);
      const { reports } = observe(field);
      await settle();

      field.refuse();

      expect(reports.at(-1)).toEqual({
        value: undefined,
        principal: undefined,
      });
      expect(cell.subscriberCount()).toBe(0);
    });

    it("reports nothing once cancelled, and ends every watch", async () => {
      const { field, cell } = pictureField(OWNER);
      const { reports, cancel } = observe(field);
      await settle();
      const reported = reports.length;

      cancel();
      cell.deliver([picture, representing(VISITOR)]);

      expect(reports.length).toBe(reported);
      expect([field, cell].map((each) => each.subscriberCount())).toEqual([
        0,
        0,
      ]);
    });
  });

  describe("observeRepresentedPrincipal()", () => {
    /** Observes `cell`, and returns every principal it reported. */
    const observeOwner = (cell: FakeCell) => {
      const owners: (string | undefined)[] = [];
      observeRepresentedPrincipal(
        cell as unknown as CellHandle<unknown>,
        (owner) => owners.push(owner),
      );
      return owners;
    };

    it("reports the principal a profile's label names", () => {
      const profile = fakeCell("of:profile", [
        { name: "Bob" },
        representing(OWNER),
      ]);

      expect(observeOwner(profile)).toEqual([OWNER]);
    });

    it("reports no principal for a label naming two, and none once refused", () => {
      const profile = fakeCell("of:profile", [
        { name: "Bob" },
        representing(OWNER, VISITOR),
      ]);
      const owners = observeOwner(profile);

      profile.refuse();

      expect(owners).toEqual([undefined, undefined]);
    });

    it("reports nothing until the label the worker read has arrived, no principal after a write through the handle, and the principal again once the worker delivers the label", () => {
      const profile = fakeCell("of:profile", [undefined, undefined], [], false);
      const owners = observeOwner(profile);
      expect(owners).toEqual([]);

      profile.deliver([{ name: "Bob" }, representing(OWNER)]);
      expect(owners).toEqual([OWNER]);

      profile.writeLocally({ name: "Robert" });
      expect(owners).toEqual([OWNER, undefined]);

      profile.deliver([{ name: "Robert" }, representing(OWNER)]);

      expect(owners).toEqual([OWNER, undefined, OWNER]);
    });

    it("reports no principal for a cell the worker refuses before its label arrives", () => {
      const profile = fakeCell("of:profile", [undefined, undefined], [], false);
      const owners = observeOwner(profile);

      profile.refuse();

      expect(owners).toEqual([undefined]);
    });
  });
});
