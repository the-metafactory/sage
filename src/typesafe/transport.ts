import type { SystemOneRequest, TypeSafeTransport } from "./types.ts";

const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export function createHttpTypeSafeTransport(options: {
  apiKey: string;
  fetchImpl?: typeof fetch;
  endpoint?: string;
}): TypeSafeTransport {
  const fetchImpl = options.fetchImpl ?? fetch;
  const endpoint = options.endpoint ?? TYPESAFE_ENDPOINT;
  return {
    async execute(request: SystemOneRequest, signal: AbortSignal): Promise<unknown> {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(request),
        signal,
      });
      if (!response.ok) {
        throw new Error(`TypeSafe HTTP ${response.status}`);
      }
      return response.json();
    },
  };
}
