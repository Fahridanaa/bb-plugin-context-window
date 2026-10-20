import assert from "node:assert/strict";
import test from "node:test";
import {
  allocate,
  allocateCategories,
  buildPiCategories,
  type WeightedCategory,
} from "../lib/context-estimate.ts";
import { parsePiSession, totalWeight } from "../lib/pi-session.ts";

function line(value: unknown): string {
  return JSON.stringify(value);
}

const SYSTEM = {
  type: "message",
  id: "sys-1",
  message: {
    role: "system",
    content: "",
    sections: {
      preamble: "You are pi.",
      tools: "- read: Read files\n- bash: Run commands",
      rules: "Be concise.",
      addendum: "Plugin guidance.",
      project_context:
        '<project_context>\n<project_instructions path="/home/u/AGENTS.md">always test</project_instructions>\n<project_instructions path="workspace/AGENTS.md">use pnpm</project_instructions>\n</project_context>',
      skills: "<skills>\n<skill><name>commit</name><description>Write commits</description><location>/s/commit/SKILL.md</location></skill>\n</skills>",
      cwd: "<cwd>/work</cwd>",
    },
    toolsAdded: [
      {
        name: "read",
        description: "Read a file",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "bash",
        description: "Run a command",
        parameters: { type: "object", properties: {} },
      },
      {
        name: "mcp_search",
        description: "Search a service",
        parameters: { type: "object", properties: {} },
      },
    ],
  },
};

const FIXTURE = [
  line({ type: "session", version: 3, id: "s1", cwd: "/work" }),
  line({ type: "model_change", modelId: "test-model" }),
  line(SYSTEM),
  line({
    type: "message",
    id: "user-1",
    message: { role: "user", content: [{ type: "text", text: "old question" }] },
  }),
  line({
    type: "message",
    id: "assistant-1",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "old answer" }],
      usage: { input: 10, cacheRead: 90, cacheWrite: 0 },
      model: "test-model",
      timestamp: "2026-01-01T10:00:00.000Z",
    },
  }),
  line({
    type: "compaction",
    firstKeptEntryId: "user-1",
    summary: "Summary of the old work.",
    tokensBefore: 1000,
  }),
  line({
    type: "message",
    id: "user-2",
    message: { role: "user", content: [{ type: "text", text: "new question" }] },
  }),
  line({
    type: "message",
    id: "assistant-2",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "think" },
        { type: "text", text: "new answer" },
      ],
      usage: { input: 20, cacheRead: 180, cacheWrite: 0 },
      model: "test-model",
      timestamp: "2026-01-01T10:05:00.000Z",
    },
  }),
  line({
    type: "message",
    id: "tool-1",
    message: {
      role: "toolResult",
      content: [{ type: "text", text: "tool output" }],
    },
  }),
].join("\n");

test("parses the pi system prompt, tools, files, and skills", () => {
  const summary = parsePiSession(FIXTURE);
  assert.equal(summary.model, "test-model");
  assert.equal(summary.compactions, 1);
  assert.equal(summary.agentsFiles.length, 2);
  assert.equal(summary.agentsFiles[0]?.path, "/home/u/AGENTS.md");
  assert.equal(summary.skills.length, 1);
  assert.equal(summary.skills[0]?.name, "commit");
  assert.equal(summary.tools.length, 3);
  assert.equal(
    summary.tools.find((tool) => tool.name === "mcp_search")?.builtin,
    false,
  );
  assert.equal(
    summary.tools.find((tool) => tool.name === "read")?.builtin,
    true,
  );
  assert.equal(summary.lastPromptTokens, 200);
});

test("counts only messages still in context after the compaction boundary", () => {
  const summary = parsePiSession(FIXTURE);
  // user-1 is the first kept entry, so its text counts; the pre-boundary
  // entries before it do not.
  assert.equal(summary.messages.user, "old question".length + "new question".length);
  assert.equal(
    summary.messages.assistant,
    "old answer".length + "think".length + "new answer".length,
  );
  assert.equal(summary.messages.toolResults, "tool output".length);
});

test("buildPiCategories covers every weighted part exactly once", () => {
  const summary = parsePiSession(FIXTURE);
  const categories = buildPiCategories(summary);
  const weights = categories.reduce(
    (total, category) => total + category.weight,
    0,
  );
  assert.equal(weights, totalWeight(summary));
  const ids = categories.map((category) => category.id);
  assert.deepEqual(ids, [
    "system",
    "tools",
    "agents",
    "extension-tools",
    "skills",
    "compaction",
    "messages",
  ]);
  const agents = categories.find((category) => category.id === "agents");
  assert.equal(agents?.entries.length, 2);
  const tools = categories.find((category) => category.id === "tools");
  assert.deepEqual(
    tools?.entries
      .map((entry) => entry.label)
      .filter((label) => label !== "Tool descriptions")
      .sort(),
    ["bash", "read"],
  );
});

test("allocate sums to the exact total", () => {
  assert.deepEqual(allocate([1, 1, 1], 100), [34, 33, 33]);
  assert.equal(
    allocate([1, 2, 3, 4], 101).reduce((total, value) => total + value, 0),
    101,
  );
  assert.deepEqual(allocate([], 10), []);
  assert.deepEqual(allocate([0, 0], 10), [0, 0]);
});

test("allocateCategories keeps category and entry totals consistent", () => {
  const categories: WeightedCategory[] = [
    {
      id: "system",
      label: "System prompt",
      weight: 3,
      entries: [
        { id: "a", label: "A", weight: 1 },
        { id: "b", label: "B", weight: 2 },
      ],
    },
    {
      id: "messages",
      label: "Messages",
      weight: 7,
      entries: [{ id: "c", label: "C", weight: 7 }],
    },
  ];
  const allocated = allocateCategories(categories, 999);
  assert.equal(
    allocated.reduce((total, category) => total + category.tokens, 0),
    999,
  );
  for (const category of allocated) {
    assert.equal(
      category.entries.reduce((total, entry) => total + entry.tokens, 0),
      category.tokens,
    );
  }
});

test("a malformed trailing line is ignored", () => {
  const summary = parsePiSession(`${FIXTURE}\n{"type":"message","id":"partial"`);
  assert.equal(summary.compactions, 1);
  assert.equal(summary.messages.user > 0, true);
});
