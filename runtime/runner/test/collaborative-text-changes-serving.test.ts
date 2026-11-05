/**
 * `applyChanges()` from a served handler, whose transaction seals into a wave
 * rather than committing on its own. The wave drops the reads of what it
 * seals, so the edit's own baseline hash is what keeps it off text the handler
 * did not read.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import {
  CODEMIRROR_CHANGESET_CODEC,
  toValuePath,
} from "@commonfabric/memory/v2";
import * as Engine from "@commonfabric/memory/v2/engine";

import type { Cell } from "../src/cell.ts";
import { stampWaveRunContext } from "../src/executor/wave.ts";
import type { MemorySpace } from "../src/storage/interface.ts";
import { ServingWaves } from "./support/serving-waves.ts";

const signer = await Identity.fromPassphrase(
  "collaborative text changes serving",
);
const space = signer.did() as MemorySpace;

type Note = { title: string; body: string };

const noteSchema = {
  type: "object",
  properties: { title: { type: "string" }, body: { type: "string" } },
  // deno-lint-ignore no-explicit-any
} as any;

describe("collaborative-text-changes-serving", () => {
  let waves: ServingWaves;
  let note: Cell<Note>;

  beforeEach(async () => {
    // The note's body is `abc`, in a field epoch a peer opened by typing the
    // `b`, and the serving runtime has seen it.

    waves = await ServingWaves.open(signer);
    const { runtime } = waves;
    note = runtime.getCell<Note>(space, "note", noteSchema);
    const seed = runtime.edit();
    note.withTx(seed).set({ title: "Notes", body: "ac" });
    expect((await seed.commit().settled).error).toBeUndefined();
    await waves.storageManager.synced();
    await waves.writeAsPeer(
      note,
      (peer) => peer.key("body").applyChanges({ from: 1, insert: "b" }),
    );
    expect(note.key("body").get()).toBe("abc");
    waves.serve();
  });
  afterEach(async () => {
    await waves.dispose();
  });

  /** Runs `edit` in a transaction stamped as an event handler's run. */
  const handle = async (
    actionId: string,
    edit: (body: Cell<string>) => void,
  ): Promise<void> => {
    const tx = waves.runtime.edit();
    stampWaveRunContext(tx, { actionId, kind: "event-handler" });
    edit(note.withTx(tx).key("body"));
    await tx.commit().settled;
  };

  /** The note's body as the store holds it. */
  const storedBody = (): unknown =>
    (Engine.read(waves.engine, { id: note.getAsNormalizedFullLink().id }) as {
      value?: Note;
    })?.value?.body;

  it("commits a served handler's edit through its wave", async () => {
    await handle(
      "append",
      (body) => body.applyChanges({ from: 3, insert: "d" }),
    );
    await waves.commitWave();

    expect(storedBody()).toBe("abcd");
    expect(
      Engine.queryOperationField(waves.engine, {
        id: note.getAsNormalizedFullLink().id,
        path: toValuePath(["body"]),
      }),
    ).toMatchObject({ active: true, cursor: { epoch: 1, version: 2 } });
  });

  it("commits two served handlers' edits to one field in one wave", async () => {
    await handle(
      "first",
      (body) => body.applyChanges({ from: 3, insert: "d" }),
    );
    await handle("second", (body) => {
      expect(body.get(), "the second run reads the first one's edit").toBe(
        "abcd",
      );
      body.applyChanges({ from: 4, insert: "!" });
    });
    await waves.commitWave();

    expect(storedBody()).toBe("abcd!");
  });

  it("keeps a served handler's edit off a keystroke its replica never saw", async () => {
    // The editor types `x` over the `b`. The keystroke goes straight to the
    // store, so the serving replica still holds `abc` when the handler reads,
    // and the handler's seal opens a wave whose basis already counts it. The
    // length is unchanged, so the handler's change set fits the text, and
    // only the hash says it was computed from other text: applied, it would
    // replace the editor's `x` with the handler's `B`.

    Engine.applyCommit(waves.engine, {
      sessionId: "session:editor",
      commit: {
        localSeq: 1,
        reads: { confirmed: [], pending: [] },
        operations: [{
          op: "apply-op",
          id: note.getAsNormalizedFullLink().id,
          path: toValuePath(["body"]),
          codec: CODEMIRROR_CHANGESET_CODEC,
          submissionId: "editor:1",
          base: { epoch: 1, version: 1 },
          payload: {
            updates: [{ clientId: "editor", changes: [1, [1, "x"], 1] }],
          },
        }],
      },
    });
    await handle("append", (body) => {
      expect(body.get(), "the replica has not seen the keystroke").toBe("abc");
      body.applyChanges({ from: 1, to: 2, insert: "B" });
    });
    await waves.commitWave();

    expect(storedBody()).toBe("axc");
  });
});
