import { expect } from "@std/expect";
import { fromFileUrl, join } from "@std/path";
import { Identity } from "@commonfabric/identity";
import { Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { runDenoCommandWithTemporaryLock } from "@commonfabric/test-support/isolated-deno";
import {
  afterEach,
  beforeEach,
  describe,
  it,
} from "@commonfabric/test-support/test";
import {
  channelId,
  getRegistrationIndex,
  registrationCell,
} from "@/routes/ingest/ingest.utils.ts";
import { main } from "./audit-ingest-channels.ts";

const toolshed = fromFileUrl(new URL("../", import.meta.url));
const root = join(toolshed, "../..");
const decoder = new TextDecoder();

const space = "did:key:z6MkspaceAAAA";
const installId = "lost-phone";
const MALFORMED = "# provisioned\ndid:key:zOnlyASpace\n";
const REFUSAL = "--recover expects '<space-did> <install-id>' per line, got: " +
  "did:key:zOnlyASpace";

describe("audit-ingest-channels", () => {
  describe("main()", () => {
    let dir: string;
    let record: string;

    beforeEach(async () => {
      dir = await Deno.makeTempDir({ prefix: "audit-ingest-channels-" });
      record = join(dir, "known.txt");
    });

    afterEach(async () => {
      await Deno.remove(dir, { recursive: true });
    });

    /**
     * Runs `main` with a runtime factory that fails the test if called, and
     * records what it printed.
     */
    const refused = async (args: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(
        args,
        () => {
          throw new Error("a usage error must not construct a runtime");
        },
        "did:key:zService",
        (line) => out.push(line),
        (line) => err.push(line),
      );
      return { code, out, err };
    };

    it("refuses a malformed recovery record before constructing a runtime", async () => {
      await Deno.writeTextFile(record, MALFORMED);
      expect(await refused(["--recover", record])).toEqual({
        code: 2,
        out: [],
        err: [`Error: ${REFUSAL}`],
      });
    });

    it("refuses a recovery record it cannot read before constructing a runtime", async () => {
      const { code, out, err } = await refused([
        "--recover",
        join(dir, "missing.txt"),
      ]);
      expect(code).toBe(2);
      expect(out).toEqual([]);
      expect(err.join("\n")).toContain("missing.txt");
    });

    it("audits the channels a well-formed recovery record names", async () => {
      const signer = await Identity.fromPassphrase("audit-main-test");
      const serviceSpace = signer.did();
      const id = channelId(space, installId);
      const storageManagers: ReturnType<typeof StorageManager.emulate>[] = [];

      /**
       * A runtime whose service space holds a live registration and no index
       * entry for it, so only the recovery record can lead the audit to it.
       */
      const seeded = async (): Promise<Runtime> => {
        const storageManager = StorageManager.emulate({ as: signer });
        storageManagers.push(storageManager);
        const runtime = new Runtime({
          apiUrl: new URL("https://audit-main-test.invalid"),
          storageManager,
        });
        const cell = registrationCell(runtime, serviceSpace, id);
        await cell.sync();
        await storageManager.synced();
        const written = await runtime.editWithRetry((tx) =>
          cell.withTx(tx).set({
            id,
            name: "lost",
            space,
            causePrefix: "location",
            installId,
            kind: "device",
            secretHash: "hash",
            createdBy: serviceSpace,
            createdAt: "2026-08-01T00:00:00.000Z",
            enabled: true,
          })
        );
        expect(written.error).toBeUndefined();
        expect(await getRegistrationIndex(runtime, serviceSpace)).toEqual([]);
        return runtime;
      };

      const auditedIds = async (args: string[]) => {
        const runtime = await seeded();
        const out: string[] = [];
        const code = await main(
          args,
          () => runtime,
          serviceSpace,
          (line) => out.push(line),
          (line) => out.push(line),
        );
        expect(code).toBe(0);
        const { channels }: { channels: { id: string }[] } = JSON.parse(
          out.join("\n"),
        );
        return channels.map((channel) => channel.id);
      };

      try {
        await Deno.writeTextFile(record, `${space} ${installId}\n`);
        expect(await auditedIds(["--json", "--recover", record])).toEqual([id]);
        expect(await auditedIds(["--json"])).toEqual([]);
      } finally {
        for (const storageManager of storageManagers) {
          await storageManager.close();
        }
      }
    });
  });

  describe("as a program", () => {
    it("exits with status 2 and the reason when the recovery record is malformed", async () => {
      // The recovery record is read before any runtime exists, so this run
      // reaches no memory server.
      const dir = await Deno.makeTempDir({ prefix: "audit-ingest-channels-" });
      try {
        const record = join(dir, "known.txt");
        await Deno.writeTextFile(record, MALFORMED);

        const output = await runDenoCommandWithTemporaryLock({
          root,
          cwd: toolshed,
          args: (lock) => [
            "run",
            "-A",
            `--lock=${lock}`,
            "--env-file=.env.test",
            "scripts/audit-ingest-channels.ts",
            "--recover",
            record,
          ],
        });

        expect(output.code).toBe(2);
        expect(decoder.decode(output.stdout)).not.toContain("Ingest channels");
        expect(decoder.decode(output.stderr)).toContain(REFUSAL);
      } finally {
        await Deno.remove(dir, { recursive: true });
      }
    });
  });
});
