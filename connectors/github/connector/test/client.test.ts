import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";
import { createGithubGraphqlTransport, GithubClient } from "../mod.ts";

function pullRequest(number: number, checkState = "SUCCESS") {
  return {
    id: `PR_${number}`,
    number,
    url: `https://github.com/common/labs/pull/${number}`,
    title: `Pull request ${number}`,
    isDraft: false,
    createdAt: "2026-08-20T00:00:00.000Z",
    updatedAt: "2026-08-21T00:00:00.000Z",
    baseRefName: "main",
    baseRefOid: "base",
    headRefName: `feature-${number}`,
    headRefOid: `head-${number}`,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: "APPROVED",
    repository: {
      nameWithOwner: "common/labs",
      url: "https://github.com/common/labs",
    },
    headRepository: {
      nameWithOwner: "common/labs",
      url: "https://github.com/common/labs",
    },
    statusCheckRollup: { state: checkState },
  };
}

function response(
  nodes: unknown[],
  hasNextPage: boolean,
  endCursor: string | null,
  totalCount = nodes.length,
) {
  return {
    data: {
      viewer: {
        login: "ianh",
        pullRequests: {
          totalCount,
          pageInfo: { hasNextPage, endCursor },
          nodes,
        },
      },
    },
  };
}

describe("GithubClient", () => {
  describe("instance members", () => {
    describe("collectOpenPullRequests()", () => {
      it("returns one complete collection across every page", async () => {
        const requests: Array<Record<string, unknown>> = [];
        const pages = [
          response([pullRequest(2)], true, "next", 2),
          response([pullRequest(1, "PENDING")], false, null, 2),
        ];
        const client = new GithubClient((request) => {
          requests.push(request.variables);
          return Promise.resolve(pages.shift());
        }, () => new Date("2026-08-21T12:00:00.000Z"));

        const result = await client.collectOpenPullRequests();

        expect(requests).toEqual([{ after: null }, { after: "next" }]);
        expect(result.viewer).toBe("ianh");
        expect(result.observedAt).toBe("2026-08-21T12:00:00.000Z");
        expect(result.pullRequests.map(({ number, status }) => ({
          number,
          status,
        }))).toEqual([
          { number: 2, status: "green-and-can-land" },
          { number: 1, status: "tests-running" },
        ]);
      });

      it("rejects the collection when a later page fails", async () => {
        let requestCount = 0;
        const client = new GithubClient(() => {
          requestCount++;
          return requestCount === 1
            ? Promise.resolve(response([pullRequest(2)], true, "next", 2))
            : Promise.reject(new Error("offline"));
        });

        await expect(client.collectOpenPullRequests()).rejects.toThrow(
          "offline",
        );
      });

      it("rejects a page that claims another page without a cursor", async () => {
        const client = new GithubClient(() =>
          Promise.resolve(response([], true, null))
        );

        await expect(client.collectOpenPullRequests()).rejects.toThrow(
          "no next cursor",
        );
      });

      it("rejects a repeated pagination cursor", async () => {
        const pages = [
          response([pullRequest(1)], true, "same", 2),
          response([pullRequest(2)], true, "same", 2),
        ];
        const client = new GithubClient(() => Promise.resolve(pages.shift()));

        await expect(client.collectOpenPullRequests()).rejects.toThrow(
          "repeated a pull-request cursor",
        );
      });

      it("retains inaccessible prior pull requests and removes closed ones", async () => {
        const prior = await new GithubClient(() =>
          Promise.resolve(response(
            [
              pullRequest(1),
              pullRequest(2),
            ],
            false,
            null,
            2,
          ))
        ).collectOpenPullRequests();
        const responses = [
          response([], false, null, 0),
          {
            data: {
              nodes: [
                null,
                { __typename: "PullRequest", id: "PR_2", state: "CLOSED" },
              ],
            },
          },
        ];
        const client = new GithubClient(() =>
          Promise.resolve(responses.shift())
        );

        const result = await client.collectOpenPullRequests(
          undefined,
          prior.pullRequests,
        );

        expect(result.pullRequests.map(({ number, visibility, status }) => ({
          number,
          visibility,
          status,
        }))).toEqual([{
          number: 1,
          visibility: "unknown",
          status: "visibility-unknown",
        }]);
      });

      it("parses nullable repository, review, and check fields", async () => {
        const node: Record<string, unknown> = pullRequest(1);
        node.headRepository = null;
        node.reviewDecision = null;
        node.statusCheckRollup = null;
        node.headRefOid = null;
        const client = new GithubClient(() =>
          Promise.resolve(response([node], false, null))
        );

        const [result] = (await client.collectOpenPullRequests()).pullRequests;

        expect(result.headRepository).toBeNull();
        expect(result.headRepositoryUrl).toBeNull();
        expect(result.reviewDecision).toBeNull();
        expect(result.checkState).toBeNull();
        expect(result.headRefOid).toBeNull();
      });

      it("rejects malformed pull-request fields", async () => {
        const cases: Array<[string, (node: Record<string, unknown>) => void]> =
          [
            ["repository must be an object", (node) => {
              node.repository = null;
            }],
            ["id must be a non-empty string", (node) => {
              node.id = "";
            }],
            ["number must be a positive safe integer", (node) => {
              node.number = 0;
            }],
            ["isDraft must be a boolean", (node) => {
              node.isDraft = "false";
            }],
            ["mergeable has an unsupported value", (node) => {
              node.mergeable = "MAYBE";
            }],
            ["reviewDecision has an unsupported value", (node) => {
              node.reviewDecision = "WAITING";
            }],
            ["statusCheckRollup.state has an unsupported value", (node) => {
              node.statusCheckRollup = { state: "QUEUED" };
            }],
          ];
        for (const [message, mutate] of cases) {
          const node: Record<string, unknown> = pullRequest(1);
          mutate(node);
          const client = new GithubClient(() =>
            Promise.resolve(response([node], false, null))
          );
          await expect(client.collectOpenPullRequests()).rejects.toThrow(
            message,
          );
        }
      });

      it("rejects malformed page metadata", async () => {
        const invalidPages: Array<[string, unknown]> = [
          ["GraphQL response must be an object", null],
          ["invalid hasNextPage", {
            data: {
              viewer: {
                login: "ianh",
                pullRequests: {
                  totalCount: 0,
                  pageInfo: { hasNextPage: "false", endCursor: null },
                  nodes: [],
                },
              },
            },
          }],
          ["invalid nodes", {
            data: {
              viewer: {
                login: "ianh",
                pullRequests: {
                  totalCount: 0,
                  pageInfo: { hasNextPage: false, endCursor: null },
                  nodes: null,
                },
              },
            },
          }],
          ["invalid totalCount", response([], false, null, -1)],
        ];
        for (const [message, page] of invalidPages) {
          const client = new GithubClient(() => Promise.resolve(page));
          await expect(client.collectOpenPullRequests()).rejects.toThrow(
            message,
          );
        }
      });

      it("rejects inconsistent pagination", async () => {
        const viewerChanged = response([pullRequest(1)], false, null, 2);
        viewerChanged.data.viewer.login = "someone-else";
        const cases: Array<[string, unknown[]]> = [
          ["viewer changed", [
            response([pullRequest(1)], true, "next", 2),
            viewerChanged,
          ]],
          ["count changed", [
            response([pullRequest(1)], true, "next", 2),
            response([pullRequest(2)], false, null, 3),
          ]],
          ["exceeds safety limit", [response([], false, null, 100_001)]],
          ["pagination exceeded its total", [
            response([pullRequest(1)], true, "next", 1),
            response([pullRequest(2)], false, null, 1),
          ]],
          ["empty pull-request page", [response([], true, "next", 1)]],
          ["duplicate pull request", [
            response([pullRequest(1)], true, "next", 2),
            response([pullRequest(1)], false, null, 2),
          ]],
          ["pages exceed their total", [
            response([pullRequest(1), pullRequest(2)], false, null, 1),
          ]],
          ["returned 1 of 2", [response([pullRequest(1)], false, null, 2)]],
        ];
        for (const [message, pages] of cases) {
          const client = new GithubClient(() => Promise.resolve(pages.shift()));
          await expect(client.collectOpenPullRequests()).rejects.toThrow(
            message,
          );
        }
      });

      it("rejects malformed known pull-request state responses", async () => {
        const prior = await new GithubClient(() =>
          Promise.resolve(response([pullRequest(1)], false, null))
        ).collectOpenPullRequests();
        const replies = [
          response([], false, null),
          { data: { nodes: [] } },
        ];
        const client = new GithubClient(() => Promise.resolve(replies.shift()));

        await expect(client.collectOpenPullRequests(
          undefined,
          prior.pullRequests,
        )).rejects.toThrow("known pull-request response has invalid nodes");
      });

      it("rejects an unsupported known pull-request state", async () => {
        const prior = await new GithubClient(() =>
          Promise.resolve(response([pullRequest(1)], false, null))
        ).collectOpenPullRequests();
        const replies = [
          response([], false, null),
          { data: { nodes: [{ state: "UNKNOWN" }] } },
        ];
        const client = new GithubClient(() => Promise.resolve(replies.shift()));

        await expect(client.collectOpenPullRequests(
          undefined,
          prior.pullRequests,
        )).rejects.toThrow("state has an unsupported value");
      });

      it("honors cancellation before starting collection", async () => {
        const controller = new AbortController();
        controller.abort(new Error("cancelled"));
        let called = false;
        const client = new GithubClient(() => {
          called = true;
          return Promise.resolve(response([], false, null));
        });

        await expect(client.collectOpenPullRequests(controller.signal))
          .rejects.toThrow("cancelled");
        expect(called).toBe(false);
      });
    });
  });
});

describe("createGithubGraphqlTransport", () => {
  it("posts authenticated GraphQL requests and returns their body", async () => {
    const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const fetch: typeof globalThis.fetch = (input, init) => {
      calls.push({ input, init });
      return Promise.resolve(Response.json({ data: { viewer: "ianh" } }));
    };
    const transport = createGithubGraphqlTransport({
      token: "  secret  ",
      endpoint: "https://github.example/graphql",
      fetch,
    });
    const controller = new AbortController();
    const request = {
      query: "query Viewer { viewer { login } }",
      variables: {},
    };

    await expect(transport(request, controller.signal)).resolves.toEqual({
      data: { viewer: "ianh" },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].input).toBe("https://github.example/graphql");
    expect(calls[0].init?.method).toBe("POST");
    expect(calls[0].init?.headers).toEqual({
      accept: "application/vnd.github+json",
      authorization: "Bearer secret",
      "content-type": "application/json",
      "user-agent": "commonfabric-github-host",
    });
    expect(calls[0].init?.body).toBe(JSON.stringify(request));
    expect(calls[0].init?.signal).toBe(controller.signal);
  });

  it("rejects empty credentials and unsuccessful HTTP responses", async () => {
    expect(() => createGithubGraphqlTransport({ token: "  " })).toThrow(
      "GitHub token must not be empty",
    );
    const transport = createGithubGraphqlTransport({
      token: "secret",
      fetch: () =>
        Promise.resolve(new Response("Unauthorized", { status: 401 })),
    });

    await expect(transport({ query: "query", variables: {} })).rejects.toThrow(
      "GitHub GraphQL request failed with 401",
    );
  });

  it("reports every GraphQL error returned by GitHub", async () => {
    const transport = createGithubGraphqlTransport({
      token: "secret",
      fetch: () =>
        Promise.resolve(Response.json({
          errors: [{ message: "first failure" }, {}],
        })),
    });

    await expect(transport({ query: "query", variables: {} })).rejects.toThrow(
      "GitHub GraphQL request failed: first failure; unknown GraphQL error",
    );
  });

  it("reads JSON from a response without a stream body", async () => {
    let jsonCalls = 0;
    const response = {
      ok: true,
      status: 200,
      body: null,
      json: () => {
        jsonCalls++;
        return Promise.resolve({ data: { viewer: "ianh" } });
      },
    } as unknown as Response;
    const transport = createGithubGraphqlTransport({
      token: "secret",
      fetch: () => Promise.resolve(response),
    });

    await expect(transport({ query: "query", variables: {} })).resolves
      .toEqual({ data: { viewer: "ianh" } });

    const controller = new AbortController();
    controller.abort(new Error("shutdown"));
    await expect(
      transport({ query: "query", variables: {} }, controller.signal),
    ).rejects.toThrow("shutdown");
    expect(jsonCalls).toBe(1);
  });

  it("cancels a pending response body when the request is aborted", async () => {
    let bodyCancelled = false;
    const bodyRead = Promise.withResolvers<void>();
    const stream = new ReadableStream<Uint8Array>({
      pull: () => bodyRead.resolve(),
      cancel: () => {
        bodyCancelled = true;
      },
    });
    const response = new Response(stream);
    const transport = createGithubGraphqlTransport({
      token: "secret",
      fetch: () => Promise.resolve(response),
    });
    const controller = new AbortController();
    const result = transport(
      { query: "query", variables: {} },
      controller.signal,
    );

    await bodyRead.promise;
    controller.abort(new Error("shutdown"));

    await expect(result).rejects.toThrow("shutdown");
    expect(bodyCancelled).toBe(true);
  });
});
