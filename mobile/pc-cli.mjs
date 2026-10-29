#!/usr/bin/env node
import { resolve } from 'node:path';
import { selectPcConnector, pcConnectorStatus } from './pc-connector.mjs';
try {
  const [command, ...args] = process.argv.slice(2), opts = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, '');
    if (!args[i]?.startsWith('--') || !args[i + 1] || args[i + 1].startsWith('--') || Object.hasOwn(opts, key) || !['workers', 'config', 'runtime-state'].includes(key)) throw Error('Use --workers path [--config path --runtime-state path]');
    opts[key] = args[i + 1];
  }
  const workersDir = resolve(opts.workers || '.pi/workers');
  if (command === 'use') {
    if (!opts.config) throw Error('use requires --config (file path only; never a credential)');
    console.log(JSON.stringify(selectPcConnector({ workersDir, configFile: opts.config, stateDir: opts['runtime-state'] })));
  } else if (command === 'status') {
    if (opts.config || opts['runtime-state']) throw Error('status only accepts --workers');
    console.log(JSON.stringify(pcConnectorStatus(workersDir)));
  } else throw Error('Commands: use, status. Select an existing Connector; this does not enroll or restart services.');
} catch (e) { console.error(e.message); process.exitCode = 1; }
