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
import {
  action,
  computed,
  handler,
  pattern,
  type Stream,
  Writable,
} from "commonfabric";

const Child = pattern<
  { rows: readonly string[]; label: string },
  { label: string }
>(({ label }) => ({ label }));

/** Writes through the cell it is handed. */
const Appender = pattern<
  { log: Writable<string[]> },
  { add: Stream<{ text: string }> }
>(({ log }) => {
  const add = action<{ text: string }>(({ text }) => {
    log.push(text);
  });
  return { add };
});

const label = { type: "object", properties: { label: { type: "string" } } };

/** States its opaque input as one arm of a union. */
const forwardUnion = handler<any, any>(label as any, {
  type: "object",
  properties: {
    rows: {
      anyOf: [
        { type: "array", items: { type: "string" }, asCell: ["opaque"] },
        { type: "undefined" },
      ],
    },
    made: { type: "array", items: true, asCell: ["cell"] },
  },
} as any, (event: any, state: any) => {
  state.made.push(Child({ rows: state.rows, label: event.label }));
});

/** States its opaque input through a reference. */
const forwardRef = handler<any, any>(label as any, {
  type: "object",
  properties: {
    rows: { $ref: "#/$defs/Rows" },
    made: { type: "array", items: true, asCell: ["cell"] },
  },
  $defs: {
    Rows: { type: "array", items: { type: "string" }, asCell: ["opaque"] },
  },
} as any, (event: any, state: any) => {
  state.made.push(Child({ rows: state.rows, label: event.label }));
});

export default pattern<{ items: Writable<string[]> }>(({ items }) => {
  const rows = computed(() => items.get().map((item) => item.toUpperCase()));
  const made = new Writable<unknown[]>([]).for("made");
  const log = new Writable<string[]>([]).for("log");
  const appenders = new Writable<unknown[]>([]).for("appenders");
  const forward = action<{ label: string }>(({ label }) => {
    made.push(Child({ rows, label }));
  });
  const read = action<{ label: string }>(({ label }) => {
    made.push(Child({ rows, label: rows[0] ?? label }));
  });
  const spawn = action(() => {
    appenders.push(Appender({ log }));
  });
  return {
    forward,
    read,
    spawn,
    forwardUnion: forwardUnion({ rows, made }),
    forwardRef: forwardRef({ rows, made }),
    made,
    rows,
    log,
    appenders,
  };
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

  /** Starts the pattern, returning its result. */
  const start = async (name: string) => {
    const pattern = await runtime.patternManager.compilePattern(
      { main: MAIN, files: [{ name: MAIN, contents: SOURCE }] },
      { space },
    );
    const tx = runtime.edit();
    const result = runtime.getCell<any>(space, { test: name }, undefined, tx);
    runtime.run(tx, pattern, { items: ["a"] }, result);
    await tx.commit().settled;
    await runtime.idle();
    return result.withTx();
  };

  /** Starts the pattern and sends an event to the verb `verb`. */
  const send = async (verb: string): Promise<void> => {
    const result = await start(verb);
    result.key(verb).send({ label: "made" });
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

  it("finds no dirty dependency for an input opaque in a union's arm", async () => {
    await send("forwardUnion");

    expect(preflights.length).toBeGreaterThan(0);
    expect(preflights.some((marker) => marker.hasDirtyDependencies)).toBe(
      false,
    );
  });

  it("finds no dirty dependency for an input opaque through a reference", async () => {
    await send("forwardRef");

    expect(preflights.length).toBeGreaterThan(0);
    expect(preflights.some((marker) => marker.hasDirtyDependencies)).toBe(
      false,
    );
  });

  it("lets the new piece write through a cell the verb only hands on", async () => {
    const result = await start("write-through");

    result.key("spawn").send({});
    await runtime.idle();
    await runtime.storageManager.synced();
    const appender = result.key("appenders").key(0).resolveAsCell();
    await appender.pull();
    appender.key("add").send({ text: "written" });
    await runtime.idle();
    await runtime.storageManager.synced();

    expect(await result.key("log").pull()).toEqual(["written"]);
  });
});
