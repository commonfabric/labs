/**
 * Who may remove a panel another principal added. Alice is the Loom's OWNER,
 * Bob holds WRITE, and Carol is on no access list, as a participant who has
 * left. Bob is refused Alice's panel. Alice is refused Bob's, since he is
 * still a member, and removes Carol's, since Carol has left.
 */
import {
  action,
  assert,
  handler,
  multiUserTest,
  pattern,
  type RepresentsCurrentUser,
  TESTS,
  type TrustedActionWrite,
  Writable,
} from "commonfabric";
import Loom from "./main.tsx";
import type { LoomOutput, Panel } from "./schemas.tsx";

/** The reviewed surface and action a person writes their own profile from. */
const PROFILE_SURFACE = "LoomRemovalProfileSurface";
const PROFILE_ACTION = "LoomRemovalWriteProfile";

/** The gesture writing a profile takes. */
const profileGesture = { surface: PROFILE_SURFACE, action: PROFILE_ACTION };

/**
 * A person's own profile, labeled with the principal who wrote it, which only
 * `writeOwnProfile` writes, from its reviewed surface. A panel added under it
 * records that principal as its adder.
 */
type OwnProfile = RepresentsCurrentUser<
  TrustedActionWrite<
    { name?: string },
    typeof writeOwnProfile,
    typeof PROFILE_ACTION,
    typeof PROFILE_SURFACE
  >
>;

/** What `writeOwnProfile` is bound to. */
interface ProfileWriteState {
  profile: Writable<OwnProfile>;
  name: string;
}

/** Writes the acting person's own profile, under `name`. */
const writeOwnProfile = handler<unknown, ProfileWriteState>((
  _event,
  { profile, name },
) => {
  profile.set({ name });
});

interface Setup {
  loom: LoomOutput;
}

export const setup = pattern(() => ({ loom: Loom({}) }));

/**
 * The URL of `panel`, or `""` for a panel that is not a URL panel or has not
 * arrived yet.
 */
const urlOf = (panel: Writable<Panel> | undefined): string => {
  const value = panel?.get();
  return value?.kind === "url" ? value.url : "";
};

const ALICE_URL = "https://example.com/alice";
const BOB_URL = "https://example.com/bob";
const CAROL_URL = "https://example.com/carol";

export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const loom = setup.loom;
  const profile = Writable.of<OwnProfile>();
  const writeProfile = writeOwnProfile({ profile, name: "Alice" });
  const panel = new Writable<Panel>({ kind: "url", url: ALICE_URL });
  const add = action(() => loom.addPanel.send({ panel, as: profile }));
  const removeBobs = action(() =>
    loom.removePanel.send({
      panel: loom.panels.find((entry) => urlOf(entry) === BOB_URL)!,
    })
  );
  const removeCarols = action(() =>
    loom.removePanel.send({
      panel: loom.panels.find((entry) => urlOf(entry) === CAROL_URL)!,
    })
  );
  return {
    // Removing Bob's panel is refused, and reported as a runtime error.
    allowRuntimeErrors: true,
    expectRuntimeErrors: 1,
    [TESTS]: [
      { action: writeProfile, event: {}, trustedUi: profileGesture },
      { action: add },
      { label: "alice-added" },
      { await: "carol-added" },
      { assertion: assert(() => loom.panels.length === 3) },
      { action: removeBobs },
      { assertion: assert(() => loom.panels.length === 3) },
      { action: removeCarols },
      {
        assertion: assert(() =>
          loom.panels.length === 2 &&
          urlOf(loom.panels[0]) === ALICE_URL &&
          urlOf(loom.panels[1]) === BOB_URL
        ),
      },
    ],
  };
});

export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const loom = setup.loom;
  const profile = Writable.of<OwnProfile>();
  const writeProfile = writeOwnProfile({ profile, name: "Bob" });
  const panel = new Writable<Panel>({ kind: "url", url: BOB_URL });
  const add = action(() => loom.addPanel.send({ panel, as: profile }));
  const removeAlices = action(() =>
    loom.removePanel.send({ panel: loom.panels[0] })
  );
  return {
    // Removing Alice's panel is refused, and reported as a runtime error.
    allowRuntimeErrors: true,
    expectRuntimeErrors: 1,
    [TESTS]: [
      { action: writeProfile, event: {}, trustedUi: profileGesture },
      { await: "alice-added" },
      { assertion: assert(() => urlOf(loom.panels[0]) === ALICE_URL) },
      { action: removeAlices },
      { assertion: assert(() => urlOf(loom.panels[0]) === ALICE_URL) },
      { action: add },
      { assertion: assert(() => loom.panels.length === 2) },
      { label: "bob-added" },
    ],
  };
});

export const carol = pattern<{ setup: Setup }>(({ setup }) => {
  const loom = setup.loom;
  const profile = Writable.of<OwnProfile>();
  const writeProfile = writeOwnProfile({ profile, name: "Carol" });
  const panel = new Writable<Panel>({ kind: "url", url: CAROL_URL });
  const add = action(() => loom.addPanel.send({ panel, as: profile }));
  return {
    [TESTS]: [
      { action: writeProfile, event: {}, trustedUi: profileGesture },
      { await: "bob-added" },
      { action: add },
      { assertion: assert(() => loom.panels.length === 3) },
      { label: "carol-added" },
    ],
  };
});

export default multiUserTest({
  setup,
  participants: { alice, bob, carol: { pattern: carol, access: "none" } },
});
