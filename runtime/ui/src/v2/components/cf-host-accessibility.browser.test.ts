import { assertEquals, assertInstanceOf } from "@std/assert";
import { CFButton } from "./cf-button/index.ts";
import { CFInput } from "./cf-input/index.ts";
import { CFSelect } from "./cf-select/index.ts";
import { CFTextarea } from "./cf-textarea/index.ts";

const nextFrame = () =>
  new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

Deno.test("cf-button and cf-input can be created by document.createElement", async () => {
  const button = document.createElement("cf-button") as CFButton;
  const input = document.createElement("cf-input") as CFInput;

  document.body.append(button, input);
  await Promise.all([button.updateComplete, input.updateComplete]);

  assertInstanceOf(button, CFButton);
  assertEquals(button.getAttribute("role"), "button");
  assertEquals(button.getAttribute("exportparts"), "button");

  assertInstanceOf(input, CFInput);
  assertEquals(input.getAttribute("role"), "textbox");
  assertEquals(input.getAttribute("exportparts"), "input");

  button.remove();
  input.remove();
});

Deno.test("form control host focus forwards to native shadow controls", async () => {
  const input = document.createElement("cf-input") as CFInput;
  const textarea = document.createElement("cf-textarea") as CFTextarea;
  const select = document.createElement("cf-select") as CFSelect;
  select.items = [{ label: "One", value: "one" }];

  document.body.append(input, textarea, select);
  assertInstanceOf(input, CFInput);
  assertInstanceOf(textarea, CFTextarea);
  assertInstanceOf(select, CFSelect);

  await Promise.all([
    input.updateComplete,
    textarea.updateComplete,
    select.updateComplete,
  ]);

  input.focus();
  await nextFrame();
  assertEquals(input.shadowRoot?.activeElement?.tagName, "INPUT");

  textarea.focus();
  await nextFrame();
  assertEquals(textarea.shadowRoot?.activeElement?.tagName, "TEXTAREA");

  select.focus();
  await nextFrame();
  assertEquals(select.shadowRoot?.activeElement?.tagName, "SELECT");

  input.disabled = true;
  await input.updateComplete;
  input.blur();
  input.focus();
  await nextFrame();
  assertEquals(input.shadowRoot?.activeElement, null);

  input.remove();
  textarea.remove();
  select.remove();
});

Deno.test("cf-input preserves early programmatic focus before first render", async () => {
  const input = document.createElement("cf-input") as CFInput;
  document.body.append(input);

  input.focus();
  assertEquals(document.activeElement, input);

  await input.updateComplete;
  await nextFrame();
  assertEquals(input.shadowRoot?.activeElement?.tagName, "INPUT");

  input.remove();
});
