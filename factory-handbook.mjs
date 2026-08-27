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
    "检查派活权限：",
    `node ${commCli} check --workers-dir ${workersDir} --subject ${quoteShell(workerId)} --action work:assign --target 对方员工`,
    "",
    "派具体任务给其他员工：",
    `node ${commCli} assign --workers-dir ${workersDir} --from ${quoteShell(workerId)} --to 对方员工 --task "任务内容"`,
    "",
    "查看收件箱：",
    `node ${commCli} inbox --workers-dir ${workersDir} --worker ${quoteShell(workerId)} --include-sent`,
    "",
    "### 全局任务看板",
    "",
    "整个工厂共用一套任务看板，project 只是筛选字段。人类可见 status 是自由文本（TODO、设计中、待验收等），无需预先注册。",
    "你可以使用 factory_task_list / factory_task_get 查询任务，使用 factory_task_update 更新自己的进度、状态和上下文，使用 factory_task_split 拆分子任务。",
    "不要直接修改 factory-tasks.jsonl；给其他员工指派或执行任务时仍需 work:assign 权限，并使用 factory_task_assign / factory_task_run。",
    "执行状态由系统单独记录；不要因为 job 结束就机械地覆盖业务状态，应根据真实阶段选择“待验收”“完成”等状态。",
    "",
    "### 外包 / 白纸 subagent",
    "",
    "如果需要把一个明确的小任务交给无记忆外包 agent，可以直接调用外包 CLI；不要绕主 agent，也不要直接改 outsource-runs 文件。",
    "外包 agent 不继承你的上下文，请在任务里写清背景、文件路径和验收标准。",
    "",
    "查看外包 profile：",
    `node ${join(extensionDir, "outsource-cli.mjs")} profiles --workers-dir ${workersDir}`,
    "",
    "派外包并等待结果：",
    `node ${join(extensionDir, "outsource-cli.mjs")} run --workers-dir ${workersDir} --from ${quoteShell(workerId)} --profile whitepaper-a --project 项目名 --task "任务内容" --wait`,
    "",
    "大任务建议先写入临时文件再派发：",
    `node ${join(extensionDir, "outsource-cli.mjs")} run --workers-dir ${workersDir} --from ${quoteShell(workerId)} --profile whitepaper-a --project 项目名 --task-file /tmp/outsource-task.md --wait`,
    "",
    "### 留言不是派活",
    "",
    "消息只写入对方 inbox；派活会写入 worker-task request，并由 Pi 主进程在 work:assign 授权通过后唤起目标员工执行。",
    "派活完成后系统会把结果作为 task_result 消息回给派活来源；普通消息中的任务仍需你执行后主动回复。",
  ].join("\n");
}
