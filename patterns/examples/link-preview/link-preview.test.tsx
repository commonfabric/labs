import { assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  findElement,
  propValue,
} from "../../tools/test-support/vnode-helpers.ts";
import LinkPreview from "./link-preview.tsx";

export default pattern(() => {
  const fallback = LinkPreview({});
  const chosen = LinkPreview({ url: "https://example.com/post" });

  const assert_defaults_to_github = assert(() =>
    fallback.url === "https://github.com" &&
    fallback[NAME] === "Link Preview: https://github.com"
  );
  const assert_names_the_chosen_url = assert(() =>
    chosen[NAME] === "Link Preview: https://example.com/post"
  );
  const assert_previews_the_chosen_url = assert(() =>
    propValue(findElement(chosen[UI], "cf-link-preview"), "url") ===
      "https://example.com/post"
  );

  return {
    [TESTS]: [
      { assertion: assert_defaults_to_github },
      { assertion: assert_names_the_chosen_url },
      { assertion: assert_previews_the_chosen_url },
    ],
    fallback,
    chosen,
  };
});
