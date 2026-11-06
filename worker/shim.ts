// The PayPal Server SDK sends requests through axios, whose fetch adapter always passes cache: "default".
// Cloudflare Workers refuse that option, so it is dropped here. This module must load before the SDK,
// because axios keeps its own reference to fetch and Request when it is first imported.
const realFetch = globalThis.fetch;
const RealRequest = globalThis.Request;

function withoutCache<T extends RequestInit | undefined>(init: T): T {
  if (!init || !("cache" in init)) return init;
  const { cache: _dropped, ...rest } = init;
  return rest as T;
}

globalThis.Request = class extends RealRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, withoutCache(init));
  }
} as typeof Request;

globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => realFetch(input, withoutCache(init))) as typeof fetch;

export {};
