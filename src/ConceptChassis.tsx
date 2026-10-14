import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CONCEPTS_A } from './chassis-concepts-a';
import { CONCEPTS_B } from './chassis-concepts-b';
import { SUSPENSION_CONCEPTS_A } from './suspension-concepts-a';
import { SUSPENSION_CONCEPTS_B } from './suspension-concepts-b';
import { TRON_F1_CONCEPT } from './tron-f1-concept';

const ORIGINAL_CONCEPTS = [...CONCEPTS_A,...CONCEPTS_B];
const SUSPENSION_CONCEPTS = [...SUSPENSION_CONCEPTS_A,...SUSPENSION_CONCEPTS_B];
export const CHASSIS_CONCEPTS = [TRON_F1_CONCEPT,...ORIGINAL_CONCEPTS,...SUSPENSION_CONCEPTS];
function dispose(root:THREE.Object3D) {const geometry=new Set<THREE.BufferGeometry>(),material=new Set<THREE.Material>();root.traverse(obj=>{const mesh=obj as THREE.Mesh;if(mesh.geometry)geometry.add(mesh.geometry);if(mesh.material)(Array.isArray(mesh.material)?mesh.material:[mesh.material]).forEach(m=>material.add(m));});geometry.forEach(g=>g.dispose());material.forEach(m=>m.dispose());}
function frameCar(camera:THREE.PerspectiveCamera,car:THREE.Object3D) {
  const target=new THREE.Vector3(0,.4,0);
  const direction=camera.position.clone().sub(target).normalize();
  camera.lookAt(target);
  const inverse=camera.quaternion.clone().invert();
  const box=new THREE.Box3().setFromObject(car);
  const tangent=Math.tan(THREE.MathUtils.degToRad(camera.fov/2));
  let distance=4;
  for(const x of [box.min.x,box.max.x])for(const y of [box.min.y,box.max.y])for(const z of [box.min.z,box.max.z]) {
    const point=new THREE.Vector3(x,y,z).sub(target).applyQuaternion(inverse);
    distance=Math.max(distance,point.z+1.2*Math.max(Math.abs(point.y)/tangent,Math.abs(point.x)/(tangent*camera.aspect)));
  }
  camera.position.copy(direction).multiplyScalar(distance).add(target);
  camera.lookAt(target);
}
function studio(canvas:HTMLCanvasElement,preserveDrawingBuffer=false){
  const renderer=new THREE.WebGLRenderer({canvas,antialias:true,preserveDrawingBuffer});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,2));renderer.setClearColor('#0d171b');renderer.toneMapping=THREE.ACESFilmicToneMapping;renderer.toneMappingExposure=1.25;
  const scene=new THREE.Scene();scene.background=new THREE.Color('#0d171b');scene.fog=new THREE.Fog('#0d171b',18,40);
  const env=new RoomEnvironment();const pmrem=new THREE.PMREMGenerator(renderer);const environment=pmrem.fromScene(env,.04);scene.environment=environment.texture;env.dispose();pmrem.dispose();
  const camera=new THREE.PerspectiveCamera(32,1,.1,100);camera.position.set(0,4.6,10);camera.lookAt(0,.4,0);
  scene.add(new THREE.HemisphereLight('#d8e8e8','#283c40',2.5));const key=new THREE.DirectionalLight('#fff5dc',4);key.position.set(3,7,-4);scene.add(key);const rim=new THREE.DirectionalLight('#7ebfcb',2);rim.position.set(-5,3,3);scene.add(rim);
  const floor=new THREE.Mesh(new THREE.PlaneGeometry(80,80),new THREE.MeshBasicMaterial({color:'#0d171b'}));floor.rotation.x=-Math.PI/2;floor.position.y=-.15;scene.add(floor);
  const grid=new THREE.GridHelper(30,30,'#284146','#1b3037');grid.position.y=-.14;scene.add(grid);
  return {renderer,scene,camera,destroy:()=>{dispose(scene);environment.dispose();renderer.dispose();}};
}

export function ConceptChassis({conceptId,roll,pitch,valid,distanceMeters}:{conceptId:string;roll:number;pitch:number;valid:boolean;distanceMeters:number}){
  const mount=useRef<HTMLDivElement>(null);const canvas=useRef<HTMLCanvasElement>(null);const draw=useRef(()=>{});const current=useRef({roll,pitch,valid,distanceMeters});current.current={roll,pitch,valid,distanceMeters};const [error,setError]=useState(false);
  useEffect(()=>{if(!canvas.current||!mount.current)return;let rig:ReturnType<typeof studio>|null=null;let observer:ResizeObserver|null=null;let controls:OrbitControls|null=null;
    try{rig=studio(canvas.current);const concept=CHASSIS_CONCEPTS.find(c=>c.id===conceptId)??CHASSIS_CONCEPTS[0];const car=concept.build();const bounds=new THREE.Box3().setFromObject(car);const articulated=typeof car.userData.updatePose==='function';const baseY=(articulated?-.135:.2)-bounds.min.y;rig.camera.position.set(0,4.6,10);rig.camera.lookAt(0,.4,0);rig.scene.add(car);
      const wheels:THREE.Object3D[]=[...(car.userData.wheels??[])];car.traverse(obj=>{if(obj.userData.isWheel&&!wheels.includes(obj))wheels.push(obj);});
      let previousWidth=0,previousHeight=0;
      const render=()=>{if(!rig||!mount.current)return;const {width,height}=mount.current.getBoundingClientRect();if(!width||!height)return;const resized=width!==previousWidth||height!==previousHeight;const p=current.current;
        if(articulated){car.userData.updatePose({rollDeg:p.valid?-p.roll*8:0,pitchDeg:p.valid?p.pitch*4:0,wheelAngle:-p.distanceMeters/(car.userData.wheelRadius??.48)});}else{car.rotation.z=THREE.MathUtils.degToRad(p.valid?-p.roll*8:0);car.rotation.x=THREE.MathUtils.degToRad(p.valid?-p.pitch*4:0);wheels.forEach(wheel=>{wheel.rotation.x=-p.distanceMeters/(car.userData.wheelRadius??.48);});}car.position.y=baseY;
        if(resized){rig.renderer.setSize(width,height,false);rig.camera.aspect=width/height;rig.camera.updateProjectionMatrix();frameCar(rig.camera,car);previousWidth=width;previousHeight=height;}
        mount.current.dataset.visualRoll=String(p.valid?-p.roll*8:0);mount.current.dataset.visualPitch=String(p.valid?p.pitch*4:0);rig.renderer.render(rig.scene,rig.camera);
      };draw.current=render;controls=new OrbitControls(rig.camera,canvas.current);controls.enableDamping=false;controls.enablePan=false;controls.minDistance=4;controls.maxDistance=18;controls.minPolarAngle=.25;controls.maxPolarAngle=Math.PI*.48;controls.target.set(0,.4,0);controls.addEventListener('change',render);controls.update();observer=new ResizeObserver(render);observer.observe(mount.current);render();setError(false);
    }catch{setError(true);}return()=>{draw.current=()=>{};observer?.disconnect();controls?.dispose();rig?.destroy();};
  },[conceptId]);
  useEffect(()=>draw.current(),[roll,pitch,valid,distanceMeters]);
  return <div ref={mount} className="concept-chassis"><canvas ref={canvas} role="img" aria-label={`${CHASSIS_CONCEPTS.find(c=>c.id===conceptId)?.name} conceptual F1 motion study. Visual roll eight times and pitch four times.`}/><span className="concept-orbit-hint">DRAG TO INSPECT</span><span className="concept-amplification">BODY ROLL ×8 · PITCH ×4</span>{error?<p className="concept-error">3D preview unavailable in this browser.</p>:null}</div>;
}

export function ChassisGallery({selected,onSelect,onClose}:{selected:string;onSelect:(id:string)=>void;onClose:()=>void}) {
  const [family,setFamily]=useState<'suspension'|'original'>('suspension');
  const [images,setImages]=useState<Record<string,string>>({});
  const [comparison,setComparison]=useState('');
  const concepts=family==='suspension'?SUSPENSION_CONCEPTS:ORIGINAL_CONCEPTS;
  const number=(index:number)=>family==='suspension'?`${index<3?'5':'8'}${String.fromCharCode(65+index%3)}`:String(index+1).padStart(2,'0');
  useEffect(()=>{
    let cancelled=false;let timer:number;let rig:ReturnType<typeof studio>|null=null;
    setComparison('');
    const make=()=>{
      try {
        const canvas=document.createElement('canvas');
        rig=studio(canvas,true);rig.renderer.setPixelRatio(1);rig.renderer.setSize(540,310,false);rig.camera.aspect=540/310;rig.camera.updateProjectionMatrix();
        const output:Record<string,string>={};
        for(const concept of concepts) {
          const car=concept.build();
          if(typeof car.userData.updatePose==='function')car.userData.updatePose({rollDeg:9,pitchDeg:-3,wheelAngle:.3});
          else {car.rotation.z=.12;car.rotation.x=-.04;}
          car.position.y=(car.userData.updatePose?-.135:.1)-new THREE.Box3().setFromObject(car).min.y;
          rig.camera.position.set(7.7,6.2,-9.6);frameCar(rig.camera,car);
          rig.scene.add(car);rig.renderer.render(rig.scene,rig.camera);output[concept.id]=canvas.toDataURL('image/webp',.9);rig.scene.remove(car);dispose(car);
        }
        if(cancelled)return;
        setImages(output);
        const columns=family==='suspension'?3:5;
        const sheet=document.createElement('canvas');sheet.width=columns*350+50;sheet.height=850;
        const ctx=sheet.getContext('2d');if(!ctx)return;
        ctx.fillStyle='#0b1418';ctx.fillRect(0,0,sheet.width,sheet.height);ctx.fillStyle='#ff824b';ctx.font='16px monospace';ctx.fillText(family==='suspension'?'BABOT / SIX SUSPENSION STUDIES':'BABOT / TEN F1 MOTION STUDIES',30,38);
        ctx.fillStyle='#e5eeeb';ctx.font='34px sans-serif';ctx.fillText(family==='suspension'?'Suspension options':'Chassis options',30,85);
        Promise.all(concepts.map(concept=>new Promise<HTMLImageElement>(resolve=>{const image=new Image();image.onload=()=>resolve(image);image.src=output[concept.id];}))).then(pictures=>{
          concepts.forEach((concept,i)=>{
            const x=30+(i%columns)*350,y=115+Math.floor(i/columns)*350;
            ctx.fillStyle='#101d22';ctx.fillRect(x,y,335,330);ctx.drawImage(pictures[i],x,y,335,192);
            ctx.fillStyle='#ff824b';ctx.font='14px monospace';ctx.fillText(number(i),x+14,y+220);
            ctx.fillStyle='#edf3ef';ctx.font='21px sans-serif';ctx.fillText(concept.name,x+48,y+221);
            ctx.fillStyle='#9bb0b5';ctx.font='14px sans-serif';let line='',lineY=y+252;
            for(const word of concept.description.split(' ')){if(ctx.measureText(line+word).width>305){ctx.fillText(line,x+14,lineY);lineY+=20;line='';}line+=word+' ';}ctx.fillText(line,x+14,lineY);
          });
          ctx.fillStyle='#6c8991';ctx.font='13px monospace';ctx.fillText('Conceptual suspension / Visual roll ×8 / Physical BaBot limits unchanged',30,830);
          if(!cancelled)setComparison(sheet.toDataURL('image/png'));
        });
      } catch { /* Interactive player remains usable if thumbnail rendering is unavailable. */ }
      finally {rig?.destroy();rig=null;}
    };
    timer=window.setTimeout(make,0);
    return()=>{cancelled=true;clearTimeout(timer);};
  },[family]);
  return <section className="concept-gallery" aria-label="Conceptual F1 chassis options">
    <div className="concept-gallery-heading"><div>
      
      <h2>{family==='suspension'?'Suspension options':'Chassis options'}</h2>
      
      <div className="concept-tabs"><button className={selected==='tron-f1'?'active':''} onClick={()=>onSelect('tron-f1')}>Light chassis ↗</button><button className={family==='suspension'?'active':''} onClick={()=>setFamily('suspension')}>Suspension studies · 6</button><button className={family==='original'?'active':''} onClick={()=>setFamily('original')}>Original concepts · 10</button></div>
    </div><div className="concept-actions">{comparison?<a href={comparison} download={`babot-${family}-concepts.png`}>Save comparison ↓</a>:null}<button onClick={onClose}>Close concepts ×</button></div></div>
    <div className={`concept-grid ${family==='suspension'?'suspension':''}`}>{concepts.map((concept,index)=><button key={concept.id} className={`concept-card ${selected===concept.id?'selected':''}`} onClick={()=>onSelect(concept.id)} aria-pressed={selected===concept.id}>
      <div className="concept-image">{images[concept.id]?<img src={images[concept.id]} alt={`${concept.name} conceptual F1 car`}/>:<span>PREPARING VIEW</span>}<span className="concept-index">{number(index)}</span>{selected===concept.id?<span className="concept-selected">IN PLAYER</span>:null}</div>
      <div className="concept-card-copy"><h3>{concept.name}<span>↗</span></h3><p>{concept.description}</p></div>
    </button>)}</div>
  </section>;
}
