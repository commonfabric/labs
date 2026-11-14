import { action, assert, NAME, pattern, TESTS, UI } from "commonfabric";
import { hasText } from "../../tools/test-support/vnode-helpers.ts";
import FetchProgramTest from "./fetch-program-test.tsx";

const BROKEN_URL = "https://example.test/broken.tsx";
const MISSING_URL = "https://example.test/missing.tsx";

// The program the pattern fetches by default, and two that fail: one that does
// not compile and one the server does not have.
export const fetchMocks = [
  {
    urlIncludes: "/patterns/examples/counter/counter.tsx",
    contentType: "text/plain",
    body: `import { NAME, pattern } from "commonfabric";

export default pattern<{ value: number }>(({ value }) => ({
  [NAME]: "Fetched counter",
  value,
}));
`,
  },
  {
    urlIncludes: "/broken.tsx",
    contentType: "text/plain",
    body: "export default pattern(() => {",
  },
  { urlIncludes: "/missing.tsx", status: 404, body: "not found" },
];

export default pattern(() => {
  const subject = FetchProgramTest({});

  const action_fetch_broken = action(() => {
    subject.url.set(BROKEN_URL);
  });
  const action_fetch_missing = action(() => {
    subject.url.set(MISSING_URL);
  });

  const assert_named = assert(() => subject[NAME] === "Fetch Program Test");
  const assert_fetched_program = assert(() =>
    subject.program?.main !== undefined &&
    subject.program.files.length === 1
  );
  const assert_compiled = assert(() =>
    hasText(subject[UI], "Successfully compiled pattern!") &&
    !hasText(subject[UI], "error")
  );
  const assert_compile_error_shown = assert(() =>
    hasText(subject[UI], "Compile error:") &&
    hasText(subject[UI], "'}' expected.") &&
    !hasText(subject[UI], "Successfully compiled pattern!")
  );
  const assert_fetch_error_shown = assert(() =>
    hasText(subject[UI], "Fetch error:") &&
    hasText(subject[UI], "404") &&
    !hasText(subject[UI], "Successfully compiled pattern!")
  );

  return {
    [TESTS]: [
      { assertion: assert_named },
      { settle: true },
      { assertion: assert_fetched_program },
      { assertion: assert_compiled },
      { action: action_fetch_broken },
      { settle: true },
      { assertion: assert_compile_error_shown },
      { action: action_fetch_missing },
      { settle: true },
      { assertion: assert_fetch_error_shown },
    ],
    subject,
  };
});
