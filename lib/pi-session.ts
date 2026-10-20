// Parses a pi bridge session file into the pieces that make up its prompt.
//
// pi writes ~/.bb/pi-bridge-sessions/<provider-thread-id>.jsonl. Each line is
// one entry: the system prompt (with named sections and tool schemas), user and
// assistant messages, tool results, model changes, and compactions. BB's own
// context reading reports a used/total pair for pi, but no category breakdown,
// so this module recovers the proportions of the prompt and lets the caller
// scale them to the total pi reported.
//
// This file is pure on purpose: the server reads the file and calls in here,
// and the tests exercise it with fixture text.

export interface PiToolWeight {
  name: string;
  chars: number;
  builtin: boolean;
}

export interface PiFileWeight {
  path: string;
  chars: number;
}

export interface PiSkillWeight {
  name: string;
  chars: number;
}

export interface PiSectionWeight {
  key: string;
  chars: number;
}

export interface PiMessageWeights {
  user: number;
  assistant: number;
  toolResults: number;
  images: number;
}

export interface PiSessionSummary {
  model: string | null;
  sections: PiSectionWeight[];
  tools: PiToolWeight[];
  agentsFiles: PiFileWeight[];
  skills: PiSkillWeight[];
  compactionSummaryChars: number;
  compactions: number;
  messages: PiMessageWeights;
  lastPromptTokens: number | null;
  capturedAt: string | null;
}

/** Friendly names for the sections pi puts in the system prompt. */
export const PI_SECTION_LABELS: Record<string, string> = {
  preamble: "Preamble",
  tools: "Tool descriptions",
  rules: "Rules",
  docs: "Docs",
  addendum: "Dynamic instructions",
  project_context: "Project context",
  skills: "Skills",
  cwd: "Working directory",
};

/** Tools pi always describes in its own `<tools>` section. */
const CORE_TOOL_NAMES = new Set(["read", "bash", "edit", "write"]);

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Length of one content part as the model sees it, in characters. */
function partChars(part: unknown): { chars: number; image: boolean } {
  const record = asRecord(part);
  if (record === null) {
    return { chars: JSON.stringify(part)?.length ?? 0, image: false };
  }
  const type = asString(record.type);
  switch (type) {
    case "text":
      return { chars: (asString(record.text) ?? "").length, image: false };
    case "thinking":
      return {
        chars: (asString(record.thinking) ?? asString(record.text) ?? "").length,
        image: false,
      };
    case "toolCall":
      return {
        chars:
          (asString(record.name)?.length ?? 0) +
          (JSON.stringify(record.arguments ?? {})?.length ?? 0),
        image: false,
      };
    case "image":
      return { chars: 0, image: true };
    default:
      return { chars: JSON.stringify(part)?.length ?? 0, image: false };
  }
}

function messageChars(message: JsonRecord): { chars: number; images: number } {
  const content = message.content;
  let chars = 0;
  let images = 0;
  if (typeof content === "string") {
    chars += content.length;
  } else {
    for (const part of asArray(content)) {
      const measured = partChars(part);
      chars += measured.chars;
      if (measured.image) images += 1;
    }
  }
  return { chars, images };
}

function readAgentsFiles(projectContext: string): PiFileWeight[] {
  const files: PiFileWeight[] = [];
  const pattern =
    /<project_instructions\s+path="([^"]*)"\s*>([\s\S]*?)<\/project_instructions>/g;
  for (const match of projectContext.matchAll(pattern)) {
    const path = match[1];
    if (path === undefined) continue;
    files.push({ path, chars: match[0].length });
  }
  return files;
}

function readSkills(skillsSection: string): PiSkillWeight[] {
  const skills: PiSkillWeight[] = [];
  const blockPattern = /<skill>([\s\S]*?)<\/skill>/g;
  for (const match of skillsSection.matchAll(blockPattern)) {
    const block = match[0];
    const body = match[1] ?? "";
    const name = /<name>([\s\S]*?)<\/name>/.exec(body)?.[1]?.trim();
    const location = /<location>([\s\S]*?)<\/location>/.exec(body)?.[1]?.trim();
    const label = name || location?.split("/").filter(Boolean).at(-2) || "Skill";
    skills.push({ name: label, chars: block.length });
  }
  return skills;
}

/**
 * Read one pi session file. Malformed lines (a partial trailing write) are
 * skipped. Only the messages still in the model's context — those after the
 * last compaction's first kept entry — count toward the message total.
 */
export function parsePiSession(text: string): PiSessionSummary {
  const sectionTexts = new Map<string, string>();
  const lineById = new Map<string, number>();
  const tools = new Map<string, PiToolWeight>();
  const builtinToolNames = new Set(CORE_TOOL_NAMES);
  const messageEntries: {
    index: number;
    id: string | null;
    role: string;
    chars: number;
    images: number;
  }[] = [];

  let model: string | null = null;
  let capturedAt: string | null = null;
  let lastPromptTokens: number | null = null;
  let compactions = 0;
  let lastCompactionIndex = -1;
  let lastFirstKeptId: string | null = null;
  let lastSummaryChars = 0;

  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]?.trim();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const entry = asRecord(parsed);
    if (entry === null) continue;
    const type = asString(entry.type);
    const entryId = asString(entry.id);
    if (entryId !== null) lineById.set(entryId, index);

    if (type === "model_change") {
      const next = asString(entry.modelId);
      if (next !== null) model = next;
      continue;
    }

    if (type === "compaction") {
      compactions += 1;
      lastCompactionIndex = index;
      lastFirstKeptId = asString(entry.firstKeptEntryId);
      lastSummaryChars = (asString(entry.summary) ?? "").length;
      continue;
    }

    if (type !== "message") continue;
    const message = asRecord(entry.message);
    if (message === null) continue;
    const role = asString(message.role) ?? "unknown";

    if (role === "system") {
      const sectionValues = asRecord(message.sections);
      if (sectionValues !== null) {
        for (const [key, value] of Object.entries(sectionValues)) {
          if (typeof value === "string") sectionTexts.set(key, value);
        }
      }
      const toolDescriptions = sectionTexts.get("tools") ?? "";
      for (const match of toolDescriptions.matchAll(/^-\s+([a-z0-9_]+):/gm)) {
        const name = match[1];
        if (name !== undefined) builtinToolNames.add(name);
      }
      for (const tool of asArray(message.toolsAdded)) {
        const record = asRecord(tool);
        const name = asString(record?.name);
        if (record === null || name === null) continue;
        tools.set(name, {
          name,
          chars: JSON.stringify(tool)?.length ?? 0,
          builtin: builtinToolNames.has(name),
        });
      }
      continue;
    }

    const measured = messageChars(message);
    messageEntries.push({
      index,
      id: asString(entry.id),
      role,
      chars: measured.chars + measured.images * 6000,
      images: measured.images,
    });

    const timestamp = asString(message.timestamp);
    if (timestamp !== null) capturedAt = timestamp;
    if (role === "assistant") {
      const usage = asRecord(message.usage);
      if (usage !== null) {
        const input =
          (asNumber(usage.input) ?? 0) +
          (asNumber(usage.cacheRead) ?? 0) +
          (asNumber(usage.cacheWrite) ?? 0);
        if (input > 0) lastPromptTokens = input;
      }
      const messageModel = asString(message.model);
      if (messageModel !== null) model = messageModel;
    }
  }

  // Everything after the last compaction's first kept entry is in context.
  let keepFrom = lastCompactionIndex + 1;
  if (lastCompactionIndex >= 0 && lastFirstKeptId !== null) {
    const kept =
      lineById.get(lastFirstKeptId) ??
      messageEntries.find((entry) => entry.id === lastFirstKeptId)?.index;
    if (kept !== undefined) keepFrom = kept;
  }

  const messages: PiMessageWeights = {
    user: 0,
    assistant: 0,
    toolResults: 0,
    images: 0,
  };
  for (const entry of messageEntries) {
    if (entry.index < keepFrom) continue;
    messages.images += entry.images;
    if (entry.role === "user") messages.user += entry.chars;
    else if (entry.role === "assistant") messages.assistant += entry.chars;
    else if (entry.role === "toolResult") messages.toolResults += entry.chars;
  }

  // Builtin classification can depend on a tool schema seen before the
  // `<tools>` section, so re-check once all system messages are merged.
  for (const tool of tools.values()) {
    tool.builtin = builtinToolNames.has(tool.name);
  }

  return {
    model,
    sections: [...sectionTexts.entries()].map(([key, value]) => ({
      key,
      chars: value.length,
    })),
    tools: [...tools.values()].sort((a, b) => b.chars - a.chars),
    agentsFiles: readAgentsFiles(sectionTexts.get("project_context") ?? ""),
    skills: readSkills(sectionTexts.get("skills") ?? ""),
    compactionSummaryChars: lastSummaryChars,
    compactions,
    messages,
    lastPromptTokens,
    capturedAt,
  };
}

export function sectionChars(summary: PiSessionSummary, key: string): number {
  return summary.sections.find((section) => section.key === key)?.chars ?? 0;
}

/** Total character weight of everything still in context. */
export function totalWeight(summary: PiSessionSummary): number {
  let total = 0;
  for (const section of summary.sections) total += section.chars;
  for (const tool of summary.tools) total += tool.chars;
  total += summary.messages.user;
  total += summary.messages.assistant;
  total += summary.messages.toolResults;
  total += summary.compactionSummaryChars;
  return total;
}
