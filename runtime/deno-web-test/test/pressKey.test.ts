/**
 * The page side of the command channel, run against a stand-in for the
 * driver's binding: what `pressKey` sends, and how the driver's settling
 * resolves or rejects the press.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { pressKey } from "../commands.ts";
import { DRIVER_BINDING, SETTLE_GLOBAL } from "../commands-protocol.ts";

/** The commands sent through the stand-in binding, parsed. */
let sent: { id: number; press: string; modifiers: string[] }[];

/** Settles command `id` the way the driver does, through the page global. */
function settle(id: number, error: string | null): void {
  const settler: unknown = Reflect.get(globalThis, SETTLE_GLOBAL);
  if (typeof settler !== "function") {
    throw new Error("pressKey installed no settler");
  }
  settler(id, error);
}

describe("pressKey()", () => {
  beforeEach(() => {
    sent = [];
    Reflect.set(globalThis, DRIVER_BINDING, (payload: string) => {
      sent.push(JSON.parse(payload));
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, DRIVER_BINDING);
    Reflect.deleteProperty(globalThis, SETTLE_GLOBAL);
  });

  it("sends the key with the modifiers held around it", async () => {
    const press = pressKey("Tab", { modifiers: ["Shift", "Alt"] });
    expect(sent).toEqual([
      { id: sent[0].id, press: "Tab", modifiers: ["Shift", "Alt"] },
    ]);
    settle(sent[0].id, null);
    await press;
  });

  it("sends no modifiers when none are given", async () => {
    const press = pressKey("Enter");
    expect(sent[0].modifiers).toEqual([]);
    settle(sent[0].id, null);
    await press;
  });

  it("numbers each press apart from the last", async () => {
    const presses = [pressKey("Home"), pressKey("End")];
    const [first, second] = sent;
    expect(second.id).not.toBe(first.id);
    settle(second.id, null);
    settle(first.id, null);
    await Promise.all(presses);
  });

  it("resolves the press the driver settles, and only that one", async () => {
    const settled: string[] = [];
    const tab = pressKey("Tab").then(() => settled.push("Tab"));
    const escape = pressKey("Escape").then(() => settled.push("Escape"));
    settle(sent[1].id, null);
    await escape;
    expect(settled).toEqual(["Escape"]);
    settle(sent[0].id, null);
    await tab;
    expect(settled).toEqual(["Escape", "Tab"]);
  });

  it("rejects with the driver's message when the driver refuses", async () => {
    const press = pressKey("Tab");
    settle(sent[0].id, "`Tab` is not a key a test may press");
    await expect(press).rejects.toThrow(
      "`Tab` is not a key a test may press",
    );
  });

  it("refuses to settle a command that is not waiting", async () => {
    const press = pressKey("Tab");
    const { id } = sent[0];
    settle(id, null);
    await press;
    expect(() => settle(id, null)).toThrow(
      `No command ${id} is waiting to be settled`,
    );
  });

  it("throws outside the driver, sending nothing", () => {
    Reflect.deleteProperty(globalThis, DRIVER_BINDING);
    expect(() => pressKey("Tab")).toThrow(
      "pressKey needs the deno-web-test driver",
    );
    expect(Reflect.get(globalThis, SETTLE_GLOBAL)).toBeUndefined();
  });

  it("throws where another copy of the module settles commands", () => {
    Reflect.set(globalThis, SETTLE_GLOBAL, () => {});
    expect(() => pressKey("Tab")).toThrow(
      "Two copies of deno-web-test's commands module are loaded",
    );
    expect(sent).toEqual([]);
  });
});
