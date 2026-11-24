import {
  action,
  assert,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import {
  findElement,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import PatternIndexUrl from "./pattern-index.tsx";

const inputValue = (view: unknown) =>
  propValue(findElement(view, "cf-input"), "$value");

const DEFAULT_URL = "/api/patterns/index.md";
const INDEX_URL = "https://example.test/patterns/index.md";

export default pattern(() => {
  const url = Writable.of(DEFAULT_URL);
  const subject = PatternIndexUrl({ url });

  const action_change_url = action(() => {
    url.set(INDEX_URL);
  });

  const assert_reports_default = assert(() =>
    subject.url === DEFAULT_URL &&
    subject[NAME] === `Pattern Index: ${DEFAULT_URL}`
  );
  // The input is bound to the url cell itself, so it shows what the pattern
  // reports and edits it in place.
  const assert_input_shows_default = assert(() =>
    inputValue(subject[UI]) === DEFAULT_URL
  );
  const assert_reports_new_url = assert(() =>
    subject.url === INDEX_URL &&
    subject[NAME] === `Pattern Index: ${INDEX_URL}`
  );
  const assert_input_shows_new_url = assert(() =>
    inputValue(subject[UI]) === INDEX_URL
  );

  return {
    [TESTS]: [
      { assertion: assert_reports_default },
      { assertion: assert_input_shows_default },
      { action: action_change_url },
      { assertion: assert_reports_new_url },
      { assertion: assert_input_shows_new_url },
    ],
    subject,
  };
});
