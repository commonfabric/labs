import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import type { FabricValue } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";

import { deriveFlowJoin } from "../src/cfc/prepare.ts";
import { getCfcReferenceProvenance } from "../src/cfc/reference-provenance.ts";
import type { LabelMapEntry } from "../src/cfc/types.ts";
import { Runtime } from "../src/runtime.ts";
import { isCell } from "../src/cell.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  seedStoredEnvelope,
  writeSeedEnvelopeDoc,
} from "./cfc-seed-envelope.ts";

const signer = await Identity.fromPassphrase("cfc-eager-reference-context");
const space = signer.did();
const selection = "private-selection";

describe("cfc-eager-reference-context", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: storage,
      cfcFlowLabels: "persist",
    });
  });

  afterEach(async () => {
    await storage.synced();
    await runtime.dispose();
    await storage.close();
  });

  const seed = async (
    cause: string,
    value: FabricValue,
    entries: LabelMapEntry[] = [],
  ) => {
    const tx = runtime.edit();
    const cell = runtime.getCell(space, cause, undefined, tx);
    writeSeedEnvelopeDoc(tx, space);
    seedStoredEnvelope(tx, { ...cell.getAsNormalizedFullLink(), path: [] }, {
      value,
      cfc: {
        version: 3,
        schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
        labelMap: { version: 1, entries },
      },
    });
    expect((await tx.commit()).ok).toBeDefined();
    return cell.withTx(undefined);
  };

  for (const asCell of [false, true]) {
    it(`retains both link selections across array-item hops (asCell=${asCell})`, async () => {
      const value = await seed("array-leaf", { value: "visible" });
      const intermediate = await seed("array-middle", value.getAsLink(), [{
        path: [],
        origin: "link",
        observes: "followRef",
        referenceAcquisition: "complete",
        label: { confidentiality: ["middle-selection"] },
      }]);
      const array = await seed("array-container", [intermediate.getAsLink()], [{
        path: ["0"],
        origin: "link",
        observes: "followRef",
        referenceAcquisition: "complete",
        label: { confidentiality: [selection] },
      }]);
      const read = runtime.edit();
      const projected = array.withTx(read).asSchema({
        type: "array",
        items: {
          type: "object",
          ...(asCell ? { asCell: ["readonly"] as const } : {}),
          properties: { value: { type: "string", asCell: ["readonly"] } },
        },
      }).get();
      const item = projected?.[0];
      const object = isCell(item) ? item.get() : item;
      const child: unknown = object?.value;
      if (!isCell(child)) throw new Error("Expected a descendant Cell");
      const held = child.withTx(undefined);
      read.abort();
      expect(getCfcReferenceProvenance(held)?.confidentiality)
        .toEqual([selection, "middle-selection"]);
      const next = runtime.edit();
      expect(held.withTx(next).get()).toBe("visible");
      expect(deriveFlowJoin(next).confidentiality).toEqual([
        selection,
        "middle-selection",
      ]);
      next.abort();
    });
  }

  for (const lazy of [false, true]) {
    for (const privateFirst of [false, true]) {
      it(`retains descendant reference history across sibling traversal (lazy=${lazy}, privateFirst=${privateFirst})`, async () => {
        const target = await seed("target", { value: "visible" });
        const selected = await seed("selected", target.getAsLink(), [{
          path: [],
          origin: "link",
          observes: "followRef",
          referenceAcquisition: "complete",
          label: { confidentiality: [selection] },
        }]);
        const inputs = runtime.getImmutableCell(
          space,
          privateFirst
            ? { private: selected, public: target }
            : { public: target, private: selected },
        );
        const childSchema = {
          type: "object",
          properties: { value: { type: "string", asCell: ["readonly"] } },
        } as const;
        const tx = runtime.edit();
        if (lazy) tx.markLazyMaterialize(true);
        const projected = inputs.withTx(tx).asSchema({
          type: "object",
          properties: privateFirst
            ? { private: childSchema, public: childSchema }
            : { public: childSchema, private: childSchema },
        }).get();
        const first = privateFirst ? projected.private : projected.public;
        const second = privateFirst ? projected.public : projected.private;
        const firstValue: unknown = first!.value;
        const secondValue: unknown = second!.value;
        if (!isCell(firstValue) || !isCell(secondValue)) {
          throw new Error("Expected descendant Cell handles");
        }
        const firstHandle = firstValue.withTx(undefined);
        const secondHandle = secondValue.withTx(undefined);
        const privateHandle = privateFirst ? firstHandle : secondHandle;
        const publicHandle = privateFirst ? secondHandle : firstHandle;
        tx.abort();

        expect(getCfcReferenceProvenance(privateHandle)?.confidentiality)
          .toContain(selection);
        // Eager traversal reads the private slot before the public slot in
        // canonical object order. A later acquisition retains that current J.
        expect(getCfcReferenceProvenance(publicHandle)?.confidentiality)
          .toEqual(lazy && !privateFirst ? [] : [selection]);
        const publicRead = runtime.edit();
        expect(target.withTx(publicRead).key("value").get()).toBe("visible");
        expect(deriveFlowJoin(publicRead).confidentiality).toEqual([]);
        publicRead.abort();
        const privateRead = runtime.edit();
        expect(privateHandle.withTx(privateRead).get()).toBe("visible");
        expect(deriveFlowJoin(privateRead).confidentiality).toContain(
          selection,
        );
        privateRead.abort();
      });
    }
  }

  it("retains an inherited final-hop cap on a held descendant after a schema rewrite", async () => {
    const setup = runtime.edit();
    const secret = runtime.getCellFromLink(
      {
        ...runtime.getCell(space, "session-target").getAsNormalizedFullLink(),
        scope: "session",
      },
      undefined,
      setup,
    );
    secret.set("session-only");
    expect((await setup.commit()).ok).toBeDefined();
    const source = await seed("source", { child: secret.getAsLink() }, [{
      path: ["child"],
      origin: "link",
      observes: "followRef",
      referenceAcquisition: "complete",
      label: {},
    }]);
    const schema = {
      type: "object",
      properties: {
        child: { type: "string", asCell: ["readonly"], scope: "session" },
      },
    } as const;
    const read = runtime.edit();
    const projected = runtime.getCellFromLink(
      {
        ...source.getAsNormalizedFullLink(),
        scopeCaps: [{ depth: 1, scope: "space" }],
      },
      schema,
      read,
    ).get();
    const child: unknown = projected.child;
    if (!isCell(child)) throw new Error("Expected a capped Cell");
    const held = child.withTx(undefined).asSchema({
      type: "string",
      scope: "session",
    });
    read.abort();

    const next = runtime.edit();
    expect(held.withTx(next).get()).toBeUndefined();
    const allowed = source.withTx(next).asSchema(schema).get();
    const allowedChild: unknown = allowed.child;
    if (!isCell(allowedChild)) throw new Error("Expected an uncapped Cell");
    expect(allowedChild.get()).toBe("session-only");
    next.abort();
  });

  for (const lazy of [false, true]) {
    for (const persisted of [false, true]) {
      it(`retains a stored link schema cap after a reader rewrite (lazy=${lazy}, persisted=${persisted})`, async () => {
        const setup = runtime.edit();
        const secret = runtime.getCellFromLink(
          {
            ...runtime.getCell(space, "stored-cap-session")
              .getAsNormalizedFullLink(),
            scope: "session",
          },
          undefined,
          setup,
        );
        secret.set("session-only");
        const target = runtime.getCell(
          space,
          "stored-cap-target",
          undefined,
          setup,
        );
        target.set(secret);
        expect((await setup.commit()).ok).toBeDefined();

        let read = runtime.edit();
        const source = runtime.getCell(
          space,
          "stored-cap-source",
          undefined,
          read,
        );
        source.set({
          capped: target.asSchema({ type: "string", scope: "space" }),
          allowed: target.asSchema({ type: "string", scope: "session" }),
        });
        if (persisted) {
          expect((await read.commit()).ok).toBeDefined();
          read = runtime.edit();
        }
        if (lazy) read.markLazyMaterialize(true);
        const childSchema = {
          type: "string",
          asCell: ["readonly"],
          scope: "session",
        } as const;
        const projected = source.withTx(read).asSchema({
          type: "object",
          properties: { capped: childSchema, allowed: childSchema },
        }).get();
        const capped: unknown = projected.capped;
        const allowed: unknown = projected.allowed;
        if (!isCell(capped) || !isCell(allowed)) {
          throw new Error("Expected projected Cell handles");
        }
        const held = capped.withTx(undefined).asSchema({
          type: "string",
          scope: "session",
        });
        const heldAllowed = allowed.withTx(undefined);
        read.abort();

        const next = runtime.edit();
        expect(held.withTx(next).get()).toBeUndefined();
        expect(heldAllowed.withTx(next).get()).toBe("session-only");
        next.abort();
      });
    }
  }

  for (
    const { required, fallback, expected } of [
      { required: true, fallback: undefined, expected: undefined },
      { required: false, fallback: undefined, expected: {} },
      { required: true, fallback: 42, expected: { child: 42 } },
    ]
  ) {
    it(`preserves blocked value validation and defaults (required=${required}, fallback=${fallback})`, async () => {
      const setup = runtime.edit();
      const secret = runtime.getCellFromLink(
        {
          ...runtime.getCell(space, "session-number").getAsNormalizedFullLink(),
          scope: "session",
        },
        undefined,
        setup,
      );
      secret.set(7);
      expect((await setup.commit()).ok).toBeDefined();
      const source = await seed("source", { child: secret.getAsLink() }, [{
        path: ["child"],
        origin: "link",
        observes: "followRef",
        referenceAcquisition: "complete",
        label: {},
      }]);
      const schema = {
        type: "object",
        properties: {
          child: {
            type: "number",
            scope: "session",
            ...(fallback !== undefined && { default: fallback }),
          },
        },
        ...(required && { required: ["child"] }),
      } as const;
      const tx = runtime.edit();
      const actual = runtime.getCellFromLink(
        {
          ...source.getAsNormalizedFullLink(),
          scopeCaps: [{ depth: 1, scope: "space" }],
        },
        schema,
        tx,
      ).get();
      expect(actual).toEqual(expected);
      expect(source.withTx(tx).asSchema(schema).get()?.child).toBe(7);
      tx.abort();
    });
  }
});
