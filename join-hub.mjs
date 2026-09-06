import { saveHubConnection } from "./device-hub-client.mjs";
import { resolve } from "node:path";

const link = process.argv[2];
if (!link) {
  process.stderr.write("Usage: node join-hub.mjs <join-link> [device-name]\n");
  process.exit(2);
}
try {
  const encoded = new URL(link).searchParams.get("hubJoin");
  if (!encoded) throw new Error("链接中缺少 hubJoin 配置");
  const config = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  if (process.argv[3]) config.deviceName = process.argv[3];
  const result = saveHubConnection(resolve(".pi", "workers"), config);
  try { await fetch("http://127.0.0.1:8787/api/workers", { cache: "no-store" }); } catch {}
  process.stdout.write(`已接入 Hub：${result.url}\n设备：${result.device.name}\n`);
} catch (error) {
  process.stderr.write(`接入失败：${String(error?.message || error)}\n`);
  process.exit(1);
}
