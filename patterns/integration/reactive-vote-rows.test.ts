/**
 * Exercises cold nested filters and remote row edits across independent replicas.
 * Only derived rows are exposed; reading the result cannot warm raw vote entities.
 * These assertions cover row data. Browser-rendered content is a separate check.
 */

import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";
import {
  experimentalOptionsFromEnv,
  type SchedulerGraphSnapshot,
} from "@commonfabric/runner";
import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { join } from "@std/path";
import { MultiRuntimeHarness } from "./multi-runtime-harness.ts";

const rootPath = join(import.meta.dirname!, "..");
const serverExecution =
  experimentalOptionsFromEnv(Deno.env.get).serverExecution ??
    SERVER_EXECUTION_DEFAULT_ENABLED;

function rowProducer(graph: SchedulerGraphSnapshot, outputId: string) {
  const matches = graph.nodes.filter((node) =>
    node.type === "computation" &&
    node.writes?.some((write) => write.includes(outputId))
  );
  expect(matches).toHaveLength(1);
  const node = matches[0];
  expect(node.stats?.runCount).toBeGreaterThan(0);
  return { id: node.id, runs: node.stats!.runCount };
}

describe("reactive vote rows across replicas", () => {
  it("includes remotely created vote entities in a nested row filter", async () => {
    const harness = await MultiRuntimeHarness.create({
      rootPath,
      programPath: join(
        import.meta.dirname!,
        "fixtures/reactive-vote-rows/nested.tsx",
      ),
      sessions: ["writer", "reader"],
    });
    try {
      const writer = harness.session("writer");
      const reader = harness.session("reader");
      await writer.send("cast", {
        key: "alice-one",
        optionId: "one",
        color: "green",
      });
      await harness.settle();
      expect(await reader.read(["rows"])).toEqual([
        { id: "one", colors: ["green"], names: ["alice-one"] },
        { id: "two", colors: [], names: [] },
      ]);
      await writer.send("cast", {
        key: "bob-two",
        optionId: "two",
        color: "yellow",
      });
      await harness.settle();
      expect(await reader.read(["rows"])).toEqual([
        { id: "one", colors: ["green"], names: ["alice-one"] },
        { id: "two", colors: ["yellow"], names: ["bob-two"] },
      ]);
    } finally {
      await harness.dispose();
    }
  });

  it("updates mapped row content after another replica edits a vote", async () => {
    const harness = await MultiRuntimeHarness.create({
      rootPath,
      programPath: join(
        import.meta.dirname!,
        "fixtures/reactive-vote-rows/mapped.tsx",
      ),
      sessions: ["writer", "reader"],
    });
    try {
      const writer = harness.session("writer");
      const reader = harness.session("reader");
      await writer.send("cast", {
        key: "alice-one",
        optionId: "one",
        color: "green",
      });
      await harness.settle();
      expect(await reader.read(["rows"])).toEqual([{
        id: "one",
        color: "green",
        names: "alice-one",
      }, { id: "two", color: "", names: "" }]);
      await writer.send("cast", {
        key: "alice-one",
        optionId: "one",
        color: "yellow",
      });
      await harness.settle();
      expect(await reader.read(["rows"])).toEqual([{
        id: "one",
        color: "yellow",
        names: "alice-one",
      }, { id: "two", color: "", names: "" }]);
    } finally {
      await harness.dispose();
    }
  });

  it({
    name:
      "preserves client row producers and skips untouched rows after remote edits",
    // Serving-host actions are outside a client worker's diagnostic graph.
    ignore: serverExecution,
    fn: async () => {
      const harness = await MultiRuntimeHarness.create({
        rootPath,
        programPath: join(
          import.meta.dirname!,
          "fixtures/reactive-vote-rows/mapped.tsx",
        ),
        sessions: ["writer", "reader"],
        diagnostics: true,
      });
      try {
        const writer = harness.session("writer");
        const reader = harness.session("reader");
        await writer.send("cast", {
          key: "alice",
          optionId: "one",
          color: "green",
        });
        await writer.send("cast", {
          key: "bob",
          optionId: "two",
          color: "yellow",
        });
        await harness.settle();
        expect(await reader.read(["rows"])).toEqual([
          { id: "one", color: "green", names: "alice" },
          { id: "two", color: "yellow", names: "bob" },
        ]);
        const links = await Promise.all(
          [0, 1].map((index) => reader.link(["rows", index, "color"])),
        );
        let graph = (await reader.diagnostics()).graph;
        let producers = links.map((link) => rowProducer(graph, link.id));
        for (const edited of [0, 1]) {
          await writer.send("cast", {
            key: edited === 0 ? "alice" : "bob",
            optionId: edited === 0 ? "one" : "two",
            color: "red",
          });
          await harness.settle();
          expect(await reader.read(["rows"])).toEqual([
            { id: "one", color: "red", names: "alice" },
            { id: "two", color: edited === 0 ? "yellow" : "red", names: "bob" },
          ]);
          const nextLinks = await Promise.all(
            [0, 1].map((index) => reader.link(["rows", index, "color"])),
          );
          expect(nextLinks).toEqual(links);
          graph = (await reader.diagnostics()).graph;
          const next = links.map((link) => rowProducer(graph, link.id));
          expect(next.map((producer) => producer.id)).toEqual(
            producers.map((producer) => producer.id),
          );
          expect(next[edited].runs).toBeGreaterThan(producers[edited].runs);
          expect(next[1 - edited].runs).toBe(producers[1 - edited].runs);
          producers = next;
        }
      } finally {
        await harness.dispose();
      }
    },
  });
});
