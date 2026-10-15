import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import {
  buildTwinRibbonPath,
  twinRibbonFrameState,
  TWIN_RIBBON_MATERIAL_CONTRACT,
} from './ribbon-twin-motion.mjs';
import './Visuals.css';

/** All views are projections of the parent's clock. They never advance time. */
export interface RibbonProps {
  /** OpenF1 tuple: [milliseconds, speed kph, rpm, throttle %, brake, gear, drs]. */
  samples: readonly (readonly number[])[];
  timeSeconds: number;
  duration: number;
}

export interface ChassisProps {
  /** Degrees. Positive pitch is nose-down. Positive roll is rotation about Z. */
  roll: number;
  pitch: number;
  speedKph: number;
  timeSeconds: number;
  valid: boolean;
  /** Integrated speed for seek-stable wheel rotation. Units: meters. */
  distanceMeters?: number;
}

interface RibbonPoint {
  t: number;
  y: number;
  zBase: number;
  halfWidth: number;
  color: { r: number; g: number; b: number };
  xPair: { negative: number; positive: number };
}

interface RibbonPath {
  duration: number;
  points: RibbonPoint[];
  depthSpan: number;
}

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, Number.isFinite(n) ? n : min));
export const CHASSIS_VISUAL_ROLL_MULTIPLIER = 8;
export const CHASSIS_VISUAL_PITCH_MULTIPLIER = 4;

const CROSS_SECTION = 8;
const INDICES_PER_SEGMENT = CROSS_SECTION * 6;

function disposeObjects(scene: THREE.Scene) {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  scene.traverse(object => {
    const drawable = object as THREE.Mesh;
    if (drawable.geometry) geometries.add(drawable.geometry);
    const material = drawable.material;
    if (Array.isArray(material)) material.forEach(item => materials.add(item));
    else if (material) materials.add(material);
  });
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
}

/** Each canvas owns its observer, environment, geometry and GPU resources. */
function createStage(mount: HTMLDivElement, label: string, onLost: () => void) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.domElement.setAttribute('role', 'img');
  renderer.domElement.setAttribute('aria-label', label);
  mount.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x080a0b);
  const camera = new THREE.PerspectiveCamera(40, 1, .1, 150);
  const environmentScene = new RoomEnvironment();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const environment = pmrem.fromScene(environmentScene, .04);
  environmentScene.dispose();
  scene.environment = environment.texture;
  pmrem.dispose();
  scene.add(new THREE.HemisphereLight(0xfff5dd, 0x142126, 2));
  const key = new THREE.DirectionalLight(0xfff6df, 3.5);
  key.position.set(-4, 7, 6);
  scene.add(key);
  const rim = new THREE.DirectionalLight(0xc7eadc, 2);
  rim.position.set(7, 3, -3);
  scene.add(rim);
  const handleLost = (event: Event) => { event.preventDefault(); onLost(); };
  renderer.domElement.addEventListener('webglcontextlost', handleLost);
  let observer: ResizeObserver | undefined;
  let disposed = false;
  return {
    scene, camera, renderer,
    observe(render: () => void, positionCamera: (aspect: number) => void) {
      const resize = () => {
        if (disposed) return;
        const width = Math.max(1, mount.clientWidth);
        const height = Math.max(1, mount.clientHeight);
        camera.aspect = width / height;
        positionCamera(camera.aspect);
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
        render();
      };
      observer = new ResizeObserver(resize);
      observer.observe(mount);
      resize();
    },
    dispose() {
      disposed = true;
      observer?.disconnect();
      renderer.domElement.removeEventListener('webglcontextlost', handleLost);
      disposeObjects(scene);
      environment.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
}

function ribbonGeometry(points: RibbonPoint[], side: 'negative' | 'positive') {
  const positions = new Float32Array(points.length * CROSS_SECTION * 3);
  const colors = new Float32Array(positions.length);
  const indices: number[] = [];
  const color = new THREE.Color();
  points.forEach((point, i) => {
    const w = point.halfWidth;
    const h = .065;
    const shoulder = Math.min(h, w * .34);
    const section = [[-w + shoulder, h], [w - shoulder, h], [w, h * .48], [w, -h * .48], [w - shoulder, -h], [-w + shoulder, -h], [-w, -h * .48], [-w, h * .48]];
    color.setRGB(point.color.r / 255, point.color.g / 255, point.color.b / 255, THREE.SRGBColorSpace);
    section.forEach(([x, y], j) => {
      const v = (i * CROSS_SECTION + j) * 3;
      positions.set([point.xPair[side] + x, point.y + y, point.zBase], v);
      colors.set([color.r, color.g, color.b], v);
    });
    if (i < points.length - 1) {
      for (let j = 0; j < CROSS_SECTION; j++) {
        const a = i * CROSS_SECTION + j;
        const b = i * CROSS_SECTION + (j + 1) % CROSS_SECTION;
        indices.push(a, a + CROSS_SECTION, b, a + CROSS_SECTION, b + CROSS_SECTION, b);
      }
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  geometry.setDrawRange(0, 0);
  return geometry;
}

function ribbonFloor(scene: THREE.Scene) {
  const vertices: THREE.Vector3[] = [];
  for (let z = 0; z >= -52; z -= 3) vertices.push(new THREE.Vector3(-5.3, -1.72, z), new THREE.Vector3(5.3, -1.72, z));
  for (let x = -5; x <= 5; x++) vertices.push(new THREE.Vector3(x, -1.72, 1), new THREE.Vector3(x, -1.72, -52));
  scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(vertices), new THREE.LineBasicMaterial({ color: 0x53666b, transparent: true, opacity: .18 })));
  const rails: THREE.Vector3[] = [];
  for (const x of [-5.3, 5.3]) {
    rails.push(new THREE.Vector3(x, -1.72, 1), new THREE.Vector3(x, -1.72, -52));
    rails.push(new THREE.Vector3(x, 3.2, 1), new THREE.Vector3(x, 3.2, -52));
    for (const z of [-12, -26, -42]) rails.push(new THREE.Vector3(x, -1.72, z), new THREE.Vector3(x, 3.2, z));
  }
  scene.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(rails), new THREE.LineBasicMaterial({ color: 0x9ca58e, transparent: true, opacity: .1 })));
}

export function Ribbon(props: RibbonProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const current = useRef(props);
  current.current = props;
  const draw = useRef<(() => void) | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let stage: ReturnType<typeof createStage> | undefined;
    setFailed(false);
    try {
      // Preserve the established Twin Ribbon mappings; OpenF1 time is in ms.
      const source = props.samples.map(sample => [sample[0] / 1000, ...sample.slice(1)]);
      const path = buildTwinRibbonPath(source, { duration: props.duration, depthSpan: 48 }) as unknown as RibbonPath;
      stage = createStage(mount, 'Twin Ribbon. Throttle controls width, speed controls height, and RPM changes yellow through red. Recorded history travels toward the horizon.', () => setFailed(true));
      const { scene, camera, renderer } = stage;
      scene.fog = new THREE.FogExp2(0x080a0b, .027);
      ribbonFloor(scene);
      const amber = new THREE.DirectionalLight(0xffb64a, 1.2);
      amber.position.set(-7, 1.5, -12);
      scene.add(amber);
      const material = new THREE.MeshPhysicalMaterial({
        vertexColors: true,
        metalness: TWIN_RIBBON_MATERIAL_CONTRACT.metalness,
        roughness: .13,
        clearcoat: 1,
        clearcoatRoughness: .045,
        sheen: .3,
        sheenColor: new THREE.Color(0xffeacc),
        envMapIntensity: 1.55,
        side: THREE.DoubleSide,
      });
      const ribbons = (['negative', 'positive'] as const).map(side => {
        const geometry = ribbonGeometry(path.points, side);
        const mesh = new THREE.Mesh(geometry, material);
        mesh.frustumCulled = false;
        scene.add(mesh);
        const headMaterial = material.clone();
        headMaterial.vertexColors = false;
        const head = new THREE.Mesh(new THREE.BoxGeometry(1, .13, .075), headMaterial);
        scene.add(head);
        return { side, geometry, mesh, head, headMaterial };
      });
      const render = () => {
        const time = clamp(current.current.timeSeconds, 0, path.duration);
        const frame = twinRibbonFrameState(path, time, path.duration);
        const a = path.points[frame.lowerIndex];
        const b = path.points[frame.upperIndex];
        const mix = frame.headMix;
        for (const ribbon of ribbons) {
          ribbon.geometry.setDrawRange(0, frame.completeSegments * INDICES_PER_SEGMENT);
          ribbon.mesh.position.z = frame.zOffset;
          ribbon.head.position.set(a.xPair[ribbon.side], THREE.MathUtils.lerp(a.y, b.y, mix), 0);
          ribbon.head.scale.x = THREE.MathUtils.lerp(a.halfWidth, b.halfWidth, mix) * 2;
          ribbon.headMaterial.color.setRGB(
            THREE.MathUtils.lerp(a.color.r, b.color.r, mix) / 255,
            THREE.MathUtils.lerp(a.color.g, b.color.g, mix) / 255,
            THREE.MathUtils.lerp(a.color.b, b.color.b, mix) / 255,
            THREE.SRGBColorSpace,
          );
        }
        renderer.render(scene, camera);
        mount.dataset.renderReady = 'true';
        mount.dataset.timeSeconds = time.toFixed(3);
        mount.dataset.visiblePoints = String(frame.completePoints);
      };
      draw.current = render;
      stage.observe(render, aspect => {
        camera.fov = aspect < .9 ? 48 : 40;
        camera.position.set(0, 3.6, aspect < .9 ? 12.5 : 9.5);
        camera.lookAt(0, -.05, -18);
      });
    } catch (error) {
      console.error('Twin Ribbon renderer failed', error);
      setFailed(true);
    }
    return () => { draw.current = null; stage?.dispose(); };
  }, [props.samples, props.duration]);

  useEffect(() => { draw.current?.(); }, [props.timeSeconds]);
  return <div className="babot-visual babot-ribbon" data-visual="twin-ribbon">
    <div className="babot-visual__canvas" ref={mountRef} />
    {!failed && <span className="babot-visual__label">Lap history → horizon</span>}
    {failed && <div className="babot-visual__fallback" role="status">3D visualizer unavailable<small>The player and telemetry still work.<br />Reload in a browser with WebGL enabled.</small></div>}
  </div>;
}

function rod(a: number[], b: number[], radius: number, material: THREE.Material) {
  const from = new THREE.Vector3(...a);
  const to = new THREE.Vector3(...b);
  const direction = to.clone().sub(from);
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, direction.length(), 10), material);
  mesh.position.copy(from).add(to).multiplyScalar(.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
  return mesh;
}

/** Low-poly aerodynamic shell. Each profile is [z, half-width, bottom, top]. */
function bodyShell(profiles: number[][], material: THREE.Material, centerX = 0) {
  const points: number[] = [];
  const indices: number[] = [];
  for (let i = 0; i < profiles.length; i++) {
    const [z, w, bottom, top] = profiles[i];
    const height = top - bottom;
    const section = [[-w * .7, top], [w * .7, top], [w, bottom + height * .65], [w, bottom + height * .2], [w * .7, bottom], [-w * .7, bottom], [-w, bottom + height * .2], [-w, bottom + height * .65]];
    section.forEach(([x, y]) => points.push(centerX + x, y, z));
    if (i > 0) for (let j = 0; j < 8; j++) {
      const a = (i - 1) * 8 + j;
      const b = (i - 1) * 8 + (j + 1) % 8;
      indices.push(a, b, a + 8, a + 8, b, b + 8);
    }
  }
  for (let j = 1; j < 7; j++) {
    indices.push(0, j + 1, j);
    const end = (profiles.length - 1) * 8;
    indices.push(end, end + j, end + j + 1);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(points, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

function createChassis(scene: THREE.Scene) {
  const car = new THREE.Group();
  car.position.y = .8;
  scene.add(car);
  const pearl = new THREE.MeshPhysicalMaterial({ color: 0xece7dc, metalness: .35, roughness: .22, clearcoat: .8, side: THREE.DoubleSide });
  const titanium = new THREE.MeshStandardMaterial({ color: 0x677579, metalness: .85, roughness: .32 });
  const carbon = new THREE.MeshStandardMaterial({ color: 0x20282b, metalness: .4, roughness: .45, side: THREE.DoubleSide });
  const mint = new THREE.MeshPhysicalMaterial({ color: 0xd7f78d, metalness: .2, roughness: .25, clearcoat: .75 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x111619, roughness: .85 });
  const black = new THREE.MeshStandardMaterial({ color: 0x080d10, roughness: .65 });
  const wheelRadius = .41;
  const box = (w: number, h: number, d: number, x: number, y: number, z: number, material: THREE.Material) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), material);
    mesh.position.set(x, y, z);
    car.add(mesh);
    return mesh;
  };

  // Long narrow nose into a sculpted monocoque; front points toward -Z.
  car.add(bodyShell([[-2.25, .08, -.14, -.015], [-1.65, .15, -.1, .1], [-.9, .24, -.12, .24], [-.38, .38, -.15, .38], [-.17, .38, -.15, .36]], pearl));
  car.add(bodyShell([[-2.25, .032, -.012, .003], [-1.65, .044, .102, .118], [-.9, .06, .242, .258], [-.38, .07, .382, .398]], mint));
  // Flat carbon floor with a tapered diffuser and exposed suspension.
  car.add(bodyShell([[-.87, .45, -.21, -.16], [-.5, .81, -.21, -.16], [1.33, .79, -.21, -.16], [1.85, .56, -.16, -.09]], carbon));
  for (const x of [-.55, .55]) {
    car.add(bodyShell([[-.37, .21, -.15, .21], [-.04, .26, -.15, .29], [.55, .25, -.15, .26], [1.18, .14, -.12, .16], [1.55, .055, -.1, .05]], pearl, x));
    box(.34, .1, .035, x, .11, -.385, black);
    car.add(bodyShell([[-.03, .02, .29, .305], [.55, .025, .26, .275], [1.18, .02, .16, .175]], mint, x));
    box(.035, .07, 1.35, x < 0 ? -.79 : .79, -.14, .35, mint);
  }
  // Cockpit opening remains dark between the nose and engine cover.
  box(.65, .18, .85, 0, -.035, .24, carbon);
  const cockpit = new THREE.Mesh(new THREE.SphereGeometry(.34, 28, 16), black);
  cockpit.scale.set(1, .4, 1.28);
  cockpit.position.set(0, .25, .23);
  car.add(cockpit);
  car.add(bodyShell([[.61, .34, -.15, .37], [.91, .29, -.13, .6], [1.34, .22, -.11, .45], [1.85, .1, -.09, .14]], pearl));
  // Airbox above the driver's head and a slender rear engine fin.
  const airbox = new THREE.Mesh(new THREE.CylinderGeometry(.1, .16, .2, 3), pearl);
  airbox.rotation.x = Math.PI / 2;
  airbox.position.set(0, .61, .75);
  car.add(airbox);
  const intake = new THREE.Mesh(new THREE.CircleGeometry(.076, 3), black);
  intake.position.set(0, .61, .64);
  intake.rotation.y = Math.PI;
  car.add(intake);
  const fin = new THREE.Shape();
  fin.moveTo(.77, .39); fin.lineTo(.9, .74); fin.lineTo(1.67, .57); fin.lineTo(1.83, .16); fin.closePath();
  const finMesh = new THREE.Mesh(new THREE.ExtrudeGeometry(fin, { depth: .028, bevelEnabled: false }), pearl);
  // Shape's horizontal coordinate becomes longitudinal Z.
  finMesh.rotation.y = -Math.PI / 2;
  finMesh.position.x = .014;
  car.add(finMesh);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(.14, 24, 16), mint);
  helmet.position.set(0, .4, .22);
  car.add(helmet);
  const visor = new THREE.Mesh(new THREE.SphereGeometry(.143, 24, 12, Math.PI, Math.PI, Math.PI * .33, Math.PI * .25), black);
  visor.position.copy(helmet.position);
  car.add(visor);
  const haloPath = new THREE.CatmullRomCurve3([
    new THREE.Vector3(.3, .35, .64), new THREE.Vector3(.34, .61, .45),
    new THREE.Vector3(.28, .67, -.08), new THREE.Vector3(0, .66, -.3),
    new THREE.Vector3(-.28, .67, -.08), new THREE.Vector3(-.34, .61, .45),
    new THREE.Vector3(-.3, .35, .64),
  ]);
  car.add(new THREE.Mesh(new THREE.TubeGeometry(haloPath, 48, .035, 10, false), titanium));
  car.add(rod([0, .31, -.22], [0, .66, -.3], .035, titanium));

  // Broad multi-element front wing, endplates and upper flap.
  for (const [z, y, width, depth] of [[-2.35, -.23, 2.16, .23], [-2.15, -.17, 2.04, .16], [-2, -.11, 1.96, .12]]) {
    box(width, .04, depth, 0, y, z, z === -2.35 ? mint : pearl);
  }
  for (const x of [-1.08, 1.08]) box(.045, .24, .55, x, -.13, -2.19, carbon);
  // Raised rear wing with two upright supports and distinct endplates.
  for (const x of [-.25, .25]) car.add(rod([x, -.06, 1.65], [x, .7, 1.93], .03, titanium));
  box(1.5, .07, .43, 0, .71, 2.02, pearl);
  box(1.5, .045, .22, 0, .84, 2.16, mint);
  for (const x of [-.77, .77]) box(.045, .48, .63, x, .64, 2.06, pearl);
  box(1.1, .035, .17, 0, .12, 1.98, carbon);
  // Diffuser strakes stay visible under the tail.
  for (const x of [-.42, -.21, 0, .21, .42]) box(.025, .14, .45, x, -.14, 1.7, titanium);

  const wheels: THREE.Group[] = [];
  for (const x of [-1.03, 1.03]) for (const z of [-1.43, 1.38]) {
    const wheel = new THREE.Group();
    wheel.position.set(x, -.035, z);
    car.add(wheel);
    const width = z > 0 ? .38 : .31;
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(wheelRadius, wheelRadius, width, 48), rubber);
    tire.rotation.z = Math.PI / 2;
    wheel.add(tire);
    for (const face of [-width / 2 - .005, width / 2 + .005]) {
      const rim = new THREE.Mesh(new THREE.TorusGeometry(.27, .019, 10, 40), titanium);
      rim.rotation.y = Math.PI / 2;
      rim.position.x = face;
      wheel.add(rim);
      const sidewall = new THREE.Mesh(new THREE.TorusGeometry(.345, .009, 6, 48), mint);
      sidewall.rotation.y = Math.PI / 2;
      sidewall.position.x = face;
      wheel.add(sidewall);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(.055, .055, .028, 12), mint);
      hub.rotation.z = Math.PI / 2;
      hub.position.x = face;
      wheel.add(hub);
      for (let angle = 0; angle < Math.PI * 2; angle += Math.PI * 2 / 7) {
        wheel.add(rod([face, 0, 0], [face, Math.cos(angle) * .25, Math.sin(angle) * .25], .013, titanium));
      }
      wheel.add(rod([face, .365, -.055], [face, .365, .055], .016, pearl));
    }
    wheels.push(wheel);
    const direction = Math.sign(x);
    const hubX = x - direction * width / 2;
    for (const height of [-.14, .12]) {
      car.add(rod([direction * .33, height, z - .33], [hubX, -.035, z], .024, titanium));
      car.add(rod([direction * .33, height, z + .33], [hubX, -.035, z], .024, titanium));
    }
    car.add(rod([direction * .24, .21, z + .18], [hubX, -.1, z], .027, pearl));
    if (z > 0) car.add(rod([0, -.03, z], [hubX, -.03, z], .03, titanium));
  }

  // The dashed ghost remains level while the car displays amplified motion.
  const outline = [new THREE.Vector3(-1.25, .8, -2.55), new THREE.Vector3(1.25, .8, -2.55), new THREE.Vector3(1.25, .8, 2.45), new THREE.Vector3(-1.25, .8, 2.45), new THREE.Vector3(-1.25, .8, -2.55)];
  const reference = new THREE.Line(new THREE.BufferGeometry().setFromPoints(outline), new THREE.LineDashedMaterial({ color: 0x6e9292, transparent: true, opacity: .32, dashSize: .09, gapSize: .08 }));
  reference.computeLineDistances();
  scene.add(reference);
  scene.add(new THREE.GridHelper(12, 24, 0x27363a, 0x172126));
  const ring = new THREE.Mesh(new THREE.RingGeometry(3, 3.012, 100), new THREE.MeshBasicMaterial({ color: 0x53666b, transparent: true, opacity: .4, side: THREE.DoubleSide }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = .005;
  scene.add(ring);
  return { car, wheels, wheelRadius };
}

export function Chassis(props: ChassisProps) {
  const mountRef = useRef<HTMLDivElement>(null);
  const current = useRef(props);
  current.current = props;
  const draw = useRef<(() => void) | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let stage: ReturnType<typeof createStage> | undefined;
    try {
      stage = createStage(mount, 'Formula One car with front and rear wings, halo, sidepods and four exposed rotating wheels. Displayed body roll is amplified eight times and pitch four times. The dashed rectangle is a level reference.', () => setFailed(true));
      const { scene, camera, renderer } = stage;
      scene.fog = new THREE.Fog(0x080a0b, 8, 20);
      const { car, wheels, wheelRadius } = createChassis(scene);
      const render = () => {
        const state = current.current;
        const roll = state.valid ? clamp(state.roll, -25, 25) : 0;
        const pitch = state.valid ? clamp(state.pitch, -25, 25) : 0;
        // Front points toward -Z, so negative X rotation pitches the nose down.
        const visualRoll = roll * CHASSIS_VISUAL_ROLL_MULTIPLIER;
        const visualPitch = pitch * CHASSIS_VISUAL_PITCH_MULTIPLIER;
        car.rotation.set(-THREE.MathUtils.degToRad(visualPitch), 0, THREE.MathUtils.degToRad(visualRoll), 'YXZ');
        const distance = Number.isFinite(state.distanceMeters)
          ? state.distanceMeters!
          : Math.max(0, state.timeSeconds) * Math.max(0, state.speedKph) / 3.6;
        wheels.forEach(wheel => { wheel.rotation.x = -distance / wheelRadius; });
        renderer.render(scene, camera);
        mount.dataset.renderReady = 'true';
        mount.dataset.timeSeconds = state.timeSeconds.toFixed(3);
        mount.dataset.roll = roll.toFixed(3);
        mount.dataset.pitch = pitch.toFixed(3);
        mount.dataset.visualRoll = visualRoll.toFixed(3);
        mount.dataset.visualPitch = visualPitch.toFixed(3);
        mount.dataset.wheelRotation = wheels[0].rotation.x.toFixed(3);
      };
      draw.current = render;
      stage.observe(render, aspect => {
        const distance = aspect < 1.1 ? 1.25 : 1;
        camera.position.set(5 * distance, 4.5 * distance, -7.2 * distance);
        camera.fov = 37;
        camera.lookAt(0, .65, -.05);
      });
    } catch (error) {
      console.error('Chassis renderer failed', error);
      setFailed(true);
    }
    return () => { draw.current = null; stage?.dispose(); };
  }, []);
  useEffect(() => { draw.current?.(); }, [props.roll, props.pitch, props.speedKph, props.timeSeconds, props.valid, props.distanceMeters]);
  return <div className="babot-visual babot-chassis" data-visual="chassis">
    <div className="babot-visual__canvas" ref={mountRef} />
    {!failed && <><span className="babot-visual__label">Dashed outline · level reference</span><span className="babot-visual__amplification">Body roll ×8 · pitch ×4</span></>}
    {failed && <div className="babot-visual__fallback" role="status">3D chassis unavailable<small>The player and telemetry still work.<br />Reload in a browser with WebGL enabled.</small></div>}
  </div>;
}
