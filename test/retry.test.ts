import { describe, test, expect } from "bun:test";
import { isTransientNetworkError, retryTransient } from "../src/util/retry.ts";

describe("isTransientNetworkError", () => {
  test("detects gh connection error", () => {
    expect(isTransientNetworkError(new Error("error connecting to api.github.com"))).toBe(true);
  });

  test("detects DNS resolution failure", () => {
    expect(isTransientNetworkError(new Error("could not resolve host: api.github.com"))).toBe(
      true,
    );
  });

  test("detects 503 status", () => {
    expect(isTransientNetworkError(new Error("HTTP 503 Service Unavailable"))).toBe(true);
  });

  test("detects rate limit", () => {
    expect(isTransientNetworkError(new Error("API rate limit exceeded"))).toBe(true);
  });

  test("does NOT match 401 auth failure", () => {
    expect(isTransientNetworkError(new Error("HTTP 401 Unauthorized"))).toBe(false);
  });

  test("does NOT match generic TypeError", () => {
    expect(isTransientNetworkError(new TypeError("Cannot read property"))).toBe(false);
  });
});

describe("retryTransient", () => {
  test("returns first-attempt success without retry", async () => {
    let attempts = 0;
    const result = await retryTransient(async () => {
      attempts++;
      return "ok";
    });
    expect(result).toBe("ok");
    expect(attempts).toBe(1);
  });

  test("retries on transient error then succeeds", async () => {
    let attempts = 0;
    const result = await retryTransient(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error("error connecting to api.github.com");
        return "recovered";
      },
      { baseDelayMs: 1, maxDelayMs: 4, maxAttempts: 5 },
    );
    expect(result).toBe("recovered");
    expect(attempts).toBe(3);
  });

  test("does NOT retry on non-transient error", async () => {
    let attempts = 0;
    await expect(
      retryTransient(
        async () => {
          attempts++;
          throw new Error("HTTP 401 Unauthorized");
        },
        { baseDelayMs: 1, maxAttempts: 5 },
      ),
    ).rejects.toThrow(/401/);
    expect(attempts).toBe(1);
  });

  test("gives up after maxAttempts on persistent transient", async () => {
    let attempts = 0;
    await expect(
      retryTransient(
        async () => {
          attempts++;
          throw new Error("connection refused");
        },
        { baseDelayMs: 1, maxDelayMs: 2, maxAttempts: 3 },
      ),
    ).rejects.toThrow(/connection refused/);
    expect(attempts).toBe(3);
  });

  test("onRetry callback fires per retry", async () => {
    const log: number[] = [];
    let attempts = 0;
    await retryTransient(
      async () => {
        attempts++;
        if (attempts < 3) throw new Error("connection timed out");
        return "ok";
      },
      {
        baseDelayMs: 1,
        maxDelayMs: 2,
        maxAttempts: 5,
        onRetry: (attempt) => log.push(attempt),
      },
    );
    expect(log).toEqual([1, 2]);
  });
});
