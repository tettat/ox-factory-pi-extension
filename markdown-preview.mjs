const DEFAULT_MAX_CHARS = 120;

function compactPreview(value, max = DEFAULT_MAX_CHARS) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (!text) return "消息";
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…`;
}

function firstNonEmptyLine(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || "";
}

function startsWithTable(lines) {
  const first = lines.findIndex((line) => line.trim());
  if (first < 0) return false;
  const line = lines[first].trim();
  const next = lines[first + 1]?.trim() || "";
  return line.startsWith("|") && line.includes("|") && /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(next);
}

function stripInlineMarkdown(text) {
  return text
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1");
}

function stripBlockMarkdown(line) {
  return line
    .replace(/^\s{0,3}#{1,6}\s+/, "")
    .replace(/^\s{0,3}>\s?/, "")
    .replace(/^\s*[-*+]\s+/, "")
    .replace(/^\s*\d+[.)]\s+/, "")
    .replace(/^\s*[-*_]{3,}\s*$/, "");
}

export function markdownPreviewText(value, { max = DEFAULT_MAX_CHARS } = {}) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";

  const first = firstNonEmptyLine(raw);
  const lines = raw.split(/\r?\n/);
  if (/^!\[[^\]]*\]\([^)]+\)/.test(first) || /^<img\b/i.test(first)) return "[图片]";
  if (/^```/.test(first) || /^~~~/.test(first)) return "[代码]";
  if (/^<table\b/i.test(first) || startsWithTable(lines)) return "[表格]";

  const cleaned = lines
    .map(stripBlockMarkdown)
    .map(stripInlineMarkdown)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ");
  return compactPreview(cleaned, max);
}
