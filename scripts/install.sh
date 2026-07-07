#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/tettat/ox-factory-pi-extension.git"
DEFAULT_MODEL="${DEEPSEEK_MODEL:-deepseek-v4-pro}"
DEFAULT_THINKING="${DEEPSEEK_THINKING_LEVEL:-high}"

log() { printf '%s\n' "$*"; }
warn() { printf '⚠️  %s\n' "$*" >&2; }
fail() { printf '❌ %s\n' "$*" >&2; exit 1; }

is_interactive() {
  [[ -t 0 && -t 1 ]]
}

prompt_choice() {
  local prompt="$1"
  local default_value="$2"
  local answer=""
  if is_interactive; then
    read -r -p "$prompt" answer || true
  fi
  printf '%s' "${answer:-$default_value}"
}

require_pi() {
  if ! command -v pi >/dev/null 2>&1; then
    cat >&2 <<'MSG'
❌ 没找到 Pi CLI（命令 `pi` 不存在）。

请先安装并确认 Pi 可用，再重新运行本脚本：

  pi --help

MSG
    exit 1
  fi
}

install_extension() {
  local scope="${OX_FACTORY_INSTALL_SCOPE:-}"
  if [[ -z "$scope" ]]; then
    log "请选择插件安装范围："
    log "  1) 当前目录 / 当前 Pi 项目（推荐，不影响其它项目）"
    log "  2) 全局安装（所有 Pi 项目可用）"
    local choice
    choice="$(prompt_choice '安装到哪里？[1/2，默认 1]: ' '1')"
    case "$choice" in
      2|g|G|global|Global) scope="global" ;;
      *) scope="local" ;;
    esac
  fi

  case "$scope" in
    local|project|current|1)
      log "📦 安装 ox-factory 到当前目录的 Pi 项目配置..."
      pi install "$REPO_URL" --local --approve
      ;;
    global|2)
      log "📦 全局安装 ox-factory..."
      pi install "$REPO_URL" --approve
      ;;
    *)
      fail "未知安装范围：$scope。请设置 OX_FACTORY_INSTALL_SCOPE=local 或 global。"
      ;;
  esac
}

write_deepseek_config_with_python() {
  python3 - <<'PY'
import json
import os
from pathlib import Path

agent_dir = Path.home() / ".pi" / "agent"
agent_dir.mkdir(parents=True, exist_ok=True)

def read_json(path):
    try:
        if path.exists():
            return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        pass
    return {}

def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

api_key = os.environ["DEEPSEEK_API_KEY_VALUE"]
model = os.environ.get("DEEPSEEK_MODEL_VALUE", "deepseek-v4-pro")
thinking = os.environ.get("DEEPSEEK_THINKING_VALUE", "high")

auth_path = agent_dir / "auth.json"
auth = read_json(auth_path)
auth["deepseek"] = {"type": "api_key", "key": api_key}
write_json(auth_path, auth)

settings_path = agent_dir / "settings.json"
settings = read_json(settings_path)
settings["defaultProvider"] = "deepseek"
settings["defaultModel"] = model
settings["defaultThinkingLevel"] = thinking
write_json(settings_path, settings)
PY
}

write_deepseek_config_with_node() {
  node - <<'NODE'
const fs = require("fs");
const os = require("os");
const path = require("path");

const agentDir = path.join(os.homedir(), ".pi", "agent");
fs.mkdirSync(agentDir, { recursive: true });

function readJson(file) {
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (_) {}
  return {};
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + "\n", "utf8");
}

const apiKey = process.env.DEEPSEEK_API_KEY_VALUE;
const model = process.env.DEEPSEEK_MODEL_VALUE || "deepseek-v4-pro";
const thinking = process.env.DEEPSEEK_THINKING_VALUE || "high";

const authPath = path.join(agentDir, "auth.json");
const auth = readJson(authPath);
auth.deepseek = { type: "api_key", key: apiKey };
writeJson(authPath, auth);

const settingsPath = path.join(agentDir, "settings.json");
const settings = readJson(settingsPath);
settings.defaultProvider = "deepseek";
settings.defaultModel = model;
settings.defaultThinkingLevel = thinking;
writeJson(settingsPath, settings);
NODE
}

configure_deepseek() {
  if [[ "${OX_FACTORY_SKIP_DEEPSEEK:-}" == "1" ]]; then
    log "⏭️  已按 OX_FACTORY_SKIP_DEEPSEEK=1 跳过 DeepSeek 配置。"
    return
  fi

  local answer
  answer="$(prompt_choice '是否现在配置 DeepSeek 官方 API 给主 agent 使用？[Y/n]: ' 'Y')"
  case "$answer" in
    n|N|no|NO|No)
      log "⏭️  跳过 DeepSeek 配置。之后也可以手动写入 ~/.pi/agent/auth.json。"
      return
      ;;
  esac

  local key="${DEEPSEEK_API_KEY:-}"
  if [[ -z "$key" && is_interactive ]]; then
    read -r -s -p '请输入 DeepSeek API Key（输入不回显；留空跳过）: ' key || true
    printf '\n'
  fi

  if [[ -z "$key" ]]; then
    warn "没有提供 DEEPSEEK_API_KEY，已跳过 DeepSeek 配置。"
    return
  fi

  log "🔐 写入 DeepSeek 凭证和默认模型到 ~/.pi/agent/（不会打印 key）..."
  umask 077
  export DEEPSEEK_API_KEY_VALUE="$key"
  export DEEPSEEK_MODEL_VALUE="$DEFAULT_MODEL"
  export DEEPSEEK_THINKING_VALUE="$DEFAULT_THINKING"
  if command -v python3 >/dev/null 2>&1; then
    write_deepseek_config_with_python
  elif command -v node >/dev/null 2>&1; then
    write_deepseek_config_with_node
  else
    fail "需要 python3 或 node 才能安全更新 Pi 配置文件。"
  fi
  unset DEEPSEEK_API_KEY_VALUE
  log "✅ 已设置 Pi 默认模型：deepseek / $DEFAULT_MODEL / thinking=$DEFAULT_THINKING"
}

main() {
  log "🚜 Ox Factory / 牛马工厂 Pi Extension 一键安装"
  require_pi
  install_extension
  configure_deepseek
  cat <<'MSG'

✅ 安装流程结束。

下一步：
  1. 在目标项目目录启动或 reload Pi，让插件重新加载。
  2. 在 Pi 里输入 /ox-web 打开本地工厂大盘。
  3. 如果你没有配置 DeepSeek，也可以继续使用已有 Pi 模型配置。

常用命令：
  /ox-web
  /ox-web --status
  也可以让主 agent 用 factory_hire 招募 Pi 后端员工。

MSG
}

main "$@"
