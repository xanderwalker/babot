(() => {
  if(location.origin!=='http://127.0.0.1:5177')return;
  window.__usbLog=[];window.__usbOpens=0;window.__usbRequests=0;
  const encoder=new TextEncoder();let incoming;
  const params=new URLSearchParams(location.search);
  const target=new EventTarget();
  const port={getInfo:()=>({usbVendorId:0x2341,usbProductId:0x8036}),async open(){
    window.__usbOpens++;
    this.readable=new ReadableStream({start(c){incoming=c;}});
    this.writable=new WritableStream({write(bytes){
      const line=new TextDecoder().decode(bytes).trim();window.__usbLog.push({line,time:performance.now()});
      const [verb,id]=line.split(' ');
      incoming.enqueue(encoder.encode(verb==='PING'?`ACK ${id} PING BABOT_MOTION 1\n`:`ACK ${id} ${verb}\n`));
      if(verb==='STOP')setTimeout(()=>{try{incoming.enqueue(encoder.encode('EVENT OFF\n'));}catch{}},80);
    }});
  },async close(){this.readable=null;this.writable=null;}};
  Object.assign(target,{getPorts:async()=>params.has('cancel')?[]:[port],requestPort:async()=>{window.__usbRequests++;if(params.has('cancel'))throw new DOMException('No port selected','NotFoundError');return port;}});
  Object.defineProperty(navigator,'serial',{configurable:true,value:target});
  document.addEventListener('DOMContentLoaded',()=>{
    const panel=document.createElement('aside');panel.setAttribute('aria-label','Software-only USB test');panel.style.cssText='padding:20px;background:#203040;color:white';
    const status=document.createElement('output');status.setAttribute('aria-label','Mock USB counters');panel.append(status);
    const reconnect=document.createElement('button');reconnect.textContent='Simulate USB reconnect';reconnect.onclick=()=>target.dispatchEvent(new Event('connect'));panel.append(reconnect);
    const breakLink=document.createElement('button');breakLink.textContent='Simulate USB failure';breakLink.onclick=()=>incoming.error(new Error('Simulated USB disconnection'));panel.append(breakLink);
    document.body.append(panel);
    setInterval(()=>{status.textContent=JSON.stringify({opens:window.__usbOpens,requests:window.__usbRequests,ping:window.__usbLog.filter(x=>x.line.startsWith('PING ')).length,arm:window.__usbLog.filter(x=>x.line.startsWith('ARM ')).length,pose:window.__usbLog.filter(x=>x.line.startsWith('POSE ')).length,stop:window.__usbLog.filter(x=>x.line.startsWith('STOP ')).length,saved:JSON.parse(localStorage.getItem('babot.mounting.v1'))});},100);
  });
  if(!localStorage.getItem('babot.mounting.v1'))localStorage.setItem('babot.mounting.v1',JSON.stringify({version:1,mounting:{angleDegrees:45,invertRoll:false,invertPitch:false,verified:true}}));
})();
