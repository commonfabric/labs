import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import {
  clientsFromEnv,
  hasRecentActivity,
  keyHolderAccounts,
  leaseAction,
  runJanitor,
} from "./test-records-janitor.ts";

function searchFetch(payload: unknown): typeof fetch {
  return (() =>
    Promise.resolve(
      new Response(JSON.stringify(payload), { status: 200 }),
    )) as typeof fetch;
}

function holder(username: string, disabled: boolean) {
  return {
    email: `test-records-gh-${username}@p.iam.gserviceaccount.com`,
    displayName: `Test records key holder: ${username}`,
    disabled,
  };
}

// A GCP-and-GitHub stub for the whole janitor pass: two account-listing
// pages, one activity answer per username, and a log of the enable and
// disable calls the janitor makes.
function janitorFetch(
  activity: Record<string, { total_count: number }>,
  actions: string[],
): typeof fetch {
  return ((input: URL | RequestInfo, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/serviceAccounts?")) {
      const body = url.includes("pageToken=page2")
        ? { accounts: [holder("idle", false), holder("returned", true)] }
        : {
          accounts: [
            holder("active", false),
            holder("mystery", false),
            { email: "unrelated@p.iam.gserviceaccount.com" },
          ],
          nextPageToken: "page2",
        };
      return Promise.resolve(
        new Response(JSON.stringify(body), { status: 200 }),
      );
    }
    if (url.includes("search/issues")) {
      const username = new URL(url).searchParams.get("q")!.match(
        /author:(\S+)/,
      )![1]!;
      const answer = activity[username];
      return Promise.resolve(
        answer === undefined
          ? new Response("rate limited", { status: 403 })
          : new Response(JSON.stringify(answer), { status: 200 }),
      );
    }
    const action = url.match(/serviceAccounts\/([^:]+):(enable|disable)$/);
    if (action !== null && init?.method === "POST") {
      actions.push(`${action[2]} ${action[1]}`);
      return Promise.resolve(new Response("{}", { status: 200 }));
    }
    return Promise.resolve(new Response("unexpected", { status: 500 }));
  }) as typeof fetch;
}

describe("test-records-janitor", () => {
  describe("leaseAction()", () => {
    it("returns disable only for an inactive, enabled account", () => {
      expect(leaseAction({ disabled: false, active: false })).toBe("disable");
      expect(leaseAction({ disabled: false, active: true })).toBe("none");
      expect(leaseAction({ disabled: true, active: true })).toBe("enable");
      expect(leaseAction({ disabled: true, active: false })).toBe("none");
    });
  });

  describe("keyHolderAccounts()", () => {
    it("returns only accounts with our prefix and display name", () => {
      const holders = keyHolderAccounts([
        {
          email: "test-records-gh-octocat@p.iam.gserviceaccount.com",
          displayName: "Test records key holder: octocat",
          disabled: false,
        },
        {
          email: "test-records-relay-labs@p.iam.gserviceaccount.com",
          displayName: "Test Records Relay - labs",
        },
        {
          email: "test-records-gh-mangled@p.iam.gserviceaccount.com",
          displayName: "Something else entirely",
        },
        { displayName: "Test records key holder: ghost" },
      ]);
      expect(holders).toEqual([{
        email: "test-records-gh-octocat@p.iam.gserviceaccount.com",
        username: "octocat",
        disabled: false,
      }]);
    });
  });

  describe("hasRecentActivity()", () => {
    const clients = (payload: unknown) => ({
      gcpToken: "t",
      fetchImpl: searchFetch(payload),
    });

    it("returns true for a positive search count", async () => {
      expect(
        await hasRecentActivity(clients({ total_count: 2 }), "o", "2026-07-19"),
      ).toBe(true);
    });

    it("returns false for a complete zero", async () => {
      expect(
        await hasRecentActivity(
          clients({ total_count: 0, incomplete_results: false }),
          "o",
          "2026-07-19",
        ),
      ).toBe(false);
    });

    it("returns unknown for a partial zero", async () => {
      expect(
        await hasRecentActivity(
          clients({ total_count: 0, incomplete_results: true }),
          "o",
          "2026-07-19",
        ),
      ).toBeUndefined();
    });

    it("returns unknown for an answer that carries no count", async () => {
      expect(
        await hasRecentActivity(
          clients({ message: "Validation Failed" }),
          "o",
          "2026-07-19",
        ),
      ).toBeUndefined();
    });

    it("returns unknown and warns when the lookup cannot reach GitHub", async () => {
      const warned: string[] = [];
      const warn = console.warn;
      console.warn = (line: string) => warned.push(line);
      let active: boolean | undefined;
      try {
        active = await hasRecentActivity(
          {
            gcpToken: "t",
            fetchImpl: () => Promise.reject(new TypeError("network down")),
          },
          "octocat",
          "2026-07-19",
        );
      } finally {
        console.warn = warn;
      }
      expect(active).toBeUndefined();
      expect(warned).toEqual([
        "janitor: activity lookup for octocat failed: TypeError: network down",
      ]);
    });

    it("searches the lease repositories with the GitHub token it holds", async () => {
      const requests: Request[] = [];
      await hasRecentActivity(
        {
          gcpToken: "t",
          githubToken: "gh-probe",
          fetchImpl: (input, init) => {
            requests.push(new Request(input, init));
            return Promise.resolve(
              new Response(JSON.stringify({ total_count: 1 })),
            );
          },
        },
        "octocat",
        "2026-07-19",
      );
      expect(requests.length).toBe(1);
      expect(requests[0]!.headers.get("authorization")).toBe(
        "Bearer gh-probe",
      );
      expect(new URL(requests[0]!.url).searchParams.get("q")).toBe(
        "repo:commonfabric/labs type:pr author:octocat updated:>=2026-07-19",
      );
    });
  });

  describe("clientsFromEnv()", () => {
    const fetchImpl = searchFetch({});

    it("returns the broker token and the GitHub CLI's token", () => {
      const env: Record<string, string> = {
        TEST_RECORDS_GCP_TOKEN: "gcp",
        GH_TOKEN: "gh",
        GITHUB_TOKEN: "actions",
      };
      expect(clientsFromEnv((name) => env[name], fetchImpl)).toEqual({
        gcpToken: "gcp",
        githubToken: "gh",
        fetchImpl,
      });
    });

    it("returns the workflow's token where the GitHub CLI's is unset", () => {
      const env: Record<string, string> = {
        TEST_RECORDS_GCP_TOKEN: "gcp",
        GITHUB_TOKEN: "actions",
      };
      expect(clientsFromEnv((name) => env[name], fetchImpl).githubToken)
        .toBe("actions");
    });

    it("returns no GitHub token for an empty one", () => {
      const env: Record<string, string> = {
        TEST_RECORDS_GCP_TOKEN: "gcp",
        GH_TOKEN: "",
      };
      expect(clientsFromEnv((name) => env[name], fetchImpl)).toEqual({
        gcpToken: "gcp",
        fetchImpl,
      });
    });

    it("throws without the broker token", () => {
      expect(() =>
        clientsFromEnv(
          (name) => name === "TEST_RECORDS_GCP_TOKEN" ? "" : undefined,
          fetchImpl,
        )
      ).toThrow("TEST_RECORDS_GCP_TOKEN is not set");
    });
  });

  describe("runJanitor()", () => {
    it("disables the idle, re-enables the returned, and skips the unknown", async () => {
      const actions: string[] = [];
      await runJanitor({
        gcpToken: "t",
        fetchImpl: janitorFetch({
          active: { total_count: 3 },
          idle: { total_count: 0 },
          returned: { total_count: 1 },
          // "mystery" has no answer: its lookup fails and it is skipped.
        }, actions),
      });
      expect(actions.sort()).toEqual([
        "disable test-records-gh-idle@p.iam.gserviceaccount.com",
        "enable test-records-gh-returned@p.iam.gserviceaccount.com",
      ]);
    });

    it("throws when the account listing fails", async () => {
      await expect(runJanitor({
        gcpToken: "t",
        fetchImpl: (() =>
          Promise.resolve(
            new Response("down", { status: 500 }),
          )) as typeof fetch,
      })).rejects.toThrow("listing service accounts");
    });

    it("throws when an enable call fails", async () => {
      await expect(runJanitor({
        gcpToken: "t",
        fetchImpl: ((input: URL | RequestInfo, init?: RequestInit) => {
          const url = String(input);
          if (url.includes("/serviceAccounts?")) {
            return Promise.resolve(
              new Response(
                JSON.stringify({ accounts: [holder("returned", true)] }),
                { status: 200 },
              ),
            );
          }
          if (url.includes("search/issues")) {
            return Promise.resolve(
              new Response(JSON.stringify({ total_count: 1 }), {
                status: 200,
              }),
            );
          }
          if (init?.method === "POST") {
            return Promise.resolve(new Response("denied", { status: 403 }));
          }
          return Promise.resolve(new Response("unexpected", { status: 500 }));
        }) as typeof fetch,
      })).rejects.toThrow("enable of");
    });
  });
});
