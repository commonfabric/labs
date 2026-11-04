import {
  computed,
  Default,
  generateText,
  isPending,
  NAME,
  pattern,
  resultOf,
  UI,
} from "commonfabric";

type QueueTestInput = {
  title: string | Default<"Queue Test">;
};

/**
 * Test pattern for the queue feature.
 *
 * Fires 5 generateText calls, all routed through the same "test-queue"
 * with maxConcurrency=2 (the default). Open the browser network tab
 * to observe that only 2 LLM requests are in-flight at once.
 */
export default pattern<QueueTestInput>(({ title }) => {
  const prompts = [
    "What is 1+1? Reply in one word.",
    "What is 2+2? Reply in one word.",
    "What is 3+3? Reply in one word.",
    "What is 4+4? Reply in one word.",
    "What is 5+5? Reply in one word.",
  ];

  const responses = prompts.map((prompt) => {
    const request = generateText({
      prompt,
      model: "anthropic:claude-haiku-4-5",
      queue: "test-queue",
    });
    const result = resultOf(request);
    return { request, result };
  });

  const completedCount = computed(() =>
    responses.filter((response) =>
      !isPending(response.request) && response.result
    ).length
  );

  return {
    [NAME]: title,
    [UI]: (
      <cf-screen>
        <cf-vstack slot="header" gap="1">
          <cf-heading level={3}>{title}</cf-heading>
          <p>
            Fires 5 LLM calls through queue "test-queue" (maxConcurrency=2).
            Check the network tab to verify only 2 are in-flight at once.
          </p>
          <p>
            <strong>Completed: {completedCount} / {prompts.length}</strong>
          </p>
        </cf-vstack>

        <cf-vstack gap="2" style="padding: 1rem;">
          {responses.map((r, i) => (
            <cf-card>
              <cf-hstack gap="2" align="center">
                <strong>{prompts[i]}</strong>
                {computed(() =>
                  isPending(r.request)
                    ? <cf-loader show-elapsed />
                    : r.result
                    ? <span style="color: green">{r.result}</span>
                    : <span style="color: gray">waiting...</span>
                )}
              </cf-hstack>
            </cf-card>
          ))}
        </cf-vstack>
      </cf-screen>
    ),
    responses: responses.map((r) => ({
      pending: isPending(r.request),
      result: r.result,
    })),
  };
});
