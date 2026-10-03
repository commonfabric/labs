/**
 * A list builtin stages each binding its callback captures into the
 * sub-pattern it sets up for an entry. Staging writes none of the bound value
 * and mints none of the slot's integrity for the stager, so an integrity floor
 * the capture's schema declares at the captured field is met only by the value
 * the field holds. A pattern's argument holds its caller's binding as a link,
 * so the value a capture of one of the argument's fields reaches lives in the
 * caller's cell, and the floor is credited from there.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import { addCfcDenialListener } from "../src/cfc/denial-report.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

const signer = await Identity.fromPassphrase("captured-binding-write-floor");
const space = signer.did();

const REFUSED =
  "write floor failed at /params/admins (requiredIntegrity, §8.12.4.1)";

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
   * Runs a pattern holding a registry, which it passes to a sub-pattern that
   * maps its rows with a callback capturing the registry's `admins`, floored
   * at the `admin` endorsement. Sets the registry's admins to `admins` unless
   * it is undefined, through a schema that mints the endorsement where
   * `endorsed`, adds two rows, and returns what each row reads.
   */
  async function run(
    admins: string[] | undefined,
    endorsed = true,
  ): Promise<unknown> {
    const declared = endorsed ? "Admins" : "string[]";
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
          type Admins = RequiresIntegrity<
            WriteAuthorizedBy<
              AddIntegrity<string[], readonly ["admin"]>,
              typeof editAdmins
            >,
            readonly ["admin"]
          >;
          interface AdminsState {
            admins: Writable<${declared} | undefined>;
          }
          const editAdmins = handler<{ admins: string[] }, AdminsState>(
            (event, { admins }) => {
              admins.set(event.admins);
            },
          );
          const addRow = handler<{ row: string }, { rows: Writable<string[]> }>(
            (event, { rows }) => {
              rows.set([...rows.get(), event.row]);
            },
          );
          const Rows = pattern<
            { registry: Writable<{ admins?: Admins }>; rows: Writable<string[]> }
          >(({ registry, rows }) => {
            const admins: Writable<Admins | undefined> = registry.key("admins");
            return {
              admin: rows.map((row) =>
                computed(() => (admins.get() ?? []).includes(row))
              ),
            };
          });
          export default pattern<Record<string, never>>(() => {
            const registry = new Writable<{ admins?: ${declared} }>({})
              .for("registry");
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

  it("commits a captured field of an argument whose caller's cell holds a value its writer endorsed there", async () => {
    expect(await run(["a"])).toEqual([true, false]);
    expect(reasons).not.toContain(REFUSED);
  });

  it("commits a captured field of an argument whose caller's cell holds nothing there", async () => {
    expect(await run(undefined)).toEqual([false, false]);
    expect(reasons).not.toContain(REFUSED);
  });

  it("refuses a captured field of an argument whose caller's cell holds a value nothing endorsed there", async () => {
    expect(await run(["a"], false)).toEqual([]);
    expect(reasons).toContain(REFUSED);
  });
});
