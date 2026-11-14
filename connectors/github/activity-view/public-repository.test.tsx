/**
 * Test Pattern: GitHub activity for a public repository
 *
 * With no connector index the view falls back to the repository URL: it names
 * the repository it parsed, fetches its recent commits, and asks for a
 * summary of the commits' first lines, which it shows once it arrives. A URL
 * that names no repository fetches nothing and asks for no summary.
 *
 * Run: deno task cf test connectors/github/activity-view/public-repository.test.tsx --root .
 */
import { assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  findElement,
  findElementByText,
  hasText,
  propValue,
  textContent,
} from "../../../patterns/tools/test-support/vnode-helpers.ts";
import GithubActivity from "./main.tsx";

export const fetchMocks = [
  {
    urlIncludes: "api.github.com/repos/acme/project/commits",
    contentType: "application/json",
    body: JSON.stringify([
      {
        sha: "abc123",
        html_url: "https://github.com/acme/project/commit/abc123",
        commit: {
          message: "Ship connector tests\n\nMore detail",
          author: { name: "Ada", date: "2026-08-26T00:00:00.000Z" },
        },
      },
    ]),
  },
];

const SUMMARY = "The team shipped connector tests.";

export const llmMocks = [
  { promptIncludes: "Recent commits:\n- Ship connector tests", text: SUMMARY },
];

export default pattern(() => {
  const repository = GithubActivity({
    repoUrl: "https://github.com/acme/project",
  });
  const unparsed = GithubActivity({ repoUrl: "not a GitHub URL" });

  const assert_names_the_repository = assert(() =>
    repository[NAME] === "GitHub Activity: acme/project"
  );
  const assert_binds_the_url_input = assert(() =>
    propValue(findElement(repository[UI], "cf-input"), "$value") ===
      "https://github.com/acme/project"
  );
  const assert_renders_fetched_commits = assert(() => {
    const ui = repository[UI];
    const text = textContent(ui);
    return text.includes("Ship connector tests") &&
      !text.includes("More detail") && !text.includes("No commits found") &&
      propValue(findElementByText(ui, "a", "View commit"), "href") ===
        "https://github.com/acme/project/commit/abc123";
  });
  const assert_shows_the_commit_summary = assert(() => {
    const ui = repository[UI];
    return hasText(ui, "Activity Summary") && hasText(ui, SUMMARY) &&
      !hasText(ui, "Generating summary");
  });
  const assert_summarizes_nothing_without_commits = assert(() =>
    !hasText(unparsed[UI], "Generating summary") &&
    !hasText(unparsed[UI], "Activity Summary")
  );
  const assert_falls_back_for_an_unparsed_url = assert(() =>
    unparsed[NAME] === "GitHub Activity: GitHub Activity" &&
    hasText(unparsed[UI], "No commits found")
  );
  const assert_reports_no_pull_requests = assert(() =>
    repository.pullRequestCount === 0 && repository.pullRequests.length === 0
  );

  return {
    [TESTS]: [
      { assertion: assert_names_the_repository },
      { assertion: assert_binds_the_url_input },
      { settle: true },
      { assertion: assert_renders_fetched_commits },
      { assertion: assert_shows_the_commit_summary },
      { assertion: assert_summarizes_nothing_without_commits },
      { assertion: assert_falls_back_for_an_unparsed_url },
      { assertion: assert_reports_no_pull_requests },
    ],
  };
});
