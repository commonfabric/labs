import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { WatchView } from "../v2/client.ts";
import type { SessionSync } from "../v2.ts";

const emptySync = (toSeq: number): SessionSync => ({
  type: "sync",
  fromSeq: toSeq - 1,
  toSeq,
  upserts: [],
  removes: [],
} as unknown as SessionSync);

describe("watch-view-syncs-consumed", () => {
  describe("WatchView.whenSyncsConsumed()", () => {
    it("stays pending until the consumer asks for a sync after a queued one", async () => {
      const view = WatchView.fromSync(emptySync(1));
      const iterator = view.subscribeSync();
      view.pushSync(emptySync(2));
      const order: string[] = [];
      const consumed = view.whenSyncsConsumed().then(() => {
        order.push("consumed");
      });
      await iterator.next();
      order.push("took it");
      void iterator.next();
      await consumed;
      expect(order).toStrictEqual(["took it", "consumed"]);
      view.close();
    });

    it("stays pending after a sync reaches a waiting consumer, until it asks again", async () => {
      const view = WatchView.fromSync(emptySync(1));
      const iterator = view.subscribeSync();
      const taken = iterator.next();
      view.pushSync(emptySync(2));
      const order: string[] = [];
      const consumed = view.whenSyncsConsumed().then(() => {
        order.push("consumed");
      });
      await taken;
      order.push("took it");
      void iterator.next();
      await consumed;
      expect(order).toStrictEqual(["took it", "consumed"]);
      view.close();
    });

    it("resolves at once for a consumer already waiting with nothing queued", async () => {
      const view = WatchView.fromSync(emptySync(1));
      void view.subscribeSync().next();
      await expect(view.whenSyncsConsumed()).resolves.toBeUndefined();
      view.close();
    });

    it("resolves when the view closes with no consumer", async () => {
      const view = WatchView.fromSync(emptySync(1));
      view.pushSync(emptySync(2));
      const consumed = view.whenSyncsConsumed();
      view.close();
      await expect(consumed).resolves.toBeUndefined();
    });
  });
});
