/**
 * Creates profiles the way Home does, through the real `profile-create.tsx`,
 * for tests that need a profile in a space of its own, on a memory server that
 * enforces access-control lists. A test can also create a profile the way
 * one was made before profiles were their space's root, in a space whose
 * genesis reserved no root, without depending on how `profile-create.tsx`
 * makes a root.
 */

import { fromFileUrl } from "@std/path";
import type { Signer } from "@commonfabric/memory/interface";
import * as MemoryV2Client from "@commonfabric/memory/v2/client";
import type * as MemoryV2Server from "@commonfabric/memory/v2/server";

import { markRendererTrustedEvent } from "../../src/cfc/ui-contract.ts";
import type { RuntimeProgram } from "../../src/harness/types.ts";
import type { NormalizedFullLink } from "../../src/link-types.ts";
import type { Runtime } from "../../src/runtime.ts";
import type { MemorySpace } from "../../src/storage/interface.ts";
import type { SessionFactory } from "../../src/storage/v2.ts";

/** Opens each session as the principal its signer is, over one server. */
export class PrincipalSessionFactory implements SessionFactory {
  /** Always `true`: the loopback server takes a genesis access list. */
  readonly supportsAclBootstrap = true;

  readonly #server: MemoryV2Server.Server;

  /** Constructs an instance which opens its sessions on `server`. */
  constructor(server: MemoryV2Server.Server) {
    this.#server = server;
  }

  /** @inheritDoc */
  async create(
    space: MemorySpace,
    signer?: Signer,
    requested: MemoryV2Client.MountOptions = {},
  ) {
    const client = await MemoryV2Client.connect({
      transport: MemoryV2Client.loopback(this.#server),
    });
    try {
      const session = await client.mount(
        space,
        requested,
        (_space, _session, context) => ({
          invocation: {
            aud: context.audience,
            challenge: context.challenge.value,
          },
          authorization: { principal: signer?.did() },
        }),
      );
      return { client, session };
    } catch (error) {
      await client.close();
      throw error;
    }
  }
}

const sysDir = fromFileUrl(
  new URL("../../../patterns/system/", import.meta.url),
);
const read = (name: string) => Deno.readTextFileSync(sysDir + name);

/**
 * A host that owns a Home-like `profiles` list and embeds the real create
 * pattern, which makes each profile its space's root.
 */
const CREATE_HOST = [
  "import ProfileCreate from './profile-create.tsx';",
  "import { pattern, Writable } from 'commonfabric';",
  "import type { ProfileHomeOutput } from './profile-home.tsx';",
  "",
  "export default pattern(() => {",
  "  const profiles = new Writable<ProfileHomeOutput[]>([]).for('profiles');",
  "  const created = ProfileCreate({ profiles });",
  "  return { profiles, createProfile: created.createProfile };",
  "});",
].join("\n");

/**
 * A host with the same list and stream that creates each profile the way
 * profiles were made before they were their space's root: an anonymous
 * `inSpace()` granting every principal `WRITE`, with no root.
 */
const EARLIER_SHAPE_HOST = [
  "import { handler, pattern, Writable } from 'commonfabric';",
  "import ProfileHome, { type ProfileHomeOutput } from './profile-home.tsx';",
  "",
  "const create = handler<",
  "  { name: string },",
  "  { profiles: Writable<ProfileHomeOutput[]> }",
  ">((event, { profiles }) => {",
  "  profiles.push(",
  "    ProfileHome.inSpace(undefined, { grants: { '*': 'WRITE' } })({",
  "      initialName: event.name,",
  "    }) as ProfileHomeOutput,",
  "  );",
  "});",
  "",
  "export default pattern(() => {",
  "  const profiles = new Writable<ProfileHomeOutput[]>([]).for('profiles');",
  "  return { profiles, createProfile: create({ profiles }) };",
  "});",
].join("\n");

/** The host program: the real create pattern, or with `root: false` the earlier shape. */
function hostProgram(root: boolean): RuntimeProgram {
  return {
    main: "/main.tsx",
    files: [
      { name: "/main.tsx", contents: root ? CREATE_HOST : EARLIER_SHAPE_HOST },
      { name: "/profile-create.tsx", contents: read("profile-create.tsx") },
      { name: "/profile-home.tsx", contents: read("profile-home.tsx") },
    ],
  };
}

const profileLinkListSchema = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
  // deno-lint-ignore no-explicit-any
} as any;

/** The create event as the create surface's submit click sends it. */
function createEvent(name: string): { name: string } {
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

/**
 * Creates a profile named `name` through the create pattern, run by `runtime`
 * in its user's home space, and returns the link the host's list holds, which
 * names the slot that links on to the profile. With `root: false` the profile
 * is created the way profiles were before they were their space's root, so
 * its space's genesis reserves no root.
 * The host's root lives at `hostCause` in the home space.
 *
 * @throws Error when a commit fails or the list does not end up holding
 *   exactly one profile in a space other than the home space.
 */
export async function createProfileThroughHome(
  runtime: Runtime,
  name: string,
  options: { root?: boolean; hostCause?: string } = {},
): Promise<NormalizedFullLink> {
  const space = runtime.userIdentityDID as MemorySpace;
  const setupTx = runtime.edit();
  const host = await runtime.patternManager.compilePattern(
    hostProgram(options.root ?? true),
    { space, tx: setupTx },
  );
  const result = runtime.run(
    setupTx,
    // deno-lint-ignore no-explicit-any
    host as any,
    {},
    runtime.getCell<Record<string, unknown>>(
      space,
      options.hostCause ?? "profile space access host",
      undefined,
      setupTx,
    ),
  );
  runtime.prepareTxForCommit(setupTx);
  const setup = await setupTx.commit().settled;
  if (setup.error) throw new Error(setup.error.message);
  await result.pull();

  const createTx = runtime.edit();
  result.withTx(createTx).key("createProfile").send(createEvent(name));
  runtime.prepareTxForCommit(createTx);
  const created = await createTx.commit().settled;
  if (created.error) throw new Error(created.error.message);
  await result.pull();
  await runtime.idle();
  await result.pull();

  const links = result.key("profiles").asSchema(profileLinkListSchema)
    // deno-lint-ignore no-explicit-any
    .get() as any[];
  if (links.length !== 1) {
    throw new Error(`The host lists ${links.length} profiles, not one`);
  }
  const profileLink = links[0].getAsNormalizedFullLink() as NormalizedFullLink;
  if (profileLink.space === space) {
    throw new Error("The profile was created in the home space");
  }

  await runtime.patternManager.flushCompileCacheWrites();
  await runtime.storageManager.synced();
  await runtime.idle();
  await runtime.storageManager.synced();
  return profileLink;
}
