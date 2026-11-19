import type { VideoEncoder, VideoSink } from "@platformcosmo/core";
import { describe, expect, test } from "vitest";
import { abortableEncoder } from "../src/commands/build.js";

const o = { fps: 1, width: 2, height: 2, format: "mp4" } as const;

function fake() {
  const state = { opened: 0, aborted: 0, written: 0 };
  const enc: VideoEncoder = {
    encode: async () => new Uint8Array(),
    open: (): VideoSink => {
      state.opened++;
      return {
        write: async () => {
          state.written++;
        },
        finish: async () => new Uint8Array([1]),
        abort: () => {
          state.aborted++;
        },
      };
    },
  };
  return { enc, state };
}

describe("abortableEncoder (SIGINT/SIGTERM)", () => {
  test("an interrupt aborts every open sink and later writes fail", async () => {
    const { enc, state } = fake();
    const ac = new AbortController();
    const wrapped = abortableEncoder(enc, ac.signal);
    const a = await wrapped.open!(o);
    await wrapped.open!(o);
    await a.write(new Uint8Array(1));
    ac.abort();
    await Promise.resolve();
    expect(state.aborted).toBe(2);
    await expect(a.write(new Uint8Array(1))).rejects.toThrow(/interrupted/);
    await expect(wrapped.open!(o)).rejects.toThrow(/interrupted/);
    expect(state.opened).toBe(2);
  });

  test("without a signal or without open the encoder is returned unchanged", () => {
    const { enc } = fake();
    expect(abortableEncoder(enc)).toBe(enc);
    const plain: VideoEncoder = { encode: async () => new Uint8Array() };
    expect(abortableEncoder(plain, new AbortController().signal)).toBe(plain);
  });

  test("20 rebuilds on one shared signal leave at most one listener (watch)", async () => {
    const { enc } = fake();
    const ac = new AbortController();
    let listeners = 0;
    let peak = 0;
    const add = ac.signal.addEventListener.bind(ac.signal);
    const remove = ac.signal.removeEventListener.bind(ac.signal);
    ac.signal.addEventListener = ((...a: Parameters<typeof add>) => {
      listeners++;
      peak = Math.max(peak, listeners);
      add(...a);
    }) as typeof add;
    ac.signal.removeEventListener = ((...a: Parameters<typeof remove>) => {
      listeners--;
      remove(...a);
    }) as typeof remove;
    for (let i = 0; i < 20; i++) {
      const sink = await abortableEncoder(enc, ac.signal).open!(o);
      await sink.write(new Uint8Array(1));
      await (i % 2 ? sink.finish() : sink.abort());
    }
    expect(peak).toBeLessThanOrEqual(1);
    expect(listeners).toBe(0);
  });

  test("finished sinks are not aborted later", async () => {
    const { enc, state } = fake();
    const ac = new AbortController();
    const sink = await abortableEncoder(enc, ac.signal).open!(o);
    await sink.finish();
    ac.abort();
    expect(state.aborted).toBe(0);
  });
});
