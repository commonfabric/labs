import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { FabricBytes } from "@commonfabric/data-model/fabric-primitives";
import { Identity } from "@commonfabric/identity";
import {
  type Cell,
  type IExtendedStorageTransaction,
  resolveEntryIdentity,
  Runtime,
  type Stream,
  systemPatternSource,
} from "@commonfabric/runner";
import {
  cfcLabelViewForCell,
  cfcLabelViewForResolvedTarget,
} from "@commonfabric/runner/cfc";
import { representsPrincipalSubjects } from "@commonfabric/runner/cfc/represents-principal";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import { EmulatedStorageManager } from "../../runner/src/storage/v2-emulate.ts";
import { newSharedServer } from "../../runner/test/memory-v2-test-utils.ts";

const owner = await Identity.fromPassphrase("profile picture owner");
const visitor = await Identity.fromPassphrase("profile picture visitor");
const profileSpace = (await Identity.fromPassphrase("profile picture space"))
  .did();
const route = "/api/patterns/system/profile-home.tsx";
// A complete profile source from before the profile had a `picture` field.
const previous = Deno.readTextFileSync(
  new URL("./fixtures/profile-home-dynamic-name.tsx.txt", import.meta.url),
);
const current = Deno.readTextFileSync(
  new URL("../../patterns/system/profile-home.tsx", import.meta.url),
);

/** The part of a profile these cases read and write. */
type Profile = {
  picture?: FabricBytes;
  setPicture: Stream<{ picture?: FabricBytes }>;
};

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

  /** A runtime acting as `identity` against the shared server. */
  const open = (identity: Identity): Runtime => {
    const runtime = new Runtime({
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

  /** Creates the owner's profile from `source`, as the served source. */
  const createProfile = async (source: string) => {
    await serve(source);
    runtime = open(owner);
    const tx = runtime.edit();
    const pattern = await runtime.patternManager.compilePattern({
      main: route,
      files: [{ name: route, contents: source }],
    }, { space: profileSpace, tx });
    profile = runtime.getCell<Profile>(profileSpace, "profile");
    runtime.runner.run(tx, pattern, { initialName: "Saved name" }, profile, {
      sourceOrigin: systemPatternSource("system/profile-home.tsx"),
    });
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit().settled).error).toBeUndefined();
    await profile.pull();
    await runtime.settled();
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
   * The principals the picture's own label says it represents: what vouches
   * for the bytes a reader shows as a face.
   */
  const pictureBy = async (): Promise<string[]> => {
    await runtime.settled();
    await profile.pull();
    return representsPrincipalSubjects(
      cfcLabelViewForResolvedTarget(profile.key("picture"))?.entries ?? [],
    );
  };

  const picture = async (): Promise<number[] | undefined> => {
    await runtime.settled();
    await profile.pull();
    const bytes = profile.key("picture").get();
    return bytes === undefined ? undefined : [...bytes.slice()];
  };

  /**
   * Sets the picture through the profile's own writer from `writer`, and
   * returns the message of the error its commit failed with, if it failed.
   */
  const setPicture = async (
    writer: Runtime,
    bytes: number[],
  ): Promise<string | undefined> => {
    const cell = writer.getCellFromLink<Profile>(
      profile.getAsNormalizedFullLink(),
    );
    await cell.sync();
    const settled = Promise.withResolvers<IExtendedStorageTransaction>();
    writer.scheduler.queueEvent(
      cell.key("setPicture").resolveAsCell().getAsNormalizedFullLink(),
      { picture: new FabricBytes(new Uint8Array(bytes)) },
      true,
      settled.resolve,
    );
    const status = (await settled.promise).status();
    await writer.settled();
    return status.status === "error" ? status.error.message : undefined;
  };

  beforeEach(() => {
    server = newSharedServer();
  });

  afterEach(async () => {
    for (const opening of opened.splice(0)) await opening.dispose();
    await server.close();
  });

  describe("on a profile created before the field existed", () => {
    beforeEach(async () => {
      await createProfile(previous);
      await updateSource(current);
    });

    it("attests the owner once the owner sets the picture", async () => {
      expect(await pictureBy()).toEqual([]);

      expect(await setPicture(runtime, [1, 2, 3])).toBeUndefined();
      expect(await picture()).toEqual([1, 2, 3]);
      expect(await pictureBy()).toEqual([owner.did()]);
    });

    it("attests the visitor, never the owner, for a picture a visitor sets over the owner's", async () => {
      expect(await setPicture(runtime, [1, 2, 3])).toBeUndefined();

      expect(await setPicture(open(visitor), [9, 9, 9, 9])).toBeUndefined();
      expect(await picture()).toEqual([9, 9, 9, 9]);
      expect(await pictureBy()).toEqual([visitor.did()]);
    });

    it("attests the owner again once the owner sets the picture after a visitor did", async () => {
      expect(await setPicture(open(visitor), [9, 9, 9, 9])).toBeUndefined();
      expect(await pictureBy()).toEqual([visitor.did()]);

      expect(await setPicture(runtime, [1, 2, 3])).toBeUndefined();
      expect(await picture()).toEqual([1, 2, 3]);
      expect(await pictureBy()).toEqual([owner.did()]);
    });

    it("attests the owner over a picture stored without a label once the owner sets it again", async () => {
      // A picture as a writer that brings no policy stores it: bytes, and
      // no label.
      const tx = runtime.edit();
      tx.writeValueOrThrow(
        profile.key("picture").resolveAsCell().getAsNormalizedFullLink(),
        new FabricBytes(new Uint8Array([7, 7])),
      );
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit().settled).error).toBeUndefined();
      expect(await picture()).toEqual([7, 7]);
      expect(await pictureBy()).toEqual([]);

      expect(await setPicture(runtime, [1, 2, 3])).toBeUndefined();
      expect(await picture()).toEqual([1, 2, 3]);
      expect(await pictureBy()).toEqual([owner.did()]);
    });
  });

  describe("on a profile created with the field", () => {
    beforeEach(async () => {
      await createProfile(current);
    });

    it("attests the visitor for a picture a visitor sets, whatever the profile's label says of the field", async () => {
      // The profile's own label claims the field for its creator, which says
      // nothing about who writes the bytes behind it.
      expect(
        representsPrincipalSubjects(
          (cfcLabelViewForCell(profile)?.entries ?? []).filter((entry) =>
            entry.path.length === 1 && entry.path[0] === "picture"
          ),
        ),
      ).toEqual([owner.did()]);

      expect(await setPicture(open(visitor), [9, 9, 9, 9])).toBeUndefined();
      expect(await pictureBy()).toEqual([visitor.did()]);
    });

    it("attests the owner once the owner sets the picture", async () => {
      expect(await setPicture(runtime, [1, 2, 3])).toBeUndefined();
      expect(await picture()).toEqual([1, 2, 3]);
      expect(await pictureBy()).toEqual([owner.did()]);
    });
  });
});
