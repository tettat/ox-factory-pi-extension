import { buildFactoryWorkerHandbook } from "./factory-handbook.mjs";

function clean(value) {
  return String(value || "").trim();
}

function backendDisplayName(backend) {
  if (backend === "codex") return "Codex";
  if (backend === "claude") return "Claude Code";
  return "Pi";
}

export function buildWorkerSystemPrompt(worker = {}, options = {}) {
  const agentDef = clean(options.agentDef);
  const backend = clean(options.backend) || clean(worker.backend) || "pi";
  const workersDir = clean(options.workersDir);
  const id = clean(worker.id || worker.name) || "未知员工";
  const role = clean(worker.role) || "worker";

  return [
    `你的名字叫 **${id}**，职位是 ${role}。`,
    "",
    `你是牛马工厂里的 ${backendDisplayName(backend)} 员工。保持这个身份和长期上下文，不要因为新的 turn 忘记之前的工作。`,
    "",
    buildFactoryWorkerHandbook({ ...worker, id, role }, { workersDir, backend }),
    agentDef ? `\n${agentDef}` : "",
  ].join("\n").trim();
}

export function buildWorkerTaskPrompt({ project, task, additionalContext } = {}) {
  const lines = [];
  const cleanProject = clean(project);
  if (cleanProject) lines.push(`## 项目: ${cleanProject}`, "");
  lines.push("## 任务", String(task || ""));
  const cleanAdditionalContext = clean(additionalContext);
  if (cleanAdditionalContext) lines.push("", "## 附加上下文", cleanAdditionalContext);
  return lines.join("\n").trim();
}
