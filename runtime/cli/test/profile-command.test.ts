/**
 * Drives the `cf profile` action bodies in-process with a stubbed
 * `createProfile()` and `readWish()` (the `wish-command.serial.test.ts` idiom),
 * so flag handling, the home-space target and the output shapes are covered
 * without a server. The create itself is covered in `profile-create.test.ts`.
 */

import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { ValidationError } from "@cliffy/command";
import { Identity } from "@commonfabric/identity";
import { decode } from "@commonfabric/utils/encoding";

import {
  dataUrlByteLength,
  profile,
  profileAttestNameAction,
  type ProfileCommandDeps,
  profileCreateAction,
  profileGetPictureAction,
  profileListAction,
  profileRenameAction,
  profileRepairNameProtectionAction,
  profileRepairRootAction,
  profileRestoreAction,
  profileRetireAction,
  profileSetPictureAction,
  profileShowAction,
} from "../commands/profile.ts";
import { getDidFromFile } from "../lib/identity.ts";
import type {
  CreatedProfile,
  ListedProfile,
  ProfileCreateConfig,
  ProfileNameAttestation,
  ProfileTargetConfig,
} from "../lib/profile.ts";
import {
  profileNameProtection,
  type ProfileNameProtectionConfig,
} from "../lib/profile-name-protection.ts";
import {
  type ProfileSpaceRootConfig,
  ProfileSpaceRootRefusal,
  type ProfileSpaceRootReport,
} from "../lib/profile-space-root.ts";
import type { WishReadConfig, WishReadResult } from "../lib/wish.ts";
import { withEnv } from "./utils.ts";

const CREATED: CreatedProfile = {
  name: "Ada Lovelace",
  space: "did:key:zProfileSpace",
  id: "of:profile-piece",
  address: "/@did:key:zProfileSpace/of:profile-piece",
};

const PICTURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

const LISTED: ListedProfile[] = [{
  name: "Ada Lovelace",
  picture: PICTURE,
  pictureByOwner: true,
  avatar: "",
  avatarByOwner: false,
  space: CREATED.space,
  id: CREATED.id,
  address: CREATED.address,
  current: true,
}];

/** What a stubbed command that acts on one profile was given. */
type Target = ProfileTargetConfig & {
  name?: string;
  bytes?: Uint8Array;
  clear?: true;
  keepCurrent?: true;
  expectedInspection?: string;
};

function stubDeps(
  wish: WishReadResult = { result: null },
  attested: ProfileNameAttestation = {
    status: "inspected",
    name: "Old Ada",
    inspection: "receipt",
  },
): {
  deps: ProfileCommandDeps;
  creates: ProfileCreateConfig[];
  reads: WishReadConfig[];
  targets: Target[];
} {
  const creates: ProfileCreateConfig[] = [];
  const reads: WishReadConfig[] = [];
  const targets: Target[] = [];
  const target = (config: ProfileTargetConfig) => {
    targets.push(config);
    return Promise.resolve();
  };
  return {
    deps: {
      attestProfileName: (config) => {
        targets.push(config);
        return Promise.resolve(attested);
      },
      createProfile: (config) => {
        creates.push(config);
        return Promise.resolve(CREATED);
      },
      listProfiles: () => Promise.resolve(LISTED),
      renameProfile: target,
      restoreProfile: target,
      retireProfile: target,
      setProfilePicture: target,
      readWish: (config) => {
        reads.push(config);
        return Promise.resolve(wish);
      },
    },
    creates,
    reads,
    targets,
  };
}

/** Capture what render() writes to stdout during `fn`. */
async function captureStdout(fn: () => Promise<void>): Promise<string> {
  let captured = "";
  const original = Deno.stdout.writeSync;
  Deno.stdout.writeSync = (data: Uint8Array): number => {
    captured += decode(data);
    return data.length;
  };
  try {
    await fn();
  } finally {
    Deno.stdout.writeSync = original;
  }
  return captured;
}

async function makeTempKeyFile(): Promise<
  { path: string; did: `did:${string}` }
> {
  const path = await Deno.makeTempFile({ suffix: ".key" });
  const pkcs8 = await Identity.generatePkcs8();
  await Deno.writeFile(path, pkcs8);
  const did = (await Identity.fromPkcs8(await Deno.readFile(path))).did();
  return { path, did };
}

describe("cf profile command actions", () => {
  it("routes parsed subcommands through their action validation", async () => {
    await withEnv(
      "CF_IDENTITY",
      undefined,
      () =>
        withEnv("CF_API_URL", undefined, async () => {
          const command = profile.reset().throwErrors();
          await expect(command.parse(["create", " "])).rejects.toThrow(
            "A profile needs a name",
          );
          await expect(command.parse(["show"])).rejects.toThrow(
            'Missing required option: "--identity"',
          );
          await expect(command.parse([
            "repair-name-protection",
            "--cell",
            "/profile",
            "--apply",
          ])).rejects.toThrow("--apply and --expect");
        }),
    );
  });

  describe("profileListAction()", () => {
    it("prints one line per profile, marking the current one and the ones with a picture", async () => {
      const key = await makeTempKeyFile();
      try {
        const { deps } = stubDeps();
        const out = await captureStdout(() =>
          profileListAction(
            { apiUrl: "http://127.0.0.1:8000", identity: key.path },
            deps,
          )
        );
        expect(out).toBe(`* ${CREATED.space} "Ada Lovelace" (picture)\n`);
        const other = await captureStdout(() =>
          profileListAction(
            { apiUrl: "http://127.0.0.1:8000", identity: key.path },
            {
              ...deps,
              listProfiles: () =>
                Promise.resolve([{ ...LISTED[0], pictureByOwner: false }]),
            },
          )
        );
        expect(other).toBe(
          `* ${CREATED.space} "Ada Lovelace" (picture not attested to its owner)\n`,
        );
      } finally {
        await Deno.remove(key.path);
      }
    });

    it("prints the listed profiles as JSON with `--json`, carrying no bytes", async () => {
      const key = await makeTempKeyFile();
      try {
        const { deps } = stubDeps();
        const legacy = "data:image/png;base64,iVBORw0KGgo=";
        const rows: ListedProfile[] = [
          LISTED[0],
          { ...LISTED[0], picture: undefined, pictureByOwner: false },
          { ...LISTED[0], avatar: legacy, avatarByOwner: true },
          { ...LISTED[0], avatar: "🦉", avatarByOwner: false },
        ];
        const out = await captureStdout(() =>
          profileListAction(
            { apiUrl: "http://127.0.0.1:8000", identity: key.path, json: true },
            { ...deps, listProfiles: () => Promise.resolve(rows) },
          )
        );
        const { name, space, id, address, current } = LISTED[0];
        const common = { name, space, id, address, current };
        const picture = { size: PICTURE.length, byOwner: true };
        expect(JSON.parse(out)).toEqual([
          { ...common, picture, avatar: null },
          { ...common, picture: null, avatar: null },
          { ...common, picture, avatar: { size: 8, byOwner: true } },
          { ...common, picture, avatar: { text: "🦉", byOwner: false } },
        ]);
        expect(out).not.toContain("base64");
        expect(out).not.toContain("iVBOR");
      } finally {
        await Deno.remove(key.path);
      }
    });
  });

  describe("dataUrlByteLength()", () => {
    it("returns the bytes a base64 or a percent-encoded `data:` URL holds", () => {
      expect(dataUrlByteLength("data:image/png;base64,iVBORw0KGgo=")).toBe(8);
      expect(dataUrlByteLength("data:;base64,AAAA")).toBe(3);
      expect(dataUrlByteLength("data:;base64,AA==")).toBe(1);
      expect(dataUrlByteLength("data:text/plain,a%20b")).toBe(3);
      expect(dataUrlByteLength("data:text/plain,é")).toBe(2);
    });
  });

  describe("profileRetireAction()", () => {
    it("retires the profile in the space named, from the identity's home", async () => {
      const key = await makeTempKeyFile();
      try {
        const { deps, targets } = stubDeps();
        const out = await captureStdout(() =>
          profileRetireAction(
            { apiUrl: "http://127.0.0.1:8000", identity: key.path },
            CREATED.space,
            deps,
          )
        );
        expect(targets).toHaveLength(1);
        expect(targets[0].space).toBe(key.did);
        expect(targets[0].profileSpace).toBe(CREATED.space);
        expect(out).toBe(`Retired profile ${CREATED.space}\n`);
      } finally {
        await Deno.remove(key.path);
      }
    });
  });

  describe("profileRestoreAction()", () => {
    it("restores the profile in the space named, from the identity's home", async () => {
      const key = await makeTempKeyFile();
      try {
        const { deps, targets } = stubDeps();
        const out = await captureStdout(() =>
          profileRestoreAction(
            { apiUrl: "http://127.0.0.1:8000", identity: key.path, json: true },
            CREATED.space,
            deps,
          )
        );
        expect(targets).toHaveLength(1);
        expect(targets[0].space).toBe(key.did);
        expect(targets[0].profileSpace).toBe(CREATED.space);
        expect(JSON.parse(out)).toEqual({ restored: CREATED.space });
      } finally {
        await Deno.remove(key.path);
      }
    });
  });

  describe("profileAttestNameAction()", () => {
    it("prints the stored name and the inspection without --apply, inspecting the profile in the space named", async () => {
      const key = await makeTempKeyFile();
      try {
        const { deps, targets } = stubDeps();
        const out = await captureStdout(() =>
          profileAttestNameAction(
            { apiUrl: "http://127.0.0.1:8000", identity: key.path, json: true },
            CREATED.space,
            deps,
          )
        );
        expect(targets).toHaveLength(1);
        expect(targets[0].space).toBe(key.did);
        expect(targets[0].profileSpace).toBe(CREATED.space);
        expect(targets[0].expectedInspection).toBeUndefined();
        expect(JSON.parse(out)).toEqual({
          space: CREATED.space,
          status: "inspected",
          name: "Old Ada",
          inspection: "receipt",
        });
      } finally {
        await Deno.remove(key.path);
      }
    });

    it("applies the inspection --expect names with --apply, naming the name it attested", async () => {
      const key = await makeTempKeyFile();
      try {
        const { deps, targets } = stubDeps({ result: null }, {
          status: "attested",
          name: "Old Ada",
        });
        const out = await captureStdout(() =>
          profileAttestNameAction(
            {
              apiUrl: "http://127.0.0.1:8000",
              identity: key.path,
              apply: true,
              expect: "receipt",
            },
            CREATED.space,
            deps,
          )
        );
        expect(targets[0].expectedInspection).toBe("receipt");
        expect(out).toContain('Attested the name "Old Ada"');
      } finally {
        await Deno.remove(key.path);
      }
    });

    it("refuses --apply without --expect, and --expect without --apply", async () => {
      const { deps, targets } = stubDeps();
      await expect(
        profileAttestNameAction({ apply: true }, CREATED.space, deps),
      ).rejects.toThrow("--apply and --expect");
      await expect(
        profileAttestNameAction({ expect: "receipt" }, CREATED.space, deps),
      ).rejects.toThrow("--apply and --expect");
      expect(targets).toEqual([]);
    });

    it("says so when the name was already attested", async () => {
      const key = await makeTempKeyFile();
      try {
        const { deps } = stubDeps({ result: null }, {
          status: "already",
          name: "Ada",
        });
        const out = await captureStdout(() =>
          profileAttestNameAction(
            { apiUrl: "http://127.0.0.1:8000", identity: key.path },
            CREATED.space,
            deps,
          )
        );
        expect(out).toContain("already attested");
      } finally {
        await Deno.remove(key.path);
      }
    });
  });

  describe("profileRenameAction()", () => {
    it("renames the profile to the trimmed name", async () => {
      const key = await makeTempKeyFile();
      try {
        const { deps, targets } = stubDeps();
        await captureStdout(() =>
          profileRenameAction(
            { apiUrl: "http://127.0.0.1:8000", identity: key.path },
            CREATED.space,
            "  Countess  ",
            deps,
          )
        );
        expect(targets).toHaveLength(1);
        expect(targets[0].profileSpace).toBe(CREATED.space);
        expect(targets[0].name).toBe("Countess");
      } finally {
        await Deno.remove(key.path);
      }
    });

    it("throws a `ValidationError` for a blank name before connecting", async () => {
      const { deps, targets } = stubDeps();
      await expect(
        profileRenameAction(
          { apiUrl: "http://127.0.0.1:8000", identity: "/unread.key" },
          CREATED.space,
          "  ",
          deps,
        ),
      ).rejects.toThrow(ValidationError);
      expect(targets).toHaveLength(0);
    });
  });

  describe("profileGetPictureAction()", () => {
    it("writes the picture's bytes to the file named", async () => {
      const key = await makeTempKeyFile();
      const out = await Deno.makeTempFile({ suffix: ".png" });
      try {
        const { deps } = stubDeps();
        await profileGetPictureAction(
          { apiUrl: "http://127.0.0.1:8000", identity: key.path },
          CREATED.space,
          out,
          deps,
        );
        expect(await Deno.readFile(out)).toEqual(PICTURE);
      } finally {
        await Deno.remove(key.path);
        await Deno.remove(out);
      }
    });

    it("throws a `ValidationError` for a space no listed profile lives in, a profile with no picture, and a picture its owner did not set", async () => {
      const key = await makeTempKeyFile();
      try {
        const options = { apiUrl: "http://127.0.0.1:8000", identity: key.path };
        const { deps } = stubDeps();
        await expect(
          profileGetPictureAction(options, "did:key:zElsewhere", "-", deps),
        ).rejects.toThrow(ValidationError);
        await expect(
          profileGetPictureAction(options, CREATED.space, "-", {
            ...deps,
            listProfiles: () =>
              Promise.resolve([{ ...LISTED[0], picture: undefined }]),
          }),
        ).rejects.toThrow(/has no picture/);
        await expect(
          profileGetPictureAction(options, CREATED.space, "-", {
            ...deps,
            listProfiles: () =>
              Promise.resolve([{ ...LISTED[0], pictureByOwner: false }]),
          }),
        ).rejects.toThrow(/not attested to its owner/);
      } finally {
        await Deno.remove(key.path);
      }
    });
  });

  describe("profileSetPictureAction()", () => {
    it("sets the picture to the file's bytes, and removes it with `--clear`", async () => {
      const key = await makeTempKeyFile();
      const image = await Deno.makeTempFile({ suffix: ".png" });
      try {
        await Deno.writeFile(image, PICTURE);
        const { deps, targets } = stubDeps();
        const options = {
          apiUrl: "http://127.0.0.1:8000",
          identity: key.path,
          json: true,
        };
        const set = await captureStdout(() =>
          profileSetPictureAction(options, CREATED.space, image, deps)
        );
        const cleared = await captureStdout(() =>
          profileSetPictureAction(
            { ...options, clear: true },
            CREATED.space,
            undefined,
            deps,
          )
        );
        expect(JSON.parse(set)).toEqual({
          pictureSet: CREATED.space,
          cleared: false,
        });
        expect(JSON.parse(cleared)).toEqual({
          pictureSet: CREATED.space,
          cleared: true,
        });
        expect(targets.map(({ bytes, clear }) => ({ bytes, clear }))).toEqual([
          { bytes: PICTURE, clear: undefined },
          { bytes: undefined, clear: true },
        ]);
      } finally {
        await Deno.remove(key.path);
        await Deno.remove(image);
      }
    });

    it("sets the stored picture again with `--keep-current`", async () => {
      const key = await makeTempKeyFile();
      try {
        const { deps, targets } = stubDeps();
        const out = await captureStdout(() =>
          profileSetPictureAction(
            {
              apiUrl: "http://127.0.0.1:8000",
              identity: key.path,
              keepCurrent: true,
            },
            CREATED.space,
            undefined,
            deps,
          )
        );

        expect(out.trim()).toBe(
          `Set the stored picture of profile ${CREATED.space} again`,
        );
        expect(
          targets.map(({ bytes, clear, keepCurrent }) => ({
            bytes,
            clear,
            keepCurrent,
          })),
        ).toEqual([{ bytes: undefined, clear: undefined, keepCurrent: true }]);
      } finally {
        await Deno.remove(key.path);
      }
    });

    it("throws a `ValidationError` for both a file and `--clear`, or neither, before connecting", async () => {
      const { deps, targets } = stubDeps();
      const options = {
        apiUrl: "http://127.0.0.1:8000",
        identity: "/unread.key",
      };
      await expect(
        profileSetPictureAction(
          { ...options, clear: true },
          CREATED.space,
          "./picture.png",
          deps,
        ),
      ).rejects.toThrow(ValidationError);
      await expect(
        profileSetPictureAction(options, CREATED.space, undefined, deps),
      ).rejects.toThrow(ValidationError);
      await expect(
        profileSetPictureAction(
          { ...options, keepCurrent: true },
          CREATED.space,
          "./picture.png",
          deps,
        ),
      ).rejects.toThrow(ValidationError);
      await expect(
        profileSetPictureAction(
          { ...options, clear: true, keepCurrent: true },
          CREATED.space,
          undefined,
          deps,
        ),
      ).rejects.toThrow(ValidationError);
      expect(targets).toHaveLength(0);
    });
  });

  describe("profileCreateAction()", () => {
    it("creates against the identity's home space and prints the address", async () => {
      const key = await makeTempKeyFile();
      try {
        const { deps, creates } = stubDeps();
        const out = await captureStdout(() =>
          profileCreateAction(
            { apiUrl: "http://127.0.0.1:8000", identity: key.path },
            "Ada Lovelace",
            deps,
          )
        );
        expect(creates).toHaveLength(1);
        expect(creates[0].space).toBe(key.did);
        expect(creates[0].name).toBe("Ada Lovelace");
        expect(creates[0].apiUrl).toBe("http://127.0.0.1:8000");
        expect(out).toBe(
          `Created profile "Ada Lovelace" at ${CREATED.address}\n`,
        );
      } finally {
        await Deno.remove(key.path);
      }
    });

    it("prints the created profile as JSON under `--json`", async () => {
      const key = await makeTempKeyFile();
      try {
        const { deps } = stubDeps();
        const out = await captureStdout(() =>
          profileCreateAction(
            { apiUrl: "http://127.0.0.1:8000", identity: key.path, json: true },
            "Ada Lovelace",
            deps,
          )
        );
        expect(JSON.parse(out)).toEqual(CREATED);
      } finally {
        await Deno.remove(key.path);
      }
    });

    it("throws a `ValidationError` for a blank name before connecting", async () => {
      const { deps, creates } = stubDeps();
      await expect(
        profileCreateAction(
          { apiUrl: "http://127.0.0.1:8000", identity: "/unread.key" },
          "   ",
          deps,
        ),
      ).rejects.toThrow(ValidationError);
      expect(creates).toHaveLength(0);
    });

    it("throws a `ValidationError` for a name carrying a control character, before connecting", async () => {
      const { deps, creates } = stubDeps();
      const attempt = profileCreateAction(
        { apiUrl: "http://127.0.0.1:8000", identity: "/unread.key" },
        "Ada\u001bLovelace",
        deps,
      );
      await expect(attempt).rejects.toThrow(ValidationError);
      await expect(attempt).rejects.toThrow(/control characters/);
      expect(creates).toHaveLength(0);
    });

    it("throws a `ValidationError` when the identity is missing", async () => {
      const { deps } = stubDeps();
      await expect(
        profileCreateAction({ apiUrl: "http://127.0.0.1:8000" }, "Ada", deps),
      ).rejects.toThrow(/--identity/);
    });

    it("throws a `ValidationError` when the API URL is missing", async () => {
      const { deps } = stubDeps();
      await expect(
        profileCreateAction({ identity: "/unread.key" }, "Ada", deps),
      ).rejects.toThrow(/--api-url/);
    });
  });

  describe("profileShowAction()", () => {
    it("reads `#profile` in the home space, asking for its address and name", async () => {
      const key = await makeTempKeyFile();
      try {
        const { deps, reads } = stubDeps({
          result: { $link: CREATED.address, name: "Ada Lovelace" },
        });
        const out = await captureStdout(() =>
          profileShowAction(
            { apiUrl: "http://127.0.0.1:8000", identity: key.path },
            deps,
          )
        );
        expect(reads).toHaveLength(1);
        expect(reads[0].query).toBe("#profile");
        expect(reads[0].space).toBe(key.did);
        expect(reads[0].selection).toBeDefined();
        expect(JSON.parse(out)).toEqual({
          $link: CREATED.address,
          name: "Ada Lovelace",
        });
      } finally {
        await Deno.remove(key.path);
      }
    });

    it("throws a `ValidationError` carrying the wish's error when there is no profile", async () => {
      const key = await makeTempKeyFile();
      try {
        const { deps } = stubDeps({ result: null, error: "no profile yet" });
        await expect(
          profileShowAction(
            { apiUrl: "http://127.0.0.1:8000", identity: key.path },
            deps,
          ),
        ).rejects.toThrow(/no profile yet/);
      } finally {
        await Deno.remove(key.path);
      }
    });
  });
  describe("profileRepairRootAction()", () => {
    it("inspects by default and forwards the snapshot, the named cells and an accepted receipt", async () => {
      const key = await makeTempKeyFile();
      const requests: ProfileSpaceRootConfig[] = [];
      const report: ProfileSpaceRootReport = {
        repairVersion: 1,
        applied: false,
        inspection: "receipt",
        rows: [],
        summary: {},
      };
      const run = (config: ProfileSpaceRootConfig) => {
        requests.push(config);
        return Promise.resolve(report);
      };
      try {
        const options = {
          apiUrl: "http://127.0.0.1:8000",
          identity: key.path,
          fromSnapshot: "/snapshot",
        };
        expect(
          JSON.parse(
            await captureStdout(() => profileRepairRootAction(options, run)),
          ),
        ).toEqual(report);
        await captureStdout(() =>
          profileRepairRootAction({
            ...options,
            cell: ["//did:key:zProfileSpace/of:profile"],
            apply: true,
            expect: "receipt",
          }, run)
        );
        expect(requests.map((request) => request.expectedInspection)).toEqual([
          undefined,
          "receipt",
        ]);
        expect(requests.map((request) => request.cells)).toEqual([
          undefined,
          ["//did:key:zProfileSpace/of:profile"],
        ]);
        expect(requests.map((request) => request.snapshot)).toEqual([
          "/snapshot",
          "/snapshot",
        ]);
      } finally {
        await Deno.remove(key.path);
      }
    });

    it("reads the identity's own Home when given no snapshot", async () => {
      const key = await makeTempKeyFile();
      const requests: ProfileSpaceRootConfig[] = [];
      const run = (config: ProfileSpaceRootConfig) => {
        requests.push(config);
        return Promise.resolve({
          repairVersion: 1,
          applied: false,
          inspection: "receipt",
          rows: [],
          summary: {},
        });
      };
      try {
        await captureStdout(() =>
          profileRepairRootAction({
            apiUrl: "http://127.0.0.1:8000",
            identity: key.path,
          }, run)
        );
        expect(requests).toHaveLength(1);
        expect(requests[0].home).toBe(await getDidFromFile(key.path));
        expect("snapshot" in requests[0]).toBe(false);
      } finally {
        await Deno.remove(key.path);
      }
    });

    it("prints a refusal as JSON and ends with its exit status", async () => {
      const key = await makeTempKeyFile();
      try {
        for (
          const [refusal, code] of [
            [
              new ProfileSpaceRootRefusal("inspection-changed", "changed"),
              3,
            ],
            [
              new ProfileSpaceRootRefusal(
                "server-execution",
                "runs it",
                "did:key:zProfileSpace",
              ),
              4,
            ],
            [
              new ProfileSpaceRootRefusal(
                "server-execution-unknown",
                "does not say",
                "did:key:zProfileSpace",
              ),
              4,
            ],
          ] as const
        ) {
          const codes: number[] = [];
          const printed = JSON.parse(
            await captureStdout(() =>
              profileRepairRootAction(
                { apiUrl: "http://127.0.0.1:8000", identity: key.path },
                () => Promise.reject(refusal),
                (exitCode) => codes.push(exitCode),
              )
            ),
          );
          expect(printed).toEqual({
            repairVersion: 1,
            refused: {
              reason: refusal.reason,
              message: refusal.message,
              ...(refusal.space === undefined ? {} : { space: refusal.space }),
            },
          });
          expect(codes).toEqual([code]);
        }
      } finally {
        await Deno.remove(key.path);
      }
    });

    it("passes on an error that is not a refusal, printing nothing", async () => {
      const key = await makeTempKeyFile();
      try {
        const codes: number[] = [];
        let thrown: unknown;
        const printed = await captureStdout(async () => {
          try {
            await profileRepairRootAction(
              { apiUrl: "http://127.0.0.1:8000", identity: key.path },
              () => Promise.reject(new Error("no Home")),
              (exitCode) => codes.push(exitCode),
            );
          } catch (error) {
            thrown = error;
          }
        });
        expect((thrown as Error | undefined)?.message).toBe("no Home");
        expect(printed).toBe("");
        expect(codes).toEqual([]);
      } finally {
        await Deno.remove(key.path);
      }
    });

    it("takes --cell only with --from-snapshot, before opening an identity", async () => {
      await expect(
        profileRepairRootAction({
          identity: "/unread.key",
          cell: ["//did:key:zProfileSpace/of:profile"],
        }),
      ).rejects.toThrow("--cell only with --from-snapshot");
    });

    it("requires apply and the inspection receipt together before opening an identity", async () => {
      for (const flags of [{ apply: true }, { expect: "receipt" }]) {
        await expect(
          profileRepairRootAction({
            fromSnapshot: "/snapshot",
            identity: "/unread.key",
            ...flags,
          }),
        ).rejects.toThrow("--apply and --expect");
      }
    });
  });

  describe("profileRepairNameProtectionAction()", () => {
    it("inspects by default and forwards only an explicitly accepted receipt", async () => {
      const key = await makeTempKeyFile();
      const requests: ProfileNameProtectionConfig[] = [];
      const result = {
        status: "repairable" as const,
        inspection: "receipt",
        owner: key.did,
        name: "Saved name",
        profile: {
          space: key.did,
          id: "of:profile" as const,
          scope: "space" as const,
          path: [],
        },
        positions: [],
      };
      const run = (config: ProfileNameProtectionConfig) => {
        requests.push(config);
        return Promise.resolve(result);
      };
      try {
        const options = {
          apiUrl: "http://127.0.0.1:8000",
          identity: key.path,
          cell: "//did:key:zProfileSpace/of:profile",
        };
        expect(
          JSON.parse(
            await captureStdout(() =>
              profileRepairNameProtectionAction(options, run)
            ),
          ),
        ).toEqual(result);
        await captureStdout(() =>
          profileRepairNameProtectionAction({
            ...options,
            apply: true,
            expect: "receipt",
          }, run)
        );
        expect(requests.map((request) => request.expectedInspection)).toEqual([
          undefined,
          "receipt",
        ]);
        expect(requests.map((request) => request.cell)).toEqual([
          options.cell,
          options.cell,
        ]);
      } finally {
        await Deno.remove(key.path);
      }
    });

    it("requires apply and the inspection receipt together before opening an identity", async () => {
      for (const flags of [{ apply: true }, { expect: "receipt" }]) {
        await expect(
          profileRepairNameProtectionAction({
            cell: "/profile",
            identity: "/unread.key",
            ...flags,
          }),
        ).rejects.toThrow("--apply and --expect");
      }
    });

    it("refuses ambiguous targets before connecting", async () => {
      let connected = false;
      const load = () => {
        connected = true;
        throw new Error("unexpected connection");
      };
      for (
        const cell of [
          "/profile",
          "//home/profile",
          "//did:key:zProfileSpace/profile",
          "//did:key:zProfileSpace/of:fid1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/name",
          "//did:key:zProfileSpace/of:fid1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@user",
        ]
      ) {
        await expect(
          profileNameProtection({
            cell,
            apiUrl: "http://127.0.0.1:8000",
            identity: "/unread.key",
            space: "home",
          }, load),
        ).rejects.toThrow("full profile cell address");
      }
      expect(connected).toBe(false);
    });
  });
});
