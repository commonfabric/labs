import { assertEquals } from "@std/assert";
import { paintDashboardMessageInput } from "./dashboard-message-client.ts";

const VISIBLE_MS = 2 * 60 * 60 * 1_000;
const FADE_MS = 4 * 60 * 60 * 1_000;

function editor(value: string): HTMLInputElement {
  const input = document.createElement("input");
  input.value = value;
  document.body.append(input);
  input.focus();
  return input;
}

Deno.test("a focused saved message fades and expires", () => {
  const input = editor("Saved message");
  const state = {
    savedText: input.value,
    updatedAt: 1_000 as number | null,
    draftProtected: false,
  };
  try {
    paintDashboardMessageInput(
      input,
      state,
      1_000 + VISIBLE_MS + FADE_MS / 2,
      VISIBLE_MS,
      FADE_MS,
    );
    assertEquals(document.activeElement, input);
    assertEquals(input.style.opacity, "0.5");

    paintDashboardMessageInput(
      input,
      state,
      1_000 + VISIBLE_MS + FADE_MS,
      VISIBLE_MS,
      FADE_MS,
    );
    assertEquals(input.value, "");
    assertEquals(input.style.opacity, "1");
    assertEquals(state, {
      savedText: "",
      updatedAt: null,
      draftProtected: false,
    });
  } finally {
    input.remove();
  }
});

for (const protectedState of ["dirty", "pending"] as const) {
  Deno.test(`a ${protectedState} message stays visible past expiry`, () => {
    const input = editor("Local draft");
    const state = {
      savedText: "Saved message",
      updatedAt: 1_000,
      draftProtected: true,
    };
    try {
      paintDashboardMessageInput(
        input,
        state,
        1_000 + VISIBLE_MS + FADE_MS,
        VISIBLE_MS,
        FADE_MS,
      );
      assertEquals(input.value, "Local draft");
      assertEquals(input.style.opacity, "1");
      assertEquals(state.savedText, "Saved message");
      assertEquals(state.updatedAt, 1_000);
    } finally {
      input.remove();
    }
  });
}

Deno.test("an empty message remains ready for editing", () => {
  const input = editor("");
  const state = {
    savedText: "",
    updatedAt: null,
    draftProtected: false,
  };
  try {
    input.style.opacity = "0.2";
    paintDashboardMessageInput(input, state, 1_000, VISIBLE_MS, FADE_MS);
    assertEquals(input.style.opacity, "1");
  } finally {
    input.remove();
  }
});
