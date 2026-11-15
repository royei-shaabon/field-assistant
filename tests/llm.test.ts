// The request sent to the API: right model, structured output, no tools, no sampling params.
import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import { AnthropicModelClient, buildMessageParams, MODEL } from "../lib/llm";

const request = {
  system: "SAMPLE system",
  content: [
    { type: "image" as const, mediaType: "image/png" as const, data: "AAAA" },
    { type: "text" as const, text: "SAMPLE" },
  ],
  schema: { $schema: "http://json-schema.org/draft-07/schema#", type: "object", additionalProperties: false },
};

test("request uses the spec model with a JSON schema and no tools", () => {
  const params = buildMessageParams(request);
  assert.equal(MODEL, "claude-sonnet-5-5");
  assert.equal(params.model, MODEL);
  assert.deepEqual(params.output_config?.format, {
    type: "json_schema",
    schema: { type: "object", additionalProperties: false },
  });
  for (const banned of ["tools", "tool_choice", "temperature", "top_p", "top_k", "mcp_servers"]) {
    assert.ok(!(banned in params), `request must not set ${banned}`);
  }
});

test("image is sent as base64 before the text", () => {
  const content = buildMessageParams(request).messages[0].content as { type: string; source?: unknown }[];
  assert.deepEqual(content.map((c) => c.type), ["image", "text"]);
  assert.deepEqual(content[0].source, { type: "base64", media_type: "image/png", data: "AAAA" });
});

function fakeSdk(response: object): Anthropic {
  return { beta: { messages: { create: async () => response } } } as unknown as Anthropic;
}

test("client returns the text block on end_turn", async () => {
  const client = new AnthropicModelClient(
    fakeSdk({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: "{}" }] }),
  );
  assert.deepEqual(await client.complete(request), { text: "{}", stopReason: "end_turn" });
});

test("client returns no text on refusal or max_tokens", async () => {
  for (const stop_reason of ["refusal", "max_tokens"]) {
    const client = new AnthropicModelClient(fakeSdk({ stop_reason, content: [{ type: "text", text: "{" }] }));
    assert.deepEqual(await client.complete(request), { text: null, stopReason: stop_reason });
  }
});
