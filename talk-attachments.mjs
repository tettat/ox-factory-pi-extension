import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";

export const TALK_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const TALK_IMAGE_MAX_COUNT = 6;
export const TALK_IMAGE_ORPHAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const MIME_EXTENSIONS = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/webp", ".webp"],
  ["image/gif", ".gif"],
]);

function nowIso(now = new Date()) {
  return now.toISOString();
}

function attachmentsDir(workersDir) {
  return join(workersDir, "attachments", "web-talk");
}

function normalizeDeclaredMime(value) {
  const mime = String(value || "").split(";", 1)[0].trim().toLowerCase();
  return mime === "image/jpg" ? "image/jpeg" : mime;
}

function detectImageMime(data) {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return "image/jpeg";
  }
  if (data.length >= 6) {
    const signature = data.subarray(0, 6).toString("ascii");
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  if (data.length >= 12 && data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  return "";
}

function safeOriginalName(value, mimeType) {
  const fallback = `image${MIME_EXTENSIONS.get(mimeType) || ""}`;
  const name = basename(String(value || fallback))
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .trim()
    .slice(0, 180);
  return name || fallback;
}

function assertAttachmentId(value) {
  const id = String(value || "").trim();
  if (!/^timg_[a-z0-9]+_[a-f0-9]{16}$/.test(id)) {
    throw new Error(`非法 talk attachment id: ${value}`);
  }
  return id;
}

function metadataPath(workersDir, id) {
  return join(attachmentsDir(workersDir), `${assertAttachmentId(id)}.json`);
}

function writeMetadata(workersDir, metadata) {
  const dir = attachmentsDir(workersDir);
  mkdirSync(dir, { recursive: true });
  const target = metadataPath(workersDir, metadata.id);
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  renameSync(temporary, target);
}

function readMetadata(workersDir, id) {
  const safeId = assertAttachmentId(id);
  const file = metadataPath(workersDir, safeId);
  if (!existsSync(file)) throw new Error(`talk attachment 不存在: ${safeId}`);
  let metadata;
  try {
    metadata = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error(`talk attachment 元数据损坏: ${safeId}`);
  }
  if (metadata?.id !== safeId || !MIME_EXTENSIONS.has(metadata?.mimeType)) {
    throw new Error(`talk attachment 元数据非法: ${safeId}`);
  }
  const expectedStorageName = `${safeId}${MIME_EXTENSIONS.get(metadata.mimeType)}`;
  if (metadata.storageName !== expectedStorageName) {
    throw new Error(`talk attachment 存储路径非法: ${safeId}`);
  }
  const contentPath = join(attachmentsDir(workersDir), expectedStorageName);
  if (!existsSync(contentPath) || !statSync(contentPath).isFile()) {
    throw new Error(`talk attachment 内容不存在: ${safeId}`);
  }
  return metadata;
}

export function createTalkAttachment(workersDir, {
  data,
  declaredMimeType,
  originalName,
  now = new Date(),
} = {}) {
  const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data || []);
  if (bytes.length === 0) throw new Error("图片内容为空");
  if (bytes.length > TALK_IMAGE_MAX_BYTES) {
    throw new Error(`图片过大，单张不能超过 ${TALK_IMAGE_MAX_BYTES / 1024 / 1024} MiB`);
  }
  const detectedMimeType = detectImageMime(bytes);
  if (!detectedMimeType) throw new Error("不支持的图片格式，仅支持 PNG、JPEG、WebP、GIF");
  const normalizedDeclaredMime = normalizeDeclaredMime(declaredMimeType);
  if (!MIME_EXTENSIONS.has(normalizedDeclaredMime)) {
    throw new Error("Content-Type 不是受支持的图片 MIME");
  }
  if (normalizedDeclaredMime !== detectedMimeType) {
    throw new Error(`图片声明 MIME 与文件内容不一致: ${normalizedDeclaredMime} != ${detectedMimeType}`);
  }

  cleanupUnboundTalkAttachments(workersDir, { now });
  const id = `timg_${now.getTime().toString(36)}_${randomBytes(8).toString("hex")}`;
  const storageName = `${id}${MIME_EXTENSIONS.get(detectedMimeType)}`;
  const metadata = {
    id,
    name: safeOriginalName(originalName, detectedMimeType),
    mimeType: detectedMimeType,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    storageName,
    createdAt: nowIso(now),
  };
  const dir = attachmentsDir(workersDir);
  mkdirSync(dir, { recursive: true });
  const contentPath = join(dir, storageName);
  writeFileSync(contentPath, bytes, { flag: "wx" });
  try {
    writeMetadata(workersDir, metadata);
  } catch (error) {
    rmSync(contentPath, { force: true });
    throw error;
  }
  return metadata;
}

export function resolveTalkAttachmentIds(workersDir, ids = []) {
  if (!Array.isArray(ids)) throw new Error("attachmentIds 必须是数组");
  const uniqueIds = [...new Set(ids.map((id) => String(id || "").trim()).filter(Boolean))];
  if (uniqueIds.length > TALK_IMAGE_MAX_COUNT) {
    throw new Error(`每条消息最多 ${TALK_IMAGE_MAX_COUNT} 张图片`);
  }
  return uniqueIds.map((id) => readMetadata(workersDir, id));
}

export function bindTalkAttachments(workersDir, attachments = [], { requestId, now = new Date() } = {}) {
  const id = String(requestId || "").trim();
  if (!id) throw new Error("requestId 不能为空");
  return attachments.map((attachment) => {
    const current = readMetadata(workersDir, attachment?.id || attachment);
    if (current.requestId && current.requestId !== id) {
      throw new Error(`talk attachment 已绑定到其他请求: ${current.id}`);
    }
    const bound = {
      ...current,
      requestId: id,
      boundAt: current.boundAt || nowIso(now),
    };
    writeMetadata(workersDir, bound);
    return bound;
  });
}

export function assertTalkAttachmentsUnbound(workersDir, attachments = []) {
  for (const attachment of attachments) {
    const current = readMetadata(workersDir, attachment?.id || attachment);
    if (current.requestId || current.boundAt) {
      throw new Error(`talk attachment 已绑定到请求 ${current.requestId || "unknown"}: ${current.id}`);
    }
  }
}

export function talkAttachmentContentPath(workersDir, attachmentId) {
  const metadata = readMetadata(workersDir, attachmentId);
  return join(attachmentsDir(workersDir), metadata.storageName);
}

export function materializeTalkAttachments(workersDir, attachments = [], { requestId } = {}) {
  return attachments.map((attachment) => {
    const metadata = readMetadata(workersDir, attachment?.id || attachment);
    if (requestId && metadata.requestId !== String(requestId)) {
      throw new Error(`talk attachment 绑定请求不一致: ${metadata.id}`);
    }
    return { ...metadata, path: join(attachmentsDir(workersDir), metadata.storageName) };
  });
}

export function buildPiAttachmentArgs(attachments = []) {
  return attachments.map((attachment) => `@${attachment.path}`);
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mentionTokenRegex(tokens, flags = "g") {
  const alternatives = [...tokens]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegex);
  if (!alternatives.length) return null;
  return new RegExp(`(${alternatives.join("|")})(?!\\d)`, flags);
}

function textHasMentionToken(text, token) {
  return mentionTokenRegex([token], "u")?.test(String(text || "")) || false;
}

export function filterTalkAttachmentMentionsInText(text, mentions = []) {
  if (!Array.isArray(mentions)) return [];
  return mentions.filter((mention) => mention?.token && textHasMentionToken(text, mention.token));
}

export function normalizeTalkAttachmentMentions(text, attachments = [], value = []) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw new Error("attachmentMentions 必须是数组");
  const attachmentIds = new Set(attachments.map((attachment) => String(attachment?.id || "")).filter(Boolean));
  const seenIds = new Set();
  const seenTokens = new Set();
  return value.map((mention) => {
    const attachmentId = String(mention?.attachmentId || "").trim();
    const token = String(mention?.token || "").trim();
    if (!attachmentIds.has(attachmentId)) {
      throw new Error(`attachment mention 不属于本条消息: ${attachmentId}`);
    }
    if (!/^@图片[1-9]\d{0,2}$/.test(token)) {
      throw new Error(`attachment mention token 非法: ${token}`);
    }
    if (seenIds.has(attachmentId) || seenTokens.has(token)) {
      throw new Error(`attachment mention 重复: ${attachmentId} ${token}`);
    }
    if (!textHasMentionToken(text, token)) {
      throw new Error(`attachment mention 在正文中不存在: ${token}`);
    }
    seenIds.add(attachmentId);
    seenTokens.add(token);
    return { attachmentId, token };
  });
}

export function orderTalkAttachmentsForMentions(text, attachments = [], mentions = []) {
  const firstPositionById = new Map();
  for (const mention of mentions) {
    const matcher = mentionTokenRegex([mention.token], "u");
    const position = matcher ? String(text || "").search(matcher) : -1;
    if (position >= 0) firstPositionById.set(mention.attachmentId, position);
  }
  return attachments
    .map((attachment, index) => ({ attachment, index }))
    .sort((a, b) => {
      const aPosition = firstPositionById.get(a.attachment.id) ?? Number.POSITIVE_INFINITY;
      const bPosition = firstPositionById.get(b.attachment.id) ?? Number.POSITIVE_INFINITY;
      return aPosition - bPosition || a.index - b.index;
    })
    .map(({ attachment }) => attachment);
}

export function buildPiAttachmentReferenceContext(text, attachments = [], mentions = []) {
  if (!mentions.length) return "";
  const mentionById = new Map(mentions.map((mention) => [mention.attachmentId, mention]));
  const ordered = orderTalkAttachmentsForMentions(text, attachments, mentions);
  return [
    "图片引用映射（图片附件按下列顺序随本轮消息提供）：",
    ...ordered.map((attachment, index) => {
      const mention = mentionById.get(attachment.id);
      const reference = mention?.token || "未在正文中 @";
      return `- ${reference} = 第 ${index + 1} 张随附图片（${attachment.name || "图片"}）`;
    }),
    "正文中的 @图片N 只表示引用位置，不是文件路径。",
  ].join("\n");
}

export function buildCodexTurnInput(text, attachments = [], mentions = []) {
  const input = [];
  const sourceText = String(text || "");
  const attachmentById = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  const mentionByToken = new Map(mentions.map((mention) => [mention.token, mention]));
  const matcher = mentionTokenRegex(mentionByToken.keys());
  const emittedAttachmentIds = new Set();
  let cursor = 0;
  const pushText = (value) => {
    if (!value) return;
    const previous = input[input.length - 1];
    if (previous?.type === "text") previous.text += value;
    else input.push({ type: "text", text: value, text_elements: [] });
  };
  if (matcher) {
    for (const match of sourceText.matchAll(matcher)) {
      const end = match.index + match[0].length;
      pushText(sourceText.slice(cursor, end));
      const mention = mentionByToken.get(match[0]);
      const attachment = attachmentById.get(mention?.attachmentId);
      if (attachment && !emittedAttachmentIds.has(attachment.id)) {
        input.push({ type: "localImage", path: attachment.path });
        emittedAttachmentIds.add(attachment.id);
      }
      cursor = end;
    }
    pushText(sourceText.slice(cursor));
  } else if (sourceText.trim()) {
    pushText(sourceText);
  }
  for (const attachment of attachments) {
    if (emittedAttachmentIds.has(attachment.id)) continue;
    input.push({ type: "localImage", path: attachment.path });
  }
  return input;
}

export function assertTalkImageBackendSupported(backend, attachments = []) {
  if (!attachments.length) return;
  const normalized = String(backend || "pi").trim().toLowerCase() || "pi";
  if (normalized === "pi" || normalized === "codex") return;
  const label = normalized === "claude" ? "Claude" : normalized === "kimi" ? "Kimi" : normalized;
  throw new Error(`${label} 后端第一版暂不支持图片输入，请改用 Pi 或 Codex 员工`);
}

export function cleanupUnboundTalkAttachments(workersDir, {
  now = new Date(),
  maxAgeMs = TALK_IMAGE_ORPHAN_MAX_AGE_MS,
} = {}) {
  const dir = attachmentsDir(workersDir);
  if (!existsSync(dir)) return 0;
  const names = readdirSync(dir);
  const nameSet = new Set(names);
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    const file = join(dir, name);
    try {
      const metadata = JSON.parse(readFileSync(file, "utf8"));
      const createdAt = new Date(metadata.createdAt || 0).getTime();
      if (metadata.boundAt || !Number.isFinite(createdAt) || now.getTime() - createdAt <= maxAgeMs) continue;
      const safeId = assertAttachmentId(metadata.id);
      const extension = MIME_EXTENSIONS.get(metadata.mimeType);
      if (!extension || metadata.storageName !== `${safeId}${extension}` || name !== `${safeId}.json`) continue;
      const content = join(dir, metadata.storageName);
      rmSync(content, { force: true });
      rmSync(file, { force: true });
      removed += 1;
    } catch {
      // Cleanup is best-effort; corrupt files remain available for manual inspection.
    }
  }
  for (const name of names) {
    const match = name.match(/^(timg_[a-z0-9]+_[a-f0-9]{16})\.(?:png|jpg|webp|gif)$/);
    if (!match || nameSet.has(`${match[1]}.json`)) continue;
    const file = join(dir, name);
    try {
      const stats = statSync(file);
      if (!stats.isFile() || now.getTime() - stats.mtimeMs <= maxAgeMs) continue;
      rmSync(file, { force: true });
      removed += 1;
    } catch {
      // The file may have disappeared during the best-effort cleanup pass.
    }
  }
  return removed;
}
