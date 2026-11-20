import { expect } from "@std/expect";
import { join } from "@std/path";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import {
  buildMountStatusRows,
  reportUnmount,
  runUnmount,
  systemUnmountCommand,
  verifyIsFuseProcess,
} from "../commands/fuse.ts";
import type { MountStateEntry, MountTableState } from "../lib/fuse.ts";

const MOUNTPOINT = "/tmp/fuse-unmount";

function entry(overrides: Partial<MountStateEntry> = {}): MountStateEntry {
  return {
    pid: 4242,
    mountpoint: MOUNTPOINT,
    apiUrl: "",
    identity: "",
    startedAt: "2026-03-17T00:00:00.000Z",
    ...overrides,
  };
}

/** A `ps` stand-in that prints `command` as the PID's command line. */
function psPrinting(command: string): Pick<Deno.Command, "output"> {
  return {
    output: () =>
      Promise.resolve({
        code: 0,
        success: true,
        signal: null,
        stdout: new TextEncoder().encode(`${command}\n`),
        stderr: new Uint8Array(),
      }),
  };
}

describe("fuse-unmount-and-status", () => {
  describe("reportUnmount", () => {
    function deps(tableStates: MountTableState[]) {
      const logs: string[] = [];
      const exits: number[] = [];
      return {
        logs,
        exits,
        deps: {
          readMountState: () => Promise.resolve(null),
          isMountpointInTable: () =>
            Promise.resolve(tableStates.shift() ?? "absent"),
          systemUnmount: () => Promise.resolve({ code: 0, stderr: "" }),
          log: (message: string) => logs.push(message),
          exit: (code: number) => {
            exits.push(code);
          },
        },
      };
    }

    it("prints the unmounted mountpoint and does not exit when the mount is gone", async () => {
      const h = deps(["absent", "absent"]);
      await reportUnmount(MOUNTPOINT, h.deps);
      expect(h.logs).toEqual([`Unmounted ${MOUNTPOINT}`]);
      expect(h.exits).toEqual([]);
    });

    it("prints the force-unmount hint and exits with status 1 when the mount survives", async () => {
      const h = deps(["present", "present"]);
      await reportUnmount(MOUNTPOINT, h.deps);
      expect(h.logs.at(-1)).toBe(
        `${MOUNTPOINT} is still mounted. Try: sudo umount -f ${MOUNTPOINT}`,
      );
      expect(h.exits).toEqual([1]);
    });
  });

  describe("runUnmount", () => {
    it("proceeds to the system unmount when the verified FUSE process is gone before the signal", async () => {
      const killed: number[] = [];
      const unmounted: string[] = [];
      const tableStates: MountTableState[] = ["present", "absent"];
      const result = await runUnmount(MOUNTPOINT, {
        readMountState: () =>
          Promise.resolve({ entry: entry(), path: "/state.json" }),
        isAlive: () => true,
        verifyIsFuseProcess: () => Promise.resolve(true),
        kill: (pid) => {
          killed.push(pid);
          throw new Deno.errors.NotFound("no such process");
        },
        isMountpointInTable: () =>
          Promise.resolve(tableStates.shift() ?? "absent"),
        systemUnmount: (mountpoint) => {
          unmounted.push(mountpoint);
          return Promise.resolve({ code: 0, stderr: "" });
        },
        removeMountStateFile: () => Promise.resolve(),
        log: () => {},
      });
      expect(killed).toEqual([4242]);
      expect(unmounted).toEqual([MOUNTPOINT]);
      expect(result).toEqual({ ok: true, message: `Unmounted ${MOUNTPOINT}` });
    });
  });

  describe("verifyIsFuseProcess", () => {
    it("returns true for a FUSE daemon or supervisor command line", async () => {
      expect(
        await verifyIsFuseProcess(
          1,
          psPrinting("deno run --allow-ffi /repo/runtime/fuse/mod.ts /mnt"),
        ),
      ).toBe(true);
      expect(
        await verifyIsFuseProcess(1, psPrinting("/opt/bin/cf fuse-supervisor")),
      ).toBe(true);
    });

    it("returns false for an unrelated command line", async () => {
      expect(await verifyIsFuseProcess(1, psPrinting("/usr/bin/vim notes")))
        .toBe(false);
    });

    it("returns false when ps cannot run", async () => {
      expect(
        await verifyIsFuseProcess(1, {
          output: () => Promise.reject(new Deno.errors.NotFound("ps")),
        }),
      ).toBe(false);
    });

    it("returns false for a live process that ps reports as not a FUSE process", async () => {
      // `cat` blocks on its open stdin, so it stays alive for the lookup and
      // exits once stdin closes.
      const child = new Deno.Command("cat", { stdin: "piped" }).spawn();
      try {
        expect(await verifyIsFuseProcess(child.pid)).toBe(false);
      } finally {
        await child.stdin.close();
        await child.status;
      }
    });
  });

  describe("systemUnmountCommand", () => {
    it("returns umount on darwin", () => {
      expect(systemUnmountCommand("/mnt/x", "darwin")).toEqual({
        command: "umount",
        args: ["/mnt/x"],
      });
    });

    it("returns fusermount3 -u on linux", () => {
      expect(systemUnmountCommand("/mnt/x", "linux")).toEqual({
        command: "fusermount3",
        args: ["-u", "/mnt/x"],
      });
    });
  });

  describe("buildMountStatusRows", () => {
    let tmp: string;

    beforeEach(async () => {
      tmp = await Deno.makeTempDir({ prefix: "fuse-status-" });
    });

    afterEach(async () => {
      await Deno.remove(tmp, { recursive: true });
    });

    async function statusFor(childStatusPath: string): Promise<string> {
      const [row] = await buildMountStatusRows(
        [{ entry: entry({ childStatusPath }), path: join(tmp, "state.json") }],
        {
          isMountStateAlive: () => true,
          isMountpointInTable: () => Promise.resolve("present"),
        },
      );
      return row[3];
    }

    it("reports unknown for a status file that is missing or unparseable", async () => {
      expect(await statusFor(join(tmp, "missing"))).toBe("unknown");
      const garbled = join(tmp, "garbled");
      await Deno.writeTextFile(garbled, JSON.stringify({ state: "bogus" }));
      expect(await statusFor(garbled)).toBe("unknown");
    });
  });
});
