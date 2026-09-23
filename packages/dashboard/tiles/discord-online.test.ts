/**
 * discord online: the tile drives a Discord gateway socket, two timers and a
 * history file on disk. All four are replaced with stand-ins here — the socket is
 * driven frame by frame, the timers fire on demand, the clock is fixed, and the
 * file reads and writes are captured in memory. No network, no filesystem, no
 * waiting.
 */

import {
  assert,
  assertEquals,
  assertMatch,
  assertStringIncludes,
} from "@std/assert";
import type { Ctx, Tile } from "../types.ts";
import { buildSnapshot, discordOnline, loadHistory } from "./discord-online.ts";
import type * as discordOnlineModule from "./discord-online.ts";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const VISITOR_GREY = "#7c828c";
const LIVE = { DISCORD_BOT_TOKEN: "tok", DISCORD_GUILD_ID: "g1" };

// The clock every stubbed poll reads. Tests move it forward by hand so the span
// the chart reports is an exact number, not a race with the real clock.
const T0 = Date.UTC(2026, 5, 1);
let clock = T0;

function ctx(env: Record<string, string> = {}): Ctx {
  return {
    runs: () => Promise.resolve([]),
    runsFor: () => Promise.resolve([]),
    env: (k) => env[k],
  };
}

// The guild every gateway test hands back: three of the four members are online,
// two of those three carry the team role.
const GUILD = {
  id: "g1",
  roles: [
    { id: "team", name: "Team", color: 0x2ecc71, position: 5 },
    { id: "g1", name: "@everyone", color: 0, position: 0 },
  ],
  members: [
    { user: { id: "a" }, roles: ["team"] },
    { user: { id: "b" }, roles: [] },
    { user: { id: "c" }, roles: ["team"] },
    { user: { id: "d" }, roles: ["team"] },
  ],
  presences: [
    { user: { id: "a" }, status: "online" },
    { user: { id: "b" }, status: "idle" },
    { user: { id: "c" }, status: "offline" },
    { user: { id: "d" }, status: "dnd" },
  ],
};

// Stands in for the gateway socket. The tile only ever assigns the three handlers
// and calls send/close, so a test drives it by hand.
class FakeSocket {
  onmessage?: (ev: { data: unknown }) => void;
  onclose?: () => void;
  onerror?: () => void;
  readonly sent: string[] = [];
  closed = false;
  sendFails = false;
  closeFails = false;

  send(data: string) {
    if (this.sendFails) throw new Error("socket is closing");
    this.sent.push(data);
  }

  close() {
    if (this.closeFails) throw new Error("already closed");
    this.closed = true;
  }

  /**
   * Delivers a gateway frame the way the real socket would: JSON in a string.
   */
  deliver(frame: unknown) {
    this.onmessage!({ data: JSON.stringify(frame) });
  }

  /**
   * Delivers whatever is given, untouched, for the frames that are not JSON.
   */
  raw(data: unknown) {
    this.onmessage!({ data });
  }

  /** Returns the parsed frames the tile sent back up the socket. */
  frames(): { op: number; d?: unknown }[] {
    return this.sent.map((s) => JSON.parse(s));
  }
}

interface Wire {
  socket(): FakeSocket;
  beat(): void; // run one heartbeat tick
  expire(): void; // run the snapshot deadline
  beatMs: number | undefined; // the interval the tile asked for
  cleared: number[]; // interval ids the tile stopped
  reads: string[];
  writes: { path: string; data: string }[];
  renames: { from: string; to: string }[];
  logged: string[];
}

interface Opts {
  read?: () => Promise<string>; // what the history file holds
  write?: () => Promise<void>; // how persisting the history goes
  connect?: () => FakeSocket; // how opening the gateway goes
}

const BEAT_ID = 41;

async function withWire(opts: Opts, body: (w: Wire) => Promise<void>): Promise<void> {
  const real = {
    WebSocket: globalThis.WebSocket,
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    readTextFile: Deno.readTextFile,
    writeTextFile: Deno.writeTextFile,
    rename: Deno.rename,
    now: Date.now,
    error: console.error,
  };

  let sock: FakeSocket | undefined;
  let beat: (() => void) | undefined;
  let expire: (() => void) | undefined;
  const w: Wire = {
    socket: () => sock!,
    beat: () => beat!(),
    expire: () => expire!(),
    beatMs: undefined,
    cleared: [],
    reads: [],
    writes: [],
    renames: [],
    logged: [],
  };

  globalThis.WebSocket = function () {
    sock = opts.connect ? opts.connect() : new FakeSocket();
    return sock;
  } as unknown as typeof WebSocket;

  globalThis.setInterval = ((fn: () => void, ms: number) => {
    beat = fn;
    w.beatMs = ms;
    return BEAT_ID;
  }) as unknown as typeof setInterval;
  globalThis.clearInterval = ((id: number) => w.cleared.push(id)) as unknown as typeof clearInterval;
  globalThis.setTimeout = ((fn: () => void) => {
    expire = fn;
    return 0;
  }) as unknown as typeof setTimeout;
  globalThis.clearTimeout = (() => {}) as unknown as typeof clearTimeout;

  Deno.readTextFile = ((path: string) => {
    w.reads.push(String(path));
    return opts.read ? opts.read() : Promise.reject(new Deno.errors.NotFound("no history file"));
  }) as typeof Deno.readTextFile;
  Deno.writeTextFile = ((path: string, data: string) => {
    if (opts.write) return opts.write();
    w.writes.push({ path: String(path), data });
    return Promise.resolve();
  }) as typeof Deno.writeTextFile;
  Deno.rename = ((from: string, to: string) => {
    w.renames.push({ from: String(from), to: String(to) });
    return Promise.resolve();
  }) as typeof Deno.rename;
  Date.now = () => clock;
  console.error = (...args: unknown[]) => w.logged.push(args.map((a) => String(a)).join(" "));

  try {
    await body(w);
  } finally {
    globalThis.WebSocket = real.WebSocket;
    globalThis.setInterval = real.setInterval;
    globalThis.clearInterval = real.clearInterval;
    globalThis.setTimeout = real.setTimeout;
    globalThis.clearTimeout = real.clearTimeout;
    Deno.readTextFile = real.readTextFile;
    Deno.writeTextFile = real.writeTextFile;
    Deno.rename = real.rename;
    Date.now = real.now;
    console.error = real.error;
  }
}

// Take the poll up to the point where the gateway has said HELLO and the tile has
// identified. The returned promise is the collect() still in flight.
function connect(w: Wire, tile: Tile = discordOnline, heartbeatMs = 41_250) {
  const view = tile.collect(ctx(LIVE));
  w.socket().deliver({ op: 10, d: { heartbeat_interval: heartbeatMs } });
  return view;
}

Deno.test("discord online: neither the token nor the guild id alone earns a color", async () => {
  const cases: Record<string, string>[] = [{}, { DISCORD_BOT_TOKEN: "tok" }, { DISCORD_GUILD_ID: "g1" }];
  for (const env of cases) {
    const v = await discordOnline.collect(ctx(env));
    assertEquals(v.status, "unknown");
    assertEquals(v.value, "—");
    assertStringIncludes(v.sub ?? "", "set DISCORD_BOT_TOKEN + DISCORD_GUILD_ID");
  }
});

Deno.test("discord snapshot: an online user with no member record counts as a visitor, not team", () => {
  const snap = buildSnapshot({
    id: "g1",
    roles: [{ id: "team", name: "Team", color: 255, position: 5 }],
    members: [{ user: { id: "a" }, roles: ["team"] }],
    presences: [
      { user: { id: "a" }, status: "online" },
      { user: { id: "ghost" }, status: "online" }, // present, but not in the member list
    ],
  });
  assert(snap);
  assertEquals(snap.online, 2);
  assertEquals(snap.team, 1);
  assertEquals(snap.visitors, 1);
  assertEquals(snap.teamColor, "#0000ff"); // a decimal Discord color, zero-padded
});

Deno.test("discord snapshot: a colorless Team role uses the visitor gray", () => {
  const online = [{ user: { id: "a" }, status: "online" }];
  const members = [{ user: { id: "a" }, roles: ["team"] }];
  // The role exists and is counted, but carries Discord's "no color" sentinel.
  const colorless = buildSnapshot({
    id: "g1",
    roles: [{ id: "team", name: "Team", color: 0, position: 5 }],
    members,
    presences: online,
  });
  assert(colorless);
  assertEquals(colorless.team, 1);
  assertEquals(colorless.teamColor, VISITOR_GREY);
});

Deno.test("discord snapshot: Team Member remains an alias for Team", () => {
  const legacy = buildSnapshot({
    id: "g1",
    roles: [{ id: "legacy", name: "Team Member", color: 0x123456, position: 5 }],
    members: [{ user: { id: "a" }, roles: ["legacy"] }],
    presences: [{ user: { id: "a" }, status: "online" }],
  });
  assert(legacy);
  assertEquals(legacy.team, 1);
  assertEquals(legacy.visitors, 0);
  assertEquals(legacy.teamColor, "#123456");
});

Deno.test("discord snapshot: Team and Team Member roles are counted together", () => {
  const snap = buildSnapshot({
    id: "g1",
    roles: [
      { id: "team", name: "Team", color: 0x2ecc71, position: 6 },
      { id: "legacy", name: "Team Member", color: 0x123456, position: 5 },
    ],
    members: [
      { user: { id: "a" }, roles: ["team"] },
      { user: { id: "b" }, roles: ["legacy"] },
      { user: { id: "c" }, roles: ["team", "legacy"] },
      { user: { id: "d" }, roles: [] },
    ],
    presences: [
      { user: { id: "a" }, status: "online" },
      { user: { id: "b" }, status: "online" },
      { user: { id: "c" }, status: "online" },
      { user: { id: "d" }, status: "online" },
    ],
  });
  assert(snap);
  assertEquals(snap.team, 3);
  assertEquals(snap.visitors, 1);
  assertEquals(snap.teamColor, "#2ecc71");
});

Deno.test("discord snapshot: absent Team aliases do not produce a valid snapshot", () => {
  const missing = buildSnapshot({
    id: "g1",
    roles: [{ id: "g1", name: "@everyone", color: 0, position: 0 }],
    members: [{ user: { id: "a" }, roles: ["team"] }],
    presences: [{ user: { id: "a" }, status: "online" }],
  });
  assertEquals(missing, null);
});

Deno.test("discord online: the history is read from disk once and carried from poll to poll", async (t) => {
  // The tile module loads the history file once, on the first poll that
  // records a sample, and each later poll works on what that load left. These
  // steps poll a copy of the module no other test has polled, so the first of
  // them sees the load, and they run in the order in which each builds on the
  // one before.

  const fresh: typeof discordOnlineModule = await import(
    `./discord-online.ts?history=${crypto.randomUUID()}`
  );

  await t.step("a snapshot -> good; the reloaded history draws the chart, stale samples age out", async () => {
    clock = T0;
    const persisted = [
      { t: T0 - 90 * DAY, team: 1, visitors: 1 }, // past the 60-day retention window
      { t: T0 - 2 * DAY, team: 3, visitors: 4 },
      "nonsense",
      null,
      42,
      { t: T0 - DAY, team: 1 }, // missing `visitors`: not a point
    ];
    await withWire({ read: () => Promise.resolve(JSON.stringify(persisted)) }, async (w) => {
      const view = connect(w, fresh.discordOnline);
      w.socket().deliver({ op: 0, t: "GUILD_CREATE", d: GUILD });
      const v = await view;

      assertEquals(v.status, "good");
      assertEquals(v.value, "3"); // a, b and d are online; c is not
      // The span reaches back to the sample from two days ago, which only exists
      // because the file was reloaded.
      assertEquals(v.duration, 2 * DAY);
      assertStringIncludes(v.extra ?? "", "<svg");
      assertMatch(
        v.extra ?? "",
        new RegExp(`background:light-dark\\(#[0-9a-f]{6},${VISITOR_GREY}\\)`),
      );
      assertMatch(
        v.extra ?? "",
        /background:light-dark\(#[0-9a-f]{6},#2ecc71\)/,
      ); // the team role's own color
      // With the chart drawn the counts sit at each line's end, not in the subline.
      assertStringIncludes(v.extra ?? "", "team + ");

      // What was persisted: the retained sample plus the fresh one. The ancient
      // sample and the entries that are not points are gone.
      assertEquals(w.reads.length, 1);
      assertStringIncludes(w.reads[0], "fabric-wall-discord-history.json");
      assertEquals(w.writes.length, 1);
      assertEquals(JSON.parse(w.writes[0].data), [
        { t: T0 - 2 * DAY, team: 3, visitors: 4 },
        { t: T0, team: 2, visitors: 1 },
      ]);
      // Written to a temp file, then renamed over the file it read.
      assertEquals(w.writes[0].path, `${w.reads[0]}.tmp`);
      assertEquals(w.renames, [{ from: `${w.reads[0]}.tmp`, to: w.reads[0] }]);

      // The socket and its heartbeat are both stopped before the poll resolves.
      assertEquals(w.socket().closed, true);
      assertEquals(w.cleared, [BEAT_ID]);
    });
  });

  await t.step("a two-month gap ages the history out; a lone sample shows its counts inline", async () => {
    clock = T0 + 90 * DAY;
    await withWire({}, async (w) => {
      const view = connect(w, fresh.discordOnline);
      w.socket().deliver({ op: 0, t: "GUILD_CREATE", d: GUILD });
      const v = await view;

      assertEquals(v.status, "good");
      assertEquals(v.value, "3");
      // Every earlier sample is past the window, so there is nothing to chart.
      assertEquals(v.duration, 0);
      assert(!(v.extra ?? "").includes("<svg"), "one sample is not a chart");
      // A numberless tile would be useless, so the counts move into the subline.
      assertStringIncludes(v.extra ?? "", "team 2 + ");
      assertStringIncludes(v.extra ?? "", "visitors 1");
      assertEquals(JSON.parse(w.writes[0].data), [{ t: clock, team: 2, visitors: 1 }]);
      // The file is read once per process, not once per poll.
      assertEquals(w.reads.length, 0);
    });
  });

  await t.step("a history that can't be persisted is logged, not fatal", async () => {
    clock = T0 + 90 * DAY + HOUR;
    await withWire({ write: () => Promise.reject(new Error("no space left on device")) }, async (w) => {
      const view = connect(w, fresh.discordOnline);
      w.socket().deliver({ op: 0, t: "GUILD_CREATE", d: GUILD });
      const v = await view;

      // The poll still reports what it saw, and the chart still spans the hour
      // between this sample and the last.
      assertEquals(v.status, "good");
      assertEquals(v.value, "3");
      assertEquals(v.duration, HOUR);
      assertEquals(w.logged, ["discord: could not persist history: no space left on device"]);
      assertEquals(w.renames, [], "a failed write is never renamed into place");
    });
  });
});

Deno.test("discord online: the identify frame carries the token and the privileged intents", async () => {
  await withWire({}, async (w) => {
    const view = connect(w);
    const identify = w.socket().frames()[0] as {
      op: number;
      d: {
        token: string;
        intents: number;
        properties: { os: string; browser: string; device: string };
      };
    };
    assertEquals(identify.op, 2);
    assertEquals(identify.d.token, "tok");
    // GUILDS | GUILD_MEMBERS | GUILD_PRESENCES — the members and presences bits are
    // what the tile needs and what the bot must be granted.
    assertEquals(identify.d.intents, 259);
    // Discord records these against the connection, where they pick this
    // client out from the others a bot token can carry.
    assertEquals(identify.d.properties, {
      os: "linux",
      browser: "commonfabric-dashboard",
      device: "commonfabric-dashboard",
    });
    w.socket().deliver({ op: 9 }); // invalid session, to end the poll
    await view;
  });
});

Deno.test("discord online: heartbeats go out at the gateway's interval; a dead socket's tick is swallowed", async () => {
  await withWire({}, async (w) => {
    const view = connect(w, discordOnline, 41_250);
    assertEquals(w.beatMs, 41_250); // the interval HELLO asked for, not one of our own
    w.beat();
    assertEquals(w.socket().frames()[1], { op: 1, d: null });
    // A socket that has gone away rejects the tick; the poll carries on.
    w.socket().sendFails = true;
    w.beat();
    assertEquals(w.socket().frames().length, 2, "the failed tick sent nothing");
    w.socket().sendFails = false;
    w.socket().deliver({ op: 9 });
    const v = await view;
    assertEquals(v.status, "unknown");
    assertEquals(w.cleared, [BEAT_ID]);
  });
});

Deno.test("discord online: an invalid session (op 9) -> gray, never a false green", async () => {
  await withWire({}, async (w) => {
    const view = connect(w);
    w.socket().deliver({ op: 9 });
    const v = await view;
    assertEquals(v.status, "unknown");
    assertEquals(v.value, "—");
    assertStringIncludes(v.sub ?? "", "enable the presences + members intents");
  });
});

Deno.test("discord online: missing Team aliases -> gray", async () => {
  await withWire({}, async (w) => {
    const view = connect(w);
    w.socket().deliver({
      op: 0,
      t: "GUILD_CREATE",
      d: {
        ...GUILD,
        roles: [{ id: "g1", name: "@everyone", color: 0, position: 0 }],
      },
    });
    const v = await view;
    assertEquals(v.status, "unknown");
    assertEquals(v.value, "—");
    assertStringIncludes(v.sub ?? "", "Team or Team Member role");
  });
});

Deno.test("discord online: noise and another guild's members never finish the poll; a close -> gray", async () => {
  await withWire({}, async (w) => {
    const view = connect(w);
    // Frames that are not JSON, and frames that are not text at all.
    w.socket().raw("<html>bad gateway</html>");
    w.socket().raw(new Uint8Array([1, 2, 3]));
    // A GUILD_CREATE for a guild we did not ask about, and an op the tile has no
    // interest in: neither can resolve the poll.
    w.socket().deliver({ op: 0, t: "GUILD_CREATE", d: { ...GUILD, id: "somewhere-else" } });
    w.socket().deliver({ op: 11, t: null });
    // Closing the socket before the guild arrives leaves the tile gray, not red:
    // an unreachable source is not a failing one.
    w.socket().closeFails = true; // a socket already on its way down
    w.socket().onclose!();
    // A close followed by an error still resolves once, with the same view.
    w.socket().onerror!();
    const v = await view;
    assertEquals(v.status, "unknown");
    assertEquals(v.value, "—");
    assertStringIncludes(v.sub ?? "", "enable the presences + members intents");
  });
});

Deno.test("discord online: a socket error -> gray", async () => {
  await withWire({}, async (w) => {
    const view = connect(w);
    w.socket().onerror!();
    const v = await view;
    assertEquals(v.status, "unknown");
    assertEquals(v.value, "—");
  });
});

Deno.test("discord online: a gateway that never sends the guild times out -> gray", async () => {
  await withWire({}, async (w) => {
    const view = discordOnline.collect(ctx(LIVE));
    // No HELLO, so no heartbeat was ever started and there is none to stop.
    w.expire();
    const v = await view;
    assertEquals(v.status, "unknown");
    assertEquals(v.value, "—");
    assertStringIncludes(v.sub ?? "", "enable the presences + members intents");
    assertEquals(w.cleared, []);
    assertEquals(w.socket().closed, true);
  });
});

Deno.test("discord online: a gateway that refuses the connection -> gray with the reason", async () => {
  await withWire({
    connect: () => {
      throw new Error("dns error: gateway.discord.gg");
    },
  }, async () => {
    const v = await discordOnline.collect(ctx(LIVE));
    assertEquals(v.status, "unknown");
    assertEquals(v.value, "—");
    assertEquals(v.sub, "dns error: gateway.discord.gg");
  });
});

Deno.test("discord history: an unreadable store starts from an empty history", async () => {
  // ensureLoaded runs at most once per process, so only one path through its try is
  // reachable that way. loadHistory is the same read without the once-only flag.
  // Every one of these is a first-run or a damaged store, and none of them is an
  // error the tile should see: the contract is to start empty and carry on.
  const real = Deno.readTextFile;
  const loadWith = async (read: () => Promise<string>): Promise<string | null> => {
    Deno.readTextFile = read as typeof Deno.readTextFile;
    try {
      await loadHistory();
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  try {
    assertEquals(await loadWith(() => Promise.reject(new Deno.errors.NotFound("no file yet"))), null);
    assertEquals(await loadWith(() => Promise.resolve("{ not json")), null);
    assertEquals(await loadWith(() => Promise.resolve('{"not": "an array"}')), null);
    assertEquals(await loadWith(() => Promise.resolve('[{"t":"nope"}]')), null);
  } finally {
    Deno.readTextFile = real;
  }
});
