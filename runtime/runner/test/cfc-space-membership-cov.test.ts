import { expect } from "@std/expect";
import {
  type AclDocumentSource,
  createRuntimeSpaceMembershipProvider,
} from "../src/cfc/space-membership.ts";
import { describe, it } from "@commonfabric/test-support/test";

const ALICE = "did:key:alice";
const SPACE_TEAM = "did:key:team-space";
const SERVICE = "did:web:commonfabric.org#runtime";

/** A runtime double that records each ACL document synced, by id. */
const syncingRuntime = () => {
  const synced: string[] = [];
  const runtime: AclDocumentSource = {
    getCellFromLink(link) {
      return {
        get: () => undefined,
        sink: () => () => {},
        sync() {
          synced.push(link.id);
          return Promise.resolve();
        },
      };
    },
  };
  return { runtime, synced };
};

describe("createRuntimeSpaceMembershipProvider()", () => {
  describe("load()", () => {
    it("syncs the space's ACL document for an ordinary principal", async () => {
      const { runtime, synced } = syncingRuntime();
      const provider = createRuntimeSpaceMembershipProvider(runtime, ALICE, [
        SERVICE,
      ]);

      await provider.load(SPACE_TEAM);

      expect(synced).toEqual([`of:${SPACE_TEAM}`]);
    });

    it("syncs nothing for a service principal, whose role reads no ACL", async () => {
      const { runtime, synced } = syncingRuntime();
      const provider = createRuntimeSpaceMembershipProvider(runtime, SERVICE, [
        SERVICE,
      ]);

      await provider.load(SPACE_TEAM);

      expect(synced).toEqual([]);
    });
  });
});
