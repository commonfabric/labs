/**
 * A list builtin stages each binding its callback captures into the
 * sub-pattern it sets up for an entry. Staging writes none of the bound value
 * and mints none of the slot's integrity for the stager, so an integrity
 * floor the capture's schema declares below the slot is met only by what the
 * bound cell holds there. A pattern's argument holds its caller's binding as
 * a link, so the value a capture of the argument reaches lives in the caller's
 * cell, and the floor is credited from there.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { addCfcDenialListener } from "../src/cfc/denial-report.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("captured-binding-write-floor");
const space = signer.did();

// A registry whose `admins` its writer alone may change, and whose value has
// to carry the `admin` endorsement that a write through the schema mints.
const floored = "Registry";
// A registry declaring neither, as a caller's own cell may.
const plain = "{ admins?: string[] }";

// What the sub-pattern's callback captures: its whole argument, or the
// argument's floored field, which the link a capture stages then names.
const captures = {
  registry: "(registry.get().admins ?? []).includes(row)",
  admins: "(admins.get() ?? []).includes(row)",
};

describe("captured-binding-write-floor", () => {
  let runtime: Runtime;
  let manager: ReturnType<typeof StorageManager.emulate>;
  let reasons: string[];
  let stopListening: () => void;

  beforeEach(() => {
    manager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://example.com"),
      storageManager: manager,
      cfcWriteFloor: "enforce",
      trustSnapshotProvider: () => ({
        id: signer.did(),
        actingPrincipal: signer.did(),
      }),
    });
    reasons = [];
    stopListening = addCfcDenialListener((denial) => {
      const listed = denial.inputs.reasons;
      if (!Array.isArray(listed)) return;
      for (const reason of listed) reasons.push(String(reason));
    });
  });

  afterEach(async () => {
    stopListening();
    await runtime.dispose();
  });

  /**
   * Runs a pattern holding a registry declared by `registry`, which it passes
   * to a sub-pattern that maps its rows with a callback reading the registry,
   * sets the registry's admins to `admins` through their writer unless that is
   * undefined, adds two rows, and returns what each row reads. The callback
   * captures what `captured` names. The sub-pattern's `admins` mints the
   * endorsement its floor requires unless `mints` is false.
   */
  async function run(
    registry: string,
    admins: string[] | undefined,
    captured: keyof typeof captures = "registry",
    mints = true,
  ): Promise<unknown> {
    const compiled = await runtime.patternManager.compilePattern({
      main: "/main.tsx",
      files: [{
        name: "/main.tsx",
        contents: `/// <cts-enable />
          import {
            AddIntegrity,
            computed,
            handler,
            pattern,
            RequiresIntegrity,
            Writable,
            WriteAuthorizedBy,
          } from "commonfabric";
          const editAdmins = handler<
            { admins: string[] },
            { admins: Writable<string[] | undefined> }
          >((event, { admins }) => {
            admins.set(event.admins);
          });
          const addRow = handler<{ row: string }, { rows: Writable<string[]> }>(
            (event, { rows }) => {
              rows.set([...rows.get(), event.row]);
            },
          );
          type Admins = RequiresIntegrity<
            WriteAuthorizedBy<
              ${
          mints ? 'AddIntegrity<string[], readonly ["admin"]>' : "string[]"
        },
              typeof editAdmins
            >,
            readonly ["admin"]
          >;
          interface Registry { admins?: Admins }
          const Rows = pattern<
            { registry: Writable<Registry>; rows: Writable<string[]> }
          >(({ registry, rows }) => {
            const admins: Writable<Admins | undefined> = registry.key("admins");
            return {
              admin: rows.map((row) => computed(() => ${captures[captured]})),
            };
          });
          export default pattern<Record<string, never>>(() => {
            const registry = new Writable<${registry}>({}).for("registry");
            const rows = new Writable<string[]>([]).for("rows");
            const view = Rows({ registry, rows });
            return {
              admin: view.admin,
              setAdmins: editAdmins({ admins: registry.key("admins") }),
              addRow: addRow({ rows }),
            };
          });
        `,
      }],
    });
    const tx = runtime.edit();
    const output = runtime.getCell<
      { admin: unknown; setAdmins: unknown; addRow: unknown }
    >(space, "output", compiled.resultSchema, tx);
    const result = runtime.run(tx, compiled, {}, output);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    const cancel = result.sink(() => {});
    await runtime.idle();
    if (admins !== undefined) {
      result.key("setAdmins").send({ admins });
      await runtime.idle();
    }
    result.key("addRow").send({ row: "a" });
    await runtime.idle();
    result.key("addRow").send({ row: "b" });
    await runtime.idle();
    await manager.synced();
    const admin = await result.key("admin").pull();
    cancel();
    return admin;
  }

  it("commits a captured argument whose field holds a value its writer endorsed in the caller's cell", async () => {
    expect(await run(floored, ["a"])).toEqual([true, false]);
    expect(reasons.filter((reason) => reason.includes("write floor"))).toEqual(
      [],
    );
  });

  it("commits a captured field of an argument that holds a value its writer endorsed in the caller's cell", async () => {
    expect(await run(floored, ["a"], "admins")).toEqual([true, false]);
    expect(reasons.filter((reason) => reason.includes("write floor"))).toEqual(
      [],
    );
  });

  it("commits a captured argument whose caller's cell holds nothing at the floored field", async () => {
    expect(await run(plain, undefined)).toEqual([false, false]);
    expect(reasons.filter((reason) => reason.includes("write floor"))).toEqual(
      [],
    );
  });

  it("refuses a captured argument whose caller's cell holds nothing at a field whose schema mints nothing its floor requires", async () => {
    // Nothing lands through the capture, so only a write through the slot's
    // schema could meet the floor, and this one mints nothing.
    expect(await run(plain, undefined, "registry", false)).toEqual([]);
    expect(reasons).toContain(
      "write floor failed at /params/registry/admins (requiredIntegrity, §8.12.4.1)",
    );
  });

  it("refuses a captured argument whose caller's cell holds a value nothing endorsed at the floored field", async () => {
    expect(await run(plain, ["a"])).toEqual([]);
    expect(reasons).toContain(
      "write floor failed at /params/registry/admins (requiredIntegrity, §8.12.4.1)",
    );
  });
});
