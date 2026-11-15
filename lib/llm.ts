// The only place that talks to the model. Product skills get no tools, no network access
// and no KB writes: a request is a system prompt, user content and a JSON output schema.
import Anthropic from "@anthropic-ai/sdk";

export const MODEL = "claude-sonnet-5-5";
// A small, fast model for short helper steps where speed matters more than depth.
export const FAST_MODEL = "claude-haiku-5-5";

export type SkillContent =
  | { type: "text"; text: string }
  | { type: "image"; mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif"; data: string };

export type ModelRequest = {
  system: string;
  content: SkillContent[];
  schema: Record<string, unknown>;
  // Run on FAST_MODEL.
  fast?: boolean;
};

// text is null when the model produced no usable text (refusal, max_tokens, empty).
export type ModelResponse = { text: string | null; stopReason: string | null };

// One turn of a tool loop: the model either calls tools or gives its final JSON.
export type ToolDef = { name: string; description: string; input_schema: { type: "object"; [key: string]: unknown } };
export type AgentMessage = { role: "user" | "assistant"; content: Anthropic.Beta.Messages.BetaContentBlockParam[] };
export type AgentRequest = { system: string; messages: AgentMessage[]; tools: ToolDef[]; schema: Record<string, unknown> };
export type AgentTurn = {
  stopReason: string | null;
  text: string | null;
  toolCalls: { id: string; name: string; input: unknown }[];
  // The assistant message to append unchanged before the tool results.
  assistant: AgentMessage;
};

export interface ModelClient {
  complete(request: ModelRequest): Promise<ModelResponse>;
  // `onText` receives the text written so far, as it grows.
  turn(request: AgentRequest, onText?: (snapshot: string) => void): Promise<AgentTurn>;
}

export function imageBlock(c: Extract<SkillContent, { type: "image" }>) {
  return { type: "image" as const, source: { type: "base64" as const, media_type: c.mediaType, data: c.data } };
}

// The system prompt and the tools are the same on every turn and every question, so they are
// cached; the conversation after them is not.
export function buildTurnParams(request: AgentRequest): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming {
  return {
    model: MODEL,
    max_tokens: 4096,
    system: [{ type: "text", text: request.system, cache_control: { type: "ephemeral" } }],
    messages: request.messages,
    tools: request.tools.map((t) => ({ ...t, strict: true })),
    output_config: { effort: "low", format: { type: "json_schema", schema: apiSchema(request.schema) } },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  };
}

// The API takes a JSON schema without the "$schema" meta key.
function apiSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(schema).filter(([k]) => k !== "$schema"));
}

// Note on the spec's `temperature: 0`: the current API rejects sampling parameters, so the
// output is pinned by structured outputs (json_schema) plus low effort instead.
export function buildMessageParams(request: ModelRequest): Anthropic.Beta.Messages.MessageCreateParamsNonStreaming {
  return {
    model: request.fast ? FAST_MODEL : MODEL,
    max_tokens: request.fast ? 512 : 2048,
    system: request.system,
    messages: [
      {
        role: "user",
        content: request.content.map((c) =>
          c.type === "text"
            ? { type: "text" as const, text: c.text }
            : { type: "image" as const, source: { type: "base64" as const, media_type: c.mediaType, data: c.data } },
        ),
      },
    ],
    output_config: { effort: "low", format: { type: "json_schema", schema: apiSchema(request.schema) } },
    // The small model has no server-side fallback.
    ...(request.fast ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
  };
}

export class AnthropicModelClient implements ModelClient {
  private client: Anthropic;

  constructor(client: Anthropic = new Anthropic({ timeout: 60_000, maxRetries: 1 })) {
    this.client = client;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const response = await this.client.beta.messages.create(buildMessageParams(request));
    if (response.stop_reason !== "end_turn") return { text: null, stopReason: response.stop_reason };
    const text = response.content.find((b) => b.type === "text");
    return { text: text && "text" in text ? text.text : null, stopReason: response.stop_reason };
  }

  async turn(request: AgentRequest, onText?: (snapshot: string) => void): Promise<AgentTurn> {
    const stream = this.client.beta.messages.stream(buildTurnParams(request));
    if (onText) stream.on("text", (_delta, snapshot) => onText(snapshot));
    const response = await stream.finalMessage();
    const text = response.content.findLast((b) => b.type === "text");
    return {
      stopReason: response.stop_reason,
      text: response.stop_reason === "end_turn" && text && "text" in text ? text.text : null,
      toolCalls: response.content.flatMap((b) => (b.type === "tool_use" ? [{ id: b.id, name: b.name, input: b.input }] : [])),
      assistant: { role: "assistant", content: response.content as unknown as AgentMessage["content"] },
    };
  }
}
