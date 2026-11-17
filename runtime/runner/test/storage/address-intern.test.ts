import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import type { ScopeKey } from "@commonfabric/memory/v2";

import type { CellScope } from "../../src/builder/types.ts";
import { AddressInterner } from "../../src/storage/address-intern.ts";
import type { MemorySpace, URI } from "../../src/storage/interface.ts";

const space = "did:key:z6Mk-address-intern-space" as MemorySpace;
const otherSpace = "did:key:z6Mk-address-intern-other" as MemorySpace;
const id = "of:interned" as URI;
const alice = "alice-key" as ScopeKey;
const bob = "bob-key" as ScopeKey;

/**
 * Runs `address-intern-helper.ts` for `scenario` in a subprocess and returns
 * its report. The helper needs `--expose-gc` and the real clock, which this
 * package's test task does not give it.
 */
async function runHelper(
  scenario: string,
): Promise<Record<string, unknown>> {
  const helper = new URL("./address-intern-helper.ts", import.meta.url);
  // Spawned by name so the launch matches the task's `--allow-run=deno`
  // grant, which resolves the name through PATH the same way.
  const command = new Deno.Command("deno", {
    args: [
      "run",
      "-A",
      "--v8-flags=--expose-gc",
      fromFileUrl(helper),
      scenario,
    ],
    stdout: "piped",
    stderr: "piped",
  });
  const output = await command.output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);
  expect(output.success, `helper failed:\n${stderr}\n${stdout}`).toBe(true);
  const lines = stdout.trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

describe("AddressInterner", () => {
  describe("instance members", () => {
    describe("address()", () => {
      it("returns one object for one address", () => {
        const interner = new AddressInterner();
        const first = interner.address(space, "user", id, alice, [
          "value",
          "title",
        ]);
        const second = interner.address(space, "user", id, alice, [
          "value",
          "title",
        ]);

        expect(second).toBe(first);
        expect(second.path).toBe(first.path);
        expect(interner.accessForTestingOnly.size()).toBe(1);
      });

      it("returns one path array for one path under different documents", () => {
        const interner = new AddressInterner();
        const first = interner.address(space, "space", id, undefined, [
          "value",
        ]);
        const second = interner.address(
          otherSpace,
          "space",
          "of:another" as URI,
          undefined,
          ["value"],
        );

        expect(second).not.toBe(first);
        expect(second.path).toBe(first.path);
      });

      it("returns a different object for addresses that differ in any field", () => {
        // A key collision here would merge two documents' reads in the
        // scheduler, and a write to one would wake the other's readers.

        type Fields = [
          MemorySpace,
          CellScope | undefined,
          URI,
          ScopeKey | undefined,
          readonly string[],
        ];
        const base: Fields = [space, "user", id, alice, ["a", "b"]];
        const variants: Fields[] = [
          base,
          [otherSpace, "user", id, alice, ["a", "b"]],
          [space, "space", id, alice, ["a", "b"]],
          [space, undefined, id, alice, ["a", "b"]],
          [space, "user", id, undefined, ["a", "b"]],
          [space, "user", id, bob, ["a", "b"]],
          [space, "user", "of:other" as URI, alice, ["a", "b"]],
          [space, "user", id, alice, ["a"]],
          [space, "user", id, alice, ["a", "b", "c"]],
          [space, "user", id, alice, ["a", "c"]],
          [space, "user", id, alice, ["a/b"]],
          [space, "user", id, alice, [""]],
          [space, "user", id, alice, []],
        ];
        const interner = new AddressInterner();
        const addresses = variants.map((fields) => interner.address(...fields));

        expect(new Set(addresses).size).toBe(variants.length);
        expect(interner.accessForTestingOnly.size()).toBe(variants.length);
        for (const [index, address] of addresses.entries()) {
          const [inSpace, scope, ofId, scopeKey, path] = variants[index];
          expect(address).toEqual({
            space: inSpace,
            scope,
            id: ofId,
            ...(scopeKey !== undefined ? { scopeKey } : {}),
            path,
          });
        }
      });

      it("freezes the address and its path, and copies the caller's path", () => {
        const interner = new AddressInterner();
        const path = ["value", "items", "0"];
        const address = interner.address(space, "space", id, undefined, path);

        expect(Object.isFrozen(address)).toBe(true);
        expect(Object.isFrozen(address.path)).toBe(true);
        expect(Object.isFrozen(path)).toBe(false);
        expect(address.path).not.toBe(path);

        path[2] = "1";
        path.push("name");
        expect(address.path).toEqual(["value", "items", "0"]);
        expect(
          interner.address(space, "space", id, undefined, [
            "value",
            "items",
            "0",
          ]),
        ).toBe(address);
      });

      it("returns the keys `space`, `scope`, `id`, `scopeKey` and `path`, in that order", () => {
        const interner = new AddressInterner();
        const unkeyed = interner.address(space, "space", id, undefined, [
          "value",
        ]);
        const keyed = interner.address(space, "user", id, alice, ["value"]);
        const unscoped = interner.address(space, undefined, id, undefined, [
          "value",
        ]);

        expect(Object.keys(unkeyed)).toEqual(["space", "scope", "id", "path"]);
        expect(Object.keys(keyed)).toEqual([
          "space",
          "scope",
          "id",
          "scopeKey",
          "path",
        ]);
        expect(Object.keys(unscoped)).toEqual([
          "space",
          "scope",
          "id",
          "path",
        ]);
        expect(JSON.stringify(keyed)).toBe(
          JSON.stringify({
            space,
            scope: "user",
            id,
            scopeKey: alice,
            path: ["value"],
          }),
        );
      });

      it("returns one address for each scope one document is interned under", () => {
        const interner = new AddressInterner();
        const forAlice = interner.address(space, "user", id, alice, ["value"]);
        const forBob = interner.address(space, "user", id, bob, ["value"]);
        const shared = interner.address(space, "space", id, undefined, [
          "value",
        ]);

        expect(new Set([forAlice, forBob, shared]).size).toBe(3);
        expect(interner.address(space, "user", id, bob, ["value"])).toBe(
          forBob,
        );
        expect(interner.address(space, "user", id, alice, ["value"])).toBe(
          forAlice,
        );
        expect(interner.address(space, "space", id, undefined, ["value"]))
          .toBe(shared);
        expect(interner.accessForTestingOnly.size()).toBe(3);
      });
    });

    describe("what the table holds", () => {
      it("sweeps once its slots reach 4,096, or twice the live addresses at the last sweep, keeping only what someone holds", async () => {
        const report = await runHelper("growth");

        expect(report).toEqual({
          floorBefore: 4095,
          floorAfter: 1,
          sizeAfterSweep: 5000,
          sizeBelowThreshold: 9999,
          sizeAtThreshold: 5001,
          stillHeld: 5000,
        });
      });

      it("returns 0 once the only address is collected and swept, with its path nodes gone", async () => {
        const report = await runHelper("release");

        expect(report.collected).toBe(true);
        expect(report.sizeAfterSweep).toBe(0);
        expect(report.nodesAfterSweep).toBe(0);
        expect(report.sizeAfterSecond).toBe(1);
        expect(report.nodesAfterSecond).toBe(3);
        expect(report.secondPath).toEqual(["value", "a", "b"]);
      });
    });
  });
});
