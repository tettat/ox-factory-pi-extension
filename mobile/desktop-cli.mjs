#!/usr/bin/env node
import { existsSync, mkdirSync, chmodSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readJson, writeJson, lockProcess } from './store.mjs';
import { vncPasswordFile } from './desktop-rfb.mjs';
import { runDesktopAgent } from './desktop-agent.mjs';
export function vncIni(password,port){
  const encrypted=Buffer.from(vncPasswordFile(password),'hex');
  const stored=encrypted.toString('hex')+Buffer.from([encrypted.reduce((a,b)=>a+b,0)&255]).toString('hex');
  return `[admin]\nLoopbackOnly=1\nAllowLoopback=1\nAuthRequired=1\nSecure=0\nMSLogonRequired=0\nRequireMSLogonIII=0\nNewMSLogon=0\nUseDSMPlugin=0\nUseIpv6=0\nSocketConnect=1\nHTTPConnect=0\nEnableTLS=0\nAutoPortSelect=0\nPortNumber=${port}\nQuerySetting=2\nQueryIfNoLogon=1\nInputsEnabled=1\nLocalInputsDisabled=0\nEnableUnicodeInput=1\nEnableJapInput=0\nFileTransferEnabled=0\nBlankMonitorEnabled=0\nRemoveWallpaper=0\nRemoveEffects=0\nRemoveFontSmoothing=0\nDisableTrayIcon=0\nAllowShutdown=1\nAllowProperties=0\nAllowEditClients=0\nAllowInjection=0\ncloudEnabled=0\nDebugMode=0\nAvilog=0\nprimary=1\nsecondary=0\nMaxViewers=1\nMaxViewerSetting=0\nCollabo=0\nFrame=0\nNotification=0\nLockSetting=0\n[poll]\nMaxFPS=20\nMaxCpu2=40\nEnableDriver=0\nEnableHook=1\nEnableVirtual=0\nPollFullScreen=1\n[UltraVNC]\npasswd=${stored}\n`;
}
function protect(dir){
  mkdirSync(dir,{recursive:true,mode:0o700});
  if(process.platform==='win32')execFileSync('icacls.exe',[dir,'/inheritance:r','/grant:r',`${process.env.USERDOMAIN}\\${process.env.USERNAME}:(OI)(CI)F`,'*S-1-5-18:(OI)(CI)F','*S-1-5-32-544:(OI)(CI)F'],{windowsHide:true,stdio:'pipe'});
  else chmodSync(dir,0o700);
}
export async function desktopCli(args){
  const [command,...rest]=args,o={};
  for(let i=0;i<rest.length;i+=2){if(!/^--[a-z-]+$/.test(rest[i])||!rest[i+1]||rest[i+1].startsWith('--')||o[rest[i].slice(2)])throw Error('Use --option value');o[rest[i].slice(2)]=rest[i+1];}
  const allowed={init:['state','connector-config','vnc','port'],agent:['state'],status:['state'],disable:['state']};
  if(!allowed[command]||Object.keys(o).some(k=>!allowed[command].includes(k)))throw Error('Commands: init, agent, status, disable');
  const dir=resolve(o.state||'.pi/mobile-desktop'),file=join(dir,'config.json');
  if(command==='init'){
    if(existsSync(file))throw Error('Already configured; refusing to overwrite local authorization');
    if(!o['connector-config']||!o.vnc)throw Error('init requires --connector-config <private config> --vnc <verified winvnc.exe>');
    const connectorConfig=resolve(o['connector-config']),c=readJson(connectorConfig,null),vnc=resolve(o.vnc),port=Number(o.port||5907);
    if(!c?.credential||!c.hub||!c.grants||!existsSync(vnc)||!Number.isInteger(port)||port<1024||port>65535)throw Error('Invalid local configuration');
    const grants=Object.fromEntries(Object.entries(c.grants).filter(([,g])=>g.role==='owner').map(([id])=>[id,'control']));
    if(!Object.keys(grants).length)throw Error('No existing owner grant');
    protect(dir);const password=randomBytes(6).toString('base64url');
    writeJson(join(dir,'vnc-secret.json'),{password});writeFileSync(join(dir,'ultravnc.ini'),vncIni(password,port),{mode:0o600});
    writeJson(file,{version:1,enabled:true,connectorConfig,grants,vnc,port});return {configured:true,loopbackOnly:true};
  }
  if(command==='status')return {configured:!!readJson(file,null),enabled:readJson(file,null)?.enabled===true,health:readJson(join(dir,'health.json'),null)};
  if(command==='disable'){const c=readJson(file,null);if(!c)throw Error('Not configured');c.enabled=false;writeJson(file,c);return {enabled:false,note:'Active desktop authorization ends within 5 seconds; factory services are untouched.'};}
  const c=readJson(file,null);if(!c?.enabled || process.platform!=='win32')throw Error('Enabled Windows desktop configuration required');
  const unlock=lockProcess(join(dir,'supervisor.lock')),abort=new AbortController();let child;
  try{
    const secret=readJson(join(dir,'vnc-secret.json'),null);
    writeFileSync(join(dir,'ultravnc.ini'),vncIni(secret.password,c.port),{mode:0o600});
    child=spawn(c.vnc,['-config',join(dir,'ultravnc.ini'),'-run'],{windowsHide:true,stdio:'ignore',cwd:dir});
    child.once('error',()=>abort.abort());child.once('exit',()=>abort.abort());
    const stop=()=>abort.abort();process.once('SIGINT',stop);process.once('SIGTERM',stop);
    // Fail closed if a vendor version ignores LoopbackOnly or binds other ports.
    let checked=false;
    for(let i=0;i<25&&!abort.signal.aborted;i++){
      await new Promise(r=>setTimeout(r,400));
      const output=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`@(Get-NetTCPConnection -State Listen -OwningProcess ${child.pid} -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort) | ConvertTo-Json -Compress`],{windowsHide:true,encoding:'utf8'}).trim();
      if(!output)continue;
      const rows=[JSON.parse(output)].flat();
      if(rows.some(r=>r.LocalAddress!=='127.0.0.1'||r.LocalPort!==c.port))throw Error('VNC listener is not restricted to the configured loopback port');
      checked=rows.length>0;if(checked)break;
    }
    if(!checked)throw Error('VNC did not start a loopback listener');
    await runDesktopAgent({configFile:file,stateDir:dir,signal:abort.signal});
    process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);
    return {stopped:true};
  }finally{abort.abort();if(child && child.exitCode===null)child.kill();unlock();}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{console.log(JSON.stringify(await desktopCli(process.argv.slice(2))));}catch(e){console.error(e.message);process.exitCode=1;}
}
