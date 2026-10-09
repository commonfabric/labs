/**
 * FabriChat's rooms under an enforced access list, across runtimes and under
 * either server-execution posture: a manager creates each room in a space of
 * its own and joins its user to it, and the room's members, and no one else,
 * can read it, unless it is a group made joinable by its link, which anyone
 * can read.
 *
 * Three sessions share the harness's space, where the manager lives: the
 * starter, who creates the rooms; a member, named in each; and a stranger,
 * named in none. A room's space grants its members at creation, so the member
 * reads it with nothing more to do, and the stranger's read is refused, except
 * of a joinable group's.
 * `fabrichat-manager.test.ts` checks the access list each room's space holds.
 *
 * No toolshed or browser required (Deno workers + in-process storage server).
 */

import { afterAll, beforeAll, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { join } from "@std/path";
import type { FabricValue } from "@commonfabric/data-model";
import {
  MultiRuntimeHarness,
  type MultiRuntimeSession,
  type PieceAddress,
} from "./multi-runtime-harness.ts";

const PROGRAM_PATH = join(
  import.meta.dirname!,
  "fixtures",
  "fabrichat-spaces",
  "main.tsx",
);
const ROOT_PATH = join(import.meta.dirname!, "..");

// The reviewed action a start is admitted from, as
// `../fabrichat/schemas.tsx` names it.
const START_ACTION = { surface: "ChatStartSurface", action: "ChatStart" };

// The reviewed action a member is added from, as `../fabrichat/schemas.tsx`
// names it.
const ADD_MEMBER_ACTION = {
  surface: "ChatAddMemberSurface",
  action: "ChatAddMember",
};

// PROBE (CI lane-1 stall, not for merge): the host's load, CPU accounting and
// pressure, and this process's threads, once a second, beside the workers'
// own samples.
function probeLog(text: string): void {
  console.log(`L1PROBE at=${Date.now()} w=main ${text}`);
}

function probeRead(path: string): string | undefined {
  try {
    return Deno.readTextFileSync(path);
  } catch {
    return undefined;
  }
}

function probeEnvironment(): void {
  const cpuinfo = probeRead("/proc/cpuinfo") ?? "";
  const field = (name: string) =>
    cpuinfo.match(new RegExp(`^${name}\\s*:\\s*(.*)$`, "m"))?.[1];
  const env = [
    "RUNNER_NAME",
    "RUNNER_OS",
    "RUNNER_ARCH",
    "RUNNER_ENVIRONMENT",
    "ImageOS",
    "ImageVersion",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_ATTEMPT",
    "GITHUB_JOB",
  ].map((name) => `${name}=${Deno.env.get(name) ?? "-"}`).join(" ");
  probeLog(
    `env cores=${navigator.hardwareConcurrency} cpu="${field("model name")}" ` +
      `mhz=${field("cpu MHz")} flags-hypervisor=${
        /\bhypervisor\b/.test(field("flags") ?? "")
      } mem="${
        probeRead("/proc/meminfo")?.match(/^MemTotal:\s*(.*)$/m)?.[1]
      }" os=${Deno.osRelease()} host=${Deno.hostname()} vendor="${
        probeRead("/sys/class/dmi/id/sys_vendor")?.trim()
      }" product="${probeRead("/sys/class/dmi/id/product_name")?.trim()}" ` +
      `cgroup-cpu.max="${probeRead("/sys/fs/cgroup/cpu.max")?.trim()}" ${env}`,
  );
}

function probeCpuLine(): number[] | undefined {
  const line = probeRead("/proc/stat")?.split("\n")[0];
  return line?.split(/\s+/).slice(1).map(Number);
}

function probeThreads(): Map<string, { name: string; ticks: number }> {
  const threads = new Map<string, { name: string; ticks: number }>();
  try {
    for (const entry of Deno.readDirSync("/proc/self/task")) {
      const stat = probeRead(`/proc/self/task/${entry.name}/stat`);
      if (!stat) continue;
      const close = stat.lastIndexOf(")");
      const name = stat.slice(stat.indexOf("(") + 1, close);
      const rest = stat.slice(close + 2).split(" ");
      threads.set(entry.name, {
        name,
        ticks: Number(rest[11]) + Number(rest[12]),
      });
    }
  } catch {
    // Not Linux.
  }
  return threads;
}

function probeSelfStatus(): string {
  const status = probeRead("/proc/self/status") ?? "";
  const field = (name: string) =>
    Number(status.match(new RegExp(`^${name}:\\s*(\\d+)`, "m"))?.[1] ?? 0);
  return `${field("voluntary_ctxt_switches")}/${
    field("nonvoluntary_ctxt_switches")
  }`;
}

function startProbe(): () => void {
  probeEnvironment();
  let lastTick = performance.now();
  let lastCpu = probeCpuLine();
  let lastThreads = probeThreads();
  let lastCtx = probeSelfStatus().split("/").map(Number);
  let lastThrottle = probeRead("/sys/fs/cgroup/cpu.stat");
  const timer = setInterval(() => {
    const now = performance.now();
    const lag = now - lastTick - 1000;
    lastTick = now;
    const [l1, l5, l15] = Deno.loadavg();
    const cpu = probeCpuLine();
    let cpuText = "-";
    if (cpu && lastCpu) {
      const d = cpu.map((v, i) => v - (lastCpu![i] ?? 0));
      const total = d.slice(0, 8).reduce((a, b) => a + b, 0) || 1;
      const pct = (i: number) => ((100 * d[i]) / total).toFixed(0);
      cpuText = `usr=${pct(0)}% sys=${pct(2)}% idle=${pct(3)}% iowait=${
        pct(4)
      }% steal=${pct(7)}%`;
    }
    lastCpu = cpu;
    const threads = probeThreads();
    const hot = [...threads].map(([tid, t]) => ({
      tid,
      name: t.name,
      ticks: t.ticks - (lastThreads.get(tid)?.ticks ?? t.ticks),
    })).filter((t) => t.ticks > 0).sort((a, b) => b.ticks - a.ticks);
    const processTicks = hot.reduce((n, t) => n + t.ticks, 0);
    lastThreads = threads;
    const ctx = probeSelfStatus().split("/").map(Number);
    const ctxText = `${ctx[0] - lastCtx[0]}/${ctx[1] - lastCtx[1]}`;
    lastCtx = ctx;
    const throttle = probeRead("/sys/fs/cgroup/cpu.stat");
    const throttled = (text?: string) =>
      Number(text?.match(/^throttled_usec (\d+)/m)?.[1] ?? 0);
    const throttleMs = (throttled(throttle) - throttled(lastThrottle)) / 1000;
    lastThrottle = throttle;
    const psi = (kind: string) =>
      probeRead(`/proc/pressure/${kind}`)?.match(/^some avg10=([\d.]+)/m)
        ?.[1] ?? "-";
    const m = Deno.memoryUsage();
    const mb = (n: number) => (n / 1048576).toFixed(0);
    probeLog(
      `tick lag=${lag.toFixed(0)}ms load=${l1.toFixed(2)}/${l5.toFixed(2)}/${
        l15.toFixed(2)
      } cores=${navigator.hardwareConcurrency} ${cpuText} ` +
        `psi-some10 cpu=${psi("cpu")} io=${psi("io")} mem=${psi("memory")} ` +
        `cg-throttled=${throttleMs.toFixed(0)}ms ` +
        `proc-cpu=${processTicks}ticks ctxsw=${ctxText} ` +
        `hot=${
          hot.slice(0, 6).map((t) => `${t.name}#${t.tid}:${t.ticks}`).join(",")
        } heap=${mb(m.heapUsed)}/${mb(m.heapTotal)}MB rss=${mb(m.rss)}MB`,
    );
  }, 1000);
  return () => clearInterval(timer);
}

describe("fabrichat spaces across runtimes", () => {
  let harness: MultiRuntimeHarness;
  let starter: MultiRuntimeSession;
  let member: MultiRuntimeSession;
  let stranger: MultiRuntimeSession;
  let stopProbe: (() => void) | undefined;

  beforeAll(async () => {
    stopProbe = startProbe();
    probeLog("mark=create-start");
    harness = await MultiRuntimeHarness.create({
      programPath: PROGRAM_PATH,
      rootPath: ROOT_PATH,
      sessions: [
        "fabrichat-spaces-starter",
        "fabrichat-spaces-member",
        "fabrichat-spaces-stranger",
      ],
      aclMode: "enforce",
      probe: true,
    });
    probeLog("mark=create-done");
    [starter, member, stranger] = harness.sessions;
    await harness.settle();
    probeLog("mark=setup-done");
  });

  afterAll(async () => {
    probeLog("mark=dispose-start");
    await harness?.dispose();
    probeLog("mark=dispose-done");
    stopProbe?.();
  });

  /**
   * Has the starter send `event` on the manager's `stream` from its reviewed
   * start control, checks that the request was done and that the manager
   * joined the starter to the room it produced, and returns that room's
   * address.
   */
  async function start(
    stream: "openDirect" | "createGroup",
    event: Record<string, FabricValue> & { requestId: string },
  ): Promise<PieceAddress> {
    probeLog(`mark=send-start ${event.requestId}`);
    const probeT0 = performance.now();
    try {
      await starter.send(stream, event, START_ACTION);
    } finally {
      probeLog(
        `mark=send-end ${event.requestId} ${
          (performance.now() - probeT0).toFixed(0)
        }ms`,
      );
    }
    await harness.settle();
    probeLog(
      `mark=settle-done ${event.requestId} ${
        (performance.now() - probeT0).toFixed(0)
      }ms`,
    );
    expect(await starter.read(["requests", event.requestId, "status"]))
      .toBe("done");
    const room = await starter.link([
      "requests",
      event.requestId,
      "entry",
      "room",
    ]);
    // The room starts with no participants, and holds no messages whose
    // authors it would add, so the one it lists is the starter's join. Under
    // server execution the join is an event the served start emits, which
    // commits in a later wave than the start's own, and `settle()` waits only
    // for the start's; so the wait is for the room to list anyone, and the
    // assertions then say who.
    await harness.settleUntil(async () =>
      (await starter.read(["participants", "length"], { piece: room })) !== 0
    );
    probeLog(
      `mark=joined ${event.requestId} ${
        (performance.now() - probeT0).toFixed(0)
      }ms`,
    );
    expect(await starter.read(["participants", "length"], { piece: room }))
      .toBe(1);
    expect(await starter.read(["participants", 0, "name"], { piece: room }))
      .toBe("Starter");
    return room;
  }

  it("lets a group room's member read it, and refuses a stranger", async () => {
    const room = await start("createGroup", {
      requestId: "g-1",
      title: "Team",
      members: [member.identity.did()],
    });

    expect(room.space).not.toBe(harness.spaceDid);
    expect(await member.read(["about", "title"], { piece: room }))
      .toBe("Team");
    await expect(stranger.read(["about", "title"], { piece: room })).rejects
      .toThrow(`lacks READ on space ${room.space}`);
  });

  it("reads a group room's message count through the manager's link, and starts a room after it", async () => {
    // The link is part of every manager handler's declared reads, so a room
    // started with one already listed shows that the link reaches nothing a
    // served handler may not read.
    await start("createGroup", {
      requestId: "g-count",
      title: "Counted",
      members: [member.identity.did()],
    });

    expect(
      await starter.read([
        "requests",
        "g-count",
        "entry",
        "room",
        "messages",
        "count",
      ]),
    ).toBe(0);
    // The member, who started nothing, reads the same count through the
    // starter's manager, in either posture.
    expect(
      await member.read([
        "requests",
        "g-count",
        "entry",
        "room",
        "messages",
        "count",
      ]),
    ).toBe(0);
    await start("createGroup", {
      requestId: "g-count-next",
      title: "Counted next",
      members: [member.identity.did()],
    });
  });

  it("lets anyone read a group room made joinable by its link", async () => {
    const room = await start("createGroup", {
      requestId: "g-open",
      title: "Open team",
      members: [member.identity.did()],
      joinableByLink: true,
    });

    expect(await stranger.read(["about", "title"], { piece: room }))
      .toBe("Open team");
  });

  it("lets a group room's member add a stranger from the room's add control", async () => {
    const room = await start("createGroup", {
      requestId: "g-add",
      title: "Growing team",
      members: [member.identity.did()],
    });
    const adding = { target: { value: stranger.identity.did() } };

    // Sent as anything but the person's gesture, the add admits no one.
    await member.send("addMember", adding, undefined, { piece: room });
    await harness.settle();
    await expect(stranger.read(["about", "title"], { piece: room })).rejects
      .toThrow(`lacks READ on space ${room.space}`);

    // A member admitted at creation holds OWNER, so their own add, from the
    // room's control, admits the stranger.
    await member.send("addMember", adding, ADD_MEMBER_ACTION, { piece: room });
    await harness.settle();
    expect(await stranger.read(["about", "title"], { piece: room }))
      .toBe("Growing team");
  });

  it("lets a direct room's counterpart read it, and refuses a stranger", async () => {
    const room = await start("openDirect", {
      requestId: "d-1",
      counterpart: member.identity.did(),
    });

    expect(room.space).not.toBe(harness.spaceDid);
    expect(await member.read(["about", "kind"], { piece: room }))
      .toBe("direct");
    await expect(stranger.read(["about", "kind"], { piece: room })).rejects
      .toThrow(`lacks READ on space ${room.space}`);
  });
});
