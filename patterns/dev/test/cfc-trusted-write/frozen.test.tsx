import { assert, pattern, TESTS } from "commonfabric";
import Frozen from "./frozen.tsx";

// Only `freeze` may write the record. Each other handler's write is refused
// at commit, so the record keeps what `freeze` wrote; a refused handler logs
// its refusal, which is why console warnings are allowed.
export default pattern(() => {
  const subject = Frozen({});
  const assert_frozen = assert(() =>
    subject.frozen.digest === "sealed" && subject.frozen.tags[0] === "checked"
  );
  const assert_digest_kept = assert(() => subject.frozen.digest === "sealed");
  const assert_record_kept = assert(() =>
    subject.frozen.digest === "sealed" && subject.frozen.tags[0] === "checked"
  );
  const assert_tags_kept = assert(() =>
    subject.frozen.tags.length === 1 && subject.frozen.tags[0] === "checked"
  );

  return {
    [TESTS]: [
      { action: subject.freeze },
      { assertion: assert_frozen },
      { action: subject.rewriteDigest },
      { assertion: assert_digest_kept },
      { action: subject.replaceWithText },
      { assertion: assert_record_kept },
      { action: subject.replaceTags },
      { assertion: assert_tags_kept },
    ],
    subject,
    allowConsoleWarnings: true,
  };
});
