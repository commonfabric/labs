/**
 * A visitor to Alice's profile cannot set its picture: `setPicture` refuses
 * everyone but the person whose own profile it is, and the picture Alice set
 * stays as it was.
 *
 * Run: deno task cf test patterns/system/profile-home/profile-home.visitor.test.tsx --verbose
 */
import {
  action,
  assert,
  FabricBytes,
  multiUserTest,
  pattern,
  TESTS,
} from "commonfabric";
import ProfileHome from "./profile-home.tsx";

/** A stand-in for Alice's picture, and one for the picture Bob sends. */
const ALICE_PICTURE = [0x89, 0x50, 0x4e, 0x47];
const BOB_PICTURE = [0xff, 0xd8, 0xff];

const picture = (bytes: number[]) => new FabricBytes(new Uint8Array(bytes));

/** Whether `actual` holds exactly `expected`. */
const bytesAre = (actual: FabricBytes | undefined, expected: number[]) =>
  actual?.slice().join() === expected.join();

// Alice, the first participant, sets the profile up, so it is hers.
export const setup = pattern(() => ({
  profile: ProfileHome({ initialName: "Alice" }),
}));

type Setup = ReturnType<typeof setup>;

export const alice = pattern<{ setup: Setup }>(({ setup }) => ({
  [TESTS]: [
    {
      action: action(() =>
        setup.profile.setPicture.send({ picture: picture(ALICE_PICTURE) })
      ),
    },
    {
      assertion: assert(() => bytesAre(setup.profile.picture, ALICE_PICTURE)),
    },
    { label: "alice-set-picture" },
    { await: "bob-tried" },
    {
      assertion: assert(() => bytesAre(setup.profile.picture, ALICE_PICTURE)),
    },
  ],
}));

export const bob = pattern<{ setup: Setup }>(({ setup }) => ({
  [TESTS]: [
    { await: "alice-set-picture" },
    {
      action: action(() =>
        setup.profile.setPicture.send({ picture: picture(BOB_PICTURE) })
      ),
    },
    {
      assertion: assert(() => bytesAre(setup.profile.picture, ALICE_PICTURE)),
    },
    { label: "bob-tried" },
  ],
  expectRuntimeErrors: ["Only the profile's owner can set its picture."],
}));

export default multiUserTest({ setup, participants: { alice, bob } });
