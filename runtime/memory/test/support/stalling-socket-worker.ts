/**
 * A websocket peer whose thread stalls: once its socket opens it blocks that
 * thread, so it answers no ping and reads no frame, and on waking sends one
 * request. It posts a {@link StalledPeerReport} when the socket closes.
 *
 * The stall has to be a real block of a thread other than the server's, since
 * what is under test is how the server's end reads a peer that has gone quiet.
 */

/** What the test asks of the peer. */
export type StalledPeerRequest = {
  /** The websocket address to connect to. */
  address: string;

  /** How long the peer's thread stays blocked, in milliseconds. */
  stallMs: number;

  /** The frame to send on waking. */
  frame: string;
};

/** How the peer's socket ended. */
export type StalledPeerReport = {
  /** The first frame that came back, which is what ends the peer's wait. */
  reply?: string;

  /** The reason the socket's close reported. */
  closeReason: string;
};

self.addEventListener("message", (event) => {
  const { address, stallMs, frame } =
    (event as MessageEvent<StalledPeerRequest>).data;
  const socket = new WebSocket(address);
  let reply: string | undefined;
  socket.addEventListener("open", () => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, stallMs);
    socket.send(frame);
  });
  socket.addEventListener("message", (message) => {
    reply = String(message.data);
    socket.close();
  });
  socket.addEventListener("close", (close) => {
    const report: StalledPeerReport = {
      ...(reply === undefined ? {} : { reply }),
      closeReason: close.reason,
    };
    self.postMessage(report);
  });
});
