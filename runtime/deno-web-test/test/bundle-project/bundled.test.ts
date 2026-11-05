import { assertEquals } from "@std/assert";

Deno.test("a bundled module loads into a realm the page creates", async function () {
  const worker = new Worker("/worker.js", { type: "module" });
  try {
    const message = await new Promise<MessageEvent>((resolve, reject) => {
      worker.onmessage = resolve;
      worker.onerror = (event) => reject(new Error(String(event.message)));
    });
    assertEquals(message.data, 2);
  } finally {
    worker.terminate();
  }
});

Deno.test("a bundled module loads into a sandboxed iframe", async function () {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("sandbox", "allow-scripts");
  iframe.srcdoc = `<script type="module" src="/frame.js"></script>`;
  const received = new Promise<MessageEvent>((resolve) => {
    globalThis.addEventListener("message", resolve, { once: true });
  });
  document.body.appendChild(iframe);
  try {
    assertEquals((await received).data, 4);
  } finally {
    iframe.remove();
  }
});
