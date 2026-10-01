import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import type { Cell } from "../src/cell.ts";
import { parseLink } from "../src/link-utils.ts";
import { Runtime } from "../src/runtime.ts";
import { createTrustedBuilder } from "./support/trusted-builder.ts";

describe("inspace-output-links", () => {
  it("keeps a child output passed to another child inside their shared space", async () => {
    const signer = await Identity.fromPassphrase("inspace-output-links-home");
    const target = (await Identity.fromPassphrase("inspace-output-links-room"))
      .did();
    const storage = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: storage,
    });
    try {
      const { handler, pattern } = createTrustedBuilder(runtime).commonfabric;
      const Policy = pattern<{ value: string }>(({ value }) => ({ value }));
      const Room = pattern<{ policy: Cell<string> }>(
        ({ policy }) => ({ policy }),
        {
          type: "object",
          properties: { policy: { type: "string", asCell: ["cell"] } },
          required: ["policy"],
        },
      );
      const create = handler<Record<string, never>, { room: Cell<unknown> }>(
        { type: "object" },
        {
          type: "object",
          properties: { room: { asCell: ["cell"] } },
          required: ["room"],
        },
        (_event, { room }) => {
          const policy = Policy.inSpace(target)({ value: "shared policy" });
          const child = Room.inSpace(target)({ policy: policy.value });
          // Factory outputs support naming through their runtime cell proxy.
          // Naming after another node consumes the output must still work.
          (policy as unknown as Cell<{ value: string }>).for("policy");
          (child as unknown as Cell<{ policy: string }>).for("room");
          room.set(child);
        },
      );
      const Root = pattern<{ room: Cell<unknown> }>(
        ({ room }) => ({ create: create({ room }) }),
        {
          type: "object",
          properties: { room: { asCell: ["cell"] } },
          required: ["room"],
        },
      );
      const tx = runtime.edit();
      const room = runtime.getCell(
        signer.did(),
        "room-reference",
        undefined,
        tx,
      );
      const root = runtime.getCell(signer.did(), "creator", undefined, tx);
      const result = runtime.run(tx, Root, { room }, root);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      await runtime.idle();
      await result.pull();
      result.key("create").send({});
      await runtime.idle();
      await storage.synced();
      await room.pull();

      const child = room.resolveAsCell();
      expect(child.space).toBe(target);
      const argument = child.getArgumentCell<{ policy: string }>()!;
      const policyLink = parseLink(argument.key("policy").getRaw(), argument);
      // Inspect the stored hop, since resolving it would hide a private alias.
      expect(policyLink?.space).toBe(target);
      expect(await child.key("policy").pull()).toBe("shared policy");
    } finally {
      await runtime.dispose();
      await storage.close();
    }
  });
});
