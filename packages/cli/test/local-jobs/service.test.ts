import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";

import type { HarnessJobResult } from "../../lib/harness-job.ts";
import { startLocalJobs } from "../../lib/local-jobs/service.ts";

/** A profile file with one read-only profile. */
const PROFILES = {
  read: {
    tools: ["loom_search"],
    maxModelTurns: 4,
    taskRole: "direct-command",
    retry: "never",
  },
};

describe("startLocalJobs()", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await Deno.makeTempDir({ prefix: "local-jobs-service-" });
    await Deno.writeTextFile(
      join(dir, "profiles.json"),
      JSON.stringify(PROFILES),
    );
  });

  afterEach(async () => {
    await Deno.remove(dir, { recursive: true });
  });

  /** Helper for tests, which starts the service with jobs that complete. */
  const start = (storePath?: string) => {
    const reported: string[] = [];
    const service = startLocalJobs(
      {
        socketPath: join(dir, "jobs.sock"),
        profilesPath: join(dir, "profiles.json"),
        ...(storePath !== undefined ? { storePath } : {}),
        maxConcurrent: 1,
        workRoot: join(dir, "runs"),
      },
      (message) => reported.push(message),
      {
        runJob: (): Promise<HarnessJobResult> =>
          Promise.resolve({
            outcome: "completed",
            structuredResult: { answer: "yes" },
            handleTable: {} as never,
          }),
      },
    );
    return { service, reported };
  };

  /** Helper for tests, which calls the socket with the token beside it. */
  const call = async (path: string, init: RequestInit = {}) => {
    const token = await Deno.readTextFile(join(dir, "jobs.sock.token"));
    const client = Deno.createHttpClient({
      proxy: { transport: "unix", path: join(dir, "jobs.sock") },
    } as never);
    try {
      const response = await fetch(`http://runner${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}` },
        client,
      } as never);
      return { status: response.status, body: await response.json() };
    } finally {
      client.close();
    }
  };

  it("serves the API on a private socket with a private token and store", async () => {
    const { service, reported } = start();
    const running = await service;
    try {
      for (
        const name of [
          "jobs.sock",
          "jobs.sock.token",
          "jobs.sqlite",
          "jobs.sqlite-wal",
          "jobs.sqlite-shm",
        ]
      ) {
        expect((await Deno.stat(join(dir, name))).mode! & 0o777).toBe(0o600);
      }
      expect((await call("/health")).body).toEqual({
        ok: true,
        lanes: { local: true, fabric: false },
      });
      running.setFabricLane(true);
      expect((await call("/health")).body.lanes.fabric).toBe(true);
      expect(reported.join("\n")).toContain(
        "serving local jobs on " + join(dir, "jobs.sock"),
      );
    } finally {
      await running.stop();
    }
  });

  it("runs an enqueued job to its end", async () => {
    const running = await start().service;
    try {
      const { status, body } = await call("/jobs", {
        method: "POST",
        body: JSON.stringify({
          caller: "test",
          profile: "read",
          idempotencyKey: "k",
          task: "Is it raining?",
          resultSchema: { type: "object" },
        }),
      });
      expect(status).toBe(201);
      const events = await (async () => {
        const token = await Deno.readTextFile(join(dir, "jobs.sock.token"));
        const client = Deno.createHttpClient({
          proxy: { transport: "unix", path: join(dir, "jobs.sock") },
        } as never);
        try {
          const response = await fetch(
            `http://runner/jobs/${body.job.id}/events`,
            { headers: { authorization: `Bearer ${token}` }, client } as never,
          );
          return await response.text();
        } finally {
          client.close();
        }
      })();
      expect(events).toContain('"state":"completed"');
      expect((await call(`/jobs/${body.job.id}`)).body.job.result).toEqual({
        answer: "yes",
      });
    } finally {
      await running.stop();
    }
  });

  it("removes the socket and token when it stops, and replaces a socket file left behind", async () => {
    await Deno.writeTextFile(join(dir, "jobs.sock"), "stale");
    const running = await start(join(dir, "store.sqlite")).service;
    await running.stop();

    for (const name of ["jobs.sock", "jobs.sock.token"]) {
      await expect(Deno.stat(join(dir, name))).rejects.toThrow(
        Deno.errors.NotFound,
      );
    }
    expect((await Deno.stat(join(dir, "store.sqlite"))).isFile).toBe(true);
  });

  it("throws when something other than a socket file stands at the socket path", async () => {
    await Deno.mkdir(join(dir, "jobs.sock", "inside"), { recursive: true });

    await expect(start().service).rejects.toThrow();
  });

  it("throws when the profile file cannot be read", async () => {
    await Deno.writeTextFile(join(dir, "profiles.json"), "{");

    await expect(start().service).rejects.toThrow();
  });
});
