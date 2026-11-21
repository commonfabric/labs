/**
 * Test Pattern: profile-create's handlers, bound outside the surfaces that
 * bind them.
 *
 * - `setMruProfile` puts the profile it is bound to first in the
 *   most-recently-used list, once.
 * - `setDefaultProfile` bound to a home with no default slot refuses.
 * - `seedProfileName` refuses an event whose profile resolves to nothing, and
 *   one whose name is blank, rather than leave the name unstored.
 * - `submitProfileCreation` refuses a name holding a control character, and
 *   creates nothing.
 *
 * Run: deno task cf test patterns/system/profile-create/profile-create.handlers.test.tsx --verbose
 */
import { action, assert, pattern, TESTS, Writable } from "commonfabric";
import ProfileHome, {
  type BackwardsCompatibleProfile,
} from "../profile-home/profile-home.tsx";
import {
  type ProfileLink,
  seedProfileName,
  type SeedProfileTarget,
  setDefaultProfile,
  setMruProfile,
  submitProfileCreation,
} from "./profile-create.tsx";

/** The names of the profiles `list` holds, in order. */
const namesOf = (list: Writable<BackwardsCompatibleProfile[]>): string =>
  list.get().map((profile) => profile.initialNameApplied).join(", ");

export default pattern(() => {
  const ada = ProfileHome({ initialName: "Ada Lovelace" });
  const alan = ProfileHome({ initialName: "Alan Turing" });
  const profiles = new Writable<BackwardsCompatibleProfile[]>([]);
  // A list holds a profile as a link, which only an action can write.
  const action_list_profiles = action(() => profiles.set([ada, alan]));
  const adaLink: ProfileLink = profiles.key(0);
  const alanLink: ProfileLink = profiles.key(1);
  const mru = new Writable<BackwardsCompatibleProfile[]>([]);
  const stampAda = setMruProfile({ mru, profile: adaLink });
  const stampAlan = setMruProfile({ mru, profile: alanLink });

  const noSlot = setDefaultProfile({ profile: adaLink });

  // A profile link that names a document nobody wrote.
  const nowhere = new Writable<SeedProfileTarget>().for("nowhere");
  const seed = seedProfileName({});
  const action_seed_nowhere = action(() => {
    seed.send({ name: "Ada", profile: nowhere });
  });
  const action_seed_blank_name = action(() => {
    seed.send({ name: "   ", profile: ada });
  });
  const action_seed_name = action(() => {
    seed.send({ name: " Ada ", profile: ada });
  });

  const created = new Writable<BackwardsCompatibleProfile[]>([]);
  const create = submitProfileCreation({ profiles: created, seedName: seed });
  const action_create_control_character = action(() => {
    create.send({ name: "Ada\u0007" });
  });

  return {
    [TESTS]: [
      { action: action_list_profiles },
      { action: stampAda },
      { assertion: assert(() => namesOf(mru) === "Ada Lovelace") },
      { action: stampAlan },
      {
        assertion: assert(() => namesOf(mru) === "Alan Turing, Ada Lovelace"),
      },
      // Stamping a profile already in the list moves it to the front.
      { action: stampAda },
      {
        assertion: assert(() => namesOf(mru) === "Ada Lovelace, Alan Turing"),
      },
      // Refused with nothing to change: the home has no slot to write.
      { action: noSlot },
      // Refused, writing nothing where the profile link points.
      { action: action_seed_nowhere },
      { assertion: assert(() => nowhere.get() === undefined) },
      // Refused, leaving the name unseeded, which a name that is not blank
      // then seeds.
      { action: action_seed_blank_name },
      { assertion: assert(() => ada.name === "") },
      { action: action_seed_name },
      { assertion: assert(() => ada.name === "Ada") },
      // Refused, creating no profile.
      { action: action_create_control_character },
      { assertion: assert(() => created.get().length === 0) },
    ],
    // Each refusal's error, by what it says, so that one refusal going
    // silent is not hidden by another error.
    expectRuntimeErrors: [
      "this home has no default slot",
      "its profile does not resolve",
      "with an empty name",
      "cannot contain control characters",
    ],
  };
});
