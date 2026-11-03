/**
 * A verb that only hands an input on to a pattern it instantiates does not read
 * it, so the event's preflight does not bring the input's writer up to date.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { RuntimeTelemetryMarker } from "../src/telemetry.ts";
import { Runtime } from "../src/runtime.ts";

const signer = await Identity.fromPassphrase("handler forwarded input");
const space = signer.did();

type PreflightMarker = Extract<
  RuntimeTelemetryMarker,
  { type: "scheduler.event.preflight" }
>;

const MAIN = "/main.tsx";

/** Two verbs over one computed: one hands it on, and one also reads it. */
const SOURCE = `/// <cts-enable />
import { action, computed, pattern, Writable } from "commonfabric";

const Child = pattern<
  { rows: readonly string[]; label: string },
  { label: string }
>(({ label }) => ({ label }));

export default pattern<{ items: Writable<string[]> }>(({ items }) => {
  const rows = computed(() => items.get().map((item) => item.toUpperCase()));
  const made = new Writable<unknown[]>([]).for("made");
  const forward = action<{ label: string }>(({ label }) => {
    made.push(Child({ rows, label }));
  });
  const read = action<{ label: string }>(({ label }) => {
    made.push(Child({ rows, label: rows[0] ?? label }));
  });
  return { forward, read, made, rows };
});
`;

describe("handler-forwarded-input", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let preflights: PreflightMarker[];
  let listener: (event: Event) => void;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    runtime.scheduler.setEventPreflightTelemetryEnabled(true);
    preflights = [];
    listener = (event: Event) => {
      const { marker } = (event as CustomEvent<
        { marker: RuntimeTelemetryMarker }
      >).detail;
      if (marker.type === "scheduler.event.preflight") {
        preflights.push(marker);
      }
    };
    runtime.telemetry.addEventListener("telemetry", listener);
  });

  afterEach(async () => {
    runtime.telemetry.removeEventListener("telemetry", listener);
    await runtime.dispose();
    await storageManager.close();
  });

  /** Starts the pattern and sends `event` to the verb `verb`. */
  const send = async (verb: "forward" | "read"): Promise<void> => {
    const pattern = await runtime.patternManager.compilePattern(
      { main: MAIN, files: [{ name: MAIN, contents: SOURCE }] },
      { space },
    );
    const tx = runtime.edit();
    const result = runtime.getCell<any>(space, { test: verb }, undefined, tx);
    runtime.run(tx, pattern, { items: ["a"] }, result);
    await tx.commit().settled;
    await runtime.idle();
    result.withTx().key(verb).send({ label: "made" });
    await runtime.idle();
    await runtime.storageManager.synced();
  };

  it("finds no dirty dependency for an input a verb only hands on", async () => {
    await send("forward");

    expect(preflights.length).toBeGreaterThan(0);
    expect(preflights.some((marker) => marker.hasDirtyDependencies)).toBe(
      false,
    );
  });

  it("brings an input a verb also reads up to date first", async () => {
    await send("read");

    expect(preflights.some((marker) => marker.hasDirtyDependencies)).toBe(true);
  });
});
