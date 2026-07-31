#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const DEFAULT_INTERVAL_MS = 15_000;
const DEFAULT_LIMIT = 5;
const DEFAULT_CLIENT = 'ox-factory';

function arg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return '';
  return process.argv[index + 1] || '';
}

function flag(name) {
  return process.argv.includes(name);
}

function requireOption(value, name) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${name} 不能为空`);
  return text;
}

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

export function buildApiUrl(baseUrl, apiPath) {
  const normalizedBase = normalizeBaseUrl(baseUrl);
  if (!normalizedBase) throw new Error('--base-url 不能为空');
  const url = new URL(normalizedBase);
  const basePath = url.pathname.replace(/\/+$/, '');
  const wanted = String(apiPath || '').startsWith('/') ? String(apiPath) : `/${apiPath}`;
  const suffix = basePath.endsWith('/api') && wanted.startsWith('/api/') ? wanted.slice('/api'.length) : wanted;
  url.pathname = `${basePath}${suffix}`.replace(/\/+/g, '/');
  return url;
}

async function requestJson(baseUrl, apiPath, { method = 'GET', token, query, body } = {}) {
  const url = buildApiUrl(baseUrl, apiPath);
  for (const [key, value] of Object.entries(query || {})) {
    if (value != null && value !== '') url.searchParams.set(key, String(value));
  }
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(url, { method, headers, body: payload });
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.ok === false) {
    throw new Error(data.error || data.detail || `intake API request failed: ${response.status} ${url.pathname}`);
  }
  return data;
}

export function formatTicketTask(ticket, { baseUrl = '' } = {}) {
  const lines = [
    '【外部接单平台】收到新需求，请判断是否处理；需要分配时按工厂内部流程安排。',
    '',
    `Ticket: ${ticket.id || ticket._id || ''}`,
    `标题: ${ticket.title || '(无标题)'}`,
    ticket.requester ? `提交人: ${ticket.requester}` : '',
    ticket.serviceId ? `Service: ${ticket.serviceId}` : '',
    baseUrl ? `平台: ${baseUrl}` : '',
    '',
    '需求内容:',
    String(ticket.body || '').trim(),
    '',
    '处理建议:',
    '1. 先确认需求是否清晰、是否需要追问。',
    '2. 如果能处理，在工厂内继续拆解/派发。',
    '3. 完成后由接单 connector 或人工把结果回写到外部平台。',
  ];
  return lines.filter((line) => line !== '').join('\n');
}

export async function heartbeat(options) {
  const baseUrl = requireOption(options.baseUrl, '--base-url');
  const token = requireOption(options.token, '--token');
  const serviceId = requireOption(options.serviceId, '--service-id');
  return requestJson(baseUrl, '/api/agent/heartbeat', {
    method: 'POST',
    token,
    body: {
      serviceId,
      client: options.client || DEFAULT_CLIENT,
      version: options.version || '0.1.0',
      capabilities: options.capabilities || ['poll', 'deliver', 'reply'],
    },
  });
}

export async function pollTickets(options) {
  const baseUrl = requireOption(options.baseUrl, '--base-url');
  const token = requireOption(options.token, '--token');
  const serviceId = requireOption(options.serviceId, '--service-id');
  return requestJson(baseUrl, '/api/agent/poll', {
    method: 'GET',
    token,
    query: {
      serviceId,
      limit: options.limit || DEFAULT_LIMIT,
      client: options.client || DEFAULT_CLIENT,
    },
  });
}

export async function postEvent(options, event) {
  const baseUrl = requireOption(options.baseUrl, '--base-url');
  const token = requireOption(options.token, '--token');
  return requestJson(baseUrl, '/api/agent/events', {
    method: 'POST',
    token,
    body: event,
  });
}

export async function replyTicket(options, reply) {
  const baseUrl = requireOption(options.baseUrl, '--base-url');
  const token = requireOption(options.token, '--token');
  return requestJson(baseUrl, '/api/agent/reply', {
    method: 'POST',
    token,
    body: {
      ticketId: requireOption(reply.ticketId || options.ticketId, '--ticket-id'),
      idempotencyKey: reply.idempotencyKey || options.idempotencyKey || `manual-${Date.now()}`,
      text: requireOption(reply.text || options.text, '--text'),
      done: reply.done ?? options.done ?? true,
    },
  });
}

async function defaultDeliver(delivery) {
  const workersDir = requireOption(delivery.workersDir, '--workers-dir');
  const from = delivery.from || '接单平台';
  const to = requireOption(delivery.to, '--target');
  const content = requireOption(delivery.content, 'content');
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'comm-cli.mjs');
  const command = delivery.deliveryMode === 'assign' ? 'assign' : 'send';
  const args = [cli, command, '--workers-dir', workersDir, '--from', from, '--to', to];
  if (command === 'assign') {
    args.push('--task', content, '--project', delivery.project || 'factory-intake', '--mode', delivery.assignmentMode || 'queue');
  } else {
    args.push('--content', content);
  }
  const { stdout, stderr } = await execFileAsync(process.execPath, args, { maxBuffer: 1024 * 1024 });
  return { ok: true, stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function runOnce(options) {
  const deliver = options.deliver || defaultDeliver;
  const target = requireOption(options.target, '--target');
  const from = options.from || '接单平台';
  const baseUrl = requireOption(options.baseUrl, '--base-url');
  const heartbeatResult = options.skipHeartbeat ? null : await heartbeat(options);
  const poll = await pollTickets(options);
  const tickets = poll.tickets || [];
  const deliveries = [];

  for (const ticket of tickets) {
    const content = formatTicketTask(ticket, { baseUrl });
    try {
      const delivery = await deliver({
        ticket,
        from,
        to: target,
        content,
        workersDir: options.workersDir,
        deliveryMode: options.deliveryMode || 'message',
        assignmentMode: options.assignmentMode || 'queue',
        project: options.project || 'factory-intake',
      });
      deliveries.push({ ticketId: ticket.id || ticket._id, ok: true, delivery });
      await postEvent(options, {
        ticketId: ticket.id || ticket._id,
        type: 'progress',
        text: `已投递到牛马工厂：${target}`,
      });
    } catch (error) {
      deliveries.push({ ticketId: ticket.id || ticket._id, ok: false, error: error.message });
      await postEvent(options, {
        ticketId: ticket.id || ticket._id,
        type: 'error',
        text: `投递到牛马工厂失败：${error.message}`,
      }).catch(() => null);
    }
  }

  return { ok: true, heartbeat: heartbeatResult, tickets, deliveries };
}

async function watch(options) {
  const intervalMs = Number(options.intervalMs || DEFAULT_INTERVAL_MS);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const result = await runOnce(options);
      console.log(JSON.stringify({ ok: true, type: 'tick', tickets: result.tickets.length, deliveries: result.deliveries }));
    } catch (error) {
      console.error(JSON.stringify({ ok: false, type: 'tick_error', error: error.message }));
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

function readOptions() {
  return {
    baseUrl: arg('--base-url') || process.env.FACTORY_INTAKE_BASE_URL,
    token: arg('--token') || process.env.FACTORY_INTAKE_TOKEN,
    serviceId: arg('--service-id') || process.env.FACTORY_INTAKE_SERVICE_ID,
    target: arg('--target') || process.env.FACTORY_INTAKE_TARGET || '秘书',
    from: arg('--from') || process.env.FACTORY_INTAKE_FROM || '接单平台',
    workersDir: arg('--workers-dir') || process.env.OX_FACTORY_WORKERS_DIR,
    client: arg('--client') || process.env.FACTORY_INTAKE_CLIENT || DEFAULT_CLIENT,
    intervalMs: Number(arg('--interval-ms') || process.env.FACTORY_INTAKE_INTERVAL_MS || DEFAULT_INTERVAL_MS),
    limit: Number(arg('--limit') || process.env.FACTORY_INTAKE_LIMIT || DEFAULT_LIMIT),
    deliveryMode: arg('--delivery') || process.env.FACTORY_INTAKE_DELIVERY || 'message',
    assignmentMode: arg('--assignment-mode') || process.env.FACTORY_INTAKE_ASSIGNMENT_MODE || 'queue',
    project: arg('--project') || process.env.FACTORY_INTAKE_PROJECT || 'factory-intake',
    skipHeartbeat: flag('--skip-heartbeat'),
    ticketId: arg('--ticket-id'),
    idempotencyKey: arg('--idempotency-key'),
    text: arg('--text'),
    done: !flag('--open'),
  };
}

function usage() {
  return [
    'Usage:',
    '  node intake-client.mjs once --base-url URL --token TOKEN --service-id SVC --workers-dir DIR --target 秘书 [--delivery message|assign]',
    '  node intake-client.mjs watch --base-url URL --token TOKEN --service-id SVC --workers-dir DIR --target 秘书 [--interval-ms 15000]',
    '  node intake-client.mjs reply --base-url URL --token TOKEN --ticket-id TKT --text 文本 [--idempotency-key KEY] [--open]',
    '  node intake-client.mjs heartbeat --base-url URL --token TOKEN --service-id SVC',
    '',
    '说明：投递员工必须走 comm-cli 授权通信；--delivery assign 需要 work:assign 权限，message 需要 message:send 权限。',
  ].join('\n');
}

async function main() {
  const command = process.argv[2] || '';
  if (!command || flag('--help') || flag('-h')) {
    console.log(usage());
    process.exit(command ? 0 : 1);
  }
  const options = readOptions();
  if (command === 'once') {
    console.log(JSON.stringify(await runOnce(options), null, 2));
    return;
  }
  if (command === 'watch') {
    await watch(options);
    return;
  }
  if (command === 'heartbeat') {
    console.log(JSON.stringify(await heartbeat(options), null, 2));
    return;
  }
  if (command === 'poll') {
    console.log(JSON.stringify(await pollTickets(options), null, 2));
    return;
  }
  if (command === 'reply') {
    console.log(JSON.stringify(await replyTicket(options, options), null, 2));
    return;
  }
  throw new Error(`unknown command: ${command}\n${usage()}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
