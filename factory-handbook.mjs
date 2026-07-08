import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

function quoteShell(value) {
  return JSON.stringify(String(value || ""));
}

function defaultWorkersDir() {
  return join(process.cwd(), ".pi", "workers");
}

export function buildFactoryWorkerHandbook(worker, {
  workersDir = defaultWorkersDir(),
  extensionDir = EXTENSION_DIR,
  backend = worker?.backend || "pi",
} = {}) {
  const workerId = String(worker?.id || worker?.name || "当前员工").trim();
  const commCli = join(extensionDir, "comm-cli.mjs");
  return [
    "## 牛马工厂工作手册",
    "",
    `你是牛马工厂员工。当前后端：${backend || "unknown"}。`,
    "",
    "### 员工通信",
    "",
    "如需联系其他员工，必须走授权式通信；不要直接改 messages/permissions 文件。",
    "未授权时通信会被拒绝；不要绕过权限。",
    "",
    "检查权限：",
    `node ${commCli} check --workers-dir ${workersDir} --subject ${quoteShell(workerId)} --action message:send --target 对方员工`,
    "",
    "发送消息：",
    `node ${commCli} send --workers-dir ${workersDir} --from ${quoteShell(workerId)} --to 对方员工 --content "消息内容"`,
    "",
    "查看收件箱：",
    `node ${commCli} inbox --workers-dir ${workersDir} --worker ${quoteShell(workerId)} --include-sent`,
    "",
    "### 留言不是派活",
    "",
    "消息只写入对方 inbox；如果需要对方立刻处理，需要由主 agent/秘书使用 wake 或 factory_command。",
    "如果收到任务类消息，请执行后用同一套授权消息机制回复发送者。",
  ].join("\n");
}
