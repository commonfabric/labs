import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import type { SessionSync } from "@commonfabric/memory/v2";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import type { MemorySpace, URI } from "../src/storage/interface.ts";
import type { SpaceReplica } from "../src/storage/v2.ts";
import { newSpaceReplica } from "./memory-v2-test-utils.ts";
import { type CapturedLogs, captureLogs } from "./support/captured-logs.ts";

const signer = await Identity.fromPassphrase("storage-v2 cfc hydration cov");
const space: MemorySpace = signer.did();
const doc = "of:storage-v2-cfc-hydration-doc" as URI;
const hash = "storage-v2-cfc-hydration-unregistered-schema";

/** A frame carrying `doc` with an envelope naming the schema `hash`. */
const frame: SessionSync = {
  type: "sync",
  fromSeq: 0,
  toSeq: 1,
  removes: [],
  upserts: [{
    id: doc,
    branch: "",
    seq: 1,
    doc: { value: { n: 1 }, cfc: { schemaHash: hash } },
  }],
};

describe("storage/v2", () => {
  let logs: CapturedLogs;
  let replica: SpaceReplica | undefined;

  beforeEach(() => {
    logs = captureLogs("storage.v2");
  });

  afterEach(() => {
    replica?.closeNow();
    replica = undefined;
    logs[Symbol.dispose]();
  });

  /** A replica whose pulls `sync` answers, with no session. */
  const replicaPulling = (sync: SpaceReplica["sync"]): SpaceReplica => {
    const created = newSpaceReplica({
      as: signer,
      space,
      createSession: () => Promise.reject(new Error("no session")),
    });
    created.sync = sync;
    return created;
  };

  it("logs a pull of a schema document arrived metadata names that throws, and pulls it again for the next frame", async () => {
    const asked: string[] = [];
    const second = Promise.withResolvers<void>();
    replica = replicaPulling((uri) => {
      asked.push(uri);
      if (asked.length === 2) second.resolve();
      return Promise.reject(new Error("the pull threw"));
    });

    replica.accessForTestingOnly.hydrateArrivedCfcSchemaRefs(frame);
    expect((await logs.first("cfc-schema-hydration-failed")).text).toContain(
      "arrived-metadata document pull threw; a later frame carrying the " +
        "reference re-kicks",
    );
    expect(logs.messagesOf("cfc-schema-hydration-failed")).toEqual([[
      expect.anything(),
      { hash, error: "Error: the pull threw" },
    ]]);
    expect(asked).toEqual([`cid:${hash}`]);

    replica.accessForTestingOnly.hydrateArrivedCfcSchemaRefs(frame);
    await second.promise;
    expect(asked).toEqual([`cid:${hash}`, `cid:${hash}`]);
  });

  it("pulls a schema document once for frames that arrive while its pull is outstanding, and again for a frame after the pull completes empty", async () => {
    const asked: string[] = [];
    const pulled = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<{ ok: Record<never, never> }>();
    replica = replicaPulling((uri) => {
      asked.push(uri);
      pulled.resolve();
      return answer.promise;
    });
    // A pull is queued as a microtask, so one queued after a frame runs after
    // any pull that frame queued.
    const pullsQueued = () =>
      new Promise<void>((resolve) => queueMicrotask(resolve));

    replica.accessForTestingOnly.hydrateArrivedCfcSchemaRefs(frame);
    await pulled.promise;
    replica.accessForTestingOnly.hydrateArrivedCfcSchemaRefs(frame);
    await pullsQueued();
    expect(asked).toEqual([`cid:${hash}`]);

    answer.resolve({ ok: {} });
    await answer.promise;
    expect(logs.textsOf("cfc-schema-hydration-failed")).toEqual([]);
    replica.accessForTestingOnly.hydrateArrivedCfcSchemaRefs(frame);
    await pullsQueued();
    expect(asked).toEqual([`cid:${hash}`, `cid:${hash}`]);
  });
});
