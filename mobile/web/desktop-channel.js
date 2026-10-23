// A noVNC-compatible channel. Hub control messages never enter the RFB parser.
// The credit acknowledgement bounds a slow phone's in-flight framebuffer data.
export class DesktopChannel {
  constructor(url,ticket,{control=()=>{},ended=()=>{}}={}){
    this.protocol='ox-desktop-v1';this.binaryType='arraybuffer';this.readyState=0;
    this.onopen=null;this.onmessage=null;this.onerror=null;this.onclose=null;
    this.received=0;this.last=Date.now();this.closed=false;this.inputs=[];this.inputBytes=0;
    this.phase='relay';this.closeCause='';this.closeInfo=null;
    this.socket=new WebSocket(url,[this.protocol,'t.'+ticket]);this.socket.binaryType='arraybuffer';
    this.socket.onopen=()=>{this.phase='desktop';};
    this.finished=new Promise(resolve=>this.finish=resolve);
    this.socket.onmessage=e=>{
      try{
        this.last=Date.now();
        if(typeof e.data==='string'){
          const m=JSON.parse(e.data);control(m);
          if(m.type==='stream-ready' && this.readyState===0){this.phase='frame';this.readyState=1;this.onopen?.({});}
          return;
        }
        if(this.readyState!==1 || e.data.byteLength>65536)throw Error();
        this.onmessage?.(e);this.received+=e.data.byteLength;
        if(!this.ackTimer)this.ackTimer=setTimeout(()=>{this.ackTimer=null;this.json({type:'ack',received:this.received});},40);
      }catch{this.close(typeof e.data==='string'?'protocol':'frame');}
    };
    this.socket.onerror=()=>this.onerror?.({});
    this.socket.onclose=e=>{
      if(this.closed)return;this.closed=true;this.readyState=3;
      this.closeInfo={code:e.code,phase:this.phase,cause:this.closeCause};this.inputs=[];this.inputBytes=0;
      clearInterval(this.timer);clearTimeout(this.deadline);clearTimeout(this.ackTimer);
      try{this.onclose?.(e);}finally{ended(this.closeInfo);this.finish();}
    };
    this.timer=setInterval(()=>{if(Date.now()-this.last>25000)this.close('heartbeat');else this.json({type:'ping'});},5000);
    this.deadline=setTimeout(()=>{if(this.readyState!==1)this.close('connect');},20000);
  }
  json(m){if(this.socket.readyState===1)this.socket.send(JSON.stringify(m));}
  send(b){
    if(this.readyState!==1 || this.socket.readyState!==1 || this.socket.bufferedAmount>131072 || this.inputBytes+b.byteLength>65536){this.close('input');return;}
    this.inputs.push(new Uint8Array(b));this.inputBytes+=b.byteLength;
    if(this.inputs.length===1)queueMicrotask(()=>{const out=new Uint8Array(this.inputBytes);let offset=0;for(const item of this.inputs){out.set(item,offset);offset+=item.length;}this.inputs=[];this.inputBytes=0;if(this.readyState===1&&this.socket.readyState===1)this.socket.send(out);});
  }
  close(cause=''){if(this.readyState>=2)return;this.closeCause=cause;this.readyState=2;clearInterval(this.timer);clearTimeout(this.deadline);clearTimeout(this.ackTimer);this.socket.close(1000,'离开桌面');}
}
