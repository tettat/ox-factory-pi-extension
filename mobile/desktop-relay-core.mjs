// Desktop is a separate capability and room. No pixels or input are persisted.
export const DESKTOP_PROTOCOL = 'ox-desktop-v1';
export function desktopTicket(protocols) {
  const p = String(protocols || '').split(',').map(v=>v.trim());
  if (p.length !== 2 || p[0] !== DESKTOP_PROTOCOL || !/^t\.[A-Za-z0-9_-]{43}$/.test(p[1])) throw Error('DESKTOP_AUTH_FAILED');
  return p[1].slice(2);
}
export async function authorizeDesktop(hub, ticket, connectionId, fetchImpl = fetch) {
  const r = await fetchImpl(hub + '/connector/desktop-authorize', { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ticket,connectionId}), redirect:'manual', signal:AbortSignal.timeout(7000) });
  if (!r.ok) throw Error('DESKTOP_AUTH_FAILED');
  const c = await r.json();
  if (c.audience !== 'desktop' || !['phone','agent'].includes(c.kind) || !/^[A-Za-z0-9_-]{8,100}$/.test(c.deviceId) || c.connectionId !== connectionId || !Number.isFinite(c.leaseUntil) || c.leaseUntil <= Date.now() || (c.kind==='phone' && !['view','control'].includes(c.mode))) throw Error('DESKTOP_AUTH_FAILED');
  return c;
}
const encoder = new TextEncoder(), decoder = new TextDecoder();
export class DesktopRoom {
  constructor({peers,save,hub,authorize=authorizeDesktop,now=Date.now}){Object.assign(this,{peers,save,hub,authorize,now});}
  active(kind){return this.peers().find(p=>p.meta.kind===kind && p.ws.readyState===1 && p.meta.leaseUntil>this.now());}
  send(p,m){if(p?.ws.readyState===1 && p.meta.leaseUntil>this.now()) p.ws.send(typeof m==='object' && !(m instanceof Uint8Array) ? JSON.stringify(m) : m);}
  close(p,code=4401,reason='桌面授权已结束'){try{p.ws.close(code,reason);}catch{}}
  connect(p){
    for(const old of this.peers()) if(old.ws!==p.ws && old.ws.readyState===1 && old.meta.kind===p.meta.kind){
      if(old.meta.leaseUntil>this.now()) {this.close(p,4409,'桌面已在另一页面连接，请先断开');return false;}
      this.close(old);
    }
    this.send(p,{type:'ready',kind:p.meta.kind,mode:p.meta.mode,agentOnline:!!this.active('agent')});
    const phone=this.active('phone'),agent=this.active('agent');
    if(phone && agent){this.send(agent,{type:'peer',peer:phone.meta.connectionId,principalId:phone.meta.principalId,role:phone.meta.role,mode:phone.meta.mode});this.send(phone,{type:'agent',online:true});}
    return true;
  }
  receive(p,raw){
    try{
      if(p.meta.leaseUntil<=this.now())return this.close(p);
      const bytes=typeof raw==='string'?null:new Uint8Array(raw.buffer || raw,raw.byteOffset || 0,raw.byteLength);
      const size=bytes?.byteLength ?? raw.length;
      if(size>(bytes?65572:2048))throw Error();
      const time=this.now();
      if(!p.meta.rate || p.meta.rate.at+1000<=time)p.meta.rate={at:time,n:0,bytes:0};
      p.meta.rate.bytes+=size;
      if(++p.meta.rate.n>1024 || p.meta.rate.bytes>32*1024*1024)throw Error();
      if(bytes){
        if(p.meta.kind==='agent'){
          const phone=this.active('phone');
          if(bytes.length<37 || !phone || decoder.decode(bytes.subarray(0,36))!==phone.meta.connectionId || !phone.meta.open)return;
          this.send(phone,bytes.subarray(36));
        }else{
          const agent=this.active('agent');if(!agent || !p.meta.open)return;
          const framed=new Uint8Array(36+bytes.length);framed.set(encoder.encode(p.meta.connectionId));framed.set(bytes,36);this.send(agent,framed);
        }
      }else{
        const m=JSON.parse(raw);
        if(m.type==='ping'){this.send(p,{type:'pong'});}
        else if(p.meta.kind==='agent'){
          const phone=this.active('phone');if(!phone || m.peer!==phone.meta.connectionId)return;
          if(m.type==='open'){
            if(!Number.isInteger(m.width)||!Number.isInteger(m.height)||m.width<1||m.height<1||m.width*m.height>16777216)throw Error();
            phone.meta.open=true;this.save(phone);this.send(phone,{type:'stream-ready',mode:phone.meta.mode,width:m.width,height:m.height});
          }else if(m.type==='error') {this.send(phone,{type:'error',code:['DESKTOP_LOCAL_DENIED','DESKTOP_VNC_OFFLINE'].includes(m.code)?m.code:'DESKTOP_UNAVAILABLE'});this.close(phone,4410,'本机桌面暂不可用');}
        }else if(m.type==='ack' && Number.isSafeInteger(m.received) && m.received>=0){this.send(this.active('agent'),{type:'ack',peer:p.meta.connectionId,received:m.received});}
        else throw Error();
      }
      this.save(p);
    }catch{this.close(p,4400,'桌面协议错误');}
  }
  disconnected(p){
    if(p.meta.kind==='phone')this.send(this.active('agent'),{type:'leave',peer:p.meta.connectionId});
    else if(!this.active('agent')){const phone=this.active('phone');if(phone)this.close(phone,4410,'电脑已断开，请重新连接');}
  }
  async maintain(){
    await Promise.all(this.peers().map(async p=>{
      if(p.ws.readyState!==1)return;
      if(p.meta.expiresAt<=this.now())return this.close(p);
      if(p.meta.leaseUntil-this.now()>15000)return;
      try{
        const c=await this.authorize(this.hub,p.meta.ticket,p.meta.connectionId);
        if(['audience','kind','deviceId','role','mode','principalId','sessionId'].some(k=>c[k]!==p.meta[k]))return this.close(p);
        const current=this.peers().find(x=>x.meta.connectionId===p.meta.connectionId && x.ws.readyState===1);
        if(current){Object.assign(current.meta,c);this.save(current);}
      }catch{this.close(p);}
    }));
  }
}
