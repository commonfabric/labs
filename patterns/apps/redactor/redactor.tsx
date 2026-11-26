/**
 * Redactor — ask a language model about something personal without sending it
 * anything personal.
 *
 * Type a draft. Every name, email, phone number, ID number and address it
 * holds, from your vault or found by format, is swapped for a realistic
 * stand-in ("Alice Anderson", "(555) 555-0100"), and only that redacted draft
 * may be sent to the model. Its reply comes back in stand-ins, and the
 * redactor puts your originals back, for your eyes only.
 *
 * The boundary at the model's prompt is enforced by Contextual Flow Control,
 * not by this pattern's good behavior: the draft and the vault are `Secret`
 * under `policy.tsx`, whose only release to a public store is what
 * `redactDraft` computes. The model's prompt is a `PublicText` store, so the
 * runtime itself refuses to write the raw draft there, or the stand-in key, or
 * the restored reply. `sendRawDraft` exists to show that refusal. The model
 * call itself is not gated, so the model sees only what this pattern reads
 * from that store (README, CFC debt 2).
 *
 * Ported from jkomoros/community-patterns `redactor.tsx` and
 * `simple-pii-vault.tsx`, which relied on the user to copy the redacted text
 * to a model by hand and promised nothing about where the originals went.
 */
import {
  action,
  computed,
  Default,
  generateText,
  handler,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";
import {
  findInDraft,
  leaksInText,
  type PublicText,
  redactDraft,
  restoreReply,
  type Secret,
  substitutionsFor,
} from "./policy.tsx";
import {
  CATEGORY_LABELS,
  type Detection,
  type Substitution,
} from "./redaction.ts";
import PIIVault, { type SecretEntry } from "./main.tsx";

const SYSTEM_PROMPT =
  "You are a helpful assistant. Some names, emails, phone numbers and other " +
  "details in the user's message are placeholders standing in for real ones. " +
  "Use them exactly as written wherever you refer to those people or details.";

const styles = {
  pre: {
    whiteSpace: "pre-wrap",
    fontFamily: "ui-monospace, monospace",
    fontSize: "13px",
    background: "var(--cf-theme-color-surface, #f6f6f6)",
    padding: "0.75rem",
    borderRadius: "8px",
    minHeight: "3em",
  },
} as const;

interface RedactorInput {
  vaultEntries?: Writable<Default<SecretEntry[], []>>;
  /**
   * No `Default` on purpose. A confidential scalar with a schema default makes
   * the piece-start commit read it, and the runtime then refuses to install
   * `modelPrompt`'s own "" default beside it (a ceiling gate that goes
   * transaction-wide at setup). Unset, it reads as undefined until typed in.
   * Remove this workaround when the runtime topic on it is resolved.
   */
  draft: Writable<Secret<string>>;
  /** What the model is asked. Admits only public values. */
  modelPrompt?: Writable<Default<PublicText, "">>;
  /** A reply from a model you asked yourself, pasted in. */
  pastedReply?: Writable<Default<string, "">>;
}

export interface RedactorOutput {
  [NAME]: string;
  [UI]: VNode;
  /** The released, redacted draft: the only thing that may reach the model. */
  redacted: string;
  /** What was found in the draft (secret). */
  found: Detection[];
  /** Vault values still present in the redacted draft (should be empty). */
  leaks: string[];
  modelPrompt: PublicText;
  /** The reply, with stand-ins (from the model or pasted). */
  reply: string;
  /** The reply with your originals restored (secret). */
  restored: string;
  /** Send the redacted draft to the model. */
  send: Stream<void>;
  /** Try to send the unredacted draft; the runtime refuses the write. */
  sendRawDraft: Stream<void>;
  /** Replace the draft (the textarea binds it directly). */
  typeDraft: Stream<{ text: string }>;
  vault: {
    entries: SecretEntry[];
    addEntry: Stream<{ category: string; value: string }>;
  };
}

/**
 * Give an unset draft a value, so the textarea can bind to it. The runtime
 * fits a confidential cell that holds nothing by its schema's label alone,
 * which no exchange rule rewrites, so the owner's display refuses it; and a
 * bound input whose read is refused writes nothing. Typing into a fresh
 * redactor was silently dropped. Once the draft holds a value it carries a
 * stored label, `releaseToSpaceReader` admits it, and the binding works.
 * Remove this when the draft can take a `Default` (README, CFC debt 3) or the
 * runtime admits an empty secret's own reader.
 */
const startDraft = handler<
  unknown,
  { draft: Writable<Secret<string>> }
>((_, { draft }) => {
  if (draft.get() == null) draft.set("" as Secret<string>);
});

const setDraft = handler<
  { text: string },
  { draft: Writable<Secret<string>> }
>(({ text }, { draft }) => {
  draft.set(text as Secret<string>);
});

/** Keep the key that undoes a redaction beside the reply it belongs to, so
 * editing the draft afterwards cannot restore the wrong originals. Its own
 * event: a transaction that reads the secret key may not also write the
 * public prompt. */
const keepKey = handler<
  void,
  {
    substitutions: Substitution[];
    sentKey: Writable<Secret<Substitution>[]>;
  }
>((_, { substitutions, sentKey }) => {
  sentKey.set(
    substitutions.map((sub) => ({ ...sub }) as Secret<Substitution>),
  );
});

const copyInto = handler<
  void,
  { from: string; to: Writable<PublicText> }
>((_, { from, to }) => {
  to.set(from);
});

const Redactor = pattern<RedactorInput, RedactorOutput>(
  ({ vaultEntries, draft, modelPrompt, pastedReply }) => {
    const vault = PIIVault({ entries: vaultEntries });
    const showVault = new Writable.perSession(false);

    const input = { draft, vault: vaultEntries };
    const redacted = redactDraft(input);
    const found = findInDraft(input);
    const substitutions = substitutionsFor(input);
    const leaks = leaksInText({ text: redacted, found, substitutions });

    // A list of secret items, like the vault: a list that starts empty holds
    // nothing labeled at piece start (README, CFC debt 3).
    const sentKey = new Writable<Secret<Substitution>[]>([]);
    // Whether a send happened. The sent key alone cannot say: a draft with
    // nothing to replace sends an empty key.
    const sent = new Writable(false);
    const sendRedacted = copyInto({ from: redacted, to: modelPrompt });
    const keepSentKey = keepKey({ substitutions, sentKey });
    const send = action(() => {
      sent.set(true);
      sendRedacted.send();
      keepSentKey.send();
    });
    const sendRawDraft = copyInto({ from: draft, to: modelPrompt });
    const typeDraft = setDraft({ draft });
    const beginDraft = startDraft({ draft });

    const answer = generateText({ system: SYSTEM_PROMPT, prompt: modelPrompt });

    const reply = computed(() =>
      pastedReply.get().trim() !== ""
        ? pastedReply.get()
        : (answer.result ?? "") as string
    );
    // A pasted reply is restored with the current draft's key; a sent one
    // with the key captured when it was sent.
    const replyKey = computed((): Substitution[] =>
      pastedReply.get().trim() !== "" || !sent.get()
        ? [...substitutions]
        : sentKey.get().map((sub) => ({ ...sub }))
    );
    const restored = restoreReply({ reply, substitutions: replyKey });

    const toggleVault = action(() => showVault.set(!showVault.get()));
    const clearPasted = action(() => pastedReply.set(""));

    const foundSummary = computed(() =>
      found.length === 0
        ? "Nothing found to replace yet."
        : `Replacing ${found.length} value${found.length === 1 ? "" : "s"}:`
    );
    const vaultToggleLabel = computed(() =>
      `${showVault.get() ? "Hide" : "Show"} vault (${vault.entries.length})`
    );
    const hasPasted = computed(() => pastedReply.get() !== "");
    const sentIsCurrent = computed(() =>
      modelPrompt.get() !== "" && modelPrompt.get() === redacted
    );

    return {
      [NAME]: "🕶️ Redactor",
      [UI]: (
        <cf-screen title="Redactor">
          <cf-vscroll flex showScrollbar>
            <cf-vstack gap="3" style={{ padding: "1rem", maxWidth: "760px" }}>
              <cf-card>
                <cf-hstack gap="2" align="center">
                  <cf-heading level={4} style={{ flex: "1" }}>
                    Your vault
                  </cf-heading>
                  <cf-button variant="ghost" onClick={toggleVault}>
                    {vaultToggleLabel}
                  </cf-button>
                </cf-hstack>
                {showVault ? vault : null}
              </cf-card>

              <cf-card>
                <cf-heading level={4}>1. Your draft (private)</cf-heading>
                <cf-textarea
                  $value={draft}
                  oncf-focus={beginDraft}
                  rows={6}
                  autoResize
                  placeholder="Write what you want to ask, real names and all."
                />
                <cf-label>{foundSummary}</cf-label>
                <cf-hstack gap="1" wrap>
                  {found.map((d) => (
                    <cf-chip
                      label={`${CATEGORY_LABELS[d.category]}: ${d.value}`}
                    />
                  ))}
                </cf-hstack>
              </cf-card>

              <cf-card>
                <cf-heading level={4}>2. What the model sees</cf-heading>
                <pre style={styles.pre}>{redacted}</pre>
                {leaks.length > 0
                  ? (
                    <cf-alert status="error">
                      Still visible: {computed(() => leaks.join(", "))}
                    </cf-alert>
                  )
                  : null}
                <cf-hstack gap="2" align="center">
                  <cf-button onClick={send} disabled={redacted === ""}>
                    Send to model
                  </cf-button>
                  <cf-copy-button text={redacted}>
                    Copy for another model
                  </cf-copy-button>
                  {sentIsCurrent ? <cf-label>✓ Sent</cf-label> : null}
                </cf-hstack>
              </cf-card>

              <cf-card>
                <cf-heading level={4}>
                  3. The reply, with your details
                </cf-heading>
                {answer.pending ? <cf-loader showElapsed /> : null}
                {restored !== ""
                  ? <cf-markdown content={restored} />
                  : (
                    <cf-label>
                      The model's reply appears here with your originals put
                      back. Asked a model yourself? Paste its reply below.
                    </cf-label>
                  )}
                <cf-textarea
                  $value={pastedReply}
                  rows={3}
                  placeholder="Paste a reply that uses the stand-ins"
                />
                {hasPasted
                  ? (
                    <cf-button variant="ghost" onClick={clearPasted}>
                      Use the model's reply instead
                    </cf-button>
                  )
                  : null}
              </cf-card>
            </cf-vstack>
          </cf-vscroll>
        </cf-screen>
      ),
      redacted,
      found,
      leaks,
      modelPrompt,
      reply,
      restored,
      send,
      sendRawDraft,
      typeDraft,
      vault,
    };
  },
);

export default Redactor;
