import fetch, { Headers, Request, Response } from 'node-fetch';

export function ensureFetchPolyfill() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = fetch;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).Headers = Headers;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).Request = Request;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).Response = Response;
}

