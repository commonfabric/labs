/**
 * Drives the `cf profile` subcommands through the parsed command with
 * `CF_IDENTITY` and `CF_API_URL` cleared, and the actions whose output these
 * cases read with `Deno.stdout.writeSync` replaced, and `Deno.exitCode` saved
 * and restored around each root-repair case.
 */

import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";

import {
  profile,
  type ProfileCommandDeps,
  profileListAction,
  profileRenameAction,
  profileRepairRootAction,
  profileRestoreAction,
} from "../commands/profile.ts";
import type { ListedProfile } from "../lib/profile.ts";
import { ProfileSpaceRootRefusal } from "../lib/profile-space-root.ts";
import { captureStdout } from "./utils.ts";

const LISTED: ListedProfile = {
  name: "Ada",
  picture: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  pictureByOwner: true,
  avatar: "",
  avatarByOwner: false,
  space: "did:key:zProfileSpace",
  id: "of:profile",
  address: "/@did:key:zProfileSpace/of:profile",
  current: true,
};

/** Deps carrying `effects`; every other effect throws. */
function stubDeps(effects: Partial<ProfileCommandDeps>): ProfileCommandDeps {
  const unexpected = () => Promise.reject(new Error("unexpected effect"));
  return {
    attestProfileName: unexpected,
    createProfile: unexpected,
    listProfiles: unexpected,
    renameProfile: unexpected,
    restoreProfile: unexpected,
    retireProfile: unexpected,
    setProfilePicture: unexpected,
    readWish: unexpected,
    ...effects,
  };
}

/** Deps whose `listProfiles()` returns `listed`; every other effect throws. */
function listingDeps(listed: ListedProfile[]): ProfileCommandDeps {
  return stubDeps({ listProfiles: () => Promise.resolve(listed) });
}

describe("profile-command", () => {
  let keyPath: string;
  let options: { apiUrl: string; identity: string };

  beforeEach(async () => {
    keyPath = await Deno.makeTempFile({ suffix: ".key" });
    await Deno.writeFile(keyPath, await Identity.generatePkcs8());
    options = { apiUrl: "http://127.0.0.1:8000", identity: keyPath };
  });

  afterEach(async () => {
    await Deno.remove(keyPath);
  });

  describe("the parsed command", () => {
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const name of ["CF_IDENTITY", "CF_API_URL"]) {
        saved[name] = Deno.env.get(name);
        Deno.env.delete(name);
      }
    });

    afterEach(() => {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) Deno.env.delete(name);
        else Deno.env.set(name, value);
      }
    });

    it("hands each subcommand's arguments and flags to its action, which refuses them before connecting", async () => {
      const command = profile.reset().throwErrors();
      const refusals: [string[], string][] = [
        [["list"], 'Missing required option: "--identity"'],
        [["rename", LISTED.space, " "], "A profile needs a name"],
        [["attest-name", LISTED.space, "--apply"], "--apply and --expect"],
        [
          ["get-picture", LISTED.space, "-"],
          'Missing required option: "--identity"',
        ],
        [["set-picture", LISTED.space], "Give one of an image file"],
        [["retire", LISTED.space], 'Missing required option: "--identity"'],
        [["restore", LISTED.space], 'Missing required option: "--identity"'],
        [
          ["repair-root", "--cell", "//did:key:zProfileSpace/of:profile"],
          "Use --cell only with --from-snapshot.",
        ],
      ];
      for (const [args, message] of refusals) {
        await expect(command.parse(args)).rejects.toThrow(message);
      }
    });

    it("passes the API URL flag on to the action, which then asks only for the identity", async () => {
      const command = profile.reset().throwErrors();
      await expect(
        command.parse(["retire", LISTED.space, "-a", "http://127.0.0.1:8000"]),
      ).rejects.toThrow('Missing required option: "--identity"');
      await expect(
        command.parse(["retire", LISTED.space, "-i", keyPath]),
      ).rejects.toThrow('Missing required option: "--api-url"');
    });
  });

  describe("profileListAction()", () => {
    it("prints `No profiles.` for an identity with none, and lines without it otherwise", async () => {
      expect(
        await captureStdout(() => profileListAction(options, listingDeps([]))),
      ).toBe("No profiles.\n");
      const listed = await captureStdout(() =>
        profileListAction(options, listingDeps([{ ...LISTED, name: "" }]))
      );
      expect(listed).toBe(`* ${LISTED.space} (no name) (picture)\n`);
    });
  });

  describe("profileRestoreAction()", () => {
    it("prints the profile restored without `--json`", async () => {
      const restored: string[] = [];
      const out = await captureStdout(() =>
        profileRestoreAction(
          options,
          LISTED.space,
          stubDeps({
            restoreProfile: ({ profileSpace }) => {
              restored.push(profileSpace);
              return Promise.resolve();
            },
          }),
        )
      );
      expect(restored).toEqual([LISTED.space]);
      expect(out).toBe(`Restored profile ${LISTED.space}\n`);
    });
  });

  describe("profileRenameAction()", () => {
    it("renames the profile to the trimmed name", async () => {
      const renamed: { profileSpace: string; name: string }[] = [];
      const out = await captureStdout(() =>
        profileRenameAction(
          options,
          LISTED.space,
          "  Countess  ",
          stubDeps({
            renameProfile: ({ profileSpace, name }) => {
              renamed.push({ profileSpace, name });
              return Promise.resolve();
            },
          }),
        )
      );
      expect(renamed).toEqual([{
        profileSpace: LISTED.space,
        name: "Countess",
      }]);
      expect(out).toBe(`Renamed profile ${LISTED.space} to "Countess"\n`);
    });

    it("prints the space renamed and its new name as JSON with `--json`", async () => {
      const out = await captureStdout(() =>
        profileRenameAction(
          { ...options, json: true },
          LISTED.space,
          "Countess",
          stubDeps({ renameProfile: () => Promise.resolve() }),
        )
      );
      expect(JSON.parse(out)).toEqual({
        renamed: LISTED.space,
        name: "Countess",
      });
    });
  });

  describe("profileRepairRootAction()", () => {
    let exitCode: number;

    beforeEach(() => {
      exitCode = Deno.exitCode;
    });

    afterEach(() => {
      Deno.exitCode = exitCode;
    });

    it("sets the process's exit status to a refusal's by default", async () => {
      Deno.exitCode = 0;
      const printed = await captureStdout(() =>
        profileRepairRootAction(
          options,
          () =>
            Promise.reject(
              new ProfileSpaceRootRefusal("inspection-changed", "changed"),
            ),
        )
      );
      expect(Deno.exitCode).toBe(3);
      expect(JSON.parse(printed).refused.reason).toBe("inspection-changed");
    });

    it("leaves the process's exit status as it was when the run is not refused", async () => {
      Deno.exitCode = 7;
      await captureStdout(() =>
        profileRepairRootAction(options, () =>
          Promise.resolve({
            repairVersion: 1,
            applied: false,
            inspection: "receipt",
            rows: [],
            summary: {},
          }))
      );
      expect(Deno.exitCode).toBe(7);
    });
  });
});
