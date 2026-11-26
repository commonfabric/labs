import { expect } from "@std/expect";
import { fromFileUrl } from "@std/path";

import {
  collectedMemory,
  exposeGarbageCollector,
} from "../src/collected-memory.ts";
import {
  startHeapSampling,
  writeThreadHeapProfile,
} from "../src/heap-profile.ts";
import { describe, it } from "@commonfabric/test-support/test";

type ProfileNode = {
  callFrame: { functionName: string };
  selfSize: number;
  children: ProfileNode[];
};

/** The bytes the profile attributes to each function, summed over its nodes. */
function bytesByFunction(head: ProfileNode): Map<string, number> {
  const bytes = new Map<string, number>();
  const walk = (node: ProfileNode) => {
    const name = node.callFrame.functionName;
    bytes.set(name, (bytes.get(name) ?? 0) + node.selfSize);
    node.children.forEach(walk);
  };
  walk(head);
  return bytes;
}

const COUNT = 400_000;

function allocatesWhatItKeeps(): unknown[] {
  const kept: unknown[] = [];
  for (let i = 0; i < COUNT; i++) kept.push({ i, s: `kept ${i}` });
  return kept;
}

function allocatesWhatItReleases(): number {
  let released: unknown[] = [];
  for (let i = 0; i < COUNT; i++) released.push({ i, s: `released ${i}` });
  const count = released.length;
  released = [];
  return count + released.length;
}

describe("heap-profile", () => {
  it("attributes the live heap to the function that allocated it, and not what was collected", async () => {
    exposeGarbageCollector();
    const directory = await Deno.makeTempDir({ prefix: "heap-profile-" });
    try {
      await startHeapSampling();
      const kept = allocatesWhatItKeeps();
      expect(allocatesWhatItReleases()).toBe(COUNT);
      collectedMemory();

      const path = await writeThreadHeapProfile(directory, "test");
      expect(path.startsWith(`${directory}/heap-${Deno.pid}-test-`)).toBe(true);
      expect(path.endsWith(".heapprofile")).toBe(true);
      expect((await Deno.stat(path)).mode! & 0o777).toBe(0o600);

      const bytes = bytesByFunction(
        JSON.parse(await Deno.readTextFile(path)).head,
      );
      // About 400,000 objects and strings, sampled about every 512 KiB.
      expect(bytes.get("allocatesWhatItKeeps") ?? 0).toBeGreaterThan(
        8 * 1024 * 1024,
      );
      expect(bytes.get("allocatesWhatItReleases") ?? 0).toBeLessThan(
        (bytes.get("allocatesWhatItKeeps") ?? 0) / 4,
      );
      expect(kept.length).toBe(COUNT);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("serves on where sampling cannot start, as without sys access, and its profile request says why", async () => {
    const directory = await Deno.makeTempDir({ prefix: "heap-profile-" });
    try {
      const script = new URL(
        "./support/heap-profile-without-sys.ts",
        import.meta.url,
      );
      const { code, stdout } = await new Deno.Command(Deno.execPath(), {
        args: [
          "run",
          "--no-lock",
          "--no-check",
          "--allow-read",
          `--allow-write=${directory}`,
          fromFileUrl(script),
          directory,
        ],
        stdout: "piped",
        stderr: "inherit",
      }).output();
      const lines = new TextDecoder().decode(stdout).trim().split("\n");
      expect(code).toBe(0);
      expect(lines[0]).toBe("started without rejecting");
      expect(lines[1]).toContain("heap sampling could not start");
      expect(lines[1]).toContain("inspector");
      expect([...Deno.readDirSync(directory)]).toEqual([]);
    } finally {
      await Deno.remove(directory, { recursive: true });
    }
  });

  it("refuses to write the profile of a thread that never started sampling", async () => {
    const directory = await Deno.makeTempDir({ prefix: "heap-profile-" });
    const module = new URL(
      "./support/heap-profile-unstarted-worker.ts",
      import.meta.url,
    );
    module.searchParams.set("directory", directory);
    const worker = new Worker(module, { type: "module" });
    try {
      const answer = await new Promise<unknown>((resolve) => {
        worker.onmessage = (event) => resolve(event.data);
      });
      expect(String(answer)).toContain("heap sampling was never started");
      expect([...Deno.readDirSync(directory)]).toEqual([]);
    } finally {
      worker.terminate();
      await Deno.remove(directory, { recursive: true });
    }
  });
});
