import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { Identity } from "@commonfabric/identity";

import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";

// CT-1648: profiles carry an owner-authored free-text `bio`. It starts empty,
// is written ONLY through the authorized `setBio` handler (owner-protected like
// name/avatar), and is readable from the profile result. This drives the real
// shipped `profile-home.tsx` and exercises create -> edit -> read.
const signer = await Identity.fromPassphrase("profile-home-bio");
const space = signer.did();

const sysDir = fromFileUrl(new URL("../../patterns/system/", import.meta.url));
const PROGRAM: RuntimeProgram = {
  main: "/profile-home.tsx",
  files: [
    {
      name: "/profile-home.tsx",
      contents: Deno.readTextFileSync(sysDir + "profile-home.tsx"),
    },
  ],
};

const RESULT_CAUSE = "profile-home bio";

describe("profile-home bio (owner-protected free-text field)", () => {
  let manager: EmulatedStorageManager;

  beforeEach(() => {
    manager = EmulatedStorageManager.emulate({ as: signer });
  });
  afterEach(async () => {
    await manager?.close();
  });

  it("starts empty, then accepts create + edit through setBio", async () => {
    const rt = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
    });
    try {
      const tx = rt.edit();
      const pattern = await rt.patternManager.compilePattern(PROGRAM, {
        space,
        tx,
      });
      const resultCell = rt.getCell<Record<string, unknown>>(
        space,
        RESULT_CAUSE,
        undefined,
        tx,
      );
      // deno-lint-ignore no-explicit-any
      const result = rt.run(
        tx,
        pattern as any,
        { initialName: "Ada" },
        resultCell,
      );
      rt.prepareTxForCommit(tx);
      const commit = await tx.commit().settled;
      expect(commit.error).toBeUndefined();
      await result.pull();

      // Fresh profile: bio is empty.
      expect(result.key("bio").get() ?? "").toBe("");

      // Create a bio via the authorized setBio stream (the "pin from event"
      // path; the edit form binds the same handler to the bio draft cell).
      const tx2 = rt.edit();
      result.withTx(tx2).key("setBio").send({
        bio: "Mathematician & first programmer.",
      });
      // A manual test tx prepares the way the runtime's own commit paths do:
      // an enforcing rung refuses a relevant transaction that arrives
      // unprepared.
      rt.prepareTxForCommit(tx2);
      const commit2 = await tx2.commit().settled;
      expect(commit2.error).toBeUndefined();
      await result.pull();
      await rt.idle();
      await result.pull();
      expect(result.key("bio").get()).toBe("Mathematician & first programmer.");

      // Editing replaces the value (and trims surrounding whitespace).
      const tx3 = rt.edit();
      result.withTx(tx3).key("setBio").send({
        bio: "  Countess of Lovelace.  ",
      });
      rt.prepareTxForCommit(tx3);
      const commit3 = await tx3.commit().settled;
      expect(commit3.error).toBeUndefined();
      await result.pull();
      await rt.idle();
      await result.pull();
      expect(result.key("bio").get()).toBe("Countess of Lovelace.");
    } finally {
      await rt.dispose();
    }
  });
});
