import { assertEquals } from "@std/assert";
import { paintDashboardMessageInput } from "./dashboard-message-client.ts";

const input = (value: string) => ({
  value,
  style: { opacity: "" },
}) as HTMLInputElement;

Deno.test("message painter fades saved text and preserves drafts", () => {
  const visibleMs = 10;
  const fadeMs = 20;
  const saved = {
    savedText: "Saved",
    updatedAt: 100 as number | null,
    draftProtected: false,
  };
  const field = input(saved.savedText);

  paintDashboardMessageInput(field, saved, 120, visibleMs, fadeMs);
  assertEquals(field.style.opacity, "0.5");

  saved.draftProtected = true;
  field.value = "Draft";
  paintDashboardMessageInput(field, saved, 130, visibleMs, fadeMs);
  assertEquals(field.value, "Draft");
  assertEquals(field.style.opacity, "1");

  saved.draftProtected = false;
  paintDashboardMessageInput(field, saved, 130, visibleMs, fadeMs);
  assertEquals(saved.savedText, "");
  assertEquals(saved.updatedAt, null);
  assertEquals(field.value, "");
  assertEquals(field.style.opacity, "1");

  paintDashboardMessageInput(field, saved, 140, visibleMs, fadeMs);
  assertEquals(field.style.opacity, "1");
});
