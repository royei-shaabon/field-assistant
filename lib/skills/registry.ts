// Skills, tools and which agent gets which.
//
// A SKILL is a written area of responsibility: skills/<name>/SKILL.md says what the skill is
// in charge of, its rules, and which tools it may use on each channel. A TOOL is one specific
// action: tools/<name>/tool.json says what a model is told about it and what it takes; code
// runs it. An agent is given the skills skills/registry.json lists for it, and exactly the
// tools those skills name: there is no other way for a tool to reach a model.
import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";

export type Agent = "chat" | "call" | "video";
export type ToolDecl = { name: string; access: "read"; answered_by: string; calls_model: boolean; description: string; input_schema: { type: "object"; [key: string]: unknown } };
// `body`: the skill as the call agent is told it. `chat`: the same responsibility as the chat agent is told it (chat.md).
export type SkillDoc = { name: string; title: string; tools: Record<Agent, string[]>; body: string; chat?: string };
type Registry = { agents: Record<Agent, { model: string; skills: string[] }>; jobs: { name: string; where: string; model: string }[] };

const ROOT = () => /*turbopackIgnore: true*/ process.cwd();
const AGENTS: Agent[] = ["chat", "call", "video"];

// A declaration that does not match its folder, or asks for more than reading, stops the
// server from answering rather than giving a model a power nobody reviewed.
export function loadTools(dir = path.join(ROOT(), "tools")): Map<string, ToolDecl> {
  const out = new Map<string, ToolDecl>();
  for (const name of fs.readdirSync(/*turbopackIgnore: true*/ dir).sort()) {
    const decl = JSON.parse(fs.readFileSync(path.join(/*turbopackIgnore: true*/ dir, name, "tool.json"), "utf8")) as ToolDecl;
    if (decl.name !== name) throw new Error(`tool ${name}: the folder name and "name" differ`);
    if (decl.access !== "read") throw new Error(`tool ${name}: only "read" access is allowed`);
    out.set(name, decl);
  }
  return out;
}

const list = (value: unknown): string[] => (typeof value === "string" ? value.split(",").map((s) => s.trim()).filter(Boolean) : Array.isArray(value) ? value.map(String) : []);

export function loadSkills(dir = path.join(ROOT(), "skills")): Map<string, SkillDoc> {
  const out = new Map<string, SkillDoc>();
  for (const name of fs.readdirSync(/*turbopackIgnore: true*/ dir).sort()) {
    const file = path.join(/*turbopackIgnore: true*/ dir, name, "SKILL.md");
    if (!fs.existsSync(file)) continue;
    const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(fs.readFileSync(file, "utf8"));
    if (!match) throw new Error(`skill ${name}: SKILL.md must begin with a "---" header`);
    const head = (YAML.parse(match[1]) ?? {}) as { name?: string; title?: string; tools?: Record<string, unknown> | null };
    if (head.name !== name) throw new Error(`skill ${name}: the folder name and "name" differ`);
    if (!head.title) throw new Error(`skill ${name}: no title`);
    const tools = Object.fromEntries(AGENTS.map((a) => [a, list(head.tools?.[a])])) as Record<Agent, string[]>;
    const chatFile = path.join(/*turbopackIgnore: true*/ dir, name, "chat.md");
    const chat = fs.existsSync(chatFile) ? fs.readFileSync(chatFile, "utf8").trim() : undefined;
    out.set(name, { name, title: head.title, tools, body: match[2].trim(), ...(chat ? { chat } : {}) });
  }
  return out;
}

let cached: { registry: Registry; skills: Map<string, SkillDoc>; tools: Map<string, ToolDecl> } | undefined;
function all() {
  if (cached) return cached;
  const registry = JSON.parse(fs.readFileSync(path.join(ROOT(), "skills", "registry.json"), "utf8")) as Registry;
  const skills = loadSkills();
  const tools = loadTools();
  for (const [agent, { skills: names }] of Object.entries(registry.agents)) {
    for (const name of names) {
      const skill = skills.get(name);
      if (!skill) throw new Error(`agent ${agent}: no such skill "${name}"`);
      for (const tool of skill.tools[agent as Agent]) if (!tools.has(tool)) throw new Error(`skill ${name}: no such tool "${tool}"`);
    }
  }
  return (cached = { registry, skills, tools });
}

// The skills of an agent, in the order they are written into its brief.
export function agentSkills(agent: Agent): SkillDoc[] {
  const { registry, skills } = all();
  return registry.agents[agent].skills.map((name) => skills.get(name)!);
}

// The tools of an agent: what its skills name for its channel, each once. Nothing else.
export function agentTools(agent: Agent): ToolDecl[] {
  const { tools } = all();
  return [...new Set(agentSkills(agent).flatMap((s) => s.tools[agent]))].map((name) => tools.get(name)!);
}

// Which skill a tool belongs to for this agent (for the record of a call).
export function skillOfTool(agent: Agent, tool: string): string | undefined {
  return agentSkills(agent).find((s) => s.tools[agent].includes(tool))?.name;
}

export const fill = (text: string, values: Record<string, string>) => text.replace(/\{\{(\w+)\}\}/g, (whole, key: string) => values[key] ?? whole);

// The chat agent's chapters: one per skill, in the registry's order. A chat skill without its
// own text stops the server from answering rather than leaving a responsibility unsaid.
export function chatChapters(): string {
  return agentSkills("chat")
    .map((skill) => {
      if (!skill.chat) throw new Error(`skill ${skill.name}: the chat agent has it, but there is no chat.md`);
      return `# ${skill.title}\n\n${skill.chat}`;
    })
    .join("\n\n");
}
