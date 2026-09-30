import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";

import { Identity } from "@commonfabric/identity";

import type { RuntimeProgram } from "../src/harness/types.ts";
import { Runtime } from "../src/runtime.ts";
import { EmulatedStorageManager } from "../src/storage/v2-emulate.ts";

// CT-1650: two DIFFERENT users who create a profile with the SAME display name
// must end up in DISTINCT profile spaces. Before the fix, profile-create seeded
// via `ProfileHome.inSpace(name)`, and `createSession({ spaceName })` derived the
// space DID from `fromPassphrase("common user").derive(name)` — the display name
// ALONE, ignoring the authenticated user — so equal names collided into one
// space. The fix routes profile creation through an anonymous `inSpace()` whose
// DID derives from the creating handler's cause (which carries the per-user home
// space links + the per-event id), making it per-user AND per-profile unique
// while the display name flows only to `initialName`. The named path supports
// the legacy space names used during development and nothing else, and is
// removed once those development-only spaces have been migrated
// (docs/plans/random-space-identities.md).

export const userA = await Identity.fromPassphrase("ct1650-user-a");
export const userB = await Identity.fromPassphrase("ct1650-user-b");

const sysDir = fromFileUrl(new URL("../../patterns/system/", import.meta.url));
const read = (n: string) => Deno.readTextFileSync(sysDir + n);

// A tiny host that owns the home `profiles` list and embeds the REAL
// profile-create pattern (mirrors profile-create-real-card-add.test.ts).
const WRAPPER_SRC = [
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

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    { name: "/main.tsx", contents: WRAPPER_SRC },
    { name: "/profile-create.tsx", contents: read("profile-create.tsx") },
    { name: "/profile-home.tsx", contents: read("profile-home.tsx") },
  ],
};

const RESULT_CAUSE = "ct1650 profile space identity";
export const PROFILE_NAME = "Ada Lovelace";

const profileLinkListSchema = {
  type: "array",
  items: { type: "unknown", asCell: ["cell"] },
  // deno-lint-ignore no-explicit-any
} as any;

// Run profile-create as `signer`, fire createProfile with `name`, return the
// space DID of the freshly-created profile (its own inSpace space).
export async function createProfileSpace(
  signer: Identity,
  name: string,
): Promise<string> {
  const space = signer.did();
  const manager = EmulatedStorageManager.emulate({ as: signer });
  const rt = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: manager,
  });
  try {
    const tx1 = rt.edit();
    const parent = await rt.patternManager.compilePattern(PROGRAM, {
      space,
      tx: tx1,
    });
    const resultCell = rt.getCell<Record<string, unknown>>(
      space,
      RESULT_CAUSE,
      undefined,
      tx1,
    );
    // deno-lint-ignore no-explicit-any
    const r = rt.run(tx1, parent as any, {}, resultCell);
    rt.prepareTxForCommit(tx1);
    const commit1 = await tx1.commit();
    expect(commit1.error).toBeUndefined();
    await r.pull();

    const tx2 = rt.edit();
    r.withTx(tx2).key("createProfile").send({ name });
    const commit2 = await tx2.commit();
    expect(commit2.error).toBeUndefined();
    await r.pull();
    await rt.idle();
    await r.pull();

    const profiles = r.key("profiles").asSchema(profileLinkListSchema)
      // deno-lint-ignore no-explicit-any
      .get() as any[];
    expect(profiles.length).toBe(1);
    const link = profiles[0].getAsNormalizedFullLink();
    // Sanity: the profile lives in its OWN space, not the home space.
    expect(link.space).not.toBe(space);
    return link.space as string;
  } finally {
    await rt.dispose();
    await manager.close();
  }
}
