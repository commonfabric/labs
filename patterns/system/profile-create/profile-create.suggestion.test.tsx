/**
 * Test Pattern: Profile Create — a host's profile suggestion
 *
 * The surface starts its name field with the suggested name, shows the
 * suggested picture with a control that removes it, and adds no way to create
 * a profile but the trusted click. The user may choose a picture of their
 * own, which takes the suggested picture's place. The seed step that follows
 * a create gives the new profile the picture the suggestion still holds.
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
  chooseSuggestedPicture,
  type ProfileSuggestion,
  removeSuggestedPicture,
  seedProfileName,
  TRUSTED_PROFILE_CREATE_ACTION,
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
const byRegion = (region: string) => (node: TestVNode) =>
  propValue(node.props["data-ui-region"]) === region;

// A stand-in for a picture; nothing here decodes it.
const PICTURE = [0x89, 0x50, 0x4e, 0x47];

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

  const removePicture = removeSuggestedPicture({
    profileSuggestion: suggestion,
  });
  const assert_removal_keeps_the_name_and_drops_the_picture = assert(() =>
    suggestion.get()?.name === "Sam Lee" &&
    suggestion.get()?.picture === undefined
  );
  const assert_removed_picture_is_not_shown = assert(() =>
    find(surface[UI], byRegion("profile-create-suggested-picture")) ===
      undefined
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

  // A picture the user chooses takes the removed one's place, keeping the
  // suggested name, and shows.
  const OWN = [0x47, 0x49, 0x46];
  const choosePicture = chooseSuggestedPicture({
    profileSuggestion: suggestion,
  });
  const action_choose_picture = action(() => {
    choosePicture.send({
      detail: { bytes: new FabricBytes(new Uint8Array(OWN)) },
    });
  });
  const assert_chosen_picture_is_kept_with_the_name = assert(() =>
    suggestion.get()?.name === "Sam Lee" &&
    bytesAre(suggestion.get()?.picture, OWN)
  );
  const assert_chosen_picture_is_shown = assert(() =>
    find(surface[UI], byRegion("profile-create-suggested-picture")) !==
      undefined &&
    find(surface[UI], byRegion("profile-create-choose-picture")) !== undefined
  );
  // A pick without bytes changes nothing.
  const action_choose_nothing = action(() => {
    choosePicture.send({ detail: {} });
  });

  // A host that suggested nothing still leaves the user somewhere to keep a
  // picture they choose, stored with the empty name that suggests none.
  const nothingSuggested = new Writable<ProfileSuggestion | undefined>(
    undefined,
  );
  const chooseWithoutSuggestion = chooseSuggestedPicture({
    profileSuggestion: nothingSuggested,
  });
  const action_choose_without_suggestion = action(() => {
    chooseWithoutSuggestion.send({
      picture: new FabricBytes(new Uint8Array(OWN)),
    });
  });
  const pickedOnly = ProfileCreate({
    profiles: new Writable<ProfileHomeOutput[]>([]),
    defaultName: "Ada",
    profileSuggestion: nothingSuggested,
  });
  const assert_picked_only_keeps_the_default_name = assert(() =>
    propValue(
        find(pickedOnly[UI], byTag("cf-submit-input"))?.props.initialValue,
      ) === "Ada" &&
    find(pickedOnly[UI], byRegion("profile-create-suggested-picture")) !==
      undefined
  );
  const assert_chosen_without_suggestion_has_no_name = assert(() =>
    nothingSuggested.get()?.name === "" &&
    bytesAre(nothingSuggested.get()?.picture, OWN)
  );

  // A surface handed no suggestion (the picker's) keeps a chosen picture in
  // its own input, for the seed step to apply.
  const noSuggestion = ProfileCreate({
    profiles: new Writable<ProfileHomeOutput[]>([]),
  });
  const action_choose_on_bare_surface = action(() => {
    const control = find(noSuggestion[UI], byTag("cf-avatar-input"));
    // deno-lint-ignore no-explicit-any
    (control?.props["oncf-change"] as any).send({
      detail: { bytes: new FabricBytes(new Uint8Array(OWN)) },
    });
  });
  const assert_bare_surface_shows_chosen_picture = assert(() =>
    find(noSuggestion[UI], byRegion("profile-create-suggested-picture")) !==
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
      { action: removePicture },
      { assertion: assert_removal_keeps_the_name_and_drops_the_picture },
      { assertion: assert_removed_picture_is_not_shown },
      { action: action_choose_picture },
      { assertion: assert_chosen_picture_is_kept_with_the_name },
      { assertion: assert_chosen_picture_is_shown },
      { action: action_choose_nothing },
      { assertion: assert_chosen_picture_is_kept_with_the_name },
      { action: action_choose_without_suggestion },
      { assertion: assert_chosen_without_suggestion_has_no_name },
      { assertion: assert_picked_only_keeps_the_default_name },
      { action: action_choose_on_bare_surface },
      { assertion: assert_bare_surface_shows_chosen_picture },
      { action: action_seed_created_profile },
      { assertion: assert_seed_names_the_profile },
      { assertion: assert_seed_gives_the_suggested_picture },
      { action: action_seed_without_suggestion },
      { assertion: assert_plain_seed_sets_no_picture },
    ],
  };
});
