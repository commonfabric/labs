/**
 * The sentences Home's private-inbox refusal notice shows for the host's
 * refusal codes. A module of its own, importing nothing, so that a test can
 * hold it to the host's list of codes.
 */

/**
 * What the host's refusal code `reason` says about the refused inbox, as a
 * sentence for the person whose inbox it is, or `undefined` for a code it does
 * not know. The codes are `INBOX_ADOPTION_REFUSALS`, from
 * `packages/piece/src/ops/private-inbox.ts`, and
 * `private-inbox-refusal-text.test.ts` fails while one of them has no sentence
 * here.
 */
export function refusalReasonText(reason: string): string | undefined {
  switch (reason) {
    case "inbox-home-space":
      return "It is in your Home space, where nobody else may deliver.";
    case "inbox-profile-space":
      return "It is in the profile's own space, where nobody else may deliver.";
    case "inbox-access-refused":
      return "Home was refused access to it.";
    case "inbox-adoption-acl-mismatch":
      return "Its space does not make you its owner, or does not let others " +
        "deliver to it.";
    case "inbox-offers-invalid":
      return "It holds no list of offers.";
    case "inbox-receive-missing":
      return "It has no way to receive offers.";
    default:
      return undefined;
  }
}
