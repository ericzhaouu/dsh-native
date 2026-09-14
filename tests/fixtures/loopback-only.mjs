const fetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (!["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)) {
    throw new Error(`Offline integration forbids external fetch: ${url.origin}`);
  }
  return fetch(input, init);
};
