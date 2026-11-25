import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { type FabricValue, hashOf } from "@commonfabric/data-model";
import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import { isDID } from "@commonfabric/identity/did";
import type { MemorySpace } from "@commonfabric/memory/interface";
import {
  type Cell,
  type IExtendedStorageTransaction,
  resolveEntryIdentity,
  Runtime,
  type RuntimeOptions,
  type Stream,
  systemPatternSource,
  transactionFailureMessage,
  writtenPrincipalAt,
} from "@commonfabric/runner";
import {
  asStoredBlobRecord,
  blobDocumentId,
} from "@commonfabric/runner/blob-record";
import { cfcLabelViewForResolvedTarget } from "@commonfabric/runner/cfc";
import { representsPrincipalSubjects } from "@commonfabric/runner/cfc/represents-principal";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { createCompileByteCache } from "@commonfabric/test-support/compile-byte-cache";
import { EmulatedStorageManager } from "../../runner/src/storage/v2-emulate.ts";
import { newSharedServer } from "../../runner/test/memory-v2-test-utils.ts";

const owner = await Identity.fromPassphrase("profile picture owner");
const visitor = await Identity.fromPassphrase("profile picture visitor");
const profileSpace = (await Identity.fromPassphrase("profile picture space"))
  .did();
const visitorSpace =
  (await Identity.fromPassphrase("profile picture visitor's space")).did();
// Where the pattern showing the owner's face runs, as a chat room showing its
// members' faces runs in a space of its own.
const readerSpace =
  (await Identity.fromPassphrase("profile picture reader's space")).did();
const route = "/api/patterns/system/profile-home/profile-home.tsx";
// A complete profile source from before the profile had a `picture` field.
const previous = Deno.readTextFileSync(
  new URL("./fixtures/profile-home-dynamic-name.tsx.txt", import.meta.url),
);
// A complete profile source whose `picture` had no default and no owner, its
// writer labeling each picture with whoever set it.
const labeledByWriter = Deno.readTextFileSync(
  new URL("./fixtures/profile-home-picture-by-writer.tsx.txt", import.meta.url),
);
const current = Deno.readTextFileSync(
  new URL(
    "../../../patterns/system/profile-home/profile-home.tsx",
    import.meta.url,
  ),
);

// A pattern that shows the face of the profile it is given, through
// `profileFace()`, as every pattern drawing someone's face does.
const faceProbe = {
  main: "/face-probe.tsx",
  files: [
    {
      name: "/face-probe.tsx",
      contents: `
import { type Cell, type FabricBytes, lift, pattern } from "commonfabric";
import { profileFace, type ProfileFaceFields } from "./profile-face.ts";

const faceOf = lift<
  { profile: Cell<ProfileFaceFields> },
  {
    pictureBlob?: { space: string; id: string };
    picture?: FabricBytes;
    avatar?: string;
  }
>(({ profile }) => profileFace(profile));

export default pattern<{ profile: Cell<ProfileFaceFields> }>(
  ({ profile }) => ({ face: faceOf({ profile }) }),
);
`,
    },
    {
      name: "/profile-face.ts",
      contents: Deno.readTextFileSync(
        new URL(
          "../../../patterns/system/profile-face/profile-face.ts",
          import.meta.url,
        ),
      ),
    },
  ],
};

/** A reference to a blob, as a profile's `pictureBlob` holds one. */
type BlobReference = { space?: string; id?: string };

/** The part of a profile these cases read and write. */
type Profile = {
  pictureBlob?: BlobReference;
  picture?: FabricBytes;
  setPicture: Stream<{ picture?: FabricBytes }>;
};

// The refusal `setPicture` gives every writer but the profile's owner.
const OWNER_ONLY = /Only the profile's owner can set its picture/;

// One cache for every runtime this file makes, so that a pattern compiles
// once per file rather than once per case.
const moduleByteCache = createCompileByteCache();

describe("profile picture ownership", () => {
  let server: MemoryV2Server.Server;
  let served: { contents: string; identity: string };
  let runtime: Runtime;
  let profile: Cell<Profile>;
  const opened: Runtime[] = [];

  const serve = async (contents: string) => {
    served = {
      contents,
      identity: await resolveEntryIdentity(
        route,
        () => Promise.resolve(contents),
      ),
    };
  };

  /**
   * A runtime acting as `identity` against the shared server, with `options`
   * for how it enforces policies.
   */
  const open = (
    identity: Identity,
    options: Pick<RuntimeOptions, "cfcEnforcementMode"> = {},
  ): Runtime => {
    const runtime = new Runtime({
      ...options,
      moduleByteCache,
      apiUrl: new URL("https://profile.test"),
      storageManager: EmulatedStorageManager.connectTo(server, {
        as: identity,
      }),
      fetch: (input) => {
        const url = new URL(input instanceof Request ? input.url : input);
        return Promise.resolve(
          new Response(
            url.pathname === route
              ? (url.searchParams.has("identity")
                ? served.identity
                : served.contents)
              : "not found",
            { status: url.pathname === route ? 200 : 404 },
          ),
        );
      },
    });
    opened.push(runtime);
    return runtime;
  };

  /**
   * Creates a profile from `source`, as the served source, in `space` with a
   * runtime acting as `identity`, and returns that runtime and the profile.
   */
  const startProfile = async (
    identity: Identity,
    space: MemorySpace,
    source: string,
  ) => {
    await serve(source);
    const runtime = open(identity);
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern({
      main: route,
      files: [{ name: route, contents: source }],
    }, { space, tx });
    const profile = runtime.getCell<Profile>(space, "profile");
    runtime.runner.run(tx, pattern, { initialName: "Saved name" }, profile, {
      sourceOrigin: systemPatternSource("system/profile-home/profile-home.tsx"),
    });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await profile.pull();
    await runtime.settled();
    return { runtime, profile };
  };

  /** Creates the owner's profile from `source`, as the served source. */
  const createProfile = async (source: string) => {
    ({ runtime, profile } = await startProfile(owner, profileSpace, source));
  };

  /** Moves the profile to `source`, as a release does. */
  const updateSource = async (source: string) => {
    await serve(source);
    expect(await runtime.sourceReconciler.reconcile(profile)).toBe("updated");
    await runtime.runner.idlePointerMaintenance();
    await runtime.settled();
    await profile.pull();
  };

  /**
   * The bytes of the blob `reference` names, as its space's blob store holds
   * them, or `undefined` when it names no space or the store holds no such
   * blob.
   */
  const blobBytes = async (
    reference: BlobReference,
  ): Promise<number[] | undefined> => {
    const space = reference.space;
    if (!isDID(space)) return undefined;
    const record = await server.readDocument(
      space,
      blobDocumentId(reference.id ?? ""),
    );
    const body = asStoredBlobRecord(record?.value)?.body;
    return body === undefined ? undefined : [...body.slice()];
  };

  /**
   * Stores `bytes` as a PNG blob in the profile's space, as a host uploading
   * a picture does, and returns the blob's reference.
   */
  const storeBlob = async (
    bytes: number[],
  ): Promise<{ space: string; id: string }> => {
    const record = {
      type: "image/png",
      body: new FabricBytes(new Uint8Array(bytes)),
    };
    const id = hashOf(record).toString();
    await server.writeDocument(profileSpace, blobDocumentId(id), record);
    return { space: profileSpace, id };
  };

  /**
   * The field of the profile holding its picture: `pictureBlob` where it
   * names a blob, and `picture`, where bytes are held inline, otherwise.
   */
  const pictureField = async (): Promise<"pictureBlob" | "picture"> => {
    await runtime.settled();
    await profile.pull();
    return profile.key("pictureBlob").get()?.id ? "pictureBlob" : "picture";
  };

  /**
   * The principals the label of the value naming or holding the picture says
   * it represents: what vouches for the bytes a reader shows as a face.
   */
  const pictureBy = async (): Promise<string[]> => {
    const field = await pictureField();
    return representsPrincipalSubjects(
      cfcLabelViewForResolvedTarget(profile.key(field))?.entries ?? [],
    );
  };

  /** The picture's bytes, from its blob or held inline. */
  const picture = async (): Promise<number[] | undefined> => {
    if (await pictureField() === "pictureBlob") {
      return await blobBytes(profile.key("pictureBlob").get() ?? {});
    }
    const bytes = profile.key("picture").get();
    return bytes === undefined ? undefined : [...bytes.slice()];
  };

  /**
   * The principal the own cell of the value naming or holding the picture
   * represents (`writtenPrincipalAt()`): whom a reader credits it to.
   */
  const pictureWriter = async () => {
    const field = await pictureField();
    const tx = runtime.edit();
    try {
      return writtenPrincipalAt(tx, profile.key(field));
    } finally {
      tx.abort();
    }
  };

  let face:
    | Cell<
      {
        pictureBlob?: BlobReference;
        picture?: FabricBytes;
        avatar?: string;
      }
    >
    | undefined;

  /**
   * The face `profileFace()` finds on the profile, as the probe pattern
   * started in another space on the first call shows it, with the picture as
   * its bytes, read from its blob where the face names one.
   */
  const faceShown = async () => {
    if (face === undefined) {
      const tx = runtime.edit();
      const probe = await runtime.patternManager.compilePattern(faceProbe, {
        space: readerSpace,
        tx,
      });
      const result = runtime.getCell<
        {
          face: {
            pictureBlob?: BlobReference;
            picture?: FabricBytes;
            avatar?: string;
          };
        }
      >(readerSpace, "face-probe", undefined, tx);
      runtime.runner.run(tx, probe, { profile }, result);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      face = result.key("face");
      face.sink(() => {});
    }
    await runtime.settled();
    await profile.pull();
    await runtime.settled();
    const shown = face.get();
    const bytes = shown?.pictureBlob !== undefined
      ? await blobBytes(shown.pictureBlob)
      : shown?.picture === undefined
      ? undefined
      : [...shown.picture.slice()];
    return {
      ...(bytes === undefined ? {} : { picture: bytes }),
      ...(shown?.avatar === undefined ? {} : { avatar: shown.avatar }),
    };
  };

  /**
   * Sets the picture of `on`, the owner's profile unless given, to `bytes`,
   * or clears it for `"clear"`, through the profile's own writer from
   * `writer`, and returns why it failed, the writer's own error where it
   * threw one, if it failed.
   */
  const setPicture = async (
    writer: Runtime,
    picture:
      | number[]
      | { blob: number[] }
      | { reference: { space: string; id: string } }
      | "clear",
    on: Cell<Profile> = profile,
  ): Promise<string | undefined> => {
    const cell = writer.getCellFromLink<Profile>(
      on.getAsNormalizedFullLink(),
    );
    await cell.sync();
    const settled = Promise.withResolvers<IExtendedStorageTransaction>();
    writer.scheduler.queueEvent(
      cell.key("setPicture").resolveAsCell().getAsNormalizedFullLink(),
      picture === "clear"
        ? { clear: true }
        : Array.isArray(picture)
        ? { picture: new FabricBytes(new Uint8Array(picture)) }
        : "blob" in picture
        ? { pictureBlob: await storeBlob(picture.blob) }
        : { pictureBlob: picture.reference },
      true,
      settled.resolve,
    );
    const status = (await settled.promise).status();
    await writer.settled();
    return status.status === "error"
      ? transactionFailureMessage(status.error)
      : undefined;
  };

  beforeEach(() => {
    server = newSharedServer();
  });

  afterEach(async () => {
    face = undefined;
    for (const opening of opened.splice(0)) await opening.dispose();
    await server.close();
  });

  /**
   * Writes `value` into the own cell of the profile's `field`, its picture's
   * by default, from a visitor's runtime that enforces no policy, as a client
   * that ignores policies writes it.
   */
  const writePastPolicy = async (
    value: FabricValue,
    field: "pictureBlob" | "picture" = "picture",
  ) => {
    const writer = open(visitor, { cfcEnforcementMode: "disabled" });
    const cell = writer.getCellFromLink<Profile>(
      profile.getAsNormalizedFullLink(),
    );
    await cell.sync();
    const target = cell.key(field).resolveAsCell();
    await target.sync();
    const tx = writer.edit();
    tx.writeValueOrThrow(target.getAsNormalizedFullLink(), value);
    writer.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await writer.settled();
  };

  describe("on a profile created before the field existed", () => {
    beforeEach(async () => {
      await createProfile(previous);
      await updateSource(current);
    });

    it("holds no picture, credited to no one, after the update", async () => {
      expect(await picture()).toEqual([]);
      expect(await pictureBy()).toEqual([]);
    });

    it("refuses every writer, the owner included, while the profile is no one's own", async () => {
      // The name the earlier source stored carries no claim of whose profile
      // it is, so `profileOwnerOf()` finds no owner, and no reader shows a
      // face for it.

      expect(await setPicture(runtime, [1, 2, 3])).toMatch(OWNER_ONLY);
      expect(await setPicture(open(visitor), [9, 9, 9, 9])).toMatch(
        OWNER_ONLY,
      );
      expect(await picture()).toEqual([]);
      expect(await faceShown()).toEqual({});
    });
  });

  describe("on a profile whose picture anyone could set", () => {
    beforeEach(async () => {
      await createProfile(labeledByWriter);
    });

    it("keeps the owner's picture, credited to the owner, and refuses a visitor's after the update", async () => {
      expect(await setPicture(runtime, [1, 2, 3])).toBeUndefined();
      await updateSource(current);

      expect(await picture()).toEqual([1, 2, 3]);
      expect(await pictureWriter()).toBe(owner.did());
      expect(await setPicture(open(visitor), [9, 9, 9, 9])).toMatch(
        OWNER_ONLY,
      );
      expect(await picture()).toEqual([1, 2, 3]);
      expect(await faceShown()).toEqual({ picture: [1, 2, 3] });
    });

    it("lets the owner replace a picture a visitor set before the update, and refuses the visitor after it", async () => {
      expect(await setPicture(open(visitor), [9, 9, 9, 9])).toBeUndefined();
      await updateSource(current);
      expect(await pictureWriter()).toBe(visitor.did());
      expect(await faceShown()).toEqual({});

      expect(await setPicture(runtime, [1, 2, 3])).toBeUndefined();
      expect(await pictureWriter()).toBe(owner.did());
      expect(await faceShown()).toEqual({ picture: [1, 2, 3] });
      expect(await setPicture(open(visitor), [9, 9, 9, 9])).toMatch(
        OWNER_ONLY,
      );
      expect(await picture()).toEqual([1, 2, 3]);
    });

    it("lets the owner replace a picture stored without a label, and refuses a visitor's", async () => {
      const tx = runtime.edit();
      tx.writeValueOrThrow(
        profile.key("picture").resolveAsCell().getAsNormalizedFullLink(),
        new FabricBytes(new Uint8Array([7, 7])),
      );
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      await updateSource(current);
      expect(await pictureWriter()).toBeUndefined();

      expect(await setPicture(open(visitor), [9, 9, 9, 9])).toMatch(
        OWNER_ONLY,
      );
      expect(await setPicture(runtime, [1, 2, 3])).toBeUndefined();
      expect(await pictureWriter()).toBe(owner.did());
    });

    it("lets the owner set a blob after the update, credited to the owner, and refuses a visitor's", async () => {
      await updateSource(current);

      expect(await setPicture(open(visitor), { blob: [9, 9, 9, 9] }))
        .toMatch(OWNER_ONLY);
      expect(await setPicture(runtime, { blob: [1, 2, 3] })).toBeUndefined();
      expect(await pictureField()).toBe("pictureBlob");
      expect(await pictureWriter()).toBe(owner.did());
      expect(await faceShown()).toEqual({ picture: [1, 2, 3] });
    });

    it("refuses a visitor's picture on a profile whose picture nobody set", async () => {
      await updateSource(current);

      expect(await setPicture(open(visitor), [9, 9, 9, 9])).toMatch(
        OWNER_ONLY,
      );
      expect(await setPicture(runtime, [1, 2, 3])).toBeUndefined();
      expect(await picture()).toEqual([1, 2, 3]);
      expect(await pictureBy()).toEqual([owner.did()]);
    });
  });

  describe("on a profile created with the field", () => {
    beforeEach(async () => {
      await createProfile(current);
    });

    it("holds no picture, and shows no face, before anyone sets one", async () => {
      expect(await picture()).toEqual([]);
      expect(await faceShown()).toEqual({});
    });

    it("attests the owner once the owner sets the picture", async () => {
      expect(await setPicture(runtime, [1, 2, 3])).toBeUndefined();
      expect(await picture()).toEqual([1, 2, 3]);
      expect(await pictureBy()).toEqual([owner.did()]);
      expect(await pictureWriter()).toBe(owner.did());
    });

    it("shows a picture its owner set as the profile's face", async () => {
      expect(await setPicture(runtime, [1, 2, 3])).toBeUndefined();

      expect(await faceShown()).toEqual({ picture: [1, 2, 3] });
    });

    it("shows a picture of 60 KiB its owner set as a blob as the profile's face, holding none of its bytes inline", async () => {
      const large = Array.from(
        { length: 60 * 1024 },
        (_, index) => index % 251,
      );

      expect(await setPicture(runtime, { blob: large })).toBeUndefined();

      expect(await pictureField()).toBe("pictureBlob");
      expect(profile.key("pictureBlob").get()?.space).toBe(profileSpace);
      expect([...(profile.key("picture").get()?.slice() ?? [])]).toEqual([]);
      expect(await pictureWriter()).toBe(owner.did());
      expect(await faceShown()).toEqual({ picture: large });
    });

    it("refuses a visitor's picture, and keeps the owner's as the profile's face", async () => {
      expect(await setPicture(runtime, [1, 2, 3])).toBeUndefined();

      expect(await setPicture(open(visitor), [9, 9, 9, 9])).toMatch(
        OWNER_ONLY,
      );
      expect(await picture()).toEqual([1, 2, 3]);
      expect(await pictureWriter()).toBe(owner.did());
      expect(await faceShown()).toEqual({ picture: [1, 2, 3] });
    });

    it("refuses a visitor's blob, and keeps the owner's blob as the profile's face", async () => {
      expect(await setPicture(runtime, { blob: [1, 2, 3] })).toBeUndefined();

      expect(await setPicture(open(visitor), { blob: [9, 9, 9, 9] }))
        .toMatch(OWNER_ONLY);
      expect(await picture()).toEqual([1, 2, 3]);
      expect(await pictureWriter()).toBe(owner.did());
      expect(await faceShown()).toEqual({ picture: [1, 2, 3] });
    });

    it("holds the bytes an owner sends after a blob inline, and shows them as the profile's face", async () => {
      expect(await setPicture(runtime, { blob: [1, 2, 3] })).toBeUndefined();

      expect(await setPicture(runtime, [4, 5])).toBeUndefined();

      expect(await pictureField()).toBe("picture");
      expect(await picture()).toEqual([4, 5]);
      expect(await faceShown()).toEqual({ picture: [4, 5] });
    });

    it("refuses a reference that names no blob, and keeps the owner's picture", async () => {
      expect(await setPicture(runtime, { blob: [1, 2, 3] })).toBeUndefined();

      for (
        const reference of [
          { space: "space", id: "fid1:abc" },
          { space: profileSpace, id: "" },
        ]
      ) {
        expect(await setPicture(runtime, { reference })).toMatch(
          /named by its space's DID and its id there/,
        );
      }
      expect(await picture()).toEqual([1, 2, 3]);
    });

    it("refuses a visitor's clear, and keeps the owner's picture", async () => {
      expect(await setPicture(runtime, [1, 2, 3])).toBeUndefined();

      expect(await setPicture(open(visitor), "clear")).toMatch(
        OWNER_ONLY,
      );
      expect(await picture()).toEqual([1, 2, 3]);
    });

    it("refuses a write to the picture that does not go through its writer", async () => {
      const tx = runtime.edit();
      tx.writeValueOrThrow(
        profile.key("picture").resolveAsCell().getAsNormalizedFullLink(),
        new FabricBytes(new Uint8Array([7, 7])),
      );
      runtime.prepareTxForCommit(tx);

      expect((await tx.commit().settled).error?.message).toMatch(
        /missing schema write-policy/,
      );
      expect(await picture()).toEqual([]);
    });

    it("refuses a write to the picture's blob reference that does not go through its writer", async () => {
      const tx = runtime.edit();
      tx.writeValueOrThrow(
        profile.key("pictureBlob").resolveAsCell().getAsNormalizedFullLink(),
        { space: profileSpace, id: "fid1:elsewhere" },
      );
      runtime.prepareTxForCommit(tx);

      expect((await tx.commit().settled).error?.message).toMatch(
        /missing schema write-policy/,
      );
      expect(await pictureField()).toBe("picture");
    });

    it("credits no one, and shows no face, for a picture a client ignoring write policies redirects to one its owner set in another space", async () => {
      // The owner's own profile in another space, whose picture's blob
      // reference is labeled as the owner's.
      const elsewhere = await startProfile(owner, visitorSpace, current);
      expect(await setPicture(runtime, { blob: [5, 5, 5] }, elsewhere.profile))
        .toBeUndefined();
      await elsewhere.profile.pull();
      expect(
        representsPrincipalSubjects(
          cfcLabelViewForResolvedTarget(elsewhere.profile.key("pictureBlob"))
            ?.entries ?? [],
        ),
      ).toEqual([owner.did()]);

      // A visitor whose runtime ignores write policies points the owner's
      // picture's blob reference at that one.
      await writePastPolicy(
        elsewhere.profile.key("pictureBlob").resolveAsCell()
          .getAsWriteRedirectLink(),
        "pictureBlob",
      );
      expect(await picture()).toEqual([5, 5, 5]);

      expect(await pictureWriter()).toBeUndefined();
      expect(await faceShown()).toEqual({});
    });

    it("removes the picture once the owner clears it, and attests the owner's next one", async () => {
      expect(await setPicture(runtime, [1, 2, 3])).toBeUndefined();

      expect(await setPicture(runtime, "clear")).toBeUndefined();
      expect(await picture()).toEqual([]);
      expect(await faceShown()).toEqual({});

      expect(await setPicture(runtime, [4, 5])).toBeUndefined();
      expect(await picture()).toEqual([4, 5]);
      expect(await pictureBy()).toEqual([owner.did()]);
    });
  });
});
