/**
 * A panel is added under a profile only by the principal that profile
 * represents. Bob is refused Alice's profile on every stream that adds a
 * panel, and from the root's Duplicate button, and is admitted under his own.
 * He is refused, too, a profile of his whose `name` links to the name of
 * another profile of his, as `#profile` refuses one: its label names him, but
 * its name is borrowed from outside its own documents, so it is no one's own
 * profile (`profileOwnerOf()`).
 */
import {
  action,
  assert,
  currentPrincipal,
  handler,
  multiUserTest,
  pattern,
  principalOf,
  profileOwnerOf,
  type RepresentsCurrentUser,
  TESTS,
  type TrustedActionWrite,
  UI,
  Writable,
} from "commonfabric";
import {
  clickButton,
  findElement,
} from "../../tools/test-support/vnode-helpers.ts";
import Loom from "./main.tsx";
import type { LoomOutput, Panel, ParticipantProfile } from "./schemas.tsx";

/** The reviewed surface and action a person writes their own profile from. */
const PROFILE_SURFACE = "LoomTestProfileSurface";
const PROFILE_ACTION = "LoomTestWriteProfile";

/** The gesture writing a profile takes. */
const profileGesture = { surface: PROFILE_SURFACE, action: PROFILE_ACTION };

/**
 * A person's own profile, labeled with the principal who wrote it, which only
 * `writeOwnProfile` writes, from its reviewed surface.
 */
type OwnProfile = RepresentsCurrentUser<
  TrustedActionWrite<
    { name?: string; avatar?: string },
    typeof writeOwnProfile,
    typeof PROFILE_ACTION,
    typeof PROFILE_SURFACE
  >
>;

/** What `writeOwnProfile` is bound to. */
interface ProfileWriteState {
  /** The profile to write. */
  profile: Writable<OwnProfile>;

  /** The name to write into it. */
  name: string;
}

/**
 * A person's own profile, as `OwnProfile` is, whose `name` is always set,
 * which only `writeNamedProfile` writes, from the same reviewed surface.
 */
type NamedProfile = RepresentsCurrentUser<
  TrustedActionWrite<
    { name: string },
    typeof writeNamedProfile,
    typeof PROFILE_ACTION,
    typeof PROFILE_SURFACE
  >
>;

/** What `writeNamedProfile` is bound to. */
interface NamedProfileWriteState {
  /** The profile to write. */
  profile: Writable<NamedProfile>;

  /** The name to write into it. */
  name: string;
}

/** Writes the acting person's `NamedProfile`, under `name`. */
const writeNamedProfile = handler<unknown, NamedProfileWriteState>((
  _event,
  { profile, name },
) => {
  profile.set({ name });
});

/**
 * A person's own profile, as `OwnProfile` is, whose `name` holds a link, which
 * only `writeBorrowingProfile` writes, from the same reviewed surface.
 */
type BorrowingProfile = RepresentsCurrentUser<
  TrustedActionWrite<
    { name?: Writable<string> },
    typeof writeBorrowingProfile,
    typeof PROFILE_ACTION,
    typeof PROFILE_SURFACE
  >
>;

/** What `writeBorrowingProfile` is bound to. */
interface BorrowingProfileWriteState {
  /** The profile to write. */
  profile: Writable<BorrowingProfile>;

  /** The name, in another document, that its `name` is to link. */
  name: Writable<string>;
}

/** Writes the acting person's `BorrowingProfile`, its `name` linking `name`. */
const writeBorrowingProfile = handler<unknown, BorrowingProfileWriteState>((
  _event,
  { profile, name },
) => {
  profile.set({ name });
});

/** Writes the acting person's own profile, under `name`. */
const writeOwnProfile = handler<unknown, ProfileWriteState>((
  _event,
  { profile, name },
) => {
  profile.set({ name });
});

/** Where Alice puts her profile and her principal for Bob to read. */
interface Handoff {
  profile?: ParticipantProfile;
  principal?: string;
}

interface Setup {
  loom: LoomOutput;
  handoff: Writable<Handoff>;
}

export const setup = pattern(() => ({
  loom: Loom({}),
  handoff: Writable.of<Handoff>({}),
}));

// Adds a piece under her own profile, and hands that profile to Bob.
export const alice = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<OwnProfile>();
  const writeProfile = writeOwnProfile({ profile, name: "Alice" });
  const piece = new Writable({ title: "Alice's target" });
  const add = action(() => setup.loom.addPiece.send({ piece, as: profile }));
  const handOff = action(() =>
    setup.handoff.set({ profile, principal: currentPrincipal() ?? "" })
  );
  return {
    [TESTS]: [
      { action: writeProfile, event: {}, trustedUi: profileGesture },
      { action: add },
      {
        assertion: assert(() =>
          setup.loom.panels.length === 1 &&
          setup.loom.panels[0].key("addedByProfile").equals(profile)
        ),
      },
      { action: handOff },
      { label: "alice-ready" },
    ],
  };
});

// Tries Alice's profile on each stream that adds a panel, then adds under his
// own.
export const bob = pattern<{ setup: Setup }>(({ setup }) => {
  const profile = Writable.of<OwnProfile>();
  const writeProfile = writeOwnProfile({ profile, name: "Bob" });
  const me = new Writable("");
  const recordMe = action(() => me.set(currentPrincipal() ?? ""));
  const piece = new Writable({ title: "Bob's target" });
  const url = new Writable<Panel>({
    kind: "url",
    url: "https://example.com/bob-under-alice",
  });
  const addPieceAsAlice = action(() =>
    setup.loom.addPiece.send({ piece, as: setup.handoff.get().profile })
  );
  const addUrlAsAlice = action(() =>
    setup.loom.addPanel.send({ panel: url, as: setup.handoff.get().profile })
  );
  const duplicateAsAlice = action(() =>
    setup.loom.duplicatePanel.send({
      panel: setup.loom.panels[0],
      as: setup.handoff.get().profile,
    })
  );
  const actAsAlice = action(() =>
    setup.loom.viewerState.key("actingProfile").set(setup.handoff.get().profile)
  );
  const duplicateFromUI = action(() =>
    clickButton(findElement(setup.loom[UI], "cf-card"), "Duplicate")
  );
  const addPieceAsSelf = action(() =>
    setup.loom.addPiece.send({ piece, as: profile })
  );
  const named = Writable.of<NamedProfile>();
  const writeNamed = writeNamedProfile({ profile: named, name: "Bob" });
  const borrowing = Writable.of<BorrowingProfile>();
  const writeBorrowing = writeBorrowingProfile({
    profile: borrowing,
    name: named.key("name"),
  });
  const addPieceAsBorrowing = action(() =>
    setup.loom.addPiece.send({ piece, as: borrowing })
  );
  return {
    // Each refused event is reported as a runtime error.
    allowRuntimeErrors: true,
    expectRuntimeErrors: 5,
    [TESTS]: [
      { action: writeProfile, event: {}, trustedUi: profileGesture },
      { action: recordMe },
      { await: "alice-ready" },
      // Bob reads Alice's profile as hers, so what refuses him is whose it
      // is.
      {
        assertion: assert(() => {
          const handoff = setup.handoff.get();
          return handoff.principal !== undefined && handoff.principal !== "" &&
            me.get() !== "" && handoff.principal !== me.get() &&
            principalOf(handoff.profile, "represents-principal") ===
              handoff.principal;
        }),
      },
      { action: addPieceAsAlice },
      { action: addUrlAsAlice },
      { action: duplicateAsAlice },
      { action: actAsAlice },
      { render: setup.loom[UI] },
      { action: duplicateFromUI },
      { assertion: assert(() => setup.loom.panels.length === 1) },
      { action: writeNamed, event: {}, trustedUi: profileGesture },
      { action: writeBorrowing, event: {}, trustedUi: profileGesture },
      // His label is on the borrowing profile, and the name it links is his
      // own profile's, so reading only whom it represents takes it for his.
      { assertion: assert(() => profileOwnerOf(named) === me.get()) },
      {
        assertion: assert(() =>
          principalOf(borrowing, "represents-principal") === me.get()
        ),
      },
      { assertion: assert(() => profileOwnerOf(borrowing) === undefined) },
      { action: addPieceAsBorrowing },
      { assertion: assert(() => setup.loom.panels.length === 1) },
      { action: addPieceAsSelf },
      {
        assertion: assert(() =>
          setup.loom.panels.length === 2 &&
          setup.loom.panels[1].key("addedByProfile").equals(profile)
        ),
      },
    ],
  };
});

export default multiUserTest({ setup, participants: { alice, bob } });
