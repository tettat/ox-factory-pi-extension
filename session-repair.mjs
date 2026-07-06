export function repairToolResultParents(inputEntries) {
  const entries = inputEntries.map((entry) => structuredClone(entry));
  const callToAssistant = new Map();

  for (const entry of entries) {
    const message = entry.message || {};
    if (message.role !== "assistant") continue;
    for (const part of message.content || []) {
      if (part && part.type === "toolCall" && part.id) {
        callToAssistant.set(part.id, entry.id);
      }
    }
  }

  const lastResultForAssistant = new Map();
  const fixes = [];

  for (const entry of entries) {
    const message = entry.message || {};
    if (message.role !== "toolResult") continue;
    const assistantId = callToAssistant.get(message.toolCallId);
    if (!assistantId) continue;

    const expectedParent = lastResultForAssistant.get(assistantId) || assistantId;
    if (entry.parentId !== expectedParent) {
      fixes.push({
        id: entry.id,
        oldParentId: entry.parentId,
        newParentId: expectedParent,
        toolName: message.toolName,
        toolCallId: message.toolCallId,
      });
      entry.parentId = expectedParent;
    }
    lastResultForAssistant.set(assistantId, entry.id);
  }

  return { entries, fixes };
}

