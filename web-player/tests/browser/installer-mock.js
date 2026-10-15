/* Software-only fixture. Loaded by the browser test runner, never the app. */
(() => {
  if(location.hostname!=='127.0.0.1'||location.port!=='5190'||!location.search.includes('installer-test'))throw new Error('Installer mock is restricted to the local test server');
  const query=new URLSearchParams(location.search), enc=new TextEncoder(), dec=new TextDecoder();
  const stats={requests:0,opens:[],writes:[],eepromWrites:0,motion:[],exits:0,runtimeLines:[]};
  const flash=new Uint8Array(32768).fill(255), eeprom=Uint8Array.from({length:1024},(_,i)=>(i*17)%256);
  eeprom[0]=eeprom[4]=eeprom[8]=75;eeprom[1]=eeprom[5]=eeprom[9]=0;
  const originalEeprom=Array.from(eeprom);flash[0]=12;flash[1]=148;
  let mode='runtime',installed=query.get('initial')==='motion',granted=false,address=0;
  const target=new EventTarget();
  function port(pid) {
    let incoming, pending=[];
    const p={readable:null,writable:null,baud:0,getInfo:()=>({usbVendorId:0x2341,usbProductId:pid}),
      async open({baudRate}) {
        if((pid===0x0036)!==(mode==='bootloader'))throw new Error('Selected port is not available');
        p.baud=baudRate;stats.opens.push({pid,baudRate});
        p.readable=new ReadableStream({start(c){incoming=c;},cancel(){incoming=null;}});
        const emit=x=>incoming?.enqueue(typeof x==='string'?enc.encode(x):Uint8Array.from(x));
        p.writable=new WritableStream({async write(bytes){
          if(pid===0x8036){
            const line=dec.decode(bytes).trim();stats.runtimeLines.push(line);
            const [verb,seq]=line.split(' ');
            if(['ARM','POSE','LEVEL'].includes(verb))stats.motion.push(line);
            if(!installed)return;
            if(verb==='PING')emit(`ACK ${seq} PING BABOT_MOTION 1\n`);
            else if(verb==='INFO')emit(`ACK ${seq} INFO BABOT_MOTION 1 VERSION 1.0.0 BOARD ATMEGA32U4 OFFSETS 75 75 75\n`);
            else if(verb==='ARM'||verb==='POSE'||verb==='LEVEL')emit(`ACK ${seq} ${verb}\n`);
            else if(verb==='STOP'){emit(`ACK ${seq} STOP\n`);emit('EVENT OFF\n');}
            return;
          }
          pending.push(...bytes);
          while(pending.length){
            const op=pending[0];let size=1;
            if(op===65)size=3;
            if(op===103)size=4;
            if(op===66){if(pending.length<4)return;size=4+pending[1]*256+pending[2];}
            if(pending.length<size)return;
            const cmd=pending.splice(0,size);
            if(op===83)emit('CATERIN');
            else if(op===115)emit(query.has('bad-signature')?[0,0,0]:[0x87,0x95,0x1e]);
            else if(op===98)emit([89,0,128]);
            else if(op===80||op===76)emit([13]);
            else if(op===65){address=cmd[1]*256+cmd[2];emit([13]);}
            else if(op===66){
              const length=cmd[1]*256+cmd[2];
              if(cmd[3]!==70){stats.eepromWrites++;throw new Error('Unexpected EEPROM write');}
              if(address*2+length>28672)throw new Error('Attempted bootloader write');
              flash.set(cmd.slice(4),address*2);stats.writes.push({address:address*2,length});address+=length/2;emit([13]);
            }
            else if(op===103){
              const length=cmd[1]*256+cmd[2], memory=cmd[3]===69?eeprom:flash, offset=cmd[3]===69?address:address*2;
              const data=memory.slice(offset,offset+length);
              if(query.has('bad-readback')&&cmd[3]===70&&stats.writes.length>1)data[0]^=1;
              emit(data);address+=cmd[3]===69?length:length/2;
            }
            else if(op===69){stats.exits++;installed=flash[0]!==255||flash[1]!==255;emit([13]);mode='runtime';}
            else throw new Error(`Unexpected programming command ${op}`);
          }
        }});
      },
      async setSignals(signals){if(pid===0x8036&&p.baud===1200&&signals.dataTerminalReady===false)mode='bootloader';},
      async close(){p.readable=null;p.writable=null;incoming=null;},
    };return p;
  }
  const runtime=port(0x8036),boot=port(0x0036);
  Object.assign(target,{
    getPorts:async()=>granted&&mode==='runtime'?[runtime]:[],
    requestPort:async({filters})=>{
      stats.requests++;
      if(query.has('cancel-picker'))throw new DOMException('No port selected','NotFoundError');
      const wantsBoot=filters.some(x=>x.usbProductId===0x0036);
      if(wantsBoot){if(mode!=='bootloader')throw new DOMException('Bootloader not available','NotFoundError');return boot;}
      granted=true;return runtime;
    },
  });
  Object.defineProperty(navigator,'serial',{value:target,configurable:true});
  window.__installerTest={stats,flash,eeprom,originalEeprom,get mode(){return mode;},get installed(){return installed;}};
  // Prove the setup handoff revokes a previously verified browser profile.
  localStorage.setItem('babot.mounting.v1',JSON.stringify({version:1,mounting:{angleDegrees:45,invertRoll:false,invertPitch:false,verified:true}}));
})();
