// Restricted RFB 3.8 gateway. The local VNC password never leaves this process.
// Clipboard, file transfer, desktop resize and vendor commands are not forwarded.
import { connect } from 'node:net';
import { createCipheriv } from 'node:crypto';
export const RFB_BANNER = Buffer.from('RFB 003.008\n');
const MAX_RECT = 64 * 1024 * 1024;
const u32 = n => { const b=Buffer.alloc(4); b.writeUInt32BE(n); return b; };
const reversed = n => { let r=0; for(let i=0;i<8;i++){r=(r<<1)|(n&1);n>>=1;} return r; };
export function vncEncrypt(data, key) {
  const k=Buffer.alloc(8); Buffer.from(key).copy(k,0,0,8);
  const des=Buffer.from(k.map(reversed)), cipher=createCipheriv('des-ede3',Buffer.concat([des,des,des]),null); cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data),cipher.final()]);
}
export function vncPasswordFile(password) { const b=Buffer.alloc(8); b.write(password,'latin1'); return vncEncrypt(b,[23,82,107,6,35,78,88,7]).toString('hex'); }

// Incremental parser: buffers only headers; image payloads pass in bounded chunks.
export class ServerFilter {
  constructor(send) { this.send=send; this.buf=Buffer.alloc(0); this.state='message'; this.remaining=0; this.rects=0; this.bpp=4; }
  push(chunk) {
    this.buf=Buffer.concat([this.buf,chunk]);
    while (this.buf.length) {
      if(this.remaining){const n=Math.min(this.remaining,this.buf.length); if(!this.drop)this.send(this.buf.subarray(0,n));this.buf=this.buf.subarray(n);this.remaining-=n;if(!this.remaining)this.state=this.next;continue;}
      if(this.state==='message'){
        const type=this.buf[0];
        if(type===0){if(this.buf.length<4)return;this.rects=this.buf.readUInt16BE(2);this.take(4);this.state=this.rects?'rect':'message';}
        else if(type===2)this.take(1);
        else if(type===3){if(this.buf.length<8)return;const n=this.buf.readUInt32BE(4);if(n>MAX_RECT)throw Error('DESKTOP_CLIPBOARD_REJECTED');this.take(8,false);this.payload(n,'message',true);}
        else throw Error('DESKTOP_SERVER_MESSAGE_REJECTED_'+type);
      } else if(this.state==='rect'){
        if(this.buf.length<12)return;
        const w=this.buf.readUInt16BE(4),h=this.buf.readUInt16BE(6),encoding=this.buf.readInt32BE(8);
        this.rects--; const next=this.rects?'rect':'message';
        if(![0,1,16,-223,-239,-224].includes(encoding))throw Error('DESKTOP_ENCODING_REJECTED_'+encoding);
        this.take(12);
        if(encoding===0)this.payload(w*h*this.bpp,next);
        else if(encoding===1)this.payload(4,next);
        else if(encoding===16){this.state='zrle';this.rectNext=next;}
        else if(encoding===-239)this.payload(w*h*this.bpp+Math.ceil(w/8)*h,next);
        else if(encoding===-224){this.rects=0;this.state='message';}
        else {if(!w||!h||w*h>16777216)throw Error(`DESKTOP_SIZE_LIMIT_${w}_${h}`);this.state=next;}
      } else if(this.state==='zrle'){
        if(this.buf.length<4)return;const n=this.buf.readUInt32BE(0);this.take(4);this.payload(n,this.rectNext);
      }
    }
  }
  take(n, forward=true){const b=this.buf.subarray(0,n);this.buf=this.buf.subarray(n);if(forward)this.send(b);return b;}
  payload(n,next,drop=false){if(n>MAX_RECT)throw Error('DESKTOP_FRAME_LIMIT');this.remaining=n;this.next=next;this.drop=drop; if(!n)this.state=next;}
}
export class ClientFilter {
  constructor({write,canControl=()=>false,format=()=>{}}){Object.assign(this,{write,canControl,format});this.buf=Buffer.alloc(0);this.keys=new Set();this.pointer=Buffer.from([5,0,0,0,0,0]);}
  push(bytes){
    if(this.buf.length+bytes.length>65536)throw Error('DESKTOP_INPUT_LIMIT');this.buf=Buffer.concat([this.buf,bytes]);
    while(this.buf.length){
      const type=this.buf[0];let n={0:20,2:4,3:10,4:8,5:6}[type]; if(!n)throw Error('DESKTOP_INPUT_REJECTED');if(this.buf.length<n)return;
      if(type===2){const count=this.buf.readUInt16BE(2);if(count>128)throw Error('DESKTOP_ENCODING_LIMIT');n+=count*4;if(this.buf.length<n)return;}
      const b=this.buf.subarray(0,n);this.buf=this.buf.subarray(n);
      if(type===0){if(![16,32].includes(b[4])||!b[7]||b[5]>b[4])throw Error('DESKTOP_PIXEL_FORMAT');this.format(b[4]/8);this.write(b);}
      else if(type===2){
        const offered=[];for(let p=4;p<n;p+=4)offered.push(b.readInt32BE(p));
        const allowed=[16,1,0,-223,-239,-224].filter(v=>offered.includes(v));if(!allowed.includes(0))allowed.push(0);
        const out=Buffer.alloc(4+allowed.length*4);out[0]=2;out.writeUInt16BE(allowed.length,2);allowed.forEach((v,i)=>out.writeInt32BE(v,4+i*4));this.write(out);
      } else if(type===3){if(!b.readUInt16BE(6)||!b.readUInt16BE(8))throw Error('DESKTOP_UPDATE_SIZE');this.write(b);}
      else if(this.canControl()){
        if(type===4){const key=b.readUInt32BE(4);if(b[1]){if(this.keys.size>=64&&!this.keys.has(key))throw Error('DESKTOP_KEY_LIMIT');this.keys.add(key);}else this.keys.delete(key);}
        if(type===5)this.pointer=Buffer.from(b);this.write(b);
      }
    }
  }
  release(){for(const key of this.keys){const b=Buffer.alloc(8);b[0]=4;b.writeUInt32BE(key,4);this.write(b);}this.keys.clear();if(this.pointer[1]){this.pointer[1]=0;this.write(this.pointer);}}
}

export async function openVnc({port,password,onData,onClose,canControl}) {
  if(!Number.isInteger(port)||port<1024||port>65535||typeof password!=='string'||password.length!==8)throw Error('DESKTOP_LOCAL_CONFIG');
  const socket=connect({host:'127.0.0.1',port});socket.setNoDelay(true);
  let buf=Buffer.alloc(0), waiting=null, failed=null, streaming=false, closed=false;
  const server=new ServerFilter(onData);
  function settle(){if(waiting&&(failed||buf.length>=waiting.n)){const w=waiting;waiting=null;clearTimeout(w.timer);if(failed)w.reject(failed);else{const b=buf.subarray(0,w.n);buf=buf.subarray(w.n);w.resolve(b);}}}
  function end(){if(closed)return;closed=true;failed ||= Error('DESKTOP_VNC_OFFLINE');settle();onClose?.(failed.message);}
  socket.on('error',end);socket.on('close',end);
  socket.on('data',data=>{try{if(streaming)server.push(data);else{buf=Buffer.concat([buf,data]);if(buf.length>131072)throw Error('DESKTOP_HANDSHAKE_LIMIT');settle();}}catch(e){failed=e;socket.destroy();}});
  const read=n=>new Promise((resolve,reject)=>{if(waiting)throw Error('Concurrent RFB read');waiting={n,resolve,reject,timer:setTimeout(()=>{waiting=null;reject(Error('DESKTOP_VNC_TIMEOUT'));socket.destroy();},8000)};settle();});
  try{
    const version=(await read(12)).toString();if(!/^RFB 003\.00[78]\n$/.test(version))throw Error('DESKTOP_VNC_VERSION');
    socket.write(RFB_BANNER);const count=(await read(1))[0];if(count<1||count>32)throw Error('DESKTOP_VNC_AUTH');
    const methods=await read(count);if(!methods.includes(2))throw Error('DESKTOP_VNC_AUTH_REQUIRED');socket.write(Buffer.from([2]));
    socket.write(vncEncrypt(await read(16),Buffer.from(password,'latin1')));
    if((await read(4)).readUInt32BE()!==0)throw Error('DESKTOP_VNC_AUTH');
    socket.write(Buffer.from([1]));const init=await read(24),nameLength=init.readUInt32BE(20);
    if(nameLength>4096||!init.readUInt16BE(0)||!init.readUInt16BE(2)||init.readUInt16BE(0)*init.readUInt16BE(2)>16777216||![16,32].includes(init[4]))throw Error(`DESKTOP_SIZE_LIMIT_${init.readUInt16BE(0)}_${init.readUInt16BE(2)}_${init[4]}_${nameLength}`);
    await read(nameLength);
    // Some servers eagerly send clipboard or display data after ServerInit.
    // Keep that TCP stream paused until the authenticated phone finishes its
    // own handshake; never buffer an entire desktop while waiting for a phone.
    socket.pause();
    const title=Buffer.from('Ox Factory Desktop');init.writeUInt32BE(title.length,20);const serverInit=Buffer.concat([init,title]);server.bpp=init[4]/8;
    let stage='version',inputBuf=Buffer.alloc(0),ready=false;
    const client=new ClientFilter({write:b=>{if(!socket.destroyed){if(socket.writableLength>131072)throw Error('DESKTOP_INPUT_BACKPRESSURE');socket.write(b);}},canControl,format:bpp=>server.bpp=bpp});
    const feed=data=>{
      if(closed)return;if(ready)return client.push(data);
      if(inputBuf.length+data.length>65536)throw Error('DESKTOP_HANDSHAKE_LIMIT');inputBuf=Buffer.concat([inputBuf,data]);
      while(inputBuf.length){
        if(stage==='version'){if(inputBuf.length<12)return;if(!inputBuf.subarray(0,12).equals(RFB_BANNER))throw Error('DESKTOP_CLIENT_VERSION');inputBuf=inputBuf.subarray(12);stage='security';onData(Buffer.from([1,1]));}
        else if(stage==='security'){if(inputBuf[0]!==1)throw Error('DESKTOP_CLIENT_AUTH');inputBuf=inputBuf.subarray(1);stage='init';onData(u32(0));}
        else {inputBuf=inputBuf.subarray(1);ready=streaming=true;onData(serverInit);if(buf.length){server.push(buf);buf=Buffer.alloc(0);}if(inputBuf.length)client.push(inputBuf);inputBuf=Buffer.alloc(0);socket.resume();return;}
      }
    };
    return {start:()=>onData(RFB_BANNER),feed,pause:()=>socket.pause(),resume:()=>{if(ready)socket.resume();},close(){try{client.release();}catch{}socket.end();setTimeout(()=>socket.destroy(),300).unref();},socket,width:init.readUInt16BE(0),height:init.readUInt16BE(2)};
  }catch(e){socket.destroy();throw e;}
}
