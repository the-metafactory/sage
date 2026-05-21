import { describe, expect, test } from "bun:test";
import { filterByCorrelation, type SubscribedEnvelope } from "../src/bus/client.ts";

/**
 * sage#58: `filterByCorrelation` is the only pure helper exported
 * from the Bus Client Module. It applies the late-bound
 * correlation_id filter — the subscribe-then-publish-then-iterate
 * shape callers use to subscribe before publish without a race
 * window.
 */

function ev(
  type: string,
  correlation_id: string | undefined,
): SubscribedEnvelope {
  return {
    envelope: {
      id: "e-" + Math.random().toString(36).slice(2),
      source: "test",
      type,
      time: new Date().toISOString(),
      correlation_id,
      payload: {},
    } as unknown as SubscribedEnvelope["envelope"],
    subject: "local.test." + type,
  };
}

async function* fromArray(arr: SubscribedEnvelope[]) {
  for (const item of arr) yield item;
}

async function collect(
  iter: AsyncIterable<SubscribedEnvelope>,
): Promise<SubscribedEnvelope[]> {
  const out: SubscribedEnvelope[] = [];
  for await (const item of iter) out.push(item);
  return out;
}

describe("filterByCorrelation", () => {
  test("passes envelopes whose correlation_id matches the thunk", async () => {
    const items = [
      ev("dispatch.task.received", "abc"),
      ev("dispatch.task.completed", "xyz"),
      ev("dispatch.task.received", "abc"),
    ];
    const out = await collect(filterByCorrelation(fromArray(items), () => "abc"));
    expect(out).toHaveLength(2);
  });

  test("drops envelopes when thunk returns undefined (pre-publish)", async () => {
    const items = [ev("dispatch.task.received", "abc")];
    const out = await collect(
      filterByCorrelation(fromArray(items), () => undefined),
    );
    expect(out).toHaveLength(0);
  });

  test("drops envelopes whose correlation_id is undefined", async () => {
    const items = [ev("dispatch.task.received", undefined)];
    const out = await collect(filterByCorrelation(fromArray(items), () => "abc"));
    expect(out).toHaveLength(0);
  });

  test("thunk is re-read per envelope — late-binding works", async () => {
    let id: string | undefined;
    const items = [
      ev("dispatch.task.received", "abc"),
      ev("dispatch.task.completed", "abc"),
    ];
    const promise = collect(filterByCorrelation(fromArray(items), () => id));
    // Publish-then-set, mirroring the dispatcher's program order.
    id = "abc";
    const out = await promise;
    expect(out).toHaveLength(2);
  });
});
