/**
 * Runs the shipped profile-create pattern through a Mode A router, for the
 * router exercise, in a process of its own: the runtime locks its realm down
 * with SES, whose unhandled-rejection handler would let the exercise exit 0
 * on a failed gate, and a runtime's dispose resets the process-global
 * experimental flags the exercise's own clients advertise.
 *
 * A user's Home is born on its first open, by its own key, with the genesis
 * ACL the storage manager commits. The pattern creates a profile in a space of
 * its own, as the shell does for a user who adds one, and a second runtime
 * reads the profile's name back. Prints one JSON line with the spaces and the
 * name, and exits 1 on any failure.
 */
import { setModernCellRepConfig } from "@commonfabric/data-model/cell-rep";
import { Identity } from "@commonfabric/identity";
// @ts-types="@types/ws"
import WebSocket from "ws";
import { markRendererTrustedEvent } from "../../../runner/src/cfc/ui-contract.ts";
import type { RuntimeProgram } from "../../../runner/src/harness/types.ts";
import { Runtime } from "../../../runner/src/runtime.ts";
import { StorageManager } from "../../../runner/src/storage/v2.ts";
import {
  createStorageAddressResolver,
  RemoteSessionFactory,
} from "../../../runner/src/storage/v2-remote-session.ts";
import type { MemorySpace } from "../../interface.ts";

/** Tracked fixture inputs, written by the exercise. */
export interface RoutedProfileFixture {
  /** The router's public origin. */
  url: string;
  /** The CA certificate the router's public certificate chains to. */
  ca: string;
  origin: string;
  /** Source addresses for the writing and the reading runtime. */
  sources: [string, string];
  modernCellRep: boolean;
}

/** A storage manager whose sessions dial the router with the fixture's trust. */
class RoutedStorageManager extends StorageManager {
  static through(config: RoutedProfileFixture, as: Identity, source: string) {
    const memoryHost = new URL(config.url);
    return new this(
      { as, memoryHost },
      new RemoteSessionFactory(
        createStorageAddressResolver(memoryHost),
        as,
        (address) => {
          const socket = new WebSocket(address, {
            ca: Deno.readTextFileSync(config.ca),
            perMessageDeflate: false,
            family: 4,
            localAddress: source,
            headers: { Origin: config.origin },
          });
          socket.binaryType = "arraybuffer";
          return {
            socket,
            send: (frame: string | Uint8Array) => socket.send(frame),
          };
        },
      ),
    );
  }
}

const read = (name: string) =>
  Deno.readTextFileSync(
    new URL(`../../../patterns/system/${name}`, import.meta.url),
  );
const program: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import ProfileCreate from './profile-create.tsx';",
        "import { pattern, Writable } from 'commonfabric';",
        "import type { ProfileHomeOutput } from './profile-home.tsx';",
        "",
        "export default pattern(() => {",
        "  const profiles = new Writable<ProfileHomeOutput[]>([]).for('profiles');",
        "  const created = ProfileCreate({ profiles });",
        "  return { profiles, createProfile: created.createProfile };",
        "});",
      ].join("\n"),
    },
    { name: "/profile-create.tsx", contents: read("profile-create.tsx") },
    { name: "/profile-home.tsx", contents: read("profile-home.tsx") },
  ],
};

/** The create event as the create surface's submit click sends it. */
function createEvent(name: string) {
  const event = {
    name,
    provenance: {
      origin: "dom",
      trusted: true,
      ui: {
        pattern: "ProfileCreateSurface",
        eventIntegrity: ["ProfileCreateSurface"],
        uiContractDataset: { uiAction: "CreateProfile" },
      },
    },
  };
  markRendererTrustedEvent(event);
  return event;
}

async function createProfile(config: RoutedProfileFixture) {
  setModernCellRepConfig(config.modernCellRep);
  const user = await Identity.generate();
  const home = user.did() as MemorySpace;
  // The exercise serves no toolshed HTTP API, so the profile patterns' wished
  // UI surfaces log "Can't load profile-create.tsx"; only Memory is checked.
  const writer = new Runtime({
    apiUrl: new URL(config.url),
    storageManager: RoutedStorageManager.through(
      config,
      user,
      config.sources[0],
    ),
  });
  const reader = new Runtime({
    apiUrl: new URL(config.url),
    storageManager: RoutedStorageManager.through(
      config,
      user,
      config.sources[1],
    ),
  });
  try {
    const tx = writer.edit();
    const host = await writer.patternManager.compilePattern(program, {
      space: home,
      tx,
    });
    const result = writer.getCell<Record<string, unknown>>(
      home,
      "routed profile creation",
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    const run = writer.run(tx, host as any, {}, result);
    writer.prepareTxForCommit(tx);
    const opened = await tx.commit().settled;
    if (opened.error !== undefined) throw opened.error;
    await run.pull();
    const create = writer.edit();
    run.withTx(create).key("createProfile").send(createEvent("Ada"));
    writer.prepareTxForCommit(create);
    const created = await create.commit().settled;
    if (created.error !== undefined) throw created.error;
    await run.pull();
    await writer.idle();
    await run.pull();
    const profiles = run.key("profiles").asSchema({
      type: "array",
      items: { type: "unknown", asCell: ["cell"] },
      // deno-lint-ignore no-explicit-any
    } as any).get() as { getAsNormalizedFullLink(): { space: string } }[];
    if (profiles?.length !== 1) {
      throw new Error(`expected one profile, found ${profiles?.length}`);
    }
    const link = profiles[0].getAsNormalizedFullLink();
    await writer.patternManager.flushCompileCacheWrites();
    await writer.storageManager.synced();
    await writer.idle();
    await writer.storageManager.synced();
    // deno-lint-ignore no-explicit-any
    const profile = reader.getCellFromLink(link as any);
    await profile.sync();
    const name = profile.key("name").asSchema<string>({ type: "string" });
    await name.sync();
    await name.pull();
    return { home, profileSpace: link.space, name: name.get() };
  } finally {
    await reader.dispose();
    await writer.dispose();
  }
}

if (import.meta.main) {
  let result: Awaited<ReturnType<typeof createProfile>>;
  try {
    result = await createProfile(
      JSON.parse(Deno.readTextFileSync(Deno.args[0])),
    );
  } catch (error) {
    console.error(error);
    Deno.exit(1);
  }
  console.log(JSON.stringify(result));
  Deno.exit(0);
}
