// Scripted ModelClient for tests: no network. Each call takes the next reply in order.
import type { AgentRequest, AgentTurn, ModelClient, ModelRequest, ModelResponse } from "../../lib/llm";

type Reply = string | null | Error | ((request: ModelRequest) => string);

export class FakeModel implements ModelClient {
  requests: ModelRequest[] = [];
  constructor(private replies: Reply[]) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const reply = this.replies.length > 1 ? this.replies.shift()! : this.replies[0];
    if (reply instanceof Error) throw reply;
    if (reply === null) return { text: null, stopReason: "refusal" };
    return { text: typeof reply === "function" ? reply(request) : reply, stopReason: "end_turn" };
  }

  async turn(): Promise<AgentTurn> {
    throw new Error("FakeModel has no tool loop; use FakeAgent");
  }
}

// Scripted tool loop: each entry is either the queries to search for or the final JSON.
type TurnStep = { search: string[] } | { final: unknown } | { stop: string };
type TurnReply = TurnStep | ((request: AgentRequest) => TurnStep);

export class FakeAgent implements ModelClient {
  turns: AgentRequest[] = [];
  constructor(private replies: TurnReply[]) {}

  // The first-search step. Without `plan` it fails, and the loop runs with no head start.
  plans: ModelRequest[] = [];
  plan?: string[];

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.plans.push(request);
    if (!this.plan) throw new Error("FakeAgent has no plan for the first search");
    return { text: JSON.stringify({ queries: this.plan }), stopReason: "end_turn" };
  }

  async turn(request: AgentRequest, onText?: (snapshot: string) => void): Promise<AgentTurn> {
    this.turns.push(structuredClone(request));
    const next = this.replies.length > 1 ? this.replies.shift()! : this.replies[0];
    const reply = typeof next === "function" ? next(request) : next;
    if ("stop" in reply) return { stopReason: reply.stop, text: null, toolCalls: [], assistant: { role: "assistant", content: [] } };
    if ("search" in reply) {
      const call = { id: `t${this.turns.length}`, name: "search_documents", input: { queries: reply.search } };
      return {
        stopReason: "tool_use",
        text: null,
        toolCalls: [call],
        assistant: { role: "assistant", content: [{ type: "tool_use", ...call }] },
      };
    }
    const text = JSON.stringify(reply.final);
    // Like the real client: the text arrives in pieces.
    for (let end = 40; onText && end < text.length + 40; end += 40) onText(text.slice(0, end));
    return { stopReason: "end_turn", text, toolCalls: [], assistant: { role: "assistant", content: [{ type: "text", text }] } };
  }
}

// Reads the JSON the skill put in its last text block.
export function lastInput(request: ModelRequest): Record<string, unknown> {
  const text = [...request.content].reverse().find((c) => c.type === "text");
  return JSON.parse(text && text.type === "text" ? text.text : "{}");
}
