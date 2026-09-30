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
  profile,
  type ProfileCommandDeps,
  profileCreateAction,
  profileRepairNameProtectionAction,
  profileShowAction,
} from "../commands/profile.ts";
import type { CreatedProfile, ProfileCreateConfig } from "../lib/profile.ts";
import {
  profileNameProtection,
  type ProfileNameProtectionConfig,
} from "../lib/profile-name-protection.ts";
import type { WishReadConfig, WishReadResult } from "../lib/wish.ts";
import { withEnv } from "./utils.ts";

const CREATED: CreatedProfile = {
  name: "Ada Lovelace",
  space: "did:key:zProfileSpace",
  id: "of:profile-piece",
  address: "/@did:key:zProfileSpace/of:profile-piece",
};

function stubDeps(wish: WishReadResult = { result: null }): {
  deps: ProfileCommandDeps;
  creates: ProfileCreateConfig[];
  reads: WishReadConfig[];
} {
  const creates: ProfileCreateConfig[] = [];
  const reads: WishReadConfig[] = [];
  return {
    deps: {
      createProfile: (config) => {
        creates.push(config);
        return Promise.resolve(CREATED);
      },
      readWish: (config) => {
        reads.push(config);
        return Promise.resolve(wish);
      },
    },
    creates,
    reads,
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
