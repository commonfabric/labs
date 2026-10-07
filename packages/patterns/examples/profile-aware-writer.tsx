import {
  type AsyncResult,
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
  type UnavailableErrorKind,
  type VNode,
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

/** The generated text and its current producer status. */
export interface ProfileWriterResultOutput {
  [UI]: VNode;
  response: string;
  availability: string;
  error: string;
  errorKind: UnavailableErrorKind | undefined;
}

/** Presents generated text without treating synchronization as an error. */
export const ProfileWriterResultPresentation = pattern<
  { topic: string; resultRequest: AsyncResult<string> },
  ProfileWriterResultOutput
>(({ topic, resultRequest }) => {
  const resultState = computed(() => {
    if (!topic) {
      return {
        response: "",
        availability: "ready",
        error: "",
        errorKind: undefined,
      };
    }
    if (isPending(resultRequest)) {
      return {
        response: "",
        availability: "pending",
        error: "",
        errorKind: undefined,
      };
    }
    if (hasError(resultRequest)) {
      return {
        response: "",
        availability: "error",
        error: resultRequest.errorMessage,
        errorKind: resultRequest.errorKind,
      };
    }
    if (isSyncing(resultRequest)) {
      return {
        response: "",
        availability: "syncing",
        error: "",
        errorKind: undefined,
      };
    }
    return {
      response: resultOf(resultRequest),
      availability: "ready",
      error: "",
      errorKind: undefined,
    };
  });

  const resultUI = !topic
    ? null
    : resultState.availability === "pending"
    ? (
      <div style="margin-top: 16px;">
        <cf-loader show-elapsed /> Generating personalized content...
      </div>
    )
    : resultState.availability === "syncing"
    ? <div role="status">Waiting for synchronized data.</div>
    : resultState.error
    ? <div role="alert">{resultState.error}</div>
    : resultState.response
    ? (
      <div style="margin-top: 16px;">
        <h3>Generated Text:</h3>
        <div style="white-space: pre-wrap; padding: 12px; background: #f9f9f9; border-radius: 4px; line-height: 1.6;">
          {resultState.response}
        </div>
      </div>
    )
    : null;

  return {
    [UI]: <div>{resultUI}</div>,
    response: resultState.response,
    availability: resultState.availability,
    error: resultState.error,
    errorKind: resultState.errorKind,
  };
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
  const resultPresentation = ProfileWriterResultPresentation({
    topic,
    resultRequest,
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

        {resultPresentation[UI]}
      </div>
    ),
    topic,
    response: resultPresentation.response,
    availability: resultPresentation.availability,
    error: resultPresentation.error,
    errorKind: resultPresentation.errorKind,
  };
});
