#!/usr/bin/env node
import { join } from "node:path";

import {
  formatMessages,
  hasPermission,
  listMessages,
  markMessageRead,
  sendAuthorizedMessage,
} from "./comm.mjs";
import { createWorkerTaskRequest } from "./task-requests.mjs";

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return "";
  return process.argv[index + 1] || "";
}

function flag(name) {
  return process.argv.includes(name);
}

function usage() {
  return [
    "Usage:",
    "  node .pi/extensions/ox-factory/comm-cli.mjs send --from 员工 --to 员工 --content 内容 [--workers-dir DIR]",
    "  node .pi/extensions/ox-factory/comm-cli.mjs assign --from 员工 --to 员工 --task 任务 [--project 项目] [--mode auto|queue|steer|now] [--cwd DIR] [--workers-dir DIR]",
    "  node .pi/extensions/ox-factory/comm-cli.mjs inbox --worker 员工 [--unread-only] [--mark-read] [--workers-dir DIR]",
    "  node .pi/extensions/ox-factory/comm-cli.mjs check --subject 员工 --action message:send --target 员工 [--workers-dir DIR]",
    "",
    "说明：未授权员工不能发送消息；本 CLI 不提供 grant/revoke，授权必须由主工厂/秘书完成。",
  ].join("\n");
}

const command = process.argv[2] || "";
if (!command || flag("--help") || flag("-h")) {
  console.log(usage());
  process.exit(command ? 0 : 1);
}

const workersDir = arg("--workers-dir") || join(process.cwd(), ".pi", "workers");

try {
  if (command === "send") {
    const message = sendAuthorizedMessage(workersDir, {
      from: arg("--from"),
      to: arg("--to"),
      content: arg("--content"),
    });
    console.log(`sent ${message.id}: ${message.from} -> ${message.to}`);
    process.exit(0);
  }

  if (command === "assign") {
    const from = arg("--from") || "用户";
    const to = arg("--to");
    if (!hasPermission(workersDir, { subject: from, action: "work:assign", target: to })) {
      console.error(`${from} 没有权限对 ${to} 执行 work:assign`);
      process.exit(2);
    }
    const request = createWorkerTaskRequest(workersDir, {
      from,
      to,
      task: arg("--task") || arg("--content"),
      project: arg("--project") || "factory-task",
      cwd: arg("--cwd"),
      mode: arg("--mode") || "auto",
      source: "cli",
    });
    console.log(`assigned ${request.id}: ${request.from} -> ${request.to} (${request.mode})`);
    process.exit(0);
  }

  if (command === "inbox") {
    const worker = arg("--worker");
    const messages = listMessages(workersDir, {
      worker,
      unreadOnly: flag("--unread-only"),
      includeSent: flag("--include-sent"),
      limit: Number(arg("--limit")) || 50,
    });
    if (flag("--mark-read")) {
      for (const message of messages) {
        if (!message.read) markMessageRead(workersDir, { worker, messageId: message.id });
      }
    }
    console.log(formatMessages(messages, `${worker} 的收件箱`));
    process.exit(0);
  }

  if (command === "check") {
    const allowed = hasPermission(workersDir, {
      subject: arg("--subject"),
      action: arg("--action"),
      target: arg("--target"),
    });
    console.log(allowed ? "allowed" : "denied");
    process.exit(allowed ? 0 : 2);
  }

  console.error(`unknown command: ${command}`);
  console.error(usage());
  process.exit(1);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
