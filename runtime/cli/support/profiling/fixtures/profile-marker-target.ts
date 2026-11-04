const releaseListener = Deno.listen({
  hostname: "127.0.0.1",
  port: 0,
});
const releaseAddr = releaseListener.addr;
if (releaseAddr.transport !== "tcp") {
  throw new Error("Expected a TCP release listener");
}
await Deno.stderr.write(
  new TextEncoder().encode(`profile release port ${releaseAddr.port}\n`),
);

async function acceptRelease(): Promise<void> {
  const releaseConnection = await releaseListener.accept();
  releaseConnection.close();
}

try {
  console.log("profile start");
  await acceptRelease();
  console.log("profile stop");
  await acceptRelease();
} finally {
  releaseListener.close();
}
