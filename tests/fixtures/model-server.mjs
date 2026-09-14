import { createServer } from "node:http";

export async function startModelServer(responder) {
  const requests = [];
  const server = createServer(async (request, response) => {
    if (request.url?.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: "deepseek-v4-pro", object: "model" }] }));
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ body, headers: request.headers, url: request.url });
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (delta, finish_reason = null, usage) => {
      response.write(`data: ${JSON.stringify({
        id: `response-${requests.length}`, object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000), model: body.model,
        choices: [{ index: 0, delta, finish_reason }], ...(usage ? { usage } : {}),
      })}\n\n`);
    };
    const finish = (reason = "stop") => {
      send({}, reason, {
        prompt_tokens: 20, completion_tokens: 5, total_tokens: 25,
        prompt_cache_hit_tokens: 2, prompt_cache_miss_tokens: 18,
      });
      response.end("data: [DONE]\n\n");
    };
    try { await responder({ body, send, finish, request, response, index: requests.length - 1 }); }
    catch (error) { response.destroy(error); }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    requests,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
