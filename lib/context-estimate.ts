// Turns a pi session summary into weighted categories, then scales those
// weights to the token total the provider reported.
//
// The weights are character counts, not tokens: the different tokenizers make
// an exact local count impossible. Scaling to the reported total keeps the
// proportions honest and the bar the right length, which is what the panel
// promises ("estimated split").

import {
  PI_SECTION_LABELS,
  sectionChars,
  totalWeight,
  type PiSessionSummary,
} from "./pi-session.ts";

export interface WeightedEntry {
  id: string;
  label: string;
  weight: number;
}

export interface WeightedCategory {
  id: string;
  label: string;
  weight: number;
  entries: WeightedEntry[];
}

export interface TokenEntry {
  id: string;
  label: string;
  tokens: number;
}

export interface TokenCategory {
  id: string;
  label: string;
  tokens: number;
  entries: TokenEntry[];
}

/** Split `total` across `weights` by largest remainder, so the parts sum exactly. */
export function allocate(weights: number[], total: number): number[] {
  const safeTotal = Math.max(0, Math.round(total));
  const sum = weights.reduce((value, weight) => value + Math.max(0, weight), 0);
  if (sum <= 0 || safeTotal === 0) return weights.map(() => 0);

  const exact = weights.map((weight) => (safeTotal * Math.max(0, weight)) / sum);
  const out = exact.map((value) => Math.floor(value));
  let remainder = safeTotal - out.reduce((value, part) => value + part, 0);

  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);

  for (let step = 0; step < remainder; step += 1) {
    const slot = order[step % order.length];
    if (slot === undefined) break;
    out[slot.index] = (out[slot.index] ?? 0) + 1;
  }
  // Floating point can leave a stray unit; keep the invariant exact.
  remainder = safeTotal - out.reduce((value, part) => value + part, 0);
  if (remainder > 0) out[0] = (out[0] ?? 0) + remainder;
  return out;
}

/** Allocate category tokens, then split each category across its entries. */
export function allocateCategories(
  categories: WeightedCategory[],
  total: number,
): TokenCategory[] {
  const categoryTokens = allocate(
    categories.map((category) => category.weight),
    total,
  );
  return categories.map((category, index) => {
    const tokens = categoryTokens[index] ?? 0;
    const entryTokens = allocate(
      category.entries.map((entry) => entry.weight),
      tokens,
    );
    return {
      id: category.id,
      label: category.label,
      tokens,
      entries: category.entries.map((entry, entryIndex) => ({
        id: entry.id,
        label: entry.label,
        tokens: entryTokens[entryIndex] ?? 0,
      })),
    };
  });
}

function entry(id: string, label: string, weight: number): WeightedEntry {
  return { id, label, weight };
}

function category(
  id: string,
  label: string,
  entries: WeightedEntry[],
): WeightedCategory {
  return {
    id,
    label,
    weight: entries.reduce((value, item) => value + Math.max(0, item.weight), 0),
    entries: entries.filter((item) => item.weight > 0),
  };
}

/**
 * The categories shown for a pi thread, in display order. Everything the
 * context is made of appears exactly once, so the weights sum to
 * `totalWeight(summary)`.
 */
export function buildPiCategories(summary: PiSessionSummary): WeightedCategory[] {
  // System prompt: every section except the ones with their own category.
  const systemEntries: WeightedEntry[] = [];
  for (const section of summary.sections) {
    if (
      section.key === "tools" ||
      section.key === "skills" ||
      section.key === "project_context"
    ) {
      continue;
    }
    systemEntries.push(
      entry(`section-${section.key}`, PI_SECTION_LABELS[section.key] ?? section.key, section.chars),
    );
  }

  const agentsChars = summary.agentsFiles.reduce(
    (value, file) => value + file.chars,
    0,
  );
  const projectRemainder = Math.max(
    0,
    sectionChars(summary, "project_context") - agentsChars,
  );
  if (projectRemainder > 0) {
    systemEntries.push(
      entry("project-context", "Project context", projectRemainder),
    );
  }

  // Tools: the prose section plus every schema pi attached.
  const toolEntries: WeightedEntry[] = [];
  const toolSection = sectionChars(summary, "tools");
  if (toolSection > 0) {
    toolEntries.push(entry("tool-descriptions", "Tool descriptions", toolSection));
  }
  for (const tool of summary.tools) {
    toolEntries.push(
      entry(`tool-${tool.name}`, tool.name, tool.chars),
    );
  }

  // Extension tools are the ones pi's own `<tools>` section does not cover.
  const extensionEntries = summary.tools
    .filter((tool) => !tool.builtin)
    .map((tool) => entry(`ext-${tool.name}`, tool.name, tool.chars));

  // Builtin tools: prose + the schemas pi marked as builtin.
  const builtinEntries = toolEntries.filter((item) => {
    if (item.id === "tool-descriptions") return true;
    const name = item.id.slice("tool-".length);
    return summary.tools.some((tool) => tool.name === name && tool.builtin);
  });

  // Skills: one entry per skill, with the unparsed remainder kept visible.
  const skillEntries = summary.skills.map((skill, index) =>
    entry(`skill-${index}`, skill.name, skill.chars),
  );
  const skillsSection = sectionChars(summary, "skills");
  const parsedSkillChars = summary.skills.reduce(
    (value, skill) => value + skill.chars,
    0,
  );
  const skillRemainder = Math.max(0, skillsSection - parsedSkillChars);
  if (skillRemainder > 0) {
    skillEntries.push(
      entry("skill-instructions", "Skill instructions", skillRemainder),
    );
  }

  const messageEntries: WeightedEntry[] = [];
  if (summary.messages.user > 0) {
    messageEntries.push(entry("messages-user", "User messages", summary.messages.user));
  }
  if (summary.messages.assistant > 0) {
    messageEntries.push(
      entry("messages-assistant", "Assistant replies", summary.messages.assistant),
    );
  }
  if (summary.messages.toolResults > 0) {
    messageEntries.push(
      entry("messages-tools", "Tool results", summary.messages.toolResults),
    );
  }

  const categories: WeightedCategory[] = [
    category("system", "System prompt", systemEntries),
    category("tools", "Builtin tools", builtinEntries),
    category(
      "agents",
      "AGENTS.md files",
      summary.agentsFiles.map((file, index) =>
        entry(`agents-${index}`, file.path, file.chars),
      ),
    ),
    category("extension-tools", "Extension tools", extensionEntries),
    category("skills", "Loaded skills", skillEntries),
    category(
      "compaction",
      "Compaction summary",
      summary.compactionSummaryChars > 0
        ? [entry("compaction-summary", "Summary", summary.compactionSummaryChars)]
        : [],
    ),
    category("messages", "Messages", messageEntries),
  ];

  return categories.filter((item) => item.weight > 0);
}

export { totalWeight };
