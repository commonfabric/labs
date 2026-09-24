import type { CellHandle, RuntimeClient } from "@commonfabric/runtime-client";
import { expect } from "@std/expect";
import { createMockCellHandle } from "../../test-utils/mock-cell-handle.ts";
import { CFCustodySeal } from "./index.ts";

type Preview = Awaited<ReturnType<RuntimeClient["prepareCustodySeal"]>>;

const preview: Preview = {
  id: "preview",
  actor: "did:key:actor",
  room: "did:key:verified-room",
  readers: [
    { principal: "did:key:actor", role: "writer" },
    { principal: "did:key:member", role: "reader" },
    { principal: "did:key:verified-room", role: "owner" },
  ],
  terms: {
    question: "Where should we eat?",
    answers: ["pizza", "sushi"],
    seats: ["did:key:actor", "did:key:member"],
    stanceSchema: { enum: ["pizza", "sushi"] },
  },
  instance: "instance-digest",
  policy: { type: "https://commonfabric.org/cfc/atom/Policy" },
  sources: [],
  stance: "sushi",
};

/** Mounts host UI with independently controlled preparation and commit calls. */
async function mountSeal(overrides: Partial<{
  prepareCustodySeal: RuntimeClient["prepareCustodySeal"];
  commitCustodySeal: (id: string) => Promise<CellHandle>;
  cancelCustodySeal: (id: string) => Promise<void>;
}> = {}) {
  const element = document.createElement("cf-custody-seal") as CFCustodySeal;
  const calls: string[] = [];
  const sealed: Event[] = [];
  element.addEventListener("cf-sealed", (event) => sealed.push(event));
  element.draft = createMockCellHandle<unknown>("sushi");
  // A pattern-controlled document claiming a room name the host never shows.
  element.terms = createMockCellHandle<unknown>({
    question: "Fake question",
    answers: ["fake answer"],
  });
  element.policy = createMockCellHandle<unknown>({});
  element.sources = createMockCellHandle<unknown>([]);
  element.runtime = {
    prepareCustodySeal: () => {
      calls.push("prepare");
      return Promise.resolve(preview);
    },
    commitCustodySeal: () => {
      calls.push("commit");
      return Promise.resolve(createMockCellHandle<unknown>({}));
    },
    cancelCustodySeal: () => Promise.resolve(),
    ...overrides,
  } as unknown as RuntimeClient;
  document.body.append(element);
  await element.updateComplete;
  return { element, calls, sealed };
}

Deno.test("cf-custody-seal presents the room and readers the worker checked apart from the answers the terms list", async () => {
  const { element } = await mountSeal();
  try {
    expect(element).toBeInstanceOf(CFCustodySeal);
    await element.accessForTestingOnly.prepare();
    await element.updateComplete;
    const root = element.shadowRoot!;
    expect(root.querySelector("dialog")?.open).toBe(true);
    expect(root.activeElement?.id).toBe("seal-title");
    expect(root.querySelector(".room")?.textContent).toBe(
      "did:key:verified-room",
    );
    expect(root.querySelector("dialog")?.textContent).not.toContain(
      "Fake question",
    );
    expect(root.querySelector(".question")?.textContent).toBe(
      "Where should we eat?",
    );
    expect(
      Array.from(root.querySelectorAll(".readers li")).map((item) => [
        item.querySelector(".principal")?.textContent,
        ...Array.from(
          item.querySelectorAll(".annotation"),
          (annotation) => annotation.textContent,
        ),
      ]),
    ).toEqual([
      ["did:key:actor", "you"],
      ["did:key:member"],
      ["did:key:verified-room", "no seat"],
    ]);
    expect(
      Array.from(root.querySelectorAll(".answers li")).map((item) =>
        item.textContent
      ),
    ).toEqual(["pizza", "sushi"]);
    expect(root.querySelector(".leak")?.textContent).toBe(
      "If the room releases only these answers, each answer reveals at most 1 bit about your values.",
    );
    expect(root.querySelector("details")?.open).toBe(false);
    expect(root.querySelector(".stance")?.textContent).toBe(
      JSON.stringify("sushi", null, 2),
    );
  } finally {
    element.remove();
  }
});

Deno.test("cf-custody-seal rejects synthetic confirmation clicks", async () => {
  const { element, calls, sealed } = await mountSeal();
  try {
    await element.accessForTestingOnly.prepare();
    await element.updateComplete;
    element.shadowRoot?.querySelector<HTMLButtonElement>(".confirm")?.click();
    await element.accessForTestingOnly.confirm(new MouseEvent("click"));
    expect(calls).toEqual(["prepare"]);
    expect(sealed).toEqual([]);
    expect(element.shadowRoot?.querySelector("dialog")?.open).toBe(true);
  } finally {
    element.remove();
  }
});

Deno.test("cf-custody-seal does nothing once the dialog is closed", async () => {
  const canceled: string[] = [];
  const { element, calls, sealed } = await mountSeal({
    cancelCustodySeal: (id) => {
      canceled.push(id);
      return Promise.resolve();
    },
  });
  try {
    await element.accessForTestingOnly.prepare();
    await element.updateComplete;
    Array.from(element.shadowRoot?.querySelectorAll("button") ?? [])
      .find((button) => button.textContent === "Cancel")?.click();
    await element.updateComplete;
    expect(element.shadowRoot?.querySelector("dialog")?.open).toBe(false);
    await element.accessForTestingOnly.confirm(new MouseEvent("click"));
    expect(calls).toEqual(["prepare"]);
    expect(canceled).toEqual(["preview"]);
    expect(sealed).toEqual([]);
  } finally {
    element.remove();
  }
});

Deno.test("cf-custody-seal invalidates the review when a bound cell changes", async () => {
  const { element, calls } = await mountSeal();
  try {
    await element.accessForTestingOnly.prepare();
    element.draft = createMockCellHandle<unknown>("pizza");
    await element.updateComplete;
    await element.accessForTestingOnly.confirm(new MouseEvent("click"));
    expect(calls).toEqual(["prepare"]);
    expect(element.accessForTestingOnly.preview).toBeUndefined();
    expect(element.shadowRoot?.querySelector("dialog")?.open).toBe(false);
  } finally {
    element.remove();
  }
});

Deno.test("cf-custody-seal states no bound for terms that list no answers", async () => {
  const { element } = await mountSeal({
    prepareCustodySeal: () =>
      Promise.resolve({
        ...preview,
        terms: { seats: ["did:key:actor"], stanceSchema: { const: 1 } },
      }),
  });
  try {
    await element.accessForTestingOnly.prepare();
    await element.updateComplete;
    const root = element.shadowRoot!;
    expect(root.querySelector(".answers")?.textContent).toBe(
      "These terms do not list the answers the room can give.",
    );
    expect(root.querySelector(".leak")?.textContent).toBe(
      "These terms state no bound on what an answer reveals.",
    );
  } finally {
    element.remove();
  }
});
