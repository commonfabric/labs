import {
  computed,
  Default,
  generateText,
  handler,
  hasError,
  hasSchemaMismatch,
  isPending,
  isSyncing,
  NAME,
  pattern,
  resultOf,
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

  const profile = wish<string>({ query: "#learnedSummary" });
  const profileText = resultOf(profile.result);
  const profileDisplay = computed(() => {
    if (isPending(profile.result) || isSyncing(profile.result)) {
      return "Loading profile context…";
    }
    if (hasSchemaMismatch(profile.result)) {
      return "Profile context has an unexpected format.";
    }
    if (hasError(profile.result)) return "Profile context is unavailable.";
    return resultOf(profile.result);
  });

  const systemPrompt = computed(() => {
    const profileSection = profileText
      ? `\n\n--- About the User ---\n${profileText}\n---\n`
      : "";
    return `You are a helpful writing assistant.${profileSection}
Write content personalized to the user when appropriate.`;
  });

  const resultRequest = generateText({
    system: systemPrompt,
    prompt: topic,
  });
  const resultState = computed(() => {
    if (!topic) {
      return { response: "", availability: "ready", error: "" };
    }
    if (isPending(resultRequest)) {
      return { response: "", availability: "pending", error: "" };
    }
    if (hasSchemaMismatch(resultRequest)) {
      return {
        response: "",
        availability: "schemaMismatch",
        error: "The generated text has an unexpected format.",
      };
    }
    if (hasError(resultRequest)) {
      return {
        response: "",
        availability: "error",
        error: resultRequest.errorMessage,
      };
    }
    if (isSyncing(resultRequest)) {
      return { response: "", availability: "syncing", error: "" };
    }
    return {
      response: resultOf(resultRequest),
      availability: "ready",
      error: "",
    };
  });
  const resultUI = computed(() => {
    if (!topic) return null;
    if (resultState.availability === "pending") {
      return (
        <div style="margin-top: 16px;">
          <cf-loader show-elapsed /> Generating personalized content...
        </div>
      );
    }
    if (resultState.availability === "syncing") {
      return <div role="status">Waiting for synchronized data.</div>;
    }
    if (resultState.error) {
      return <div role="alert">{resultState.error}</div>;
    }
    return resultState.response
      ? (
        <div style="margin-top: 16px;">
          <h3>Generated Text:</h3>
          <div style="white-space: pre-wrap; padding: 12px; background: #f9f9f9; border-radius: 4px; line-height: 1.6;">
            {resultState.response}
          </div>
        </div>
      )
      : null;
  });

  return {
    [NAME]: title,
    [UI]: (
      <div>
        <h2>{title}</h2>

        <cf-card>
          <h4 style="margin-top: 0;">Profile Context:</h4>
          <pre>{profileDisplay}</pre>
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

        {resultUI}
      </div>
    ),
    topic,
    response: resultState.response,
    availability: resultState.availability,
    error: resultState.error,
  };
});
