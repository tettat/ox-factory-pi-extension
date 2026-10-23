import { esc } from './ui.js';
import { DesktopChannel } from './desktop-channel.js';
const errors={DESKTOP_LOCAL_DENIED:'电脑尚未授权此账号控制桌面',DESKTOP_VNC_OFFLINE:'电脑桌面服务暂未就绪',DESKTOP_UNAVAILABLE:'桌面连接中断，请重新连接',DESKTOP_RELAY_UNAVAILABLE:'此 Hub 尚未配置桌面中继',ROLE_DENIED:'当前账号只能查看桌面'};
export function desktopTextKeys(text){return [...text].filter(c=>c!=='\r').map(c=>c==='\n'?0xff0d:c==='\t'?0xff09:0x01000000|c.codePointAt(0));}
export function desktopViewport(w,h,fw,fh,zoom=1){
  const base=Math.min(w/fw,h/fh),scale=base*zoom,iw=fw*scale,ih=fh*scale,width=Math.max(w,iw),height=Math.max(h,ih);
  return {w,h,fw,fh,scale,width,height,padX:(width-iw)/2,padY:(height-ih)/2,fitZoom:w<h?(h/fh)/base:1};
}
export function mountDesktop({host,api,device,toast}){
  const root=document.createElement('section');root.className='desktop-root';host.replaceChildren(root);
  root.innerHTML=`<div class="desktop-card"><span class="desktop-eyebrow">REMOTE DESKTOP</span><div class="desktop-emblem" aria-hidden="true">▱</div><h2>你的电脑，就在手边</h2><p>${esc(device.name)}</p><p class="muted">查看当前桌面，操作普通浏览器和应用。<br>使用工厂认证，仅限本机明确授权的账号。</p><button class="primary" data-d="connect">连接桌面</button><p class="desktop-note" data-note role="status">进入后默认仅查看，不会误触电脑。</p><details><summary>使用说明与隐私</summary><p>电脑需开机并登录桌面。连接时会共享当前主屏幕；退出、锁定手机或切到后台即断开，不重发输入。剪贴板与文件传输关闭。</p><p>首次需在电脑配置独立的 Desktop Agent。它不替换工厂或 Chrome 控制。当前版本不保证锁屏、UAC 提权窗口可操作。</p><a href="https://github.com/novnc/noVNC/tree/v1.7.0" target="_blank" rel="noopener noreferrer">noVNC 1.7.0 源码</a> · <a href="/vendor/DESKTOP-LICENSES.txt" target="_blank" rel="noopener noreferrer">开源许可</a></details></div>
  <section class="desktop-stage" hidden aria-label="远程电脑桌面"><header class="desktop-top"><button data-d="leave" aria-label="断开并返回">‹</button><div><b>${esc(device.name)}</b><small data-status role="status">正在连接</small></div><button data-d="control" aria-pressed="false">开始控制</button><button data-d="full" aria-label="全屏">⛶</button></header>
  <div class="desktop-workspace"><div class="desktop-scroll"><div class="desktop-canvas"></div></div><div class="desktop-pan" aria-label="拖动平移，双指缩放"></div><div class="desktop-cover"><span data-cover>正在连接桌面…</span><button data-d="retry" hidden>重新连接</button></div></div>
  <div class="desktop-info"><span data-hint>仅查看 · 拖动平移，双指缩放</span><span data-zoom>100%</span></div>
  <form class="desktop-keyboard" hidden><label>输入到电脑当前光标处<textarea rows="2" maxlength="1000" autocomplete="off" spellcheck="false" placeholder="先点选电脑里的输入位置…"></textarea></label><div><button type="button" data-key="Escape">Esc</button><button type="button" data-key="Tab">Tab</button><button type="button" data-key="Backspace">退格</button><button type="button" data-key="Return">回车</button><button type="submit" class="primary">输入</button></div><div><button type="button" data-combo="address">地址栏</button><button type="button" data-combo="all">全选</button><button type="button" data-combo="switch">切换应用</button></div></form>
  <footer class="desktop-tools"><button data-d="pan" aria-pressed="true">平移</button><button data-d="out" aria-label="缩小画面">−</button><button data-d="fit">适配</button><button data-d="in" aria-label="放大画面">＋</button><button data-d="keyboard">键盘</button><button data-d="leave">断开</button></footer></section>`;
  const $=s=>root.querySelector(s),stage=$('.desktop-stage'),screen=$('.desktop-scroll'),canvas=$('.desktop-canvas'),pan=$('.desktop-pan'),cover=$('.desktop-cover');
  let rfb,channel,destroyed=false,epoch=0,connected=false,mode='view',moving=true,zoom=1,loading=false,engine;
  let framebuffer=null,layout=null,settling=false,settleTimer;
  const points=new Map();let gesture;
  const setStatus=s=>{$('[data-status]').textContent=s;};
  function update(){
    $('[data-d="control"]').textContent=mode==='control'?'退出控制':'开始控制';$('[data-d="control"]').setAttribute('aria-pressed',String(mode==='control'));$('[data-d="control"]').disabled=!connected||loading;
    $('[data-d="keyboard"]').disabled=!connected||mode!=='control';$('[data-d="pan"]').disabled=mode!=='control';$('[data-d="pan"]').setAttribute('aria-pressed',String(moving));$('[data-d="pan"]').textContent=moving?'平移':'点击';
    pan.hidden=!moving&&!settling&&mode==='control';stage.dataset.mode=connected?mode:'view';
    $('[data-hint]').textContent=!connected?'未连接 · 不会发送操作':mode==='view'?'仅查看 · 拖动平移，双指缩放':moving?'控制已开启 · 平移画面，不操作鼠标':'轻点点击 · 单指滑动滚动 · 长按拖拽';
    if(mode!=='control')$('.desktop-keyboard').hidden=true;
  }
  function size(next=zoom,anchor){
    const w=screen.clientWidth,h=screen.clientHeight;if(!w||!h||!framebuffer)return;
    const first=!layout;if(first || (layout.w<layout.h)!==(w<h))next=desktopViewport(w,h,framebuffer.w,framebuffer.h).fitZoom;
    const old=layout||desktopViewport(w,h,framebuffer.w,framebuffer.h,next);
    const px=(screen.scrollLeft+(anchor?.x??old.w/2)-old.padX)/old.scale,py=(screen.scrollTop+(anchor?.y??old.h/2)-old.padY)/old.scale;
    zoom=Math.max(1,Math.min(12,next));layout=desktopViewport(w,h,framebuffer.w,framebuffer.h,zoom);
    canvas.style.width=layout.width+'px';canvas.style.height=layout.height+'px';
    screen.scrollLeft=first?0:px*layout.scale+layout.padX-(anchor?.x??w/2);screen.scrollTop=first?0:py*layout.scale+layout.padY-(anchor?.y??h/2);
    // noVNC applies viewport scaling asynchronously. During that short resize
    // transition, touches may pan but must not click stale remote coordinates.
    settling=true;clearTimeout(settleTimer);settleTimer=setTimeout(()=>{settling=false;if(!destroyed)update();},250);update();
    $('[data-zoom]').textContent=Math.round(zoom*100)+'%';
  }
  async function stop(){
    connected=false;loading=false;const old=channel;channel=null;rfb?.disconnect();rfb=null;old?.close();points.clear();
    if(old)await Promise.race([old.finished,new Promise(r=>setTimeout(r,1200))]);
  }
  function showFailure(text){connected=false;loading=false;mode='view';moving=true;cover.hidden=false;$('[data-cover]').textContent=text;$('[data-d="retry"]').hidden=false;setStatus('已断开');$('[data-note]').textContent=text;update();}
  async function connect(modeRequested='view'){
    const id=++epoch;await stop();if(destroyed||id!==epoch)return;
    stage.hidden=false;document.documentElement.classList.add('desktop-open');loading=true;mode=modeRequested;moving=mode==='view';cover.hidden=false;$('[data-cover]').textContent='正在连接桌面…';$('[data-d="retry"]').hidden=true;setStatus('连接中');update();
    try{
      engine ||= await import('./vendor/desktop-engine.js');
      if(id!==epoch||destroyed)return;
      // A different ticket is required to change view/control; UI flags alone never grant input.
      const ticket=await api('/api/desktop-ticket',{deviceId:device.id,mode});
      if(id!==epoch||destroyed)return;
      const url=new URL(ticket.relay);if(url.protocol!=='https:' && !(url.protocol==='http:'&&['127.0.0.1','localhost','[::1]'].includes(url.hostname)))throw Error('中继地址不安全');url.protocol=url.protocol==='https:'?'wss:':'ws:';url.pathname='/desktop';
      let failure='';
      const ch=new DesktopChannel(url,ticket.ticket,{control:m=>{
        if(id!==epoch||destroyed)return;
        if(m.type==='ready'&&!m.agentOnline){failure='这台电脑尚未开启远程桌面';$('[data-cover]').textContent=failure;}
        if(m.type==='stream-ready'){framebuffer={w:m.width,h:m.height};size();}
        if(m.type==='error')failure=errors[m.code]||'电脑桌面暂不可用';
      },ended:e=>{if(id===epoch&&!destroyed)showFailure(failure || (e.code===4409?'桌面已在另一页面连接，请先断开':e.code===4401?'授权已结束，请重新登录或连接':'连接已断开；输入不会重发'));}});
      channel=ch;canvas.replaceChildren();size();
      const current=new engine.RFB(canvas,ch,{shared:true});rfb=current;
      current.viewOnly=mode!=='control';current.resizeSession=false;current.scaleViewport=true;current.clipViewport=false;current.focusOnClick=false;current.background='#111f1a';
      current.addEventListener('connect',()=>{if(id!==epoch)return;connected=true;loading=false;cover.hidden=true;setStatus(mode==='control'?'正在控制 · 加密连接':'仅查看 · 加密连接');update();size();});
      current.addEventListener('disconnect',()=>{if(id===epoch&&!destroyed){ch.close();showFailure(failure||'连接已断开；输入不会重发');}});
      current.addEventListener('credentialsrequired',()=>ch.close());
    }catch(e){if(id===epoch&&!destroyed)showFailure(errors[e.message]||e.message);}
  }
  function leave(){epoch++;void stop();stage.hidden=true;document.documentElement.classList.remove('desktop-open');canvas.replaceChildren();if(document.fullscreenElement===stage)void document.exitFullscreen();}
  function key(value){if(!connected||mode!=='control'||document.hidden)return;rfb.sendKey(value);}
  const keys={Escape:0xff1b,Tab:0xff09,Backspace:0xff08,Return:0xff0d};
  root.addEventListener('click',e=>{
    const b=e.target.closest('button');if(!b)return;
    if(b.dataset.key){key(keys[b.dataset.key]);return;}
    if(b.dataset.combo){if(!connected||mode!=='control')return;const [modifier,k]=b.dataset.combo==='switch'?[0xffe9,0xff09]:[0xffe3,b.dataset.combo==='address'?0x6c:0x61];rfb.sendKey(modifier,null,true);key(k);rfb.sendKey(modifier,null,false);return;}
    const action=b.dataset.d;
    if(action==='connect'||action==='retry')void connect();
    if(action==='leave')leave();
    if(action==='control')void connect(mode==='control'?'view':'control');
    if(action==='pan'){moving=!moving;points.clear();update();}
    if(action==='fit'){size(layout?.fitZoom||1);screen.scrollTo(0,0);}
    if(action==='in')size(zoom*1.5);if(action==='out')size(zoom/1.5);
    if(action==='keyboard'){$('.desktop-keyboard').hidden=!$('.desktop-keyboard').hidden;if(!$('.desktop-keyboard').hidden)$('textarea').focus();}
    if(action==='full'){if(document.fullscreenElement===stage)void document.exitFullscreen();else if(stage.requestFullscreen)void stage.requestFullscreen().catch(()=>toast('当前浏览器不支持全屏；可横屏使用'));else toast('可旋转手机横屏，或添加到主屏幕');}
  });
  $('.desktop-keyboard').addEventListener('submit',e=>{e.preventDefault();if(!connected||mode!=='control')return;const input=$('textarea');for(const value of desktopTextKeys(input.value))key(value);input.value='';});
  const measure=()=>{const p=[...points.values()],a=p[0],b=p[1];return {x:b?(a.x+b.x)/2:a.x,y:b?(a.y+b.y)/2:a.y,dist:b?Math.hypot(a.x-b.x,a.y-b.y):0};};
  const start=()=>{if(!points.size){gesture=null;return;}gesture={...measure(),zoom,left:screen.scrollLeft,top:screen.scrollTop};};
  pan.addEventListener('pointerdown',e=>{e.preventDefault();pan.setPointerCapture(e.pointerId);points.set(e.pointerId,{x:e.clientX,y:e.clientY});start();});
  pan.addEventListener('pointermove',e=>{if(!points.has(e.pointerId)||!gesture)return;e.preventDefault();points.set(e.pointerId,{x:e.clientX,y:e.clientY});const m=measure(),rect=screen.getBoundingClientRect();if(m.dist&&gesture.dist){size(gesture.zoom*m.dist/gesture.dist,{x:m.x-rect.left,y:m.y-rect.top});start();}else{screen.scrollLeft=gesture.left+gesture.x-m.x;screen.scrollTop=gesture.top+gesture.y-m.y;}});
  for(const name of ['pointerup','pointercancel'])pan.addEventListener(name,e=>{points.delete(e.pointerId);start();});
  pan.addEventListener('wheel',e=>{e.preventDefault();if(e.ctrlKey)size(zoom*(e.deltaY<0?1.15:1/1.15));else screen.scrollBy(e.deltaX,e.deltaY);},{passive:false});
  const resize=new ResizeObserver(()=>size());resize.observe(screen);
  const hidden=()=>{if(document.hidden&&!stage.hidden){epoch++;void stop();showFailure('手机已切到后台，桌面安全断开');}};
  document.addEventListener('visibilitychange',hidden);update();
  return {destroy(){destroyed=true;epoch++;void stop();resize.disconnect();clearTimeout(settleTimer);document.removeEventListener('visibilitychange',hidden);document.documentElement.classList.remove('desktop-open');root.remove();}};
}
