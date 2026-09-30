import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  fetchManifest,
  generatedAtOf,
  manifestObjectName,
  manifestPrefix,
  newestAtOrBefore,
  newestFirstAtOrBefore,
  selectionPrefix,
  stateDayOf,
  stateObjectName,
  statePrefix,
} from "./store.ts";
import {
  MANIFEST_SCHEMA_VERSION,
  SELECTION_AREA,
  serializeManifest,
} from "./manifest.ts";
import { sampleManifest } from "./testing.ts";

const NO_ENV = () => undefined;

/**
 * The area every manifest is in, whatever shape it was written in.
 *
 * Written out rather than built from `SELECTION_AREA`, so that moving
 * the area is a deliberate edit here as well. Every object the store
 * holds is under this one, and the publisher's identity cannot move
 * them, so a changed segment abandons the whole of it.
 */
const AREA = "labs/test-selection/v1";

/**
 * A fetch that answers a listing and one object, and nothing else.
 *
 * An object's creation time defaults to the moment its name carries, which
 * is the ordinary case where a publisher finished in the instant it
 * started. `createdAt` names the two apart for a test about the gap
 * between them, and a name mapped to undefined lists without a creation
 * time at all.
 */
function storeOf(
  objects: Record<string, Uint8Array | string>,
  createdAt: Record<string, string | undefined> = {},
): typeof fetch {
  return ((input: string | URL | Request) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname.endsWith("/o")) {
      const prefix = url.searchParams.get("prefix") ?? "";
      const items = Object.keys(objects)
        .filter((name) => name.startsWith(prefix))
        .map((name) => {
          const timeCreated = name in createdAt
            ? createdAt[name]
            : generatedAtOf(name);
          return timeCreated === undefined ? { name } : { name, timeCreated };
        });
      return Promise.resolve(
        new Response(JSON.stringify({ items }), { status: 200 }),
      );
    }
    const name = decodeURIComponent(
      url.pathname.split("/").slice(2).join("/"),
    );
    const body = objects[name];
    if (body === undefined) {
      return Promise.resolve(new Response("", { status: 404 }));
    }
    return Promise.resolve(
      new Response(body as BodyInit, { status: 200 }),
    );
  }) as typeof fetch;
}

describe("store", () => {
  describe("object names", () => {
    it("puts the manifest area beside the records area", () => {
      expect(selectionPrefix(NO_ENV)).toBe("labs/test-selection");
      expect(manifestPrefix(NO_ENV)).toBe(AREA);
      expect(statePrefix(NO_ENV)).toBe(`${AREA}/state`);
    });

    it("adds the version to the area the environment names", () => {
      // The infra root sets this to the dataset area, the way
      // TEST_RECORDS_PREFIX names `labs/test-records`, so a job and a
      // workstation have to agree on where the version segment comes
      // from or they write to two different layouts.
      const configured = (name: string) =>
        name === "TEST_SELECTION_PREFIX" ? "labs/test-selection" : undefined;
      expect(manifestPrefix(configured)).toBe(manifestPrefix(NO_ENV));
      expect(statePrefix(configured)).toBe(statePrefix(NO_ENV));
    });

    it("leads a manifest's name with its generation time", () => {
      const name = manifestObjectName(
        "2026-08-20T04:00:00.000Z",
        "01K3",
        NO_ENV,
      );
      expect(name).toBe(
        `${AREA}/manifest-2026-08-20T04:00:00.000Z-01K3.json.gz`,
      );
      expect(generatedAtOf(name)).toBe("2026-08-20T04:00:00.000Z");
    });

    it("leads a state object's name with its day", () => {
      const name = stateObjectName("2026-08-20", "01K3", NO_ENV);
      expect(name).toBe(`${AREA}/state/2026-08-20-01K3.json.gz`);
      expect(stateDayOf(name)).toBe("2026-08-20");
    });

    it("reads no generation time out of a name that is not one", () => {
      expect(generatedAtOf(`${AREA}/state/x.json.gz`))
        .toBeUndefined();
      expect(generatedAtOf("something-else")).toBeUndefined();
    });

    it("reads no day out of a name that is not a state object's", () => {
      // The publisher walks the state listing by the day each name
      // carries, so anything else under the prefix has to drop out of
      // that walk rather than sort into it. A listing has no folders in
      // it, so a name carrying one is an object among the states rather
      // than one of them.
      expect(stateDayOf(`${AREA}/state/x.json.gz`)).toBeUndefined();
      expect(stateDayOf(`${AREA}/state/held/2026-08-20-01K3.json.gz`))
        .toBeUndefined();
      expect(stateDayOf(`${AREA}/state/2026-08-20-.json.gz`)).toBeUndefined();
      expect(
        stateDayOf(
          manifestObjectName("2026-08-20T04:00:00.000Z", "01K3", NO_ENV),
        ),
      ).toBeUndefined();
    });
  });

  describe("newestFirstAtOrBefore()", () => {
    it("breaks a tie on the name by code point, not by locale", () => {
      // Every reader orders a name the same way, and a locale's order is
      // not that: two manifests created in one millisecond would leave a
      // lane and the dashboard obeying different ones. A locale collation
      // sorts a capital after the small letter it matches, where a code
      // point puts every capital first.
      const createdAt = "2026-08-20T04:00:00.000Z";
      const upper = `${AREA}/manifest-${createdAt}-Z.json.gz`;
      const lower = `${AREA}/manifest-${createdAt}-a.json.gz`;
      expect("Z".localeCompare("a")).toBeGreaterThan(0);
      expect(newestFirstAtOrBefore(
        [{ name: upper, createdAt }, { name: lower, createdAt }],
        "2026-08-20T05:00:00.000Z",
      )).toEqual([lower, upper]);
    });
  });

  describe("newestAtOrBefore()", () => {
    /** A listing whose objects were created at the moment they name. */
    const listed = (...names: string[]) =>
      names.map((name) => ({
        name,
        createdAt: generatedAtOf(name) ?? "2026-08-20T00:00:00.000Z",
      }));
    const names = listed(
      "p/manifest-2026-08-20T00:00:00.000Z-a.json.gz",
      "p/manifest-2026-08-20T04:00:00.000Z-b.json.gz",
      "p/manifest-2026-08-20T08:00:00.000Z-c.json.gz",
      "p/state/2026-08-20-d.json.gz",
    );

    it("takes the newest that is not after the moment asked about", () => {
      expect(newestAtOrBefore(names, "2026-08-20T05:00:00.000Z")).toBe(
        "p/manifest-2026-08-20T04:00:00.000Z-b.json.gz",
      );
    });

    it("gives a re-run the same answer as the run it replaces", () => {
      const at = "2026-08-20T05:00:00.000Z";
      const later = [
        ...names,
        ...listed("p/manifest-2026-08-20T12:00:00.000Z-e.json.gz"),
      ];
      expect(newestAtOrBefore(later, at)).toBe(newestAtOrBefore(names, at));
    });

    it("returns undefined when every manifest is newer", () => {
      expect(newestAtOrBefore(names, "2026-08-19T00:00:00.000Z"))
        .toBeUndefined();
    });

    it("passes over a manifest the store had not created yet", () => {
      // A publisher names its manifest when it starts and creates the
      // object when it finishes. A run whose commit falls in that gap must
      // not resolve the manifest on one listing and miss it on another,
      // which is what ordering on the name would do.
      const at = "2026-08-20T08:30:00.000Z";
      const building = {
        name: "p/manifest-2026-08-20T08:17:00.000Z-e.json.gz",
        createdAt: "2026-08-20T08:47:00.000Z",
      };
      expect(newestAtOrBefore([...names, building], at))
        .toBe(newestAtOrBefore(names, at));
    });
  });

  describe("fetchManifest()", () => {
    /**
     * A store that lists one manifest and answers for the object itself
     * however the caller says. The listing has to succeed for the reader
     * to reach the object at all.
     */
    const listingOnly = (answer: () => Promise<Response>): typeof fetch =>
      ((input: string | URL | Request) => {
        const url = new URL(
          String(input instanceof Request ? input.url : input),
        );
        if (!url.pathname.endsWith("/o")) return answer();
        const items = [{
          name: `${AREA}/manifest-2026-08-20T04:00:00.000Z-b.json.gz`,
          timeCreated: "2026-08-20T04:00:00.000Z",
        }];
        return Promise.resolve(
          new Response(JSON.stringify({ items }), { status: 200 }),
        );
      }) as typeof fetch;

    it("reads the area every stored object is under", () => {
      expect(`labs/test-selection/${SELECTION_AREA}`).toBe(AREA);
    });

    const at = "2026-08-20T05:00:00.000Z";
    const name = `${AREA}/manifest-2026-08-20T04:00:00.000Z-b.json.gz`;

    it("returns the newest manifest at or before the moment", async () => {
      const manifest = sampleManifest();
      const found = await fetchManifest({
        at,
        env: NO_ENV,
        fetch: storeOf({ [name]: serializeManifest(manifest) }),
      });
      expect(found.objectName).toBe(name);
      expect(found.manifest).toEqual(manifest);
    });

    it("reports an absent manifest rather than throwing", async () => {
      const found = await fetchManifest({
        at,
        env: NO_ENV,
        fetch: storeOf({}),
      });
      expect(found.manifest).toBeUndefined();
      expect(found.absent).toContain("no manifest");
      // The store answered, and it answers every lane the same way.
      expect(found.unreachable).toBeUndefined();
    });

    it("takes the newest manifest written in a shape it reads", async () => {
      // A manifest published after a change to what one holds is ahead
      // of a lane that has not been deployed since. Taking none would
      // make the whole corpus mandatory, where the one before it costs
      // a figure some hours old.
      const older = `${AREA}/manifest-2026-08-20T03:00:00.000Z-a.json.gz`;
      const ahead = JSON.parse(serializeManifest(sampleManifest()));
      ahead.schema = MANIFEST_SCHEMA_VERSION + 1;
      const found = await fetchManifest({
        at,
        env: NO_ENV,
        fetch: storeOf({
          [older]: serializeManifest(sampleManifest()),
          [name]: JSON.stringify(ahead),
        }),
      });
      expect(found.objectName).toBe(older);
      expect(found.manifest).toBeDefined();
    });

    it("reports nothing when every manifest it reads is ahead of it", async () => {
      const ahead = JSON.parse(serializeManifest(sampleManifest()));
      ahead.schema = MANIFEST_SCHEMA_VERSION + 1;
      const found = await fetchManifest({
        at,
        env: NO_ENV,
        fetch: storeOf({ [name]: JSON.stringify(ahead) }),
      });
      expect(found.manifest).toBeUndefined();
      expect(found.absent).toContain("newer shape");
      expect(found.unreachable).toBeUndefined();
    });

    it("stops at a corrupt manifest rather than taking the one before it", async () => {
      // Being behind the publisher and reading a store nobody should be
      // reporting from are different, and only the first is a reason to
      // answer with an older figure.
      const older = `${AREA}/manifest-2026-08-20T03:00:00.000Z-a.json.gz`;
      const found = await fetchManifest({
        at,
        env: NO_ENV,
        fetch: storeOf({
          [older]: serializeManifest(sampleManifest()),
          [name]: "{not a manifest",
        }),
      });
      expect(found.manifest).toBeUndefined();
      expect(found.objectName).toBe(name);
    });

    it("treats a malformed manifest as absent", async () => {
      const found = await fetchManifest({
        at,
        env: NO_ENV,
        fetch: storeOf({ [name]: "{not a manifest" }),
      });
      expect(found.manifest).toBeUndefined();
      expect(found.absent).toContain("not a manifest this reader understands");
      expect(found.unreachable).toBeUndefined();
    });

    it("ignores a manifest created after the moment it is asked about", async () => {
      // The whole listing is visible to a lane that lists late enough;
      // what keeps every lane and every attempt on one manifest is that a
      // manifest created after the commit is never eligible.
      const building = `${AREA}/manifest-2026-08-20T04:30:00.000Z-c.json.gz`;
      const manifest = sampleManifest();
      const found = await fetchManifest({
        at,
        env: NO_ENV,
        fetch: storeOf({
          [name]: serializeManifest(manifest),
          [building]: serializeManifest(manifest),
        }, { [building]: "2026-08-20T06:00:00.000Z" }),
      });
      expect(found.objectName).toBe(name);
    });

    for (
      const [what, timeCreated] of [
        ["says nothing about a creation time", undefined],
        ["gives an empty creation time", ""],
        ["gives an unparseable creation time", "the other day"],
      ] as const
    ) {
      it(`marks a listing that ${what} as unreachable`, async () => {
        // Any of these would order the resolution by a key that means
        // nothing, so the listing fails rather than the lane obeying a
        // manifest it picked by accident. A listing that did not answer
        // the question asked is a store that could not be asked.
        const found = await fetchManifest({
          at,
          env: NO_ENV,
          fetch: storeOf(
            { [name]: serializeManifest(sampleManifest()) },
            { [name]: timeCreated },
          ),
        });
        expect(found.manifest).toBeUndefined();
        expect(found.absent).toContain("no usable creation time");
        expect(found.unreachable).toBe(true);
      });
    }

    it("reports an object the listing named and the store would not give", async () => {
      // A manifest deleted between the listing and the read looks like
      // this. Every way a fetch can go wrong ends as no manifest with a
      // sentence saying so, rather than as an exception, and is marked as
      // a store that could not be asked, which one lane can meet and the
      // next need not.
      const found = await fetchManifest({
        at,
        env: NO_ENV,
        fetch: listingOnly(() =>
          Promise.resolve(new Response("", { status: 404 }))
        ),
      });
      expect(found.manifest).toBeUndefined();
      expect(found.absent).toContain("HTTP 404");
      expect(found.unreachable).toBe(true);
    });

    it("reports a read of one object that threw", async () => {
      const found = await fetchManifest({
        at,
        env: NO_ENV,
        fetch: listingOnly(() => Promise.reject(new Error("connection lost"))),
      });
      expect(found.manifest).toBeUndefined();
      expect(found.absent).toContain("connection lost");
      expect(found.unreachable).toBe(true);
    });

    it("marks a store whose listing threw as unreachable", async () => {
      const found = await fetchManifest({
        at,
        env: NO_ENV,
        fetch: (() => Promise.reject(new Error("no network"))) as typeof fetch,
      });
      expect(found.manifest).toBeUndefined();
      expect(found.absent).toContain("no network");
      expect(found.unreachable).toBe(true);
    });
  });
});
