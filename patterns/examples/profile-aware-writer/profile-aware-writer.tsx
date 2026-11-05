import {
  Cell,
  computed,
  Default,
  generateText,
  handler,
  NAME,
  pattern,
  UI,
  wish,
  Writable,
} from "commonfabric";

type Input = {
  title?: string | Default<"Profile-Aware Writer">;
};

const handleSend = handler<
  { detail: { message: string } },
  { topic: Writable<string> }
>((event, { topic }) => {
  const userTopic = event.detail?.message?.trim();
  if (userTopic) {
    topic.set(userTopic);
  }
});

export default pattern<Input>(({ title }) => {
  const topic = new Writable("");

  const profile = wish<Cell<string>>({ query: "#learnedSummary" });

  const systemPrompt = computed(() => {
    const profileText = profile.result!.get();
    const profileSection = profileText
      ? `\n\n--- About the User ---\n${profileText}\n---\n`
      : "";
    return `You are a helpful writing assistant.${profileSection}
Write content personalized to the user when appropriate.`;
  });

  const result = generateText({
    system: systemPrompt,
    prompt: topic,
  });

  return {
    [NAME]: title,
    [UI]: (
      <div>
        <h2>{title}</h2>

        <cf-card>
          <h4 style="margin-top: 0;">Profile Context:</h4>
          <cf-code-editor
            $value={profile.result}
            style={{ maxHeight: "256px" }}
          />
        </cf-card>

        <div>
          <cf-message-input
            name="Write"
            placeholder="Enter a topic to write about..."
            appearance="rounded"
            oncf-send={handleSend({ topic })}
          />
        </div>

        {topic.get()
          ? (
            <div style="margin-top: 16px;">
              <h3>Topic:</h3>
              <blockquote>
                {topic.get()}
              </blockquote>
            </div>
          )
          : null}

        {result.pending
          ? (
            <div style="margin-top: 16px;">
              <cf-loader show-elapsed /> Generating personalized content...
            </div>
          )
          : result.result
          ? (
            <div style="margin-top: 16px;">
              <h3>Generated Text:</h3>
              <div style="white-space: pre-wrap; padding: 12px; background: #f9f9f9; border-radius: 4px; line-height: 1.6;">
                {result.result}
              </div>
            </div>
          )
          : null}
      </div>
    ),
    topic,
    response: result.result,
  };
});
