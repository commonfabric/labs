import { expect } from "@std/expect";
import { fromFileUrl, join } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { valueEqual } from "@commonfabric/data-model";
import { createSession, Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { resolveLocalProgram } from "@commonfabric/runner/local-program.deno";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";

import { PiecesController } from "../src/ops/pieces-controller.ts";

const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
const PORTABLE = {
  scheme: "ical-uid-slot",
  item_key: "ff91746000eda3309fc01866704976f244a0f1832e418f51f1fab13968b8ccae",
  occurrence_key:
    "064701cd8b686840c32ef69ed46576a0c2726f140ccc6b31c8e64d27497f3aed",
};
const signer = await Identity.fromPassphrase("loom meeting identity update");

/** A key-only binding over the Loom's unchanged scoped input fields. */
const legacyFile = {
  name: "/legacy-meeting-root.tsx",
  contents: `
      import { type Default, handler, NAME, pattern, type PerSpace, type Stream, Writable } from "commonfabric";
      import type { LoomInput, Panel } from "./loom/schemas.tsx";
      interface Meeting { key?: string; [field: string]: unknown; }
      type MeetingCell = Writable<Meeting | Default<Record<PropertyKey, never>>>;
      type Input = Omit<LoomInput, "meeting"> & {
        meeting?: PerSpace<Writable<Meeting | Default<Record<PropertyKey, never>>>>;
      };
      type Result =
        | { status: "bound"; key: string }
        | { status: "already-bound"; key: string }
        | { status: "conflict"; key: string }
        | { status: "invalid-key" }
        | { status: "invalid-state" };
      interface Request { key: string; reply?: Writable<Result>; }
      const bind = handler<Request, { meeting: MeetingCell }>(
        ({ key, reply }, { meeting }) => {
          const storedKey = meeting.get().key;
          if (storedKey !== undefined) {
            reply?.set({ status: storedKey === key ? "already-bound" : "conflict", key: storedKey });
            return;
          }
          meeting.set({ key });
          reply?.set({ status: "bound", key });
        },
      );
      interface Output {
        [NAME]: string; title: string; panels: Writable<Panel>[];
        meeting: Meeting; bindMeeting: Stream<Request>;
      }
      export default pattern<Input, Output>(({ title, panels, meeting }) => ({
        [NAME]: title, title, panels, meeting, bindMeeting: bind({ meeting }),
      }));
    `,
};

describe("loom-meeting-identity-update", () => {
  let storage: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;

  beforeEach(async () => {
    storage = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager: storage,
    });
    pieces = new PiecesController(
      createSession({
        identity: signer,
        spaceDid: await runtime.createSpace(),
      }),
      runtime,
    );
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime.dispose();
    await storage.close();
  });

  it("retains the legacy association on upgrade and portable evidence on a later source update", async () => {
    const meeting = { key: KEY, future: "keep" };
    const loomDirectory = fromFileUrl(
      new URL("../../patterns/loom/", import.meta.url),
    );
    const program = await resolveLocalProgram(
      runtime.harness.resolve.bind(runtime.harness),
      {
        main: join(loomDirectory, "main.tsx"),
        root: fromFileUrl(new URL("../../patterns/", import.meta.url)),
        testPaths: Array.from(Deno.readDirSync(loomDirectory))
          .filter((entry) => entry.isFile && entry.name.endsWith(".test.tsx"))
          .map((entry) => join(loomDirectory, entry.name)),
      },
    );
    const piece = await pieces.create({
      ...program,
      main: legacyFile.name,
      files: [...program.files, legacyFile],
    }, {
      input: {
        title: "Established meeting Loom",
        panels: [{ kind: "url", url: "https://example.test/meeting" }],
        meeting,
      },
    });
    const panelsBefore = (await piece.result.getCell(["panels"]))
      .resolveAsCell().getRawUntyped({ lastNode: "value" });
    expect(await piece.result.get(["panels", 0, "url"]))
      .toBe("https://example.test/meeting");
    expect((await piece.result.getCell(["meeting"])).resolveAsCell().getRaw())
      .toEqual(meeting);
    await piece.result.set({ key: KEY, portableIdentity: PORTABLE }, [
      "bindMeeting",
    ]);
    await runtime.idle();
    expect((await piece.result.getCell(["meeting"])).resolveAsCell().getRaw())
      .toEqual(meeting);
    await piece.setPattern(program);
    await runtime.idle();
    await pieces.synced();
    expect((await piece.result.getCell(["meeting"])).resolveAsCell().getRaw())
      .toEqual(meeting);
    expect(await piece.result.get(["title"])).toBe("Established meeting Loom");
    expect(valueEqual(
      (await piece.result.getCell(["panels"]))
        .resolveAsCell().getRawUntyped({ lastNode: "value" }),
      panelsBefore,
    )).toBe(true);

    await piece.result.set({ key: KEY, portableIdentity: PORTABLE }, [
      "bindMeeting",
    ]);
    await runtime.idle();
    await pieces.synced();
    const enriched = { ...meeting, portableIdentity: PORTABLE };
    expect(await piece.result.get(["meeting", "portableIdentity"]))
      .toEqual(PORTABLE);
    expect((await piece.result.getCell(["meeting"])).resolveAsCell().getRaw())
      .toEqual(enriched);

    const updated = {
      ...program,
      files: program.files.map((file) => ({
        ...file,
        contents: file.name === "/loom/schemas.tsx"
          ? file.contents.replace(
            'Default<"Shared Loom">',
            'Default<"Updated Loom">',
          )
          : file.contents,
      })),
    };
    expect(
      updated.files.some((file) =>
        file.contents.includes('Default<"Updated Loom">')
      ),
    )
      .toBe(true);
    const before = await piece.getPatternRef();
    await piece.setPattern(updated);
    await runtime.idle();
    await pieces.synced();
    expect(await piece.getPatternRef()).not.toEqual(before);
    expect(await piece.result.get(["title"])).toBe("Established meeting Loom");
    expect(await piece.result.get(["panels", 0, "url"]))
      .toBe("https://example.test/meeting");
    expect(valueEqual(
      (await piece.result.getCell(["panels"]))
        .resolveAsCell().getRawUntyped({ lastNode: "value" }),
      panelsBefore,
    )).toBe(true);
    expect(await piece.result.get(["meeting", "portableIdentity"]))
      .toEqual(PORTABLE);
    expect((await piece.result.getCell(["meeting"])).resolveAsCell().getRaw())
      .toEqual(enriched);
  });
});
