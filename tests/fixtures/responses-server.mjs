import { createServer } from "node:http";

export async function startResponsesServer(responder) {
  const requests = [];
  const server = createServer(async (request, response) => {
    if (!request.url?.endsWith("/responses")) {
      response.writeHead(404);
      response.end("Only the local Responses fixture is available.");
      return;
    }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    requests.push({ body, headers: request.headers });
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const output = [];
    const id = `resp_sensitive_${requests.length}`;
    let sequence = 0;
    const emit = (type, data) => response.write(
      `event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...data })}\n\n`,
    );
    emit("response.created", { response: { id, object: "response", status: "in_progress", output: [] } });
    const add = (item) => {
      const index = output.length;
      output.push(item);
      emit("response.output_item.added", { output_index: index, item });
      return index;
    };
    const done = (index, item) => {
      output[index] = item;
      emit("response.output_item.done", { output_index: index, item });
    };
    const reasoning = (text = "private planning") => {
      const item = { id: "rs_sensitive", type: "reasoning", summary: [], encrypted_content: "encrypted_sensitive" };
      const index = add(item);
      emit("response.reasoning_summary_text.delta", { output_index: index, item_id: item.id, summary_index: 0, delta: text });
      emit("response.reasoning_summary_part.done", {
        output_index: index, item_id: item.id, summary_index: 0, part: { type: "summary_text", text },
      });
      done(index, { ...item, summary: [{ type: "summary_text", text }] });
    };
    const tool = (name, args, callId = "call_fixture") => {
      const item = { id: "fc_sensitive", type: "function_call", call_id: callId, name, arguments: "", status: "in_progress" };
      const index = add(item);
      const json = JSON.stringify(args);
      emit("response.function_call_arguments.delta", { output_index: index, item_id: item.id, delta: json });
      done(index, { ...item, arguments: json, status: "completed" });
    };
    const text = (value) => {
      const item = { id: "msg_sensitive", type: "message", role: "assistant", status: "in_progress", content: [] };
      const index = add(item);
      emit("response.output_text.delta", { output_index: index, item_id: item.id, content_index: 0, delta: value });
      done(index, { ...item, status: "completed", content: [{ type: "output_text", text: value, annotations: [] }] });
    };
    const finish = (usage = { input_tokens: 20, output_tokens: 8, total_tokens: 28,
      input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 3 } }) => {
      emit("response.completed", { response: {
        id, object: "response", status: "completed", model: body.model, output,
        usage,
      } });
      response.end("data: [DONE]\n\n");
    };
    try { await responder({ body, reasoning, tool, text, finish, request, response, index: requests.length - 1 }); }
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
