import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricError } from "@commonfabric/data-model/fabric-instances";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { handler } from "../src/builder/module.ts";
import { pattern } from "../src/builder/pattern.ts";
import { type Cell, sendEvent } from "../src/cell.ts";
import { isCellLink, parseLink } from "../src/link-utils.ts";
import { areLinksSame } from "../src/link-equality.ts";
import { Runtime } from "../src/runtime.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";
import { findAndInlineDataUriLinks } from "../src/data-uri.ts";
import { hasInlineCellScheme } from "../src/immutable-cell.ts";

const signer = await Identity.fromPassphrase("stream send data uri");
const space = signer.did();

/** The ids of the links anywhere inside `value`. */
const linkIdsIn = (value: unknown): string[] => {
  const ids: string[] = [];
  const visit = (node: unknown): void => {
    if (isCellLink(node)) {
      ids.push(String(parseLink(node)!.id));
    } else if (Array.isArray(node)) {
      node.forEach(visit);
    } else if (typeof node === "object" && node !== null) {
      Object.values(node).forEach(visit);
    }
  };
  visit(value);
  return ids;
};

describe("stream-send-data-uri", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let stream: Cell<unknown>;
  let queued: unknown[];

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    // Explicit schemas: a unit test compiles without the CTS transforms.
    const record = handler(
      true as const,
      { type: "object", properties: {} } as const,
      (_event, _ctx) => {},
    );
    const recorder = pattern<{ value: number }>(({ value }) => ({
      value,
      record: record({}),
    }));
    const tx = runtime.edit();
    const result = runtime.getCell<{ value: number; record: unknown }>(
      space,
      "stream-send-data-uri-result",
      undefined,
      tx,
    );
    runtime.run(tx, recorder, { value: 0 }, result);
    await tx.commit().settled;
    await runtime.idle();
    stream = result.key("record");

    // Observe the payload delivered to the local handler.
    queued = [];
    const queueEvent = runtime.scheduler.queueEvent.bind(runtime.scheduler);
    runtime.scheduler.queueEvent = (link, event, ...rest) => {
      queued.push(event);
      return queueEvent(link, event, ...rest);
    };
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  /** Sends `event` to the stream and resolves once its handling commits. */
  const send = (event: unknown) =>
    new Promise<void>((resolve) => {
      sendEvent(stream, event, () => resolve());
    });

  /** A cell over the first element of a stored array of inline objects. */
  const inlineElement = async (tx: IExtendedStorageTransaction) => {
    const target = runtime.getCell(space, "send-target", undefined, tx);
    target.set({ name: "x" });
    const holder = runtime.getCell(space, "send-holder", undefined, tx);
    holder.setRaw({
      items: [{ label: "one", ref: target.getAsLink() }],
    });
    await tx.commit().settled;
    return {
      element: holder.key("items").key(0).resolveAsCell(),
      targetId: String(target.getAsNormalizedFullLink().id),
    };
  };

  it("preserves an inline array element identity in local delivery", async () => {
    const { element, targetId } = await inlineElement(runtime.edit());
    expect(hasInlineCellScheme(element.getAsNormalizedFullLink().id)).toBe(
      true,
    );

    await send({ item: element });

    expect(queued).toHaveLength(1);
    const event = queued[0] as { item: { label: string; ref: unknown } };
    expect(isCellLink(event.item)).toBe(true);
    expect(parseLink(event.item)!.id).toBe(
      element.getAsNormalizedFullLink().id,
    );
    expect(element.getRaw()).toMatchObject({ label: "one" });
    expect(linkIdsIn(element.getRaw())).toEqual([targetId]);
  });

  it("preserves an immutable cell identity in local delivery", async () => {
    const immutable = runtime.getImmutableCell(space, { count: 3 });
    expect(hasInlineCellScheme(immutable.getAsNormalizedFullLink().id)).toBe(
      true,
    );

    await send({ boxed: immutable });

    expect(linkIdsIn(queued[0])).toEqual([
      immutable.getAsNormalizedFullLink().id,
    ]);
  });

  it("preserves nested immutable identities in local delivery", async () => {
    const { element, targetId } = await inlineElement(runtime.edit());
    const immutable = runtime.getImmutableCell(space, { input: element });

    await send({ boxed: immutable });

    expect(linkIdsIn(queued[0])).toEqual([
      immutable.getAsNormalizedFullLink().id,
    ]);
    expect(linkIdsIn(element.getRaw())).toEqual([targetId]);
  });

  it("refuses a FabricInstance supplied directly in an event", () => {
    const failure = new FabricError({
      type: "Error",
      message: "boom",
      stack: undefined,
      cause: undefined,
      extras: undefined,
    });
    expect(() => sendEvent(stream, { failure })).toThrow(
      "converting cells to links",
    );
    expect(queued).toEqual([]);
  });

  it("carries portable immutable links in a durable append and its echo", async () => {
    const { element, targetId } = await inlineElement(runtime.edit());
    const immutable = runtime.getImmutableCell(space, { input: element });
    const appended: unknown[] = [];
    const replica = storageManager.open(space).replica;
    replica.enqueueEventAppend = (entry) => {
      appended.push(entry.payload);
      return Promise.resolve({ delivered: true });
    };
    runtime.experimental.serverExecution = true;

    sendEvent(stream, { boxed: immutable });
    await runtime.idle();
    await storageManager.synced();

    expect(appended).toHaveLength(1);
    expect(queued).toEqual(appended);
    const event = appended[0] as { boxed: unknown };
    expect(linkIdsIn(event)[0]?.startsWith("data:")).toBe(true);
    expect(areLinksSame(event.boxed, immutable)).toBe(true);
    const expanded = findAndInlineDataUriLinks(event);
    expect(expanded).toMatchObject({ boxed: { input: { label: "one" } } });
    expect(linkIdsIn(expanded)).toEqual([targetId]);
  });

  it("carries a cell stored in a space as a link to it", async () => {
    const tx = runtime.edit();
    const stored = runtime.getCell(space, "send-stored", undefined, tx);
    stored.set({ name: "y" });
    await tx.commit().settled;

    await send({ item: stored });

    expect(linkIdsIn(queued[0])).toEqual([
      String(stored.getAsNormalizedFullLink().id),
    ]);
  });
});
