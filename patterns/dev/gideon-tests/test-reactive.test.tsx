/**
 * Test: a generic building block that calls `generateObject<T>()` inside
 * `.map()`, with `T` a type parameter, gives one analysis per email and
 * carries each email through beside it.
 *
 * Run: deno task cf test patterns/dev/gideon-tests/test-reactive.test.tsx --root patterns --verbose
 */
import { assert, pattern, TESTS } from "commonfabric";
import GenericGenerateObject from "./test-reactive.tsx";

export default pattern(() => {
  const subject = GenericGenerateObject({
    emails: [
      { id: "a", content: "First email" },
      { id: "b", content: "Second email" },
    ],
  });

  const assert_one_analysis_per_email = assert(() =>
    subject.data.analyses.length === 2
  );
  const assert_emails_carried_through = assert(() =>
    subject.data.analyses[0]?.email.id === "a" &&
    subject.data.analyses[0]?.email.content === "First email" &&
    subject.data.analyses[1]?.email.id === "b" &&
    subject.data.analyses[1]?.email.content === "Second email"
  );

  return {
    [TESTS]: [
      { assertion: assert_one_analysis_per_email },
      { assertion: assert_emails_carried_through },
    ],
    // The language-model builtin warns as it traces and fails each request.
    allowConsoleWarnings: true,
    subject,
  };
});

// No outcome is asserted: on the server-execution arm the runtime resets a
// request that settles at once, answered or failed, back to pending.
export const llmMocks = [];
