/**
 * Exercises CLI creation retries against an in-process memory store and a
 * client runtime. The root's registration action and creation receipts are
 * real; the dependency seams supply the already-open space and source program.
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { createSession, Identity } from "@commonfabric/identity";
import { pieceId } from "@commonfabric/piece";
import {
  PiecesController,
  ServedLifecycleRefusal,
} from "@commonfabric/piece/ops";
import { type Cell, Runtime, type RuntimeProgram } from "@commonfabric/runner";
import { pieceListSchema } from "@commonfabric/runner/schemas";
import {
  EmulatedStorageManager,
  newLoopbackServer,
} from "@commonfabric/runner/storage/cache.deno";

import { newPiece } from "../lib/piece.ts";
import { resetWriteReceipts } from "../lib/write-receipt.ts";

const CONFIG = {
  apiUrl: "https://cf.dev",
  space: "cli-piece-retry",
  identity: "/unused/identity.key",
};

const NOTE_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `
import { pattern } from "commonfabric";
export default pattern<{ title: string; body: string }>(
  ({ title, body }) => ({ title, body }),
);
`,
  }],
};

const ROOT_PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `
import { handler, pattern, Writable } from "commonfabric";
const addPiece = handler<
  { piece: Writable<unknown> },
  {
    blocked: Writable<boolean>;
    attempts: Writable<Writable<unknown>[]>;
    panels: Writable<Writable<unknown>[]>;
  }
>(({ piece }, { blocked, attempts, panels }) => {
  attempts.push(piece);
  if (!blocked.get()) panels.addUnique(piece);
});
export default pattern(() => {
  const blocked = new Writable(false);
  const attempts = new Writable<Writable<unknown>[]>([]);
  const panels = new Writable<Writable<unknown>[]>([]);
  return {
    blocked,
    attempts,
    pieceRegistry: panels,
    addPiece: addPiece({ blocked, attempts, panels }),
  };
});
`,
  }],
};

describe("newPiece()", () => {
  let server: ReturnType<typeof newLoopbackServer>;
  let storageManager: EmulatedStorageManager;
  let runtime: Runtime;
  let pieces: PiecesController;
  let controller: PiecesController;
  let signer: Identity;
  let root: Cell<unknown>;

  beforeEach(async () => {
    resetWriteReceipts();
    signer = await Identity.fromPassphrase("CLI creation retry tests");
    server = newLoopbackServer({ subscriptionRefreshDelayMs: 0 });
    await openClient();
    root = (await pieces.create(ROOT_PROGRAM)).getCell();
    await pieces.linkDefaultPattern(root);
  });

  afterEach(async () => {
    await runtime?.dispose();
    await server?.close();
  });

  /** Opens an independent client connection to the test's memory server. */
  async function openClient(): Promise<void> {
    storageManager = EmulatedStorageManager.connectTo(server, { as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      experimental: { serverExecution: false },
    });
    pieces = new PiecesController(
      await createSession({ identity: signer, spaceName: CONFIG.space }),
      runtime,
    );
    await pieces.synced();
    controller = new Proxy(pieces, {
      get(target, property) {
        // The fixture root supplies the same registration contract as the
        // system root, so its source stays under the test's control.
        if (property === "ensureDefaultPattern") {
          return () => Promise.resolve();
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  /** Reopens the space with the persisted state a later CLI invocation sees. */
  async function reconnect(): Promise<void> {
    const rootId = pieceId(root)!;
    await runtime.dispose();
    await openClient();
    root = (await pieces.get(rootId)).getCell();
  }

  /** Creates a note through the CLI with a caller-owned retry identity. */
  function createNote(
    requestKey: string,
    body: string,
    slug?: string,
  ): Promise<string> {
    return newPiece(
      CONFIG,
      { mainPath: "/notes/main.tsx" },
      { requestKey, input: { title: "Imported note", body }, slug },
      {
        loadPieces: () => Promise.resolve(controller),
        loadIdentity: () => Promise.resolve(signer),
        getPinnedProgramFromFile: () => Promise.resolve(NOTE_PROGRAM),
      },
    );
  }

  /** Returns the identities delivered to the fixture root's registration action. */
  async function registrationAttempts(): Promise<string[]> {
    const attempts = root.key("attempts").asSchema(pieceListSchema);
    await attempts.sync();
    return attempts.get().map((piece) => pieceId(piece)!);
  }

  it("reuses a creation key without replacing edits or registering a second piece", async () => {
    const markdown = "---\ntags: [team]\n---\n# Notes\n\n- [ ] Café 📝\n";
    const created = await createNote("completed-import", markdown);
    const piece = await pieces.get(created);
    expect(await piece.input.get()).toEqual({
      title: "Imported note",
      body: markdown,
    });

    const edited = markdown + "\nA colleague edited the shared note.\n";
    const input = await piece.input.getCell();
    const outcome = await runtime.editWithRetry((tx) =>
      input.withTx(tx).key("body").set(edited)
    );
    expect(outcome.error).toBeUndefined();
    await pieces.synced();
    await reconnect();

    expect(await (await pieces.get(created)).input.get(["body"]))
      .toBe(edited);

    const retried = await createNote("completed-import", markdown);

    expect(retried).toBe(created);
    expect(await (await pieces.get(retried)).input.get(["body"]))
      .toBe(edited);
    expect((await pieces.getRegisteredPieces()).map((entry) => entry.id))
      .toEqual([created]);
    expect(await registrationAttempts()).toEqual([created]);
  });

  it("preserves a definite refusal when a different creation claims a taken slug", async () => {
    const created = await createNote("original", "# Original", "shared-note");

    await expect(createNote("other", "# Other", "shared-note"))
      .rejects.toBeInstanceOf(ServedLifecycleRefusal);
    await expect(createNote("other", "# Other", "shared-note"))
      .rejects.toThrow('Slug "shared-note" already points at');
    expect((await pieces.getRegisteredPieces()).map((entry) => entry.id))
      .toEqual([created]);
  });

  it("registers the retained piece after repairing an incomplete registration", async () => {
    const blocked = await runtime.editWithRetry((tx) =>
      root.withTx(tx).key("blocked").set(true)
    );
    expect(blocked.error).toBeUndefined();
    const markdown = "# Imported while registration is unavailable\n";

    await expect(createNote("incomplete-import", markdown)).rejects.toThrow();
    const attempts = await registrationAttempts();
    expect(attempts).toHaveLength(1);
    const created = attempts[0]!;
    const piece = await pieces.get(created);
    expect(await piece.input.get(["body"])).toBe(markdown);
    expect(await pieces.getRegisteredPieces()).toHaveLength(0);

    const edited = "# Edited before registration recovered\n";
    const input = await piece.input.getCell();
    const repaired = await runtime.editWithRetry((tx) => {
      root.withTx(tx).key("blocked").set(false);
      input.withTx(tx).key("body").set(edited);
    });
    expect(repaired.error).toBeUndefined();
    await pieces.synced();
    await reconnect();

    const retried = await createNote("incomplete-import", markdown);

    expect(retried).toBe(created);
    expect(await (await pieces.get(retried)).input.get(["body"]))
      .toBe(edited);
    expect((await pieces.getRegisteredPieces()).map((entry) => entry.id))
      .toEqual([created]);
    expect(await registrationAttempts()).toEqual([created, created]);
  });
});
