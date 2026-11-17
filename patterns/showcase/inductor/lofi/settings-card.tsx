/**
 * The lo-fi inductor's settings, folded away until opened: the model, how
 * many new surprises start a rewrite, and the held-out share. The drafts are
 * per session; "Apply" sends each one that was filled in to its setter, which
 * refuses a value out of range.
 */

import {
  action,
  computed,
  NAME,
  pattern,
  type Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

interface SettingsCardInput {
  /** The model, or "" for the deployment's default. */
  hifiModel: string;

  rewriteAfter: number;
  heldOutPercent: number;
  setHifiModel: Stream<{ model: string }>;
  setRewriteAfter: Stream<{ count: number }>;
  setHeldOutPercent: Stream<{ percent: number }>;
}

/** The inductor's settings, with a button that applies the drafts. */
export interface SettingsCardOutput {
  [NAME]: string;
  [UI]: VNode;
}

export default pattern<SettingsCardInput, SettingsCardOutput>(
  ({
    hifiModel,
    rewriteAfter,
    heldOutPercent,
    setHifiModel,
    setRewriteAfter,
    setHeldOutPercent,
  }) => {
    const modelDraft = new Writable.perSession("");
    const rewriteAfterDraft = new Writable.perSession("");
    const heldOutDraft = new Writable.perSession("");

    // A blank draft leaves its setting as it is. A new model asks about every
    // item again, so the same name is not sent twice.
    const apply = action(() => {
      const model = modelDraft.get().trim();
      if (model !== "" && model !== hifiModel) setHifiModel.send({ model });
      const count = rewriteAfterDraft.get().trim();
      if (count !== "") setRewriteAfter.send({ count: Number(count) });
      const share = heldOutDraft.get().trim();
      if (share !== "") setHeldOutPercent.send({ percent: Number(share) });
      modelDraft.set("");
      rewriteAfterDraft.set("");
      heldOutDraft.set("");
    });

    // A model typed but not applied goes too, so a later Apply does not
    // switch back to it.
    const useDefault = action(() => {
      if (hifiModel !== "") setHifiModel.send({ model: "" });
      modelDraft.set("");
    });

    const summary = computed(() =>
      `Model: ${hifiModel || "the deployment's default"} · rewrite after ` +
      `${rewriteAfter} surprises · ${heldOutPercent}% held out`
    );

    return {
      [NAME]: "Settings",
      [UI]: (
        <cf-card>
          <cf-collapsible>
            <cf-button
              slot="trigger"
              variant="ghost"
              style="width: 100%; text-align: left;"
            >
              Settings
            </cf-button>
            <cf-vstack gap="2">
              <cf-text tone="muted">{summary}</cf-text>
              <cf-field label="Model, as the gateway lists it">
                <cf-input
                  $value={modelDraft}
                  placeholder={computed(() =>
                    hifiModel || "the deployment's default"
                  )}
                />
              </cf-field>
              <cf-field label="New surprises that start a rewrite">
                <cf-input
                  type="number"
                  $value={rewriteAfterDraft}
                  placeholder={computed(() => String(rewriteAfter))}
                />
              </cf-field>
              <cf-field label="Held-out share, in percent">
                <cf-input
                  type="number"
                  $value={heldOutDraft}
                  placeholder={computed(() => String(heldOutPercent))}
                />
              </cf-field>
              <cf-hstack gap="2">
                <cf-button color="primary" onClick={apply}>Apply</cf-button>
                <cf-button variant="ghost" onClick={useDefault}>
                  Use the default model
                </cf-button>
              </cf-hstack>
            </cf-vstack>
          </cf-collapsible>
        </cf-card>
      ),
    };
  },
);
