import {
  assert,
  handler,
  NAME,
  pattern,
  TESTS,
  UI,
  Writable,
} from "commonfabric";
import Gallery, {
  DISCLAIMER_EXAMPLE_COUNT,
  DISCLAIMER_RENDERED_EXAMPLE_COUNT,
  DisclaimerFactCheckBriefExample,
  DisclaimerPromptRoutingAckExample,
  DisclaimerSourceProvenanceReviewExample,
  TrustedDisclaimerAckHost,
  TrustedFactCheckGateHost,
  TrustedProvenanceReviewHost,
} from "./disclaimer-examples.tsx";
import {
  childNodes,
  textContent,
} from "../../tools/test-support/vnode-helpers.ts";

/** The text of the gallery's card at `index`: the first introduces the
 * gallery and the second is its catalog. Reached by position, since a search
 * would also walk every example the gallery renders. */
const cardText = (view: unknown, index: number): string =>
  textContent(childNodes(childNodes(view)[0])[index]);

const numbered = (titles: readonly string[]): string =>
  "Catalog" + titles.map((title, index) => `${index + 1}. ${title}`).join("");

type AckSuite = ReturnType<typeof TrustedDisclaimerAckHost>;
type ProvenanceSuite = ReturnType<typeof TrustedProvenanceReviewHost>;
type FactCheckSuite = ReturnType<typeof TrustedFactCheckGateHost>;

const runAck = handler<void, { suite: AckSuite }>((_, { suite }) => {
  suite.triggerLookalike.send();
});

const runProvenance = handler<void, { suite: ProvenanceSuite }>((
  _,
  { suite },
) => {
  suite.triggerLookalike.send();
});

const runFactCheck = handler<void, { suite: FactCheckSuite }>((
  _,
  { suite },
) => {
  suite.triggerLookalike.send();
});

const runLookalikeOnly = handler<void, { suite: AckSuite }>((
  _,
  { suite },
) => {
  suite.triggerLookalike.send();
});

export default pattern(() => {
  const gallery = Gallery({});
  const promptRouting = DisclaimerPromptRoutingAckExample({});
  const sourceProvenance = DisclaimerSourceProvenanceReviewExample({});
  const factCheckBrief = DisclaimerFactCheckBriefExample({});
  const influenceAcknowledged = new Writable("");
  const influenceFakeStatus = new Writable("Lookalike control is idle.");
  const influence = TrustedDisclaimerAckHost({
    title: new Writable("Influence disclosure ack"),
    summary: new Writable("Influence disclosure demo"),
    content: new Writable("Recommendation copy"),
    disclaimerText: new Writable(
      "This recommendation may be influenced by campaign goals.",
    ),
    acknowledgedDisclaimer: influenceAcknowledged,
    fakeButton: new Writable("Fake influence ack"),
    fakeMessage: new Writable(
      "The lookalike influence notice did not update trusted state.",
    ),
    fakeStatus: influenceFakeStatus,
  });

  const reviewedProvenance = new Writable("");
  const provenanceFakeStatus = new Writable(
    "Lookalike provenance control is idle.",
  );
  const provenance = TrustedProvenanceReviewHost({
    title: new Writable("Source provenance review"),
    summary: new Writable("Provenance disclosure demo"),
    content: new Writable("Shared source excerpt"),
    provenanceText: new Writable(
      "Source provenance: shared by the project owner.",
    ),
    reviewedProvenance,
    fakeButton: new Writable("Fake provenance review"),
    fakeMessage: new Writable(
      "The lookalike provenance card did not update the reviewed text.",
    ),
    fakeStatus: provenanceFakeStatus,
  });

  const factCheckResult = new Writable("");
  const factCheckFakeStatus = new Writable(
    "Lookalike fact-check gate is idle.",
  );
  const factCheck = TrustedFactCheckGateHost({
    title: new Writable("Fact-check brief gate"),
    summary: new Writable("Fact-check gate demo"),
    content: new Writable("External brief about launch performance."),
    factCheckClaim: new Writable("External brief about launch performance."),
    factCheckResult,
    fakeButton: new Writable("Fake fact-check"),
    fakeMessage: new Writable(
      "The lookalike fact-check gate did not approve the brief.",
    ),
    fakeStatus: factCheckFakeStatus,
  });

  const lookalikeAcknowledged = new Writable("");
  const lookalikeFakeStatus = new Writable("Lookalike control is idle.");
  const lookalike = TrustedDisclaimerAckHost({
    title: new Writable("Lookalike disclaimer host"),
    summary: new Writable("Lookalike-only negative path"),
    content: new Writable("Host-controlled disclaimer demo."),
    disclaimerText: new Writable(
      "Trusted output only changes when the reviewed button is used.",
    ),
    acknowledgedDisclaimer: lookalikeAcknowledged,
    fakeButton: new Writable("Fake trusted button"),
    fakeMessage: new Writable(
      "The host lookalike never changed the trusted output.",
    ),
    fakeStatus: lookalikeFakeStatus,
  });

  const assert_influence_disclosure_is_render_only = assert(() =>
    influenceFakeStatus.get() ===
      "The lookalike influence notice did not update trusted state." &&
    influenceAcknowledged.get() === ""
  );

  const assert_provenance_disclosure_is_render_only = assert(() =>
    provenanceFakeStatus.get() ===
      "The lookalike provenance card did not update the reviewed text." &&
    reviewedProvenance.get() === ""
  );

  const assert_fact_check_disclosure_is_render_only = assert(() =>
    factCheckFakeStatus.get() ===
      "The lookalike fact-check gate did not approve the brief." &&
    factCheckResult.get() === ""
  );

  const assert_lookalike_stays_untrusted = assert(() =>
    lookalikeFakeStatus.get() ===
      "The host lookalike never changed the trusted output." &&
    lookalikeAcknowledged.get() === ""
  );
  const assert_gallery_renders_catalog = assert(() =>
    DISCLAIMER_EXAMPLE_COUNT === 14 &&
    DISCLAIMER_RENDERED_EXAMPLE_COUNT === DISCLAIMER_EXAMPLE_COUNT
  );

  // An example's content is its text, carrying the label of its kind.
  const assert_examples_carry_their_content = assert(() =>
    promptRouting.content ===
      "Route this note to the verified recipient only." &&
    sourceProvenance.content ===
      "Shared source excerpt for the design review." &&
    factCheckBrief.content === "External brief about launch performance."
  );

  // Each host goes by the title it is given.
  const assert_hosts_named_by_title = assert(() =>
    influence[NAME] === "Influence disclosure ack" &&
    provenance[NAME] === "Source provenance review" &&
    factCheck[NAME] === "Fact-check brief gate"
  );

  // The catalog lists each example under the name it goes by, so reading it
  // reads every example's name.
  const assert_gallery_catalog = assert(() =>
    gallery[NAME] === "Disclaimer Example Gallery" &&
    gallery.exampleCount === DISCLAIMER_EXAMPLE_COUNT &&
    gallery.renderedExampleCount === DISCLAIMER_EXAMPLE_COUNT &&
    cardText(gallery[UI], 0).includes(
      "The gallery currently exposes 14 example patterns.",
    ) &&
    cardText(gallery[UI], 1) === numbered([
        "Prompt routing ack",
        "AI-generated content disclaimer",
        "Medical-style information disclaimer",
        "Influence disclosure ack",
        "Redacted summary disclaimer",
        "Confidential source disclaimer",
        "Public-post disclaimer",
        "Source provenance review",
        "Citation provenance review",
        "Public-post provenance review",
        "Fact-check brief gate",
        "Fact-check release gate",
        "Fact-check claims gate",
        "Lookalike disclaimer host",
      ])
  );

  return {
    [TESTS]: [
      { action: runAck({ suite: influence }) },
      { assertion: assert_influence_disclosure_is_render_only },
      { action: runProvenance({ suite: provenance }) },
      { assertion: assert_provenance_disclosure_is_render_only },
      { action: runFactCheck({ suite: factCheck }) },
      { assertion: assert_fact_check_disclosure_is_render_only },
      { action: runLookalikeOnly({ suite: lookalike }) },
      { assertion: assert_lookalike_stays_untrusted },
      { assertion: assert_gallery_renders_catalog },
      { assertion: assert_examples_carry_their_content },
      { assertion: assert_hosts_named_by_title },
      { assertion: assert_gallery_catalog },
    ],
    influence,
    provenance,
    factCheck,
    lookalike,
    promptRouting,
    sourceProvenance,
    factCheckBrief,
  };
});
