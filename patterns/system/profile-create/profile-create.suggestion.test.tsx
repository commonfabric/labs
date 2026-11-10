/**
 * Test Pattern: Profile Create — a host's profile suggestion
 *
 * The surface starts its name field with the suggested name, shows the
 * suggested picture with a control that removes it, and adds no way to create
 * a profile but the trusted click. The user may remove the picture or choose
 * their own on the surface, which leaves the host's suggestion as it was. The
 * seed step that follows a create gives the new profile the picture the user
 * chose, or else the suggested one.
 *
 * The create itself is a cross-space `inSpace()` push; here the seed step is
 * sent the profile it would be sent, made in this space. That the `#profile`
 * wish hands the surface its user's suggestion is
 * `patterns/integration/profile-suggestion-multi-runtime.test.ts`'s to show.
 *
 * Run: deno task cf test patterns/system/profile-create/profile-create.suggestion.test.tsx --verbose
 */
import {
  action,
  assert,
  FabricBytes,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import ProfileCreate, {
  type PictureChoice,
  type ProfileSuggestion,
  seedProfileName,
  TRUSTED_PROFILE_CREATE_ACTION,
  TRUSTED_PROFILE_CREATE_PICTURE_ACTION,
  TRUSTED_PROFILE_CREATE_SURFACE,
} from "./profile-create.tsx";
import ProfileHome, {
  type ProfileHomeOutput,
} from "../profile-home/profile-home.tsx";

interface TestVNode {
  type: "vnode";
  name: string;
  // deno-lint-ignore no-explicit-any
  props: Record<string, any>;
  children: unknown[];
}

const isVNode = (node: unknown): node is TestVNode =>
  typeof node === "object" && node !== null &&
  (node as { type?: unknown }).type === "vnode";

// The first descendant (or self) VNode for which `match` holds.
function find(
  node: unknown,
  match: (node: TestVNode) => boolean,
): TestVNode | undefined {
  if (!isVNode(node)) return undefined;
  if (match(node)) return node;
  for (const child of node.children ?? []) {
    const found = find(child, match);
    if (found) return found;
  }
  return undefined;
}

// A compiled JSX prop reads as a cell reference rather than its value.
// deno-lint-ignore no-explicit-any
function propValue(value: any): unknown {
  return value && typeof value.get === "function" ? value.get() : value;
}

const byTag = (tag: string) => (node: TestVNode) => node.name === tag;
const byId = (id: string) => (node: TestVNode) =>
  propValue(node.props.id) === id;

const byRegion = (region: string) => (node: TestVNode) =>
  propValue(node.props["data-ui-region"]) === region;

// A stand-in for a picture; nothing here decodes it.
const PICTURE = [0x89, 0x50, 0x4e, 0x47];

// The picture controls' gesture: only one on the trusted create surface may
// choose or remove the picture, so the steps send it as the renderer would.
const pictureGesture = {
  surface: TRUSTED_PROFILE_CREATE_SURFACE,
  action: TRUSTED_PROFILE_CREATE_PICTURE_ACTION,
};

const bytesAre = (actual: FabricBytes | undefined, expected: number[]) =>
  actual?.slice().join() === expected.join();

export default pattern(() => {
  const profiles = new Writable<ProfileHomeOutput[]>([]);
  const suggestion = new Writable<ProfileSuggestion | undefined>({
    name: "Sam Lee",
    picture: new FabricBytes(new Uint8Array(PICTURE)),
  });
  const surface = ProfileCreate({
    profiles,
    defaultName: "Ada",
    profileSuggestion: suggestion,
  });

  const assert_suggested_name_starts_the_field = assert(() =>
    propValue(
      find(surface[UI], byTag("cf-submit-input"))?.props.initialValue,
    ) === "Sam Lee"
  );
  const assert_suggested_picture_is_shown = assert(() =>
    find(surface[UI], byRegion("profile-create-suggested-picture")) !==
      undefined
  );
  const assert_create_stays_the_trusted_click = assert(() => {
    const input = find(surface[UI], byTag("cf-submit-input"));
    return propValue(input?.props["data-ui-action"]) ===
        TRUSTED_PROFILE_CREATE_ACTION &&
      input?.props.onClick !== undefined &&
      (profiles.get()?.length ?? 0) === 0;
  });

  // Choosing and removing the picture are the surface's own trusted
  // gestures, like the create.
  const assert_picture_controls_are_trusted_actions = assert(() =>
    propValue(
        find(surface[UI], byTag("cf-avatar-input"))?.props["data-ui-action"],
      ) === TRUSTED_PROFILE_CREATE_PICTURE_ACTION &&
    propValue(
        find(surface[UI], byId("profile-create-remove-picture"))?.props[
          "data-ui-action"
        ],
      ) === TRUSTED_PROFILE_CREATE_PICTURE_ACTION
  );

  const assert_removed_picture_is_not_shown = assert(() =>
    find(surface[UI], byRegion("profile-create-suggested-picture")) ===
      undefined
  );
  // The host's suggestion is the host's: removing the picture leaves it.
  const assert_removal_leaves_the_suggestion = assert(() =>
    suggestion.get()?.name === "Sam Lee" &&
    bytesAre(suggestion.get()?.picture, PICTURE)
  );

  // A picture the user chooses shows in place of the suggested one. It is
  // chosen on a surface of its own: the harness reaches a sub-pattern's
  // streams in an `action` step only when the test holds none of its inputs.
  const OWN = [0x47, 0x49, 0x46];
  const chooser = ProfileCreate({
    profiles: new Writable<ProfileHomeOutput[]>([]),
    profileSuggestion: new Writable<ProfileSuggestion | undefined>({
      name: "Sam Lee",
      picture: new FabricBytes(new Uint8Array(PICTURE)),
    }),
  });
  const chosenPicture = {
    detail: { bytes: new FabricBytes(new Uint8Array(OWN)) },
  };
  const assert_chosen_picture_is_shown = assert(() => {
    const shown = find(
      chooser[UI],
      byRegion("profile-create-suggested-picture"),
    );
    return bytesAre(propValue(shown?.props.bytes) as FabricBytes, OWN);
  });
  // A change without bytes decides nothing.

  // A surface handed no suggestion (the picker's) offers the choice too.
  const bare = ProfileCreate({
    profiles: new Writable<ProfileHomeOutput[]>([]),
  });
  const assert_bare_surface_shows_no_picture = assert(() =>
    find(bare[UI], byTag("cf-avatar-input")) !== undefined &&
    find(bare[UI], byRegion("profile-create-suggested-picture")) === undefined
  );
  const barePicture = { picture: new FabricBytes(new Uint8Array(OWN)) };
  const assert_bare_surface_shows_chosen_picture = assert(() =>
    find(bare[UI], byRegion("profile-create-suggested-picture")) !== undefined
  );

  // An empty picture is no picture: nothing would apply it, so none shows.
  const emptyPicture = ProfileCreate({
    profiles: new Writable<ProfileHomeOutput[]>([]),
    profileSuggestion: new Writable<ProfileSuggestion | undefined>({
      name: "Sam Lee",
      picture: new FabricBytes(new Uint8Array()),
    }),
  });
  const assert_empty_picture_is_not_shown = assert(() =>
    propValue(
        find(emptyPicture[UI], byTag("cf-submit-input"))?.props.initialValue,
      ) === "Sam Lee" &&
    find(emptyPicture[UI], byRegion("profile-create-suggested-picture")) ===
      undefined
  );

  // The seed step, sent the profile a create would send it.
  const withPicture = new Writable<ProfileSuggestion | undefined>({
    name: "Sam Lee",
    picture: new FabricBytes(new Uint8Array(PICTURE)),
  });
  const created = ProfileHome({});
  const seed = seedProfileName({ profileSuggestion: withPicture });
  const action_seed_created_profile = action(() => {
    // deno-lint-ignore no-explicit-any
    seed.send({ name: "Sam", profile: created as any });
  });
  const assert_seed_names_the_profile = assert(() => created.name === "Sam");
  const assert_seed_gives_the_suggested_picture = assert(() =>
    bytesAre(created.picture, PICTURE)
  );

  // A choice the user made wins over the suggestion: their own picture, or
  // none at all once they removed it.
  const chose = ProfileHome({});
  const choseSeed = seedProfileName({
    profileSuggestion: withPicture,
    pictureChoice: new Writable<PictureChoice | undefined>({
      picture: new FabricBytes(new Uint8Array(OWN)),
    }),
  });
  const action_seed_with_choice = action(() => {
    // deno-lint-ignore no-explicit-any
    choseSeed.send({ name: "Sam", profile: chose as any });
  });
  const assert_seed_gives_the_chosen_picture = assert(() =>
    bytesAre(chose.picture, OWN)
  );
  const removed = ProfileHome({});
  const removedSeed = seedProfileName({
    profileSuggestion: withPicture,
    pictureChoice: new Writable<PictureChoice | undefined>({}),
  });
  const action_seed_after_removal = action(() => {
    // deno-lint-ignore no-explicit-any
    removedSeed.send({ name: "Sam", profile: removed as any });
  });
  const assert_seed_after_removal_sets_no_picture = assert(() =>
    removed.name === "Sam" && removed.picture === undefined
  );

  // Without a suggestion, the seed step names the profile and sets no
  // picture.
  const plain = ProfileHome({});
  const plainSeed = seedProfileName({});
  const action_seed_without_suggestion = action(() => {
    // deno-lint-ignore no-explicit-any
    plainSeed.send({ name: "Ada", profile: plain as any });
  });
  const assert_plain_seed_sets_no_picture = assert(() =>
    plain.name === "Ada" && plain.picture === undefined
  );

  return {
    [TESTS]: [
      { assertion: assert_suggested_name_starts_the_field },
      { assertion: assert_suggested_picture_is_shown },
      { assertion: assert_create_stays_the_trusted_click },
      { assertion: assert_empty_picture_is_not_shown },
      { assertion: assert_picture_controls_are_trusted_actions },
      // A click on the rendered control, which carries the surface's markers.
      { press: surface[UI], control: "Remove picture" },
      { assertion: assert_removed_picture_is_not_shown },
      { assertion: assert_removal_leaves_the_suggestion },
      {
        action: chooser.choosePicture,
        event: chosenPicture,
        trustedUi: pictureGesture,
      },
      { assertion: assert_chosen_picture_is_shown },
      {
        action: chooser.choosePicture,
        event: { detail: {} },
        trustedUi: pictureGesture,
      },
      { assertion: assert_chosen_picture_is_shown },
      { assertion: assert_bare_surface_shows_no_picture },
      {
        action: bare.choosePicture,
        event: barePicture,
        trustedUi: pictureGesture,
      },
      { assertion: assert_bare_surface_shows_chosen_picture },
      { action: action_seed_created_profile },
      { assertion: assert_seed_names_the_profile },
      { assertion: assert_seed_gives_the_suggested_picture },
      { action: action_seed_with_choice },
      { assertion: assert_seed_gives_the_chosen_picture },
      { action: action_seed_after_removal },
      { assertion: assert_seed_after_removal_sets_no_picture },
      { action: action_seed_without_suggestion },
      { assertion: assert_plain_seed_sets_no_picture },
    ],
  };
});
