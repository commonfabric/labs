/**
 * `profileFace()` over a profile created as the user creates one, in a space
 * of its own, whose picture the creation set as its owner: the picture is the
 * face.
 *
 * Run: deno task cf test patterns/system/profile-face/profile-face.test.tsx --verbose
 */
import {
  assert,
  type Cell,
  FabricBytes,
  pattern,
  TESTS,
  Writable,
} from "commonfabric";
import {
  seedProfileName,
  submitProfileCreation,
} from "../profile-create/profile-create.tsx";
import type { BackwardsCompatibleProfile } from "../profile-home/profile-home.tsx";
import { profileFace, type ProfileFaceFields } from "./profile-face.ts";

// A stand-in for a picture; nothing here decodes it.
const PICTURE = [0x89, 0x50, 0x4e, 0x47];

/** The bytes of the picture `profile`'s face shows, joined, or "". */
const facePicture = (profile: Cell<ProfileFaceFields> | undefined): string =>
  profileFace(profile).picture?.slice().join() ?? "";

export default pattern(() => {
  const profiles = new Writable<BackwardsCompatibleProfile[]>([]);
  const seed = seedProfileName({
    profileSuggestion: { picture: new FabricBytes(new Uint8Array(PICTURE)) },
  });
  const create = submitProfileCreation({ profiles, seedName: seed });
  const created: Cell<ProfileFaceFields> = profiles.key(0);

  return {
    [TESTS]: [
      { action: create, event: { name: "Ada" } },
      { assertion: assert(() => facePicture(created) === PICTURE.join()) },
    ],
  };
});
