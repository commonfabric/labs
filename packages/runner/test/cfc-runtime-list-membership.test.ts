import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { cfcAtom, type CfcListPosition } from "@commonfabric/api/cfc";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import {
  createRuntimeListMembershipProvider,
} from "../src/cfc/runtime-list-membership.ts";
import {
  setCfcImplementationIdentity,
  setCfcTrustSnapshot,
} from "../src/storage/extended-storage-transaction.ts";
import { parseLink } from "../src/link-utils.ts";
import type { MemorySpace, URI } from "../src/storage/interface.ts";

const alice = await Identity.fromPassphrase("runner-list-membership-alice");
const DANIEL = "did:key:daniel";
const EVE = "did:key:eve";

const writer = {
  __ctWriterIdentityOf: { file: "/share.tsx", path: ["share"] },
};

/**
 * A list field whose entries are labelled `[User(daniel) ∨ User(alice)]`. The
 * list position, and each entry, which the runtime stores as a document of
 * its own, may declare the share handler as their writer.
 */
const listSchema = (
  declaresWriter: boolean,
  entriesDeclareWriter = declaresWriter,
): JSONSchema => ({
  type: "object",
  properties: {
    liveList: {
      type: "array",
      items: {
        type: "object",
        properties: { principal: { type: "string" } },
        ifc: {
          confidentiality: [{
            anyOf: [cfcAtom.user(DANIEL), cfcAtom.user(alice.did())],
          }],
          ...(entriesDeclareWriter ? { writeAuthorizedBy: writer } : {}),
        },
      },
      ...(declaresWriter ? { ifc: { writeAuthorizedBy: writer } } : {}),
    },
  },
} as JSONSchema);

const withRuntime = async (
  body: (runtime: Runtime) => Promise<void>,
): Promise<void> => {
  const storageManager = StorageManager.emulate({ as: alice });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
    cfcEnforcementMode: "enforce-strict",
  });
  try {
    await body(runtime);
  } finally {
    await runtime.dispose();
    await storageManager.close();
  }
};

/** Writes `entries` under `schema` and returns the list's position. */
const writeList = async (
  runtime: Runtime,
  cause: string,
  schema: JSONSchema,
  entries: readonly string[],
): Promise<CfcListPosition> => {
  // Written as the share handler the list position declares as its writer.
  const tx = runtime.edit();
  tx.setCfcEnforcementMode("enforce-strict");
  setCfcTrustSnapshot(tx, { id: "trust-alice", actingPrincipal: alice.did() });
  setCfcImplementationIdentity(tx, {
    kind: "verified",
    moduleIdentity: "share-module",
    sourceFile: "/share.tsx",
    bindingPath: ["share"],
  });
  const cell = runtime.getCell(alice.did(), cause, schema, tx);
  cell.set({ liveList: entries.map((principal) => ({ principal })) });
  tx.prepareCfc();
  const { error } = await tx.commit().settled;
  if (error !== undefined) throw error;
  const link = cell.getAsNormalizedFullLink();
  return { space: link.space, id: link.id, path: ["liveList"] };
};

describe("createRuntimeListMembershipProvider (spec §4.9.5)", () => {
  it("lists a principal whose entry names them and admits them", async () => {
    await withRuntime(async (runtime) => {
      const list = await writeList(runtime, "listed", listSchema(true), [
        DANIEL,
        EVE,
      ]);
      expect(createRuntimeListMembershipProvider(runtime, DANIEL).listed(list))
        .toBe(true);
      // Eve's entry carries the label every entry does, which does not
      // admit her: seeing a release would tell her a bit she cannot read.
      expect(createRuntimeListMembershipProvider(runtime, EVE).listed(list))
        .toBe(false);
    });
  });

  it("lists nobody at a position that declares no writer", async () => {
    await withRuntime(async (runtime) => {
      const list = await writeList(runtime, "no-writer", listSchema(false), [
        DANIEL,
      ]);
      expect(createRuntimeListMembershipProvider(runtime, DANIEL).listed(list))
        .toBe(false);
    });
  });

  it("lists nobody through entries that declare no writer", async () => {
    // An entry the runtime stored as its own document answers to its own
    // schema; without a declared writer anyone who can address it could
    // rewrite who it names.
    await withRuntime(async (runtime) => {
      const list = await writeList(
        runtime,
        "unguarded-entries",
        listSchema(true, false),
        [DANIEL],
      );
      expect(createRuntimeListMembershipProvider(runtime, DANIEL).listed(list))
        .toBe(false);
    });
  });

  it("refuses a rewrite of an entry by a writer the entry does not declare", async () => {
    await withRuntime(async (runtime) => {
      const list = await writeList(runtime, "rewritten", listSchema(true), [
        DANIEL,
      ]);
      const tx = runtime.edit();
      tx.setCfcEnforcementMode("enforce-strict");
      setCfcTrustSnapshot(tx, { id: "trust-alice", actingPrincipal: alice.did() });
      setCfcImplementationIdentity(tx, {
        kind: "verified",
        moduleIdentity: "other-module",
        sourceFile: "/other.tsx",
        bindingPath: ["edit"],
      });
      const position = {
        space: list.space as MemorySpace,
        id: list.id as URI,
        path: [...list.path, "0"],
        scope: "space" as const,
      };
      const entry = parseLink(tx.readValueOrThrow(position), position);
      if (entry === undefined) throw new Error("the entry is not a link");
      runtime.getCellFromLink<{ principal: string }>(entry, undefined, tx)
        .key("principal").set(EVE);
      tx.prepareCfc();
      const { error } = await tx.commit().settled;
      expect(error).toBeDefined();
      expect(createRuntimeListMembershipProvider(runtime, DANIEL).listed(list))
        .toBe(true);
    });
  });

  it("lists nobody at an absent position", async () => {
    await withRuntime(async (runtime) => {
      await Promise.resolve();
      const missing = { space: alice.did(), id: "of:missing", path: ["x"] };
      expect(
        createRuntimeListMembershipProvider(runtime, DANIEL).listed(missing),
      ).toBe(false);
    });
  });

  it("follows a membership change", async () => {
    await withRuntime(async (runtime) => {
      const schema = listSchema(true);
      const list = await writeList(runtime, "changing", schema, [DANIEL]);
      const provider = createRuntimeListMembershipProvider(runtime, DANIEL);
      expect(provider.listed(list)).toBe(true);
      await writeList(runtime, "changing", schema, []);
      expect(provider.listed(list)).toBe(false);
    });
  });
});
