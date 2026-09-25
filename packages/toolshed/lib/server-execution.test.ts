import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import * as MemoryClient from "@commonfabric/memory/v2/client";
import { Server as MemoryServer } from "@commonfabric/memory/v2/server";
import { Identity } from "@commonfabric/identity";
import {
  DEFAULT_MAX_OUTSTANDING_EFFECTS,
  ensureSpaceRootsFromEnv,
  serverExecutionPolicyFromEnv,
  startServerExecutionHost,
  stopServerExecutionHost,
} from "@/lib/server-execution.ts";
import {
  experimentalPosture,
  publishExperimentalPosture,
} from "@/lib/experimental-posture.ts";
import { SERVER_EXECUTION_DEFAULT_ENABLED } from "@commonfabric/memory/v2/server-execution-default";

const envOf = (values: Record<string, string | undefined>) => (name: string) =>
  values[name];

describe("serverExecutionPolicyFromEnv", () => {
  // The Phase-6 env knobs (serving-loop.md §5) are the production
  // multi-tenancy bound: a runaway fan-out must degrade only its own space,
  // so the outstanding-effect cap is ON by default and only the LITERAL `0`
  // opts out. The property worth pinning is that a typo cannot disable it:
  // garbage must fall back to the default (loudly), never read as the
  // opt-out (the Phase-6 independent review's F4 — the pre-fix parser
  // mapped "abc"/"-1" to `undefined` = unbounded, indistinguishable from
  // the explicit `0`).

  it("defaults the outstanding cap ON when the knob is unset or empty", () => {
    const warnings: string[] = [];
    expect(serverExecutionPolicyFromEnv(envOf({}), (m) => warnings.push(m)))
      .toEqual({ maxOutstandingEffects: DEFAULT_MAX_OUTSTANDING_EFFECTS });
    expect(
      serverExecutionPolicyFromEnv(
        envOf({ SERVER_EXECUTION_MAX_OUTSTANDING_EFFECTS: "" }),
        (m) => warnings.push(m),
      ),
    ).toEqual({ maxOutstandingEffects: DEFAULT_MAX_OUTSTANDING_EFFECTS });
    expect(warnings).toEqual([]);
  });

  it("honors an explicit positive cap and the literal 0 opt-out (unbounded)", () => {
    const warnings: string[] = [];
    expect(
      serverExecutionPolicyFromEnv(
        envOf({ SERVER_EXECUTION_MAX_OUTSTANDING_EFFECTS: "8" }),
        (m) => warnings.push(m),
      ),
    ).toEqual({ maxOutstandingEffects: 8 });
    // The operator's deliberate opt-out: the key is ABSENT from the
    // policy (the outbox reads absent as unbounded).
    expect(
      serverExecutionPolicyFromEnv(
        envOf({ SERVER_EXECUTION_MAX_OUTSTANDING_EFFECTS: "0" }),
        (m) => warnings.push(m),
      ),
    ).toEqual({});
    expect(warnings).toEqual([]);
  });

  it("FAILS CLOSED on garbage/negative/fractional cap values: default cap, loud warning — never the unbounded opt-out", () => {
    for (const raw of ["abc", "-1", "1.5", "16abc", "0x10", " 4"]) {
      const warnings: string[] = [];
      const policy = serverExecutionPolicyFromEnv(
        envOf({ SERVER_EXECUTION_MAX_OUTSTANDING_EFFECTS: raw }),
        (m) => warnings.push(m),
      );
      expect(policy).toEqual({
        maxOutstandingEffects: DEFAULT_MAX_OUTSTANDING_EFFECTS,
      });
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("SERVER_EXECUTION_MAX_OUTSTANDING_EFFECTS");
      expect(warnings[0]).toContain(JSON.stringify(raw));
    }
  });

  it("threads the T_flush and egress-rate knobs; garbage there reads as unset (built-in default) with a warning", () => {
    const warnings: string[] = [];
    expect(
      serverExecutionPolicyFromEnv(
        envOf({
          SERVER_EXECUTION_FLUSH_DEADLINE_MS: "250",
          SERVER_EXECUTION_EGRESS_RATE_PER_S: "5",
          SERVER_EXECUTION_MAX_OUTSTANDING_EFFECTS: "0",
        }),
        (m) => warnings.push(m),
      ),
    ).toEqual({ flushDeadlineMs: 250, egressRatePerSecond: 5 });
    expect(warnings).toEqual([]);
    expect(
      serverExecutionPolicyFromEnv(
        envOf({
          SERVER_EXECUTION_FLUSH_DEADLINE_MS: "fast",
          SERVER_EXECUTION_EGRESS_RATE_PER_S: "0",
        }),
        (m) => warnings.push(m),
      ),
    ).toEqual({ maxOutstandingEffects: DEFAULT_MAX_OUTSTANDING_EFFECTS });
    expect(warnings.length).toBe(2);
    expect(warnings[0]).toContain("SERVER_EXECUTION_FLUSH_DEADLINE_MS");
    expect(warnings[1]).toContain("SERVER_EXECUTION_EGRESS_RATE_PER_S");
  });

  it("turns the store read-through on for the literal true only; garbage leaves it off with a warning", () => {
    const warnings: string[] = [];
    expect(
      serverExecutionPolicyFromEnv(
        envOf({
          SERVER_EXECUTION_STORE_READ_THROUGH: "true",
          SERVER_EXECUTION_MAX_OUTSTANDING_EFFECTS: "0",
        }),
        (m) => warnings.push(m),
      ),
    ).toEqual({ storeReadThrough: true });
    expect(
      serverExecutionPolicyFromEnv(
        envOf({
          SERVER_EXECUTION_STORE_READ_THROUGH: "false",
          SERVER_EXECUTION_MAX_OUTSTANDING_EFFECTS: "0",
        }),
        (m) => warnings.push(m),
      ),
    ).toEqual({});
    expect(warnings).toEqual([]);
    expect(
      serverExecutionPolicyFromEnv(
        envOf({
          SERVER_EXECUTION_STORE_READ_THROUGH: "yes",
          SERVER_EXECUTION_MAX_OUTSTANDING_EFFECTS: "0",
        }),
        (m) => warnings.push(m),
      ),
    ).toEqual({});
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("SERVER_EXECUTION_STORE_READ_THROUGH");
  });

  it("threads the parked-runtime retention knob, the literal 0 included; garbage reads as unset with a warning", () => {
    const warnings: string[] = [];
    const cases: [string, number][] = [
      ["60000", 60_000],
      ["0", 0],
      ["2147483647", 2_147_483_647],
    ];
    for (const [raw, parkedRuntimeRetentionMs] of cases) {
      expect(
        serverExecutionPolicyFromEnv(
          envOf({
            SERVER_EXECUTION_PARKED_RUNTIME_RETENTION_MS: raw,
            SERVER_EXECUTION_MAX_OUTSTANDING_EFFECTS: "0",
          }),
          (m) => warnings.push(m),
        ),
      ).toEqual({ parkedRuntimeRetentionMs });
    }
    expect(warnings).toEqual([]);
    // One past the longest delay a timer honors reads as unset too.
    for (const raw of ["-1", "2147483648"]) {
      expect(
        serverExecutionPolicyFromEnv(
          envOf({
            SERVER_EXECUTION_PARKED_RUNTIME_RETENTION_MS: raw,
            SERVER_EXECUTION_MAX_OUTSTANDING_EFFECTS: "0",
          }),
          (m) => warnings.push(m),
        ),
      ).toEqual({});
    }
    expect(warnings.length).toBe(2);
    for (const warning of warnings) {
      expect(warning).toContain(
        "SERVER_EXECUTION_PARKED_RUNTIME_RETENTION_MS",
      );
    }
  });
});

describe("startServerExecutionHost OFF witness", () => {
  // The OFF witness for the serving-loop bootstrap (OW45 arm-B
  // server-ensure stage 1's explicit pin; the arc's OFF byte-identity
  // bar): with the flag OFF — whether selected by the default or an
  // explicit "false" override — `startServerExecutionHost`
  // returns undefined, so NO ExecutorHost exists, NO SpaceServer is ever
  // built, and the server-side space-root ensure path added by stage 1
  // (the SpaceServer activation owed-step) structurally does not exist
  // OFF. The seat's only reachability chain is toolshed bootstrap →
  // ExecutorHost → SpaceServer.activate, and it severs at its first link.
  //
  // The options are untouchable fakes on purpose: the flag check is the
  // function's FIRST act, so the OFF arm must touch neither the server
  // nor the identity — any use throws and fails the pin. The same
  // untouchables also witness whichever direction UNSET resolves: if the
  // first-party default is ON, the gate opens and the construction's first
  // touch of the identity is the proof. The full ON construction is exercised
  // by the integration lanes and the deployed-topology gate, not here. Which
  // outcome UNSET takes is deliberately relative to the one default constant,
  // so changing that constant does not require re-tensing this test.

  const untouchable = <T extends object>(label: string): T =>
    new Proxy({} as T, {
      get(_target, property) {
        throw new Error(
          `${label}.${String(property)} touched — on the OFF arm the ` +
            "flag check must precede any use (the pin's failure); on " +
            "the unset ON arm, this touch is the gate-opened witness",
        );
      },
    });

  it("resolves the UNSET flag to the first-party default", () => {
    const start = () =>
      startServerExecutionHost({
        server: untouchable<MemoryServer>("server"),
        identity: untouchable<Identity>("identity"),
        apiUrl: new URL("http://toolshed.test"),
        envGet: () => undefined,
      });
    if (SERVER_EXECUTION_DEFAULT_ENABLED) {
      // The ON path gets past the gate and first touches the identity.
      expect(start).toThrow("identity.did touched");
    } else {
      // The OFF path returns before touching either untouchable dependency.
      expect(start()).toBeUndefined();
    }
  });

  it("is inert with the flag explicitly false", () => {
    const host = startServerExecutionHost({
      server: untouchable<MemoryServer>("server"),
      identity: untouchable<Identity>("identity"),
      apiUrl: new URL("http://toolshed.test"),
      envGet: (name) =>
        name === "EXPERIMENTAL_SERVER_EXECUTION" ? "false" : undefined,
    });
    expect(host).toBeUndefined();
  });

  describe("the posture it publishes", () => {
    // What `/api/meta` reports has to be the posture this deployment SERVES at,
    // not the generic webhook runtime's: a serving runtime forces flags of its
    // own, and a client adopting the base alone would run values the deployment
    // does not (docs/development/EXPERIMENTAL_OPTIONS.md).

    // Enough of a server for the host to register its observer on and let go
    // of again; an inert host touches nothing else.
    const observableServer = () =>
      ({ setServerExecutionObserver: () => {} }) as unknown as MemoryServer;
    const serviceIdentity = {
      did: () => "did:key:zServing",
    } as unknown as Identity;

    it("adds nothing while the serving loop is off", () => {
      publishExperimentalPosture({ modernCellRep: false });
      try {
        // Explicit "false" always selects the OFF arm.
        startServerExecutionHost({
          server: untouchable<MemoryServer>("server"),
          identity: untouchable<Identity>("identity"),
          apiUrl: new URL("http://toolshed.test"),
          envGet: (name) =>
            name === "EXPERIMENTAL_SERVER_EXECUTION" ? "false" : undefined,
        });
        expect(experimentalPosture()).toEqual({ modernCellRep: false });
      } finally {
        publishExperimentalPosture(null);
      }
    });

    it("adds the serving runtimes' own flags over the base while it serves", async () => {
      publishExperimentalPosture({
        modernCellRep: true,
        serverExecution: false,
      });
      try {
        expect(
          startServerExecutionHost({
            server: observableServer(),
            identity: serviceIdentity,
            apiUrl: new URL("http://toolshed.test"),
            envGet: (name) =>
              name === "EXPERIMENTAL_SERVER_EXECUTION" ? "true" : undefined,
          }),
        ).toBeDefined();
        // The one the serving runtime factory forces, over a base that says
        // the opposite; everything else rides the base through untouched.
        expect(experimentalPosture()).toEqual({
          modernCellRep: true,
          serverExecution: true,
        });
      } finally {
        await stopServerExecutionHost();
        publishExperimentalPosture(null);
      }
    });

    it("drops them again once the serving loop stops", async () => {
      publishExperimentalPosture({ serverExecution: false });
      try {
        startServerExecutionHost({
          server: observableServer(),
          identity: serviceIdentity,
          apiUrl: new URL("http://toolshed.test"),
          envGet: (name) =>
            name === "EXPERIMENTAL_SERVER_EXECUTION" ? "true" : undefined,
        });
        await stopServerExecutionHost();
        expect(experimentalPosture()).toEqual({ serverExecution: false });
      } finally {
        await stopServerExecutionHost();
        publishExperimentalPosture(null);
      }
    });
  });
});

describe("ensureSpaceRootsFromEnv", () => {
  // The RULED test switch's env parsing (OW45 arm-B stage 1, RULED 2026-08-24):
  // unset and "true" are the production posture (ensure ON); only the literal
  // "false" switches the space-root ensure off; garbage FAILS TO PRODUCTION
  // (ON, with a warning) — a typo must never silently strip production spaces
  // of their roots.

  const envOf2 =
    (values: Record<string, string | undefined>) => (name: string) =>
      values[name];

  it("defaults ON, honors true, and only the literal false disables", () => {
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    expect(ensureSpaceRootsFromEnv(envOf2({}), warn)).toBe(true);
    expect(
      ensureSpaceRootsFromEnv(
        envOf2({ SERVER_EXECUTION_ENSURE_SPACE_ROOTS: "true" }),
        warn,
      ),
    ).toBe(true);
    expect(
      ensureSpaceRootsFromEnv(
        envOf2({ SERVER_EXECUTION_ENSURE_SPACE_ROOTS: "false" }),
        warn,
      ),
    ).toBe(false);
    expect(warnings).toEqual([]);
  });

  it("FAILS TO PRODUCTION on garbage: ensure stays ON, loudly", () => {
    for (const raw of ["off", "0", "FALSE", " false", "no"]) {
      const warnings: string[] = [];
      expect(
        ensureSpaceRootsFromEnv(
          envOf2({ SERVER_EXECUTION_ENSURE_SPACE_ROOTS: raw }),
          (m) => warnings.push(m),
        ),
      ).toBe(true);
      expect(warnings.length).toBe(1);
      expect(warnings[0]).toContain("SERVER_EXECUTION_ENSURE_SPACE_ROOTS");
    }
  });
});

describe("startServerExecutionHost with the store read-through on", () => {
  // A real memory server and a client session on it: the session open
  // activates the space, the host's factory builds the serving runtime with
  // the read-through the SpaceServer handed it installed ahead of the
  // runtime, and the space serves. What the knob switches on, end to end.

  /** Polls `predicate` until it holds, and throws naming `label` once the
   * deadline has passed — a backstop on a live host's activation, which
   * exposes no event to await, sized for a stuck condition rather than a
   * slow one (the runner's executor suites wait the same way). */
  const until = async (
    predicate: () => boolean,
    label: string,
    timeoutMs = 20_000,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${label}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };

  it("serves a space whose client session opens, with the read-through installed through the factory", async () => {
    const identity = await Identity.fromPassphrase(
      "store read-through service",
    );
    const client = await Identity.fromPassphrase("store read-through client");
    const space = (await Identity.fromPassphrase("store read-through space"))
      .did();
    const server = new MemoryServer({
      store: new URL("memory://store-read-through-serving"),
      subscriptionRefreshDelayMs: 0,
      // Both shapes: the signed loopback invocation the serving runtime's
      // session carries `iss`; the client mounted below carries
      // `authorization.principal`.
      authorizeSessionOpen: (message) => {
        const iss = (message.invocation as { iss?: unknown } | undefined)?.iss;
        if (typeof iss === "string") return iss;
        const principal =
          (message.authorization as { principal?: unknown } | undefined)
            ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
      sessionOpenAuth: { audience: "did:key:z6Mk-store-read-through" },
    });
    const knobs: Record<string, string> = {
      EXPERIMENTAL_SERVER_EXECUTION: "true",
      SERVER_EXECUTION_STORE_READ_THROUGH: "true",
      SERVER_EXECUTION_ENSURE_SPACE_ROOTS: "false",
    };
    const host = startServerExecutionHost({
      server,
      identity,
      apiUrl: new URL("http://toolshed.test"),
      envGet: (name) => knobs[name],
    });
    expect(host).toBeDefined();
    const connection = await MemoryClient.connect({
      transport: MemoryClient.loopback(server),
    });
    try {
      const session = await connection.mount(
        space,
        {},
        (_space, _descriptor, context) => ({
          invocation: {
            aud: context.audience,
            challenge: context.challenge.value,
          },
          authorization: { principal: client.did() },
        }),
      );
      await until(
        () => host!.spaceServer(space)?.active === true,
        "the space to activate on the client's session",
      );
      expect(host!.stats().activeSpaces).toBe(1);
      // The client's watch is demand: the serving loop loads the demanded
      // root through its replica, and under the posture that read comes
      // from the engine through the installed read-through, counted as
      // such — over the session it would count nothing.
      await session.watchAddSync([{
        id: "store-read-through-demand",
        kind: "graph",
        query: {
          roots: [{
            id: "of:store-read-through-demanded",
            scope: "space",
            selector: { path: [], schema: false },
          }],
        },
      }]);
      await until(
        () => host!.stats().storeReads > 0,
        "the demanded root to be read through the engine",
      );
    } finally {
      await connection.close();
      await stopServerExecutionHost();
      await server.close();
    }
  });
});
