/**
 * `profileFace()` over profiles created as the user creates one, each in a
 * space of its own, whose picture the creation set as its owner: the picture
 * is the face, held inline as bytes for one created with a host's suggested
 * bytes, and as a blob for one created with a picture the user chose, which
 * `<cf-avatar-input>` stored as a blob.
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
  type PictureChoice,
  seedProfileName,
  submitProfileCreation,
} from "../profile-create/profile-create.tsx";
import type { BackwardsCompatibleProfile } from "../profile-home/profile-home.tsx";
import { profileFace, type ProfileFaceFields } from "./profile-face.ts";

// A stand-in for a picture; nothing here decodes it.
const PICTURE = [0x89, 0x50, 0x4e, 0x47];

// The blob a picture the user chose was stored in.
const CHOSEN = { space: "did:key:z6MkChosenPicture", id: "fid1:chosen" };

/** The bytes of the picture `profile`'s face shows, joined, or "". */
const facePicture = (profile: Cell<ProfileFaceFields> | undefined): string =>
  profileFace(profile).picture?.slice().join() ?? "";

/** The blob holding the picture `profile`'s face shows, or "". */
const faceBlob = (profile: Cell<ProfileFaceFields> | undefined): string => {
  const blob = profileFace(profile).pictureBlob;
  return blob === undefined ? "" : `${blob.space} ${blob.id}`;
};

export default pattern(() => {
  const profiles = new Writable<BackwardsCompatibleProfile[]>([]);
  const seed = seedProfileName({
    profileSuggestion: { picture: new FabricBytes(new Uint8Array(PICTURE)) },
  });
  const create = submitProfileCreation({ profiles, seedName: seed });
  const created: Cell<ProfileFaceFields> = profiles.key(0);

  const chosenProfiles = new Writable<BackwardsCompatibleProfile[]>([]);
  const chosenSeed = seedProfileName({
    pictureChoice: new Writable<PictureChoice | undefined>({
      picture: new FabricBytes(new Uint8Array(PICTURE)),
      pictureBlob: CHOSEN,
    }),
  });
  const createChosen = submitProfileCreation({
    profiles: chosenProfiles,
    seedName: chosenSeed,
  });
  const chosen: Cell<ProfileFaceFields> = chosenProfiles.key(0);

  return {
    [TESTS]: [
      { action: create, event: { name: "Ada" } },
      {
        assertion: assert(() =>
          facePicture(created) === PICTURE.join() && faceBlob(created) === ""
        ),
      },
      { action: createChosen, event: { name: "Grace" } },
      {
        assertion: assert(() =>
          faceBlob(chosen) === `${CHOSEN.space} ${CHOSEN.id}` &&
          facePicture(chosen) === ""
        ),
      },
    ],
  };
});
