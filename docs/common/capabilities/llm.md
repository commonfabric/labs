# LLM Generation

LLM calls are reactive nodes, not promises: never `await` them. Call them in
the pattern body and check `pending` / `error` / `result` reactively, as shown
below.

## generateText

Free-form text generation.

```typescript
// Shown for illustration only.
const response = generateText({
  prompt: userInput,
  system: "You are a helpful assistant.",  // optional
});

// Response: { result: string, error: string, pending: boolean }
{response.pending
  ? <span>Generating...</span>
  : response.error
  ? <span>Error: {response.error}</span>
  : <div>{response.result}</div>}
```

---

## generateObject\<T\>

Structured data matching a TypeScript type. Schema is inferred automatically.

```typescript
// Shown for illustration only.
interface ProductIdea {
  name: string;
  description: string;
  price: number;
}

const idea = generateObject<ProductIdea>({
  prompt: userInput,
  system: "Generate a product idea.",
});

// Response: { result: ProductIdea, error: string, pending: boolean }
{idea.pending
  ? <span>Generating...</span>
  : idea.error
  ? <span>Error: {idea.error}</span>
  : (
    <div>
      <h3>{idea.result?.name}</h3>
      <p>{idea.result?.description}</p>
      <p>${idea.result?.price}</p>
    </div>
  )}
```

## Processing Arrays

Map over items - caching is automatic per-item:

```typescript
// Shown inside a pattern body.
const summaries = articles.map((article) => ({
  article,
  summary: generateText({
    prompt: computed(() => `Summarize: ${article.title}\n${article.content}`),
  }),
}));

{summaries.map(({ article, summary }) => (
  <div>
    <h3>{article.title}</h3>
    {summary.pending
      ? <em>Summarizing...</em>
      : <p>{summary.result}</p>}
  </div>
))}
```

### Selecting a Model

`model` is optional on `generateText`, `generateObject`, and `llmDialog`. Omit
it and the runtime fills in a default. Prefer omitting it over naming a specific
model version, which stops working on any deployment that no longer offers that
exact version.

The default an omitted `model` resolves to depends on the call. `generateText`
and `llmDialog` use the `"default"` alias, which is the deployment's current
default model. `generateObject` uses a separate default chosen for structured
output. To pin any call to the deployment's default model explicitly — for
instance to keep a `generateObject` call on the same model as the rest of a
pattern — pass `model: "default"`.

After provider discovery, toolshed selects the first available model in this
order: `gateway:claude-sonnet-4-6`, `anthropic:claude-sonnet-4-6`,
`anthropic:claude-sonnet-4-5`, then `gateway:gpt-5.4-mini`. If none is registered,
it uses the first registered language model. That fallback follows provider
registration order and the gateway's returned catalog order. Image-generation
models are excluded. A deployment with no language models cannot serve the
alias; an explicitly named unknown model is also rejected.

Hardcode a specific model only when the call needs that model's particular
capability — for example a cheaper, faster model for a high-volume map, or a
model chosen for a vision task.

**TODO:** A call should be able to request a model by capability rather than by
name — asking for a capability such as "vision", "high-effort", or "low-cost"
and letting the deployment resolve the best available model that has it. That
would remove the remaining reason to name a specific model, so a capability need
would no longer force a version pin that goes stale.

### Valid Model Names

Model names must match the registry format exactly. Invalid names cause cryptic errors:

```typescript
// ❌ WRONG - causes "Cannot read properties of undefined"
model: "claude-3-5-sonnet-20241022"   // Wrong format
model: "claude-sonnet-4-5"            // Missing vendor prefix
model: "anthropic/claude-sonnet-4-5"  // Wrong separator

// ✅ CORRECT - use vendor:model format
model: "anthropic:claude-sonnet-4-5"
model: "anthropic:claude-haiku-4-5"
model: "anthropic:claude-opus-4-1"
model: "openai:gpt-4o"

// ✅ ALSO CORRECT - aliases work
model: "sonnet-4-5"
model: "opus-4-1"
```

If you get `TypeError: Cannot read properties of undefined (reading 'model')`, check your model name format first.

**Discovery:** Query `/api/ai/llm/models` to see all available models.

### Cache Busting for Regeneration

For "respin" or "regenerate" features, set `cache: false` in the options.
Only `generateObject` accepts it (`generateText` is always cached per
distinct input):

```typescript
// Shown for illustration only.
const result = generateObject({
  prompt,
  cache: false,  // Forces fresh generation
});
```
