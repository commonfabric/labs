/**
 * The count of what one outbound channel of the worker has carried, kept at
 * the send site so the sizes read can say which port the serialization
 * traffic crossed. Measuring a message walks its encoding, which costs about
 * a tenth of what encoding and cloning it cost, so one message in
 * {@link IPC_SAMPLE_STRIDE} is measured and the rest are counted.
 */

import { approximateJsonSize } from "@commonfabric/utils/approximate-json-size";

import type { IpcChannelSizes } from "@/protocol/mod.ts";

/** How many messages apart the measured ones are; a channel's first is one. */
export const IPC_SAMPLE_STRIDE = 16;

/**
 * Counts the messages of one channel and measures a sample of them. A tally
 * that stands for several channels adds their snapshots, and adds each
 * one's own estimate rather than re-estimating from the pooled sample, since
 * channels of different lifetimes sampled different fractions of their
 * traffic.
 */
export class IpcChannelTally {
  #messages = 0;
  #sampledMessages = 0;
  #sampledBytes = 0;

  /** What the added channels reported, their estimates among it. */
  #added: IpcChannelSizes = {
    messages: 0,
    sampledMessages: 0,
    sampledBytes: 0,
    approxBytes: 0,
  };

  /**
   * Counts `encoded`, handed to the channel's `postMessage`, and measures it
   * when it falls on the stride.
   */
  note(encoded: unknown): void {
    if (this.#messages % IPC_SAMPLE_STRIDE === 0) {
      this.#sampledMessages++;
      this.#sampledBytes += approximateJsonSize(encoded).bytes;
    }
    this.#messages++;
  }

  /** Adds what another channel carried, for a tally that stands for several. */
  add(sizes: IpcChannelSizes): void {
    this.#added.messages += sizes.messages;
    this.#added.sampledMessages += sizes.sampledMessages;
    this.#added.sampledBytes += sizes.sampledBytes;
    this.#added.approxBytes += sizes.approxBytes;
  }

  /** What the channel has carried so far, the added channels included. */
  snapshot(): IpcChannelSizes {
    const own = this.#sampledMessages === 0 ? 0 : Math.round(
      this.#sampledBytes / this.#sampledMessages * this.#messages,
    );
    return {
      messages: this.#messages + this.#added.messages,
      sampledMessages: this.#sampledMessages + this.#added.sampledMessages,
      sampledBytes: this.#sampledBytes + this.#added.sampledBytes,
      approxBytes: own + this.#added.approxBytes,
    };
  }
}
