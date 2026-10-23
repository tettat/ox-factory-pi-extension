import WebSocket from 'ws';
import { join } from 'node:path';
import { readJson, writeJson, lockProcess } from './store.mjs';
import { validateHubUrl } from './connector.mjs';
import { DESKTOP_PROTOCOL } from './desktop-relay-core.mjs';
import { openVnc } from './desktop-rfb.mjs';

export async function runDesktopAgent({configFile,stateDir,signal,onStatus=()=>{}}){
  const unlock=lockProcess(join(stateDir,'agent.lock'));
  let lastError=null,lastRelayClose=null;
  const diagnostic=e=>{lastError=/^DESKTOP_[A-Z0-9_-]+$/.test(String(e))?e:'DESKTOP_CONNECTION_ERROR';};
  const status=value=>{writeJson(join(stateDir,'health.json'),{pid:process.pid,status:value,lastError,lastRelayClose,observedAt:Date.now()});onStatus(value);};
  const config=()=>readJson(configFile,null);
  let socket, stream=null, pendingPeer=null, delay=1000;
  const drop=()=>{pendingPeer=null;const old=stream;stream=null;old?.vnc?.close();};
  function grant(peer){
    const l=config(),c=l?.connectorConfig && readJson(l.connectorConfig,null);
    if(!l?.enabled || !['owner','operator','viewer'].includes(c?.grants?.[peer.principalId]?.role))return false;
    const local=l.grants?.[peer.principalId];
    return local==='control' && (peer.mode==='view' || (peer.role!=='viewer' && c.grants[peer.principalId].role!=='viewer')) || local==='view' && peer.mode==='view';
  }
  try{
    while(!signal?.aborted){
      try{
        const l=config();if(!l?.enabled)throw Error();
        const c=readJson(l.connectorConfig,null);validateHubUrl(c.hub,c.allowInsecureLoopback);
        const r=await fetch(c.hub+'/connector/desktop-ticket',{method:'POST',headers:{authorization:'Bearer '+c.credential,'content-type':'application/json'},body:'{}',redirect:'error',signal:AbortSignal.timeout(12000)});
        if(!r.ok)throw Error('DESKTOP_TICKET_HTTP_'+r.status);
        const t=await r.json(),u=new URL(t.relay);validateHubUrl(u.origin,c.allowInsecureLoopback);u.protocol=u.protocol==='https:'?'wss:':'ws:';u.pathname='/desktop';
        socket=new WebSocket(u,[DESKTOP_PROTOCOL,'t.'+t.ticket],{maxPayload:65572,handshakeTimeout:15000,perMessageDeflate:false});
        const ws=socket;let last=Date.now(),ready=false;
        const send=m=>{if(ws.readyState===1)ws.send(JSON.stringify(m));};
        const fail=(peer,code='DESKTOP_VNC_OFFLINE')=>{if(pendingPeer!==peer)return;drop();send({type:'error',peer,code});};
        const begin=async m=>{
          drop();pendingPeer=m.peer;
          try{
            // UltraVNC tears down its desktop capture thread after the last
            // client leaves. Do not race that teardown when switching modes.
            await new Promise(r=>setTimeout(r,500));
            if(pendingPeer!==m.peer || ws.readyState!==1)return;
            if(!/^[a-f0-9-]{36}$/.test(m.peer)||!['view','control'].includes(m.mode)||!grant(m))return fail(m.peer,'DESKTOP_LOCAL_DENIED');
            const current=config(),secret=readJson(join(stateDir,'vnc-secret.json'),null);
            const st={peer:m.peer,claims:m,sent:0,acked:0,chunks:[],queued:0,scheduled:false,ackAt:Date.now()};
            function flush(){
              st.scheduled=false;if(stream!==st || ws.readyState!==1)return;
              const b=Buffer.concat(st.chunks);st.chunks=[];st.queued=0;
              for(let p=0;p<b.length;p+=32768){const part=b.subarray(p,p+32768);st.sent+=part.length;ws.send(Buffer.concat([Buffer.from(st.peer),part]));}
              if(st.sent-st.acked>=524288 || ws.bufferedAmount>524288)st.vnc.pause();
            }
            const vnc=await openVnc({port:current.port,password:secret?.password,canControl:()=>stream===st && m.mode==='control' && grant(m),onData:b=>{
              if(stream!==st || ws.readyState!==1)return;
              st.chunks.push(b);st.queued+=b.length;
              if(st.queued>1048576 || ws.bufferedAmount>2097152){diagnostic('DESKTOP_BACKPRESSURE_LIMIT');return fail(m.peer);}
              // Pause during the TCP data callback, not only in the later
              // setImmediate flush: a busy producer can deliver many packets
              // in one poll phase before that flush gets a chance to run.
              if(st.queued+st.sent-st.acked>=524288)st.vnc?.pause();
              if(!st.scheduled){st.scheduled=true;setImmediate(flush);}
            },onClose:reason=>{if(pendingPeer===m.peer){diagnostic(reason);fail(m.peer);}}});
            if(pendingPeer!==m.peer || ws.readyState!==1){vnc.close();return;}
            st.vnc=vnc;stream=st;lastError=null;send({type:'open',peer:m.peer,width:vnc.width,height:vnc.height});vnc.start();
          }catch(e){diagnostic(e.message);fail(m.peer);}
        };
        await new Promise(resolve=>{
          const abort=()=>{drop();ws.close(1000,'本机已停用');};signal?.addEventListener('abort',abort,{once:true});
          const heartbeat=setInterval(()=>{
            try{
              if(Date.now()-last>30000 || !config()?.enabled){drop();ws.terminate();return;}
              if(stream && (!grant(stream.claims) || (stream.sent>stream.acked && Date.now()-stream.ackAt>20000)))fail(stream.peer,'DESKTOP_LOCAL_DENIED');
              if(ws.readyState===1){send({type:'ping'});if(ready)status(stream?'sharing':'connected');}
            }catch{drop();ws.terminate();}
          },5000);
          ws.once('close',code=>{clearInterval(heartbeat);signal?.removeEventListener('abort',abort);drop();lastRelayClose={code,at:Date.now()};status('reconnecting');resolve();});
          ws.on('error',()=>{diagnostic('DESKTOP_RELAY_CONNECTION_ERROR');status('reconnecting');});
          ws.on('message',(raw,binary)=>{
            last=Date.now();
            try{
              if(binary){if(stream && raw.subarray(0,36).toString()===stream.peer)stream.vnc.feed(raw.subarray(36));return;}
              const m=JSON.parse(raw);
              if(m.type==='ready'){ready=true;delay=1000;lastError=null;status('connected');}
              else if(m.type==='peer')void begin(m);
              else if(m.type==='leave' && m.peer===pendingPeer)drop();
              else if(m.type==='ack' && stream && m.peer===stream.peer){
                if(!Number.isSafeInteger(m.received)||m.received<stream.acked||m.received>stream.sent)throw Error();
                if(m.received>stream.acked)stream.ackAt=Date.now();stream.acked=m.received;
                if(stream.sent-stream.acked<262144 && ws.bufferedAmount<262144)stream.vnc.resume();
              }
            }catch(e){diagnostic(e.message);if(pendingPeer)fail(pendingPeer);}
          });
        });
      }catch(e){diagnostic(e.message);status('reconnecting');}
      finally{drop();socket?.close();}
      if(signal?.aborted)break;
      await new Promise(resolve=>{const timer=setTimeout(done,delay);function done(){clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();}signal?.addEventListener('abort',done,{once:true});});
      delay=Math.min(delay*2,30000);
    }
  }finally{drop();status('stopped');unlock();}
}
