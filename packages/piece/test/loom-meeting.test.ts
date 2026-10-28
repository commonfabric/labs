/** Meeting binding preserves malformed storage and survives source updates. */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { FabricEpochDay } from "@commonfabric/data-model/fabric-primitives";
import { createSession, Identity } from "@commonfabric/identity";
import {
  type Cell,
  getPatternIdentityRef,
  getPatternSetupIdentityRef,
  Runtime,
  type RuntimeProgram,
  sendEvent,
  setPatternSource,
  type Stream,
} from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { rawMetaWriteAuthorization } from "@commonfabric/runner/meta-seam";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { PiecesController } from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("loom meeting contract");

/** Sends an event and waits for its handler transaction. */
const sendAndSettle = (
  stream: Readonly<Stream<unknown>>,
  event: unknown,
  eventId: string,
): Promise<void> =>
  new Promise((resolve, reject) =>
    sendEvent(stream, event, (tx) => {
      const status = tx.status();
      if (status.status === "error") reject(status.error);
      else resolve();
    }, { eventId, session: signer.did() })
  );

describe("loom meeting", () => {
  let manager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;
  let root: Cell<unknown>;
  let program: RuntimeProgram;

  beforeEach(async () => {
    manager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://localhost:9999"),
      storageManager: manager,
    });
    pieces = new PiecesController(
      createSession({
        identity: signer,
        spaceDid: await runtime.createSpace(),
      }),
      runtime,
    );
    await pieces.ready;
    program = await resolveLocalProgram(
      runtime.harness.resolve.bind(runtime.harness),
      {
        root: fromFileUrl(new URL("../../patterns/", import.meta.url)),
        main: fromFileUrl(
          new URL("../../patterns/loom/main.tsx", import.meta.url),
        ),
      },
    );
  });

  afterEach(async () => {
    await runtime.dispose();
    await manager.close();
  });

  it("preserves meeting state through refusals and a source update", async () => {
    const compiled = await runtime.patternManager.compilePattern(program, {
      space: pieces.getSpace(),
    });
    root = await pieces.runPersistent(compiled, {}, "loom meeting");
    const key = "a".repeat(64);
    const meetingSchema = {
      type: "object",
      properties: {
        meeting: { type: "object", additionalProperties: true },
        bindMeeting: { asCell: ["stream"] },
      },
      required: ["meeting", "bindMeeting"],
    } as const;
    const output = root.asSchema(meetingSchema);
    const bind = await output.key("bindMeeting").pull();
    const meeting = pieces.getArgument(root).key("meeting").asSchema(undefined);
    const reply = runtime.getCell(pieces.getSpace(), "meeting reply");
    const malformed = [null, [], "unexpected", 12, { key: 12 }, {
      key: `${key}\n`,
    }, {
      future: true,
    }, new FabricEpochDay(123n)];
    for (const [index, value] of malformed.entries()) {
      const { error } = await runtime.editWithRetry((tx) => {
        meeting.withTx(tx).set(value);
      });
      expect(error).toBeUndefined();
      await sendAndSettle(bind, { key, reply }, `meeting-malformed-${index}`);
      expect(meeting.getRaw()).toEqual(value);
      expect(await reply.pull()).toEqual({ status: "invalid-state" });
    }
    const stored = { key, future: { preserved: true } };
    const { error } = await runtime.editWithRetry((tx) => {
      meeting.withTx(tx).set(stored);
    });
    expect(error).toBeUndefined();
    await sendAndSettle(bind, { key, reply }, "meeting-before-update");
    expect(await reply.pull()).toEqual({ status: "already-bound", key });

    const controller = await pieces.get(root.getAsNormalizedFullLink().id);
    const before = getPatternIdentityRef(root)?.identity;
    await controller.setPattern({
      ...program,
      files: program.files.map((file) =>
        file.name === program.main
          ? {
            ...file,
            contents: file.contents.replace(
              "<cf-screen>",
              '<cf-screen data-source-update="true">',
            ),
          }
          : file
      ),
    });
    await runtime.idle();
    expect(getPatternIdentityRef(root)?.identity).not.toBe(before);
    expect(output.key("meeting").getRaw({ lastNode: "value" })).toEqual(
      stored,
    );
    await sendAndSettle(
      await output.key("bindMeeting").pull(),
      { key: "b".repeat(64), reply },
      "meeting-after-update",
    );
    expect(await reply.pull()).toEqual({ status: "conflict", key });
    expect(output.key("meeting").getRaw({ lastNode: "value" })).toEqual(
      stored,
    );
  });

  it("leaves the association unchanged when a request's reply cell is the association", async () => {
    const compiled = await runtime.patternManager.compilePattern(program, {
      space: pieces.getSpace(),
    });
    root = await pieces.runPersistent(compiled, {}, "loom meeting alias");
    const key = "a".repeat(64);
    const bind = await root.asSchema(
      {
        type: "object",
        properties: { bindMeeting: { asCell: ["stream"] } },
        required: ["bindMeeting"],
      } as const,
    ).key("bindMeeting").pull();
    const meeting = pieces.getArgument(root).key("meeting").asSchema(undefined);
    const cases: [string, unknown, string][] = [
      ["empty", {}, key],
      ["bound, invalid key", { key }, "bad"],
      ["bound, conflicting key", {
        key,
        future: { preserved: true },
      }, "b".repeat(64)],
      ["malformed", { future: { preserved: true } }, key],
    ];
    for (const [name, value, requested] of cases) {
      const { error } = await runtime.editWithRetry((tx) => {
        meeting.withTx(tx).set(value);
      });
      expect(error).toBeUndefined();
      await sendAndSettle(
        bind,
        { key: requested, reply: meeting },
        `meeting-alias-${name}`,
      );
      expect(meeting.getRaw()).toEqual(value);
    }
  });

  for (const mode of ["controller", "cold setup"] as const) {
    it(`binds a populated pre-meeting root after ${mode} and preserves panel writes`, async () => {
      const space = pieces.getSpace();
      const legacy = { ...program, files: [...program.files] };
      // Freeze the two changed Loom sources at 4edf1fba52. Other imports use
      // the resolved source closure, including admission and presentation.
      for (const name of ["main.tsx", "schemas.tsx"]) {
        const index = legacy.files.findIndex((file) =>
          file.name.endsWith(`loom/${name}`)
        );
        expect(index).toBeGreaterThanOrEqual(0);
        legacy.files[index] = {
          ...legacy.files[index],
          contents: await Deno.readTextFile(
            new URL(
              `./fixtures/loom-before-meeting/${name}.txt`,
              import.meta.url,
            ),
          ),
        };
      }
      const compiled = await runtime.patternManager.compilePattern(legacy, {
        space,
      });
      root = await pieces.runPersistent(compiled, {}, "legacy loom meeting");
      await pieces.linkDefaultPattern(root);
      const panelSchema = {
        type: "object",
        properties: {
          panels: {
            type: "array",
            items: { type: "unknown", asCell: ["cell"] },
          },
          addPiece: { asCell: ["stream"] },
        },
        required: ["panels", "addPiece"],
      } as const;
      const output = root.asSchema(panelSchema);
      expect(root.asSchema(undefined).key("meeting").getRaw()).toBeUndefined();
      await sendAndSettle(
        await output.key("addPiece").pull(),
        { piece: runtime.getCell(space, "before meeting upgrade") },
        "before-meeting-upgrade",
      );
      const [panel] = await output.key("panels").pull();
      const panelLink = panel.resolveAsCell().getAsNormalizedFullLink();
      const candidate = await runtime.patternManager.compilePattern(program, {
        space,
      });
      const nextRef = runtime.patternManager.getArtifactEntryRef(candidate)!;
      expect(nextRef).not.toEqual(getPatternIdentityRef(root));
      const link = root.getAsNormalizedFullLink();
      if (mode === "controller") {
        await (await pieces.get(link.id)).setPattern(program);
      } else {
        const { error } = await runtime.editWithRetry((tx) => {
          root.withTx(tx).setMetaRaw(
            "patternIdentity",
            nextRef,
            rawMetaWriteAuthorization,
          );
          setPatternSource(root, tx, "system:loom/main.tsx");
        });
        expect(error).toBeUndefined();
      }
      await runtime.dispose({ closeStorage: false });
      runtime = new Runtime({
        apiUrl: new URL("http://localhost:9999"),
        storageManager: manager,
      });
      const reopened = runtime.getCellFromLink(link);
      const loaded = await runtime.patternManager.loadPatternByIdentity(
        nextRef.identity,
        nextRef.symbol,
        space,
      );
      expect(loaded).toBeDefined();
      // The daemon can set up an identity-swapped root before starting it.
      await runtime.runSynced(reopened, loaded!, undefined, {
        expectedPatternIdentity: nextRef,
      });
      expect(getPatternSetupIdentityRef(reopened)).toEqual(nextRef);
      await runtime.start(reopened);
      const current = reopened.asSchema(
        {
          ...panelSchema,
          properties: {
            ...panelSchema.properties,
            meeting: { type: "object", additionalProperties: true },
            bindMeeting: { asCell: ["stream"] },
          },
          required: [...panelSchema.required, "meeting", "bindMeeting"],
        } as const,
      );
      const retained = await current.key("panels").pull();
      expect(retained).toHaveLength(1);
      expect(retained[0].resolveAsCell().getAsNormalizedFullLink()).toEqual(
        panelLink,
      );
      const reply = runtime.getCell(space, "upgraded meeting reply");
      const key = "a".repeat(64);
      const bind = await current.key("bindMeeting").pull();
      await sendAndSettle(bind, { key, reply }, "bind-after-upgrade");
      expect(await reply.pull()).toEqual({ status: "bound", key });
      expect(await current.key("meeting").pull()).toEqual({ key });
      await sendAndSettle(bind, { key, reply }, "replay-after-upgrade");
      expect(await reply.pull()).toEqual({ status: "already-bound", key });
      await sendAndSettle(
        bind,
        { key: "b".repeat(64), reply },
        "conflict-after-upgrade",
      );
      expect(await reply.pull()).toEqual({ status: "conflict", key });
      expect(await current.key("meeting").pull()).toEqual({ key });
      await sendAndSettle(
        await current.key("addPiece").pull(),
        { piece: runtime.getCell(space, "after meeting upgrade") },
        "add-after-meeting-upgrade",
      );
      expect(await current.key("panels").pull()).toHaveLength(2);
    });
  }
});
