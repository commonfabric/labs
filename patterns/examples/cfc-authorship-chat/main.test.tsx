import { assert, NAME, pattern, TESTS, UI } from "commonfabric";
import {
  findNodeByProp,
  hasText,
  propValue,
  readValue,
} from "../../tools/test-support/vnode-helpers.ts";
import AuthorshipChat from "./main.tsx";

const surface = (root: unknown, name: string) =>
  findNodeByProp(root, "data-authorship-surface", name);

// Whether a block verifies its content's integrity and refuses literal text,
// which is what lets it refuse a forged claim.
const verifiesTextOnly = (root: unknown, name: string): boolean =>
  propValue(surface(root, name), "verifyTextIntegrity") === true &&
  propValue(surface(root, name), "allowLiteralText") === false;

// The integrity each block's author claim requires its content to carry, as
// the block hands it to `cf-cfc-authorship`.
const requiredSubject = (root: unknown, name: string): unknown => {
  const required = readValue(
    propValue(surface(root, name), "requiredTextIntegrity"),
  );
  return typeof required === "object" && required !== null &&
      "kind" in required && required.kind === "authored-by" &&
      "subject" in required
    ? required.subject
    : undefined;
};

export default pattern(() => {
  const instance = AuthorshipChat({});

  const assert_names_itself = assert(() =>
    instance[NAME] === "CFC authorship chat demo"
  );
  const assert_verified_fixture_names_alice = assert(() =>
    instance.verifiedAuthor === "Alice Nguyen"
  );
  const assert_forged_fixture_names_bob = assert(() =>
    instance.forgedClaim === "Bob Patel"
  );
  const assert_unsigned_fixture_names_casey = assert(() =>
    instance.unsignedState === "Casey Morgan"
  );

  // Each block requires authorship by the sender it claims, so only the
  // block whose content is labeled authored-by that sender can be certified:
  // the forged block claims Bob over content labeled authored-by Alice, and
  // the unsigned block's content carries no authorship label at all.
  const assert_verified_block_requires_alice = assert(() =>
    requiredSubject(instance[UI], "verified") === "alice" &&
    hasText(surface(instance[UI], "verified"), "Alice Nguyen") &&
    verifiesTextOnly(instance[UI], "verified")
  );
  const assert_forged_block_requires_bob = assert(() =>
    requiredSubject(instance[UI], "forged") === "bob" &&
    hasText(surface(instance[UI], "forged"), "Bob Patel") &&
    hasText(surface(instance[UI], "forged"), "I definitely authored") &&
    verifiesTextOnly(instance[UI], "forged")
  );
  const assert_unsigned_block_requires_casey = assert(() =>
    requiredSubject(instance[UI], "unsigned") === "casey" &&
    hasText(surface(instance[UI], "unsigned"), "Casey Morgan") &&
    verifiesTextOnly(instance[UI], "unsigned")
  );
  const assert_channels_render = assert(() =>
    hasText(
      findNodeByProp(instance[UI], "data-authorship-card", "verified"),
      "Project chat",
    ) &&
    hasText(
      findNodeByProp(instance[UI], "data-authorship-card", "unsigned"),
      "Imported ticket thread",
    )
  );

  return {
    [TESTS]: [
      { assertion: assert_names_itself },
      { assertion: assert_verified_fixture_names_alice },
      { assertion: assert_forged_fixture_names_bob },
      { assertion: assert_unsigned_fixture_names_casey },
      { assertion: assert_verified_block_requires_alice },
      { assertion: assert_forged_block_requires_bob },
      { assertion: assert_unsigned_block_requires_casey },
      { assertion: assert_channels_render },
    ],
    instance,
  };
});
