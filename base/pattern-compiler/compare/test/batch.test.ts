import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { type Artifact, Instance } from "../../exec/executor.ts";
import { type BatchEvent, batchOnRuntime } from "../batch.ts";

// A batch of events on `fixtures/batch.tsx`: the executor's `batch()`
// against today's runtime with the same events queued before its
// scheduler takes any, under the serving posture, where the scheduler
// runs the handlers back to back and settles once behind them. `items`
// is an array of plain values in place, and no per-element construct is
// over it.

const artifactOf = async (name: string): Promise<Artifact> => {
  const [{ patterns }] = JSON.parse(
    await Deno.readTextFile(
      new URL(`../fixtures/${name}.emit.json`, import.meta.url),
    ),
  ) as { patterns: Artifact[] }[];
  return patterns.find((pattern) => pattern.name === "default") ??
    patterns[patterns.length - 1];
};

/** The member of the result that holds the stream of each binding. */
const STREAMS: Record<string, string> = { add: "adding" };

const MEMBERS = ["items", "count", "total", "seen", "copied", "joined"];

const picked = (result: Record<string, unknown>) =>
  Object.fromEntries(MEMBERS.map((name) => [name, result[name]]));

const onExecutor = async (batch: BatchEvent[]) => {
  const instance = new Instance(await artifactOf("batch"), {});
  for (const { stream, event } of batch) {
    const name = STREAMS[stream] ?? stream;
    instance.enqueue(
      instance.plan.bindings.findIndex((binding) => binding.name === name),
      event,
    );
  }
  instance.batch();
  return picked(instance.result() as Record<string, unknown>);
};

const add = (text: string): BatchEvent => ({ stream: "add", event: { text } });
const to = (stream: string): BatchEvent => ({ stream, event: {} });

describe("a batch of events, against today's runtime under the serving posture", () => {
  const cases: [string, BatchEvent[], Record<string, unknown>][] = [
    [
      "a handler reads a computed value that two earlier events made stale",
      [add("a"), add("b"), to("note")],
      { seen: [2], count: 2 },
    ],
    [
      "a handler reads a cell that a cone writes from what an earlier event wrote",
      [add("a"), to("copy")],
      { copied: "a" },
    ],
    [
      "a handler writes a cell that a cone writes, behind an event that made the cone stale",
      [add("a"), to("overwrite")],
      { joined: "a" },
    ],
    [
      "a handler sends an event, which is handled behind the events queued before",
      [{ stream: "relay", event: { text: "x" } }, add("y")],
      { items: ["y", "x!"] },
    ],
    [
      "a handler throws between two that commit",
      [add("a"), to("fail"), add("b")],
      { items: ["a", "b"], joined: "a,b" },
    ],
  ];
  for (const [name, batch, expected] of cases) {
    it(`computes equal values where ${name}`, async () => {
      const executor = await onExecutor(batch);
      const runtime = picked(await batchOnRuntime("batch", {}, batch, true));

      expect(executor).toMatchObject(expected);
      expect(executor).toEqual(runtime);
    });
  }

  it("differs from today's runtime where each of the two events is a batch of its own", async () => {
    const instance = new Instance(await artifactOf("batch"), {});
    const binding = (name: string) =>
      instance.plan.bindings.findIndex((binding) => binding.name === name);
    instance.send(binding("adding"), { text: "a" });
    instance.send(binding("overwrite"), {});

    // Today's runtime runs `_join` again behind the handler that wrote
    // `joined`, in either posture, and the executor does not: nothing
    // that `_join` read changed.
    const runtime = await batchOnRuntime("batch", {}, [
      add("a"),
      to("overwrite"),
    ], false);
    expect(runtime.joined).toBe("a");
    expect((instance.result() as Record<string, unknown>).joined).toBe(
      "written by the handler",
    );
  });
});
