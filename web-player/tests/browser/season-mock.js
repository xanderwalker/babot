(() => {
  if(location.origin!=='http://127.0.0.1:5178'||location.pathname!=='/tests/browser/season.html')throw new Error('Season USB fixture is restricted to its isolated localhost page.');
  const stats={opens:0,ping:0,arm:0,pose:0,stop:0,off:0};
  const encoder=new TextEncoder();let incoming;
  const target=new EventTarget();
  const port={getInfo:()=>({usbVendorId:0x2341,usbProductId:0x8036}),async open(){
    stats.opens++;
    this.readable=new ReadableStream({start(c){incoming=c;}});
    this.writable=new WritableStream({write(bytes){
      const [verb,id]=new TextDecoder().decode(bytes).trim().split(' ');
      if(verb.toLowerCase() in stats)stats[verb.toLowerCase()]++;
      incoming.enqueue(encoder.encode(verb==='PING'?`ACK ${id} PING BABOT_MOTION 1\n`:`ACK ${id} ${verb}\n`));
      if(verb==='STOP')setTimeout(()=>{try{incoming.enqueue(encoder.encode('EVENT OFF\n'));stats.off++;}catch{}},250);
    }});
  },async close(){this.readable=null;this.writable=null;}};
  Object.assign(target,{getPorts:async()=>[port],requestPort:async()=>port});
  Object.defineProperty(navigator,'serial',{configurable:true,value:target});
  // A test-only read override never writes a verified calibration to storage.
  const originalGet=Storage.prototype.getItem;
  Storage.prototype.getItem=function(key){return key==='babot.mounting.v1'?JSON.stringify({version:1,mounting:{angleDegrees:45,invertRoll:false,invertPitch:false,verified:true}}):originalGet.call(this,key);};
  document.addEventListener('DOMContentLoaded',()=>{
    const panel=document.createElement('aside');panel.setAttribute('aria-label','Mock USB test');panel.style.cssText='position:fixed;bottom:0;left:0;z-index:100;padding:12px;background:#203040;color:white;font:12px monospace';
    const status=document.createElement('output');status.setAttribute('aria-label','Mock USB counters');panel.append(status);document.body.append(panel);
    setInterval(()=>{status.textContent=JSON.stringify(stats);},40);
  });
})();
