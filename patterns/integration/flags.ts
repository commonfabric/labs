const enabled = ["1", "true", "yes"];

// Binds tests that require LLM configurations.
export const TEST_LLM = enabled.includes(Deno.env.get("TEST_LLM") ?? "");
// Binds tests that are dependent on making external HTTP requests.
export const TEST_HTTP = enabled.includes(Deno.env.get("TEST_HTTP") ?? "");
