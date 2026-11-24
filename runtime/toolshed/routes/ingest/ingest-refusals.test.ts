import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import {
  cellRuntime,
  type NormalizedLink,
  Runtime,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { linkRefPayloadToString } from "@commonfabric/runner/shared";
import {
  cellTargetOf,
  ClaimStoreFullError,
  generateIngestSecret,
  getRegistration,
  getRegistrationIndex,
  type IngestRegistration,
  journalCell,
  latestCell,
  parseWireCellLink,
  processIngest,
  recordLastSeen,
  requestClaim,
  saveRegistration,
} from "./ingest.utils.ts";

const signer = await Identity.fromPassphrase("ingest refusals test");
const space = signer.did();

describe("ingest.utils", () => {
  // The refusals and failures of the ingest registry and data plane, each
  // reached through the input or the stored state that produces it.

  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("https://ingest-refusals-test.invalid"),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime.dispose();
    await storageManager.close();
  });

  const device = (
    over: Partial<IngestRegistration> = {},
  ): IngestRegistration => ({
    id: "ing_refusals",
    name: "refusals",
    space,
    causePrefix: "location",
    installId: "install-1",
    kind: "device",
    secretHash: "unused",
    createdBy: space,
    createdAt: "2026-11-12T00:00:00.000Z",
    enabled: true,
    ...over,
  });

  describe("cellTargetOf()", () => {
    const link = (over: Partial<NormalizedLink>): NormalizedLink => ({
      id: "of:target",
      space,
      path: ["a", "b"],
      ...over,
    });

    it("returns the parts of a complete space-scoped link", () => {
      expect(cellTargetOf(link({ scope: "space" }))).toEqual({
        space,
        id: "of:target",
        path: ["a", "b"],
      });
    });

    it("throws for a link without a space or an id", () => {
      expect(() => cellTargetOf(link({ space: undefined }))).toThrow(
        "a target cell link must carry a space and an id",
      );
      expect(() => cellTargetOf(link({ id: undefined }))).toThrow(
        "a target cell link must carry a space and an id",
      );
    });

    it("throws for a link scoped other than to the space", () => {
      expect(() => cellTargetOf(link({ scope: "user" }))).toThrow(
        "a target cell must be space-scoped",
      );
    });
  });

  describe("parseWireCellLink()", () => {
    const wire = (payload: Record<string, unknown>) =>
      linkRefPayloadToString({ id: "of:target", space, ...payload });

    it("returns the link a wire string names", () => {
      expect(parseWireCellLink(wire({ path: ["a"] }))).toMatchObject({
        id: "of:target",
        space,
        path: ["a"],
      });
    });

    it("throws, naming the fault, for a payload that is not a target cell", () => {
      expect(() => parseWireCellLink(wire({ overwrite: "redirect" }))).toThrow(
        'a target cell link has no field "overwrite"',
      );
      expect(() => parseWireCellLink(wire({ id: "ba:target" }))).toThrow(
        "a target cell link names its document by an of: id",
      );
      expect(() => parseWireCellLink(wire({ space: [space] }))).toThrow(
        "a target cell link names its space",
      );
      expect(() => parseWireCellLink(wire({ path: "a/b" }))).toThrow(
        "a target cell link's path is a list of segments",
      );
      expect(() => parseWireCellLink(wire({ scope: "user" }))).toThrow(
        "a target cell must be space-scoped",
      );
    });
  });

  describe("journalCell()", () => {
    it("throws for a gmail channel, which has no journal", () => {
      expect(() =>
        journalCell(runtime, device({ kind: "gmail" }), "2026-11-12")
      ).toThrow(
        "channel ing_refusals is a gmail channel, not a device channel",
      );
    });
  });

  describe("latestCell()", () => {
    it("throws for a device channel, which has no target", () => {
      expect(() => latestCell(runtime, device())).toThrow(
        "channel ing_refusals is a device channel, not a gmail channel",
      );
    });
  });

  describe("saveRegistration()", () => {
    it("indexes a registration whose creation time does not parse", async () => {
      await saveRegistration(runtime, space, device({ createdAt: "garbage" }));
      expect(await getRegistrationIndex(runtime, space)).toEqual([
        "ing_refusals",
      ]);
    });

    it("throws `ClaimStoreFullError` once the owner's live claims fill the store, writing nothing", async () => {
      const now = Date.parse("2026-11-12T00:00:00.000Z");
      const claim = {
        owner: space,
        requestId: "req-new",
        channel: "ing_refusals",
        now,
      };
      const { cell } = requestClaim(runtime, space, claim);
      await cell.sync();
      const { error } = await cellRuntime(cell).editWithRetry((tx) => {
        cell.withTx(tx).set(
          Array.from({ length: 500 }, (_, i) => ({
            id: `req-${i}`,
            at: now,
            channel: `ing_${i}`,
          })),
        );
      });
      expect(error).toBeUndefined();

      await expect(
        saveRegistration(runtime, space, device(), null, claim),
      ).rejects.toThrow(ClaimStoreFullError);
      expect(await getRegistration(runtime, space, "ing_refusals")).toBe(null);
    });
  });

  describe("recordLastSeen()", () => {
    it("logs a failed write rather than throwing", async () => {
      const errors: string[] = [];
      await runtime.dispose();
      await recordLastSeen(runtime, space, "ing_refusals", {
        info: () => {},
        error: (_obj, msg) => errors.push(msg),
      });
      expect(errors).toEqual(["ingest: failed to bump last-seen"]);
    });
  });

  describe("processIngest()", () => {
    it("returns 502 when the records cannot be written", async () => {
      // A device channel stored without a cause prefix has no journal to
      // append to.

      const { secret, secretHash } = generateIngestSecret();
      await saveRegistration(
        runtime,
        space,
        device({ causePrefix: undefined, secretHash }),
      );
      const result = await processIngest(
        runtime,
        space,
        "ing_refusals",
        secret,
        JSON.stringify({ partition: "2026-11-12", records: [{ x: 1 }] }),
      );
      expect(result).toEqual({
        status: 502,
        body: { error: "Failed to write records" },
      });
    });
  });
});
