/**
 * Test: a `fetchJson()` created inside `.map()`, one per element, resolves
 * just as a `fetchJson()` at the top of the pattern body does.
 *
 * The GitHub requests are answered by `fetchMocks`, each repository with its
 * own star count, so each rendered row shows the result of its own request.
 *
 * Run: deno task cf test patterns/dev/gideon-tests/test-30-fetchjson-dynamic-instantiation.test.tsx --root patterns --verbose
 */
import { assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  findNode,
  hasText,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";
import FetchJsonDynamic from "./test-30-fetchjson-dynamic-instantiation.tsx";

export const fetchMocks = [
  {
    urlIncludes: "/repos/facebook/react",
    body: '{"stargazers_count":101}',
  },
  {
    urlIncludes: "/repos/facebook/vue",
    body: '{"stargazers_count":202}',
  },
  {
    urlIncludes: "/repos/facebook/angular",
    body: '{"stargazers_count":303}',
  },
];

// The text of the outermost node whose text starts with `prefix`: one whole
// row of the view, since every container around it starts with other text.
const rowText = (root: unknown, prefix: string): string =>
  textContent(
    findNode(
      root,
      (node) =>
        typeof node === "object" && textContent(node).startsWith(prefix),
    ),
  );

export default pattern(() => {
  const subject = FetchJsonDynamic({
    repos: [
      { id: "1", name: "react" },
      { id: "2", name: "vue" },
      { id: "3", name: "angular" },
    ],
  });

  const assert_named = assert(() =>
    subject[NAME] === "Test #30: fetchJson Dynamic Instantiation"
  );
  const assert_repos_listed = assert(() =>
    subject.repos.length === 3 &&
    hasText(subject[UI], "react (id: 1)") &&
    hasText(subject[UI], "vue (id: 2)") &&
    hasText(subject[UI], "angular (id: 3)")
  );

  const assert_static_fetch_resolved = assert(() =>
    rowText(subject[UI], "URL:") ===
      "URL: https://api.github.com/repos/facebook/react" &&
    rowText(subject[UI], "Result:") === "Result: Stars: 101" &&
    rowText(subject[UI], "Pending:") === "Pending: false"
  );

  // Each fetch made inside .map() answered with its own repository's count,
  // in the order of the repositories. The rows share one container, which is
  // the outermost node starting with the first row's text.
  const assert_dynamic_fetches_resolved = assert(() =>
    rowText(subject[UI], "Repo 1:") ===
      "Repo 1:Pending: false | Error: none | Result: Stars: 101" +
        "Repo 2:Pending: false | Error: none | Result: Stars: 202" +
        "Repo 3:Pending: false | Error: none | Result: Stars: 303"
  );

  return {
    [TESTS]: [
      { assertion: assert_named },
      { assertion: assert_repos_listed },
      // Drive the in-flight requests to completion before reading results.
      { settle: true },
      { assertion: assert_static_fetch_resolved },
      { assertion: assert_dynamic_fetches_resolved },
    ],
    subject,
  };
});
