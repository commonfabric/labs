/** Verifies row catch-up after a real storage transport outage in the reader. */

import { env } from "@commonfabric/integration";
import { expect } from "@std/expect";
import { join } from "@std/path";
import { describe, it } from "@std/testing/bdd";

import { MultiRuntimeHarness } from "./multi-runtime-harness.ts";
import { StorageNetworkGate } from "./storage-network-gate.ts";

const rootPath = join(import.meta.dirname!, "..");

describe("reactive vote rows after reconnect", () => {
  for (const variant of ["nested", "mapped"]) {
    it(`catches up ${variant} membership and profiles and continues reacting`, async () => {
      const apiUrl = new URL(env.API_URL);
      const gate = new StorageNetworkGate(apiUrl);
      let harness: MultiRuntimeHarness | undefined;
      try {
        harness = await MultiRuntimeHarness.create({
          rootPath,
          programPath: join(
            import.meta.dirname!,
            `fixtures/reactive-vote-rows/${variant}.tsx`,
          ),
          apiUrl,
          sessions: ["writer", { label: "reader", apiUrl: gate.url }],
        });
        const writer = harness.session("writer");
        const reader = harness.session("reader");
        const expected = (alice: boolean, bobColor: string) =>
          variant === "nested"
            ? [
              {
                id: "one",
                colors: alice ? ["yellow"] : [],
                names: alice ? ["Alice Offline"] : [],
              },
              { id: "two", colors: [bobColor], names: ["bob"] },
            ]
            : [
              {
                id: "one",
                color: alice ? "yellow" : "",
                names: alice ? "Alice Offline" : "",
              },
              { id: "two", color: bobColor, names: "bob" },
            ].sort((a, b) =>
              Number(Boolean(b.color)) - Number(Boolean(a.color))
            );
        await writer.send("cast", {
          key: "alice",
          optionId: "one",
          color: "red",
        });
        await harness.settle();
        const initial = await reader.read(["rows"]);
        expect(initial).toEqual(
          variant === "nested"
            ? [
              { id: "one", colors: ["red"], names: ["alice"] },
              { id: "two", colors: [], names: [] },
            ]
            : [
              { id: "one", color: "red", names: "alice" },
              { id: "two", color: "", names: "" },
            ],
        );

        await gate.pause();
        await writer.send("cast", {
          key: "alice",
          optionId: "one",
          color: "yellow",
        });
        await writer.send("rename", { key: "alice", name: "Alice Offline" });
        await writer.send("cast", {
          key: "bob",
          optionId: "two",
          color: "green",
        });
        gate.resume();
        await harness.settle();
        expect(await reader.read(["rows"])).toEqual(expected(true, "green"));

        await gate.pause();
        await writer.send("retract", { key: "alice" });
        gate.resume();
        await harness.settle();
        expect(await reader.read(["rows"])).toEqual(expected(false, "green"));

        await writer.send("cast", {
          key: "bob",
          optionId: "two",
          color: "blue",
        });
        await harness.settle();
        expect(await reader.read(["rows"])).toEqual(expected(false, "blue"));
      } finally {
        gate.resume();
        try {
          await harness?.dispose();
        } finally {
          await gate.close();
        }
      }
    });
  }
});
