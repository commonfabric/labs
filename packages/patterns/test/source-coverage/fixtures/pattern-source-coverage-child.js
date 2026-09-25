// deno-lint-ignore-file cf-imports/no-inline-module-import -- the patterns must
// load inside the coverage run, which is what this child process exists to
// measure.

import {
  clearFetchJsonResult,
  clearGenerateTextResult,
  clearWishResults,
  findEventHandlers,
  NAME,
  setFetchJsonResult,
  setGenerateTextResult,
  setWishResult,
  textContent,
  UI,
  Writable,
} from "../../../tools/test-support/source-coverage-commonfabric.ts";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function instantiatePattern(factory, input) {
  return factory(input);
}

function uiOf(value) {
  return value[UI];
}

function elementsOfType(node, type) {
  if (node == null || typeof node !== "object") return [];
  if (Array.isArray(node)) {
    return node.flatMap((child) => elementsOfType(child, type));
  }
  const matches = node.type === type ? [node] : [];
  return matches.concat(elementsOfType(node.children, type));
}

if (Deno.env.get("SOURCE_COVERAGE_CHILD") === "1") {
  Deno.test("changed pattern source paths execute under plain Deno coverage", async () => {
    const { default: DoList } = await import("../../../do-list/do-list.tsx");
    const doItems = new Writable([
      {
        title: "Done",
        done: true,
        indent: 0,
        aiEnabled: false,
        attachments: [],
      },
    ]);
    const doList = instantiatePattern(DoList, { items: doItems });
    const compactArchiveHandlers = findEventHandlers(
      doList.compactUI,
      "onClick",
    );
    const screenArchiveHandlers = findEventHandlers(uiOf(doList), "onClick");
    assert(
      compactArchiveHandlers.length > 0 && screenArchiveHandlers.length > 0,
      "expected archive buttons in both UIs",
    );
    compactArchiveHandlers[0]();
    screenArchiveHandlers[0]();
    assert(
      doItems.get().length === 0,
      "archive buttons remove completed items",
    );

    const { default: FetchJsonDynamic } = await import(
      "../../../gideon-tests/test-30-fetchjson-dynamic-instantiation.tsx"
    );
    const fetchJsonDynamic = instantiatePattern(FetchJsonDynamic, {
      repos: [
        { id: "1", name: "react" },
        { id: "2", name: "vue" },
      ],
    });
    const repos = fetchJsonDynamic.repos;
    assert(
      Array.isArray(repos) && repos.length === 2,
      "fetch-json dynamic pattern keeps input repos",
    );
    assert(
      textContent(uiOf(fetchJsonDynamic)).includes("Stars: 123"),
      "fetch-json dynamic pattern renders typed star counts",
    );

    const { default: FetchJsonExample } = await import(
      "../../../examples/fetch-json.tsx"
    );
    const fetchJsonExample = instantiatePattern(FetchJsonExample, {
      repoUrl: new Writable("https://github.com/vercel/next.js"),
    });
    assert(
      textContent(uiOf(fetchJsonExample)).includes("123"),
      "fetch-json example renders the typed repo star count",
    );

    const { default: SharedProfileDemo } = await import(
      "../../../shared-profile-demo/main.tsx"
    );
    clearWishResults();
    setWishResult("#profile", { initialNameApplied: "Ada Lovelace" });
    setWishResult("#profileName", "Fallback Name");
    const sharedProfile = instantiatePattern(SharedProfileDemo, {});
    assert(
      textContent(uiOf(sharedProfile)).includes("Ada Lovelace"),
      "shared profile demo uses the typed profile wish result first",
    );

    const { default: Journal } = await import("../../../system/journal.tsx");
    clearWishResults();
    setWishResult("#journal", [
      {
        timestamp: Date.now(),
        eventType: "piece:created",
        subject: new Writable({ [NAME]: "Journal subject" }),
        snapshot: { name: "Journal subject" },
        narrative: "Created a journal subject",
        tags: ["created"],
      },
    ]);
    const journal = instantiatePattern(Journal, {});
    assert(
      textContent(uiOf(journal)).includes("Journal subject"),
      "journal renders entries with typed subject cells",
    );

    const { default: GithubActivity } = await import(
      "../../../../connectors/github/activity-view/main.tsx"
    );
    setFetchJsonResult([
      {
        sha: "abc123",
        html_url: "https://github.com/acme/project/commit/abc123",
        commit: {
          message: "Ship connector tests\n\nMore detail",
          author: { name: "Ada", date: "2026-08-26T00:00:00.000Z" },
        },
      },
    ]);
    setGenerateTextResult({
      pending: false,
      result: "Connector coverage improved.",
      error: undefined,
    });
    const githubActivity = instantiatePattern(GithubActivity, {
      repoUrl: new Writable("https://github.com/acme/project"),
    });
    assert(
      githubActivity[NAME] === "GitHub Activity: acme/project",
      "GitHub activity names the parsed repository",
    );
    assert(
      textContent(uiOf(githubActivity)).includes("Ship connector tests") &&
        textContent(uiOf(githubActivity)).includes(
          "Connector coverage improved.",
        ),
      "GitHub activity renders commit and summary details",
    );

    const synchronizedStatuses = [
      "green-and-can-land",
      "tests-running",
      "tests-failed",
      "merge-conflicts",
      "merge-blocked",
      "visibility-unknown",
      "draft",
    ];
    const synchronizedGithubActivity = instantiatePattern(GithubActivity, {
      repoUrl: new Writable("https://github.com/acme/project"),
      pullRequestIndex: {
        schema: "commonfabric.github-connector.pull-request-index.v1",
        formatVersion: 1,
        viewer: "octocat",
        generatedAt: "2026-08-28T02:00:00.000Z",
        lastCompleteCollectionAt: "2026-08-28T01:59:00.000Z",
        generation: 42,
        pullRequests: synchronizedStatuses.map((status, index) => ({
          id: `PR_${index}`,
          number: index + 1,
          url: `https://github.com/acme/project/pull/${index + 1}`,
          title: `Synchronized ${status}`,
          repository: index === 0 ? "acme/widgets" : "acme/project",
          repositoryUrl: index === 0
            ? "https://github.com/acme/widgets"
            : "https://github.com/acme/project",
          baseRefName: "main",
          baseRefOid: "0123456789abcdef",
          headRefName: `feature-${index}`,
          headRefOid: index === 0 ? null : "fedcba9876543210",
          headRepository: index === 0 ? null : "contributor/project",
          headRepositoryUrl: index === 0
            ? null
            : "https://github.com/contributor/project",
          isDraft: status === "draft",
          mergeable: index === 0 ? "UNKNOWN" : "MERGEABLE",
          mergeState: index === 0 ? "" : "CLEAN",
          reviewDecision: index === 0 ? null : "APPROVED",
          checkState: index === 0 ? null : "SUCCESS",
          createdAt: index === 0 ? "not-a-date" : "2026-08-27T00:00:00.000Z",
          updatedAt: `2026-08-28T01:5${index}:00.000Z`,
          observedAt: "2026-08-28T01:59:00.000Z",
          visibility: status === "visibility-unknown" ? "unknown" : "visible",
          status,
          detail: { schema: "commonfabric.github-connector.pull-request.v1" },
        })),
      },
      health: {
        schema: "commonfabric.github-connector.health.v1",
        service: "github-host",
        formatVersion: 1,
        status: "degraded",
        startedAt: "2026-08-28T01:00:00.000Z",
        updatedAt: "2026-08-28T02:00:00.000Z",
        target: {
          spaceDid: "did:key:space",
          cells: { index: "of:index", health: "of:health" },
        },
        sync: {
          reason: "scheduled",
          status: "failed",
          startedAt: "2026-08-28T01:58:00.000Z",
          completedAt: "2026-08-28T01:59:00.000Z",
          error: "One repository was unavailable",
        },
        lastComplete: {
          completedAt: "2026-08-28T01:59:00.000Z",
          pullRequestCount: synchronizedStatuses.length,
        },
      },
    });
    const synchronizedText = textContent(uiOf(synchronizedGithubActivity));
    assert(
      synchronizedGithubActivity[NAME] ===
          "GitHub pull requests: octocat" &&
        synchronizedGithubActivity.pullRequestCount === 7 &&
        synchronizedGithubActivity.repositoryCount === 2 &&
        synchronizedGithubActivity.readyToLandCount === 1 &&
        synchronizedGithubActivity.needsAttentionCount === 4,
      "GitHub activity summarizes the synchronized index",
    );
    assert(
      synchronizedText.includes("Synchronized green-and-can-land") &&
        synchronizedText.includes("Ready to land") &&
        synchronizedText.includes("One repository was unavailable") &&
        synchronizedText.includes("feature-0 → main"),
      "GitHub activity renders synchronized pull requests and health",
    );
    const statusBadges = elementsOfType(
      uiOf(synchronizedGithubActivity),
      "cf-badge",
    );
    for (
      const [label, color] of [
        ["Ready to land", "primary"],
        ["Tests running", "accent"],
        ["Tests failed", "danger"],
        ["Merge conflicts", "danger"],
        ["Merge blocked", "neutral"],
        ["Visibility unknown", "accent"],
        ["Draft", "neutral"],
      ]
    ) {
      assert(
        statusBadges.some((badge) =>
          badge.props.color === color && textContent(badge).includes(label)
        ),
        `GitHub activity renders ${label} with the ${color} badge color`,
      );
    }
    assert(
      synchronizedGithubActivity.pullRequests.every((row) =>
        !("detail" in row)
      ),
      "GitHub activity excludes opaque details from its shallow output",
    );

    const emptySynchronizedIndex = {
      schema: "commonfabric.github-connector.pull-request-index.v1",
      formatVersion: 1,
      viewer: "octocat",
      generatedAt: "",
      lastCompleteCollectionAt: "",
      generation: 43,
      pullRequests: [],
    };
    const emptySynchronizedGithubActivity = instantiatePattern(GithubActivity, {
      repoUrl: new Writable("https://github.com/acme/project"),
      pullRequestIndex: emptySynchronizedIndex,
    });
    const stoppedHealth = {
      schema: "commonfabric.github-connector.health.v1",
      service: "github-host",
      formatVersion: 1,
      status: "stopped",
      startedAt: "2026-08-28T01:00:00.000Z",
      updatedAt: "2026-08-28T02:00:00.000Z",
      target: {
        spaceDid: "did:key:space",
        cells: { index: "of:index", health: "of:health" },
      },
    };
    const hostActivity = (status, healthFields = {}) =>
      instantiatePattern(GithubActivity, {
        repoUrl: new Writable("https://github.com/acme/project"),
        pullRequestIndex: emptySynchronizedIndex,
        health: {
          ...stoppedHealth,
          status,
          ...healthFields,
        },
      });
    const stoppedGithubActivity = hostActivity("stopped");
    const hostStatusCases = [
      [
        "ready",
        "primary",
        hostActivity("ready", {
          sync: {
            reason: "scheduled",
            status: "complete",
            startedAt: "2026-08-28T01:58:00.000Z",
            completedAt: "2026-08-28T01:59:00.000Z",
            pullRequestCount: 0,
          },
          lastComplete: {
            completedAt: "2026-08-28T01:59:00.000Z",
            pullRequestCount: 0,
          },
        }),
        "complete",
      ],
      ["degraded", "danger", synchronizedGithubActivity, "failed"],
      ["starting", "accent", hostActivity("starting")],
      [
        "syncing",
        "accent",
        hostActivity("syncing", {
          sync: {
            reason: "scheduled",
            status: "running",
            startedAt: "2026-08-28T01:58:00.000Z",
          },
        }),
        "running",
      ],
      ["stopped", "neutral", stoppedGithubActivity],
    ];
    const emptyStateMessages = elementsOfType(
      uiOf(emptySynchronizedGithubActivity),
      "cf-empty-state",
    ).map((node) => node.props.message);
    assert(
      emptySynchronizedGithubActivity.pullRequestCount === 0 &&
        emptySynchronizedGithubActivity.repositoryCount === 0 &&
        emptyStateMessages.includes("No synchronized pull requests") &&
        emptyStateMessages.includes("No recent pull-request activity") &&
        emptyStateMessages.includes(
          "No connector health snapshot is connected",
        ),
      "GitHub activity renders empty synchronized states",
    );
    for (const [status, color, activity, syncStatus] of hostStatusCases) {
      const badges = elementsOfType(uiOf(activity), "cf-badge");
      assert(
        badges.some((badge) =>
          badge.props.color === color && textContent(badge).includes(status)
        ),
        `GitHub activity renders ${status} with the ${color} host badge`,
      );
      if (syncStatus !== undefined) {
        const rows = elementsOfType(uiOf(activity), "tr").map(textContent);
        assert(
          rows.some((row) =>
            row.includes("Last sync") && row.includes(syncStatus)
          ),
          `GitHub activity renders the ${status} host's ${syncStatus} sync`,
        );
      }
    }
    const stoppedRows = elementsOfType(
      uiOf(stoppedGithubActivity),
      "tr",
    ).map(textContent);
    for (
      const label of [
        "Last sync",
        "Reason",
        "Sync started",
        "Sync completed",
        "Reported PR count",
        "Error",
      ]
    ) {
      assert(
        stoppedRows.some((row) => row.includes(label) && row.includes("—")),
        `GitHub activity renders the missing ${label.toLowerCase()} value`,
      );
    }

    setFetchJsonResult([]);
    setGenerateTextResult({
      pending: true,
      result: undefined,
      error: undefined,
    });
    const pendingGithubActivity = instantiatePattern(GithubActivity, {
      repoUrl: new Writable("not a GitHub URL"),
    });
    assert(
      pendingGithubActivity[NAME] === "GitHub Activity: GitHub Activity",
      "GitHub activity falls back for an invalid repository URL",
    );
    assert(
      textContent(uiOf(pendingGithubActivity)).includes("Generating summary") &&
        textContent(uiOf(pendingGithubActivity)).includes("No commits found"),
      "GitHub activity renders pending and empty states",
    );
    clearFetchJsonResult();
    clearGenerateTextResult();
  });
}
