import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";

import type { RuntimeProgram } from "../src/harness/types.ts";
import { markRendererTrustedEvent } from "../src/cfc/ui-contract.ts";
import { Runtime } from "../src/runtime.ts";
import { StorageManager } from "../src/storage/cache.deno.ts";

// The profile-create surface's picture becomes the new profile's face, set by
// its owner, so only a gesture on that trusted surface may choose or remove
// it. A pattern that holds the surface, as a loom showing a guest's `#profile`
// create surface does, reaches the same streams; its send carries no
// renderer mark and must change nothing. The REAL shipped pattern is run, as
// in profile-create-real-card-add.test.ts.

const signer = await Identity.fromPassphrase("profile-create-picture-choice");
const space = signer.did();

const sysDir = fromFileUrl(
  new URL("../../../patterns/system/", import.meta.url),
);
const read = (name: string) => Deno.readTextFileSync(sysDir + name);

const WRAPPER_SRC = [
  "import ProfileCreate from './profile-create/profile-create.tsx';",
  "import { pattern, Writable } from 'commonfabric';",
  "import type { ProfileHomeOutput } from './profile-home/profile-home.tsx';",
  "",
  "export default pattern(() => {",
  "  const profiles = new Writable<ProfileHomeOutput[]>([]).for('profiles');",
  "  const surface = ProfileCreate({ profiles });",
  "  return {",
  "    picture: surface.picture,",
  "    choosePicture: surface.choosePicture,",
  "    removePicture: surface.removePicture,",
  "  };",
  "});",
].join("\n");

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    { name: "/main.tsx", contents: WRAPPER_SRC },
    {
      name: "/profile-create/profile-create.tsx",
      contents: read("profile-create/profile-create.tsx"),
    },
    {
      name: "/profile-home/profile-home.tsx",
      contents: read("profile-home/profile-home.tsx"),
    },
  ],
};

const PICTURE = [0x89, 0x50, 0x4e, 0x47];

// The event the surface's controls carry, as the renderer builds it; the
// renderer marks it trusted, which `marked` does here.
const gesture = (detail: unknown, marked: boolean) => {
  const event = {
    type: "cf-change",
    detail,
    provenance: {
      origin: "dom",
      trusted: true,
      ui: {
        pattern: "ProfileCreateSurface",
        eventIntegrity: ["ProfileCreateSurface"],
        uiContractDataset: { uiAction: "ChooseProfilePicture" },
      },
    },
  };
  if (marked) markRendererTrustedEvent(event);
  return event;
};

const bytesOf = (value: unknown) =>
  value instanceof FabricBytes ? [...value.slice()] : value;

describe("profile-create picture choice", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({ apiUrl: new URL(import.meta.url), storageManager });
  });
  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  const startSurface = async () => {
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern(PROGRAM, {
      space,
      tx,
    });
    const cell = runtime.getCell<Record<string, unknown>>(
      space,
      "profile-create picture choice",
      undefined,
      tx,
    );
    const running = runtime.run(tx, pattern, {}, cell);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await running.pull();
    await runtime.idle();
    return running;
  };

  const send = async (
    cell: Awaited<ReturnType<typeof startSurface>>,
    stream: string,
    event: unknown,
  ) => {
    (cell.key(stream) as unknown as { send: (e: unknown) => void }).send(
      event,
    );
    await runtime.idle();
    await cell.pull();
    await runtime.idle();
  };

  it("refuses a picture sent without a gesture on the surface, and takes one with it", async () => {
    const cell = await startSurface();
    const picture = { bytes: new FabricBytes(new Uint8Array(PICTURE)) };

    await send(cell, "choosePicture", gesture(picture, false));
    expect(bytesOf(await cell.key("picture").pull())).toBeUndefined();

    await send(cell, "choosePicture", gesture(picture, true));
    expect(bytesOf(await cell.key("picture").pull())).toEqual(PICTURE);
  });

  it("refuses a removal sent without a gesture on the surface, and takes one with it", async () => {
    const cell = await startSurface();
    await send(
      cell,
      "choosePicture",
      gesture({ bytes: new FabricBytes(new Uint8Array(PICTURE)) }, true),
    );
    expect(bytesOf(await cell.key("picture").pull())).toEqual(PICTURE);

    await send(cell, "removePicture", gesture(undefined, false));
    expect(bytesOf(await cell.key("picture").pull())).toEqual(PICTURE);

    await send(cell, "removePicture", gesture(undefined, true));
    expect(bytesOf(await cell.key("picture").pull())).toBeUndefined();
  });
});
