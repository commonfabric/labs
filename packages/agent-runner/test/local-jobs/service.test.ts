import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { join } from "@std/path";

import type { HarnessJobResult } from "../../src/harness-job.ts";
import { startLocalJobs } from "../../src/local-jobs/service.ts";

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
    const listener = Deno.listen({
      transport: "unix",
      path: join(dir, "old.sock"),
    });
    await Deno.rename(join(dir, "old.sock"), join(dir, "jobs.sock"));
    listener.close();
    const running = await start(join(dir, "store.sqlite")).service;
    await running.stop();

    for (const name of ["jobs.sock", "jobs.sock.token"]) {
      await expect(Deno.stat(join(dir, name))).rejects.toThrow(
        Deno.errors.NotFound,
      );
    }
    expect((await Deno.stat(join(dir, "store.sqlite"))).isFile).toBe(true);
  });

  it("refuses a second service without replacing the first token or listener", async () => {
    const first = await start().service;
    let second: Awaited<ReturnType<typeof startLocalJobs>> | undefined;
    try {
      const token = await Deno.readTextFile(first.tokenPath);
      await expect((async () => {
        second = await start().service;
      })()).rejects.toThrow();
      expect(await Deno.readTextFile(first.tokenPath)).toBe(token);
      expect((await call("/health")).status).toBe(200);
    } finally {
      await second?.stop();
      await first.stop();
    }
  });

  it("rolls back a startup failure and releases ownership for another start", async () => {
    await expect(startLocalJobs({
      socketPath: join(dir, "jobs.sock"),
      profilesPath: join(dir, "profiles.json"),
      maxConcurrent: 1,
      workRoot: join(dir, "runs"),
    }, () => {
      throw new Error("report failed");
    })).rejects.toThrow("report failed");
    for (const name of ["jobs.sock", "jobs.sock.token"]) {
      await expect(Deno.stat(join(dir, name))).rejects.toThrow(
        Deno.errors.NotFound,
      );
    }
    const next = await start().service;
    await next.stop();
  });

  it("admits only one concurrent starter reclaiming a stale socket", async () => {
    const listener = Deno.listen({
      transport: "unix",
      path: join(dir, "old.sock"),
    });
    await Deno.rename(join(dir, "old.sock"), join(dir, "jobs.sock"));
    listener.close();
    const results = await Promise.allSettled([
      start().service,
      start().service,
    ]);
    try {
      expect(results.filter((result) => result.status === "fulfilled"))
        .toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected"))
        .toHaveLength(1);
      expect((await call("/health")).status).toBe(200);
    } finally {
      for (const result of results) {
        if (result.status === "fulfilled") await result.value.stop();
      }
    }
  });

  it("refuses a different socket sharing an active store", async () => {
    const first = await start().service;
    let second: Awaited<ReturnType<typeof startLocalJobs>> | undefined;
    try {
      await expect((async () => {
        second = await startLocalJobs({
          socketPath: join(dir, "other.sock"),
          storePath: join(dir, "jobs.sqlite"),
          profilesPath: join(dir, "profiles.json"),
          maxConcurrent: 1,
          workRoot: join(dir, "runs"),
        }, () => {});
      })()).rejects.toThrow("already owned");
      expect((await call("/health")).status).toBe(200);
    } finally {
      await second?.stop();
      await first.stop();
    }
  });

  it("refuses requests before initialization and rolls back a socket chmod failure", async () => {
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const startup = startLocalJobs(
      {
        socketPath: join(dir, "jobs.sock"),
        profilesPath: join(dir, "profiles.json"),
        maxConcurrent: 1,
        workRoot: join(dir, "runs"),
      },
      () => {},
      {
        chmod: async () => {
          entered.resolve();
          await finish.promise;
          throw new Error("chmod failed");
        },
      },
    );
    const rejected = expect(startup).rejects.toThrow("chmod failed");
    await entered.promise;
    try {
      expect((await call("/health")).status).toBe(503);
      expect(
        (await call("/jobs", {
          method: "POST",
          body: JSON.stringify({
            caller: "test",
            profile: "read",
            idempotencyKey: "early",
            task: "t",
            resultSchema: true,
          }),
        })).status,
      ).toBe(503);
    } finally {
      finish.resolve();
      await rejected;
    }
    for (const name of ["jobs.sock", "jobs.sock.token"]) {
      await expect(Deno.stat(join(dir, name))).rejects.toThrow(
        Deno.errors.NotFound,
      );
    }
    const next = await start().service;
    await next.stop();
  });

  for (const kind of ["directory", "dangling symlink"] as const) {
    it(`preserves a pre-existing token ${kind} when token writing fails`, async () => {
      const tokenPath = join(dir, "jobs.sock.token");
      const target = join(dir, "missing", "token");
      if (kind === "directory") await Deno.mkdir(tokenPath);
      else await Deno.symlink(target, tokenPath);
      await expect(start().service).rejects.toThrow();
      const stat = await Deno.lstat(tokenPath);
      if (kind === "directory") expect(stat.isDirectory).toBe(true);
      else {
        expect(stat.isSymlink).toBe(true);
        expect(await Deno.readLink(tokenPath)).toBe(target);
      }
      await Deno.remove(tokenPath);
      const next = await start().service;
      await next.stop();
    });
  }

  it("throws when something other than a socket file stands at the socket path", async () => {
    await Deno.mkdir(join(dir, "jobs.sock", "inside"), { recursive: true });

    await expect(start().service).rejects.toThrow();
  });

  it("throws when the profile file cannot be read", async () => {
    await Deno.writeTextFile(join(dir, "profiles.json"), "{");

    await expect(start().service).rejects.toThrow();
  });
  it("hosts a job's browser end to end: a client on the socket answers each operation, acknowledges a withdrawal, and is told the job closed", async () => {
    await Deno.writeTextFile(
      join(dir, "browse.json"),
      JSON.stringify({
        browse: { ...PROFILES.read, browserHost: true },
      }),
    );
    /** What the client saw and did, in order. */
    const log: string[] = [];
    let clickAnswer: unknown;
    let clickDelivered = () => {};
    const delivered = new Promise<void>((resolve) => clickDelivered = resolve);
    const running = await startLocalJobs(
      {
        socketPath: join(dir, "jobs.sock"),
        profilesPath: join(dir, "browse.json"),
        maxConcurrent: 1,
        workRoot: join(dir, "runs"),
      },
      () => {},
      {
        // The job's run, scripted: it browses through the host it was
        // handed, under the tools and profiles the lane gave it.
        runJob: async (spec, options): Promise<HarnessJobResult> => {
          const host = options.browserHost!;
          log.push(`run ${spec.tools.join(",")} ${spec.subagentProfiles}`);
          const opened = await host.perform({
            action: "open",
            url: "https://example.com",
          });
          const snapshot = await host.perform({
            action: "snapshot",
            interactive: true,
          });
          const abort = new AbortController();
          const click = host.perform(
            { action: "click", ref: "@e1" },
            abort.signal,
          ).catch((error) => `rejected: ${error.message}`);
          await delivered;
          abort.abort(new Error("the run moved on"));
          // The withdrawn call rejects at once; the host's answer to it is
          // the acknowledgment the next operation waits on.
          clickAnswer = await click;
          const title = await host.perform({ action: "get", kind: "title" });
          return {
            outcome: "completed",
            structuredResult: { opened, snapshot, title },
            handleTable: {} as never,
          };
        },
      },
    );
    const token = await Deno.readTextFile(join(dir, "jobs.sock.token"));
    const client = Deno.createHttpClient({
      proxy: { transport: "unix", path: join(dir, "jobs.sock") },
    } as never);
    const request = (path: string, init: RequestInit = {}) =>
      fetch(`http://runner${path}`, {
        ...init,
        headers: { authorization: `Bearer ${token}` },
        client,
      } as never);
    try {
      const enqueued = await (await request("/jobs", {
        method: "POST",
        body: JSON.stringify({
          caller: "test",
          profile: "browse",
          idempotencyKey: "browse-1",
          task: "Find the opening hours.",
          resultSchema: { type: "object" },
          browserHost: {},
        }),
      })).json();
      const id = enqueued.job.id;
      const answer = async (operationId: string, result: unknown) => {
        const response = await request(`/jobs/${id}/browser/result`, {
          method: "POST",
          body: JSON.stringify({ id: operationId, result }),
        });
        log.push(`posted ${operationId} ${response.status}`);
      };
      const page = { url: "https://example.com/", title: "Example" };

      // The fake host: reads the stream and answers as the Weaver would.
      const stream = await request(`/jobs/${id}/browser/stream`);
      const lines = stream.body!.pipeThrough(new TextDecoderStream())
        .getReader();
      let buffer = "";
      read: for (;;) {
        const { value, done } = await lines.read();
        if (done) break;
        buffer += value;
        let end: number;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const event = /^event: (.*)$/m.exec(frame)?.[1];
          if (event === undefined) continue;
          const data = JSON.parse(/^data: (.*)$/m.exec(frame)![1]);
          log.push(
            `${event}${data.id !== undefined ? ` ${data.id}` : ""}${
              data.operation !== undefined ? ` ${data.operation.action}` : ""
            }`,
          );
          if (event === "close") break read;
          if (event === "withdraw") {
            await answer(data.id, { status: "failed", message: "withdrawn" });
          } else if (data.operation.action === "click") {
            clickDelivered();
          } else {
            await answer(data.id, {
              status: "ok",
              page,
              ...(data.operation.action === "snapshot"
                ? { text: '- heading "Hours" [ref=e1]' }
                : {}),
            });
          }
        }
      }

      expect(log).toEqual([
        "run loom_search,delegate_task browser",
        "request 1 open",
        "posted 1 200",
        "request 2 snapshot",
        "posted 2 200",
        "request 3 click",
        "withdraw 3",
        "posted 3 200",
        "request 4 get",
        "posted 4 200",
        "close",
      ]);
      expect(clickAnswer).toBe("rejected: the run moved on");
      const events = await (await request(`/jobs/${id}/events`)).text();
      expect(events).toContain('"state":"completed"');
      const { job } = await (await request(`/jobs/${id}`)).json();
      expect(job.result).toEqual({
        opened: { status: "ok", page },
        snapshot: { status: "ok", page, text: '- heading "Hours" [ref=e1]' },
        title: { status: "ok", page },
      });
      expect(job.browser).toMatchObject({ state: "closed", outstanding: 0 });
    } finally {
      client.close();
      await running.stop();
    }
  });
});
