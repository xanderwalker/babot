import * as THREE from 'three';

type Point = [number, number, number];
type Pose = { rollDeg: number; pitchDeg: number; wheelAngle: number };
const Y = new THREE.Vector3(0, 1, 0);
const finite = (n: number) => Number.isFinite(n) ? n : 0;

function light(color: number, opacity = 1) {
  return new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: opacity >= 1, toneMapped: false });
}

function trace(parent: THREE.Group, points: Point[], radius: number, material: THREE.Material, closed = false, smooth = false) {
  const path = smooth
    ? new THREE.CatmullRomCurve3(points.map(p => new THREE.Vector3(...p)), closed, 'centripetal')
    : new THREE.CurvePath<THREE.Vector3>();
  if (path instanceof THREE.CurvePath) {
    const vectors = points.map(p => new THREE.Vector3(...p));
    for (let i = 1; i < vectors.length; i++) path.add(new THREE.LineCurve3(vectors[i - 1], vectors[i]));
    if (closed) path.add(new THREE.LineCurve3(vectors[vectors.length - 1], vectors[0]));
  }
  const mesh = new THREE.Mesh(new THREE.TubeGeometry(path, Math.max(20, points.length * 8), radius, 7, closed), material);
  parent.add(mesh);
  return mesh;
}

function link(parent: THREE.Group, radius: number, material: THREE.Material) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 1, 8), material);
  const delta = new THREE.Vector3();
  parent.add(mesh);
  return (from: THREE.Vector3, to: THREE.Vector3) => {
    delta.subVectors(to, from);
    const length = Math.max(.0001, delta.length());
    mesh.position.copy(from).add(to).multiplyScalar(.5);
    mesh.scale.y = length;
    mesh.quaternion.setFromUnitVectors(Y, delta.multiplyScalar(1 / length));
  };
}

function dot(parent: THREE.Group, position: Point, radius: number, material: THREE.Material) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 8), material);
  mesh.position.set(...position);
  parent.add(mesh);
  return mesh;
}

/** Small horizontal inboard coil/shaft assembly, updated only with transforms. */
function coil(parent: THREE.Group, geometry: THREE.BufferGeometry, amber: THREE.Material, dim: THREE.Material) {
  const assembly = new THREE.Group();
  const spring = new THREE.Mesh(geometry, amber);
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(.008, .008, 1, 8), dim);
  const ends = [-1, 1].map(() => {
    const end = new THREE.Mesh(new THREE.CylinderGeometry(.04, .04, .012, 16), amber);
    assembly.add(end);
    return end;
  });
  assembly.add(spring, shaft);
  parent.add(assembly);
  const direction = new THREE.Vector3();
  let neutralLength = 0;
  const state = { length: 0, compression: 0 };
  return {
    state,
    update(from: THREE.Vector3, to: THREE.Vector3) {
      direction.subVectors(to, from);
      const length = Math.max(.065, direction.length());
      if (!neutralLength) neutralLength = length;
      state.length = length;
      state.compression = neutralLength - length;
      assembly.position.copy(from).add(to).multiplyScalar(.5);
      assembly.quaternion.setFromUnitVectors(Y, direction.multiplyScalar(1 / length));
      shaft.scale.y = length;
      spring.scale.y = length * .75;
      ends[0].position.y = -length * .375;
      ends[1].position.y = length * .375;
    },
  };
}

function buildLightChassis() {
  const rig = new THREE.Group();
  const body = new THREE.Group();
  body.position.y = .66;
  rig.add(body);
  const cyan = light(0x7ee9f1);
  const secondary = light(0x57969e, .8);
  const faint = light(0x385a66, .65);
  const amber = light(0xffc278);
  const white = new THREE.MeshStandardMaterial({ color: 0xf5edda, emissive: 0xffce8f, emissiveIntensity: .23, roughness: .3, metalness: .08 });

  // One tapering perimeter establishes the F1 silhouette without stacked bodywork.
  trace(body, [
    [0, -.31, -2.37], [.105, -.23, -1.95], [.15, -.11, -1.25], [.28, .025, -.63],
    [.46, -.04, .13], [.55, -.1, .65], [.34, -.14, 1.23], [0, -.17, 1.79],
    [-.34, -.14, 1.23], [-.55, -.1, .65], [-.46, -.04, .13], [-.28, .025, -.63],
    [-.15, -.11, -1.25], [-.105, -.23, -1.95],
  ], .017, cyan, true, true);
  // The nose and engine spine leave an open space around the driver.
  trace(body, [[0, -.31, -2.37], [0, -.02, -1.3], [0, .14, -.62]], .014, cyan, false, true);
  trace(body, [[0, .26, .34], [0, .39, .63], [0, .2, 1.18], [0, -.17, 1.79]], .017, cyan, false, true);
  trace(body, [[-.22, .13, -.42], [0, .16, -.56], [.22, .13, -.42], [.255, .13, .13], [0, .16, .34], [-.255, .13, .13]], .014, cyan, true, true);
  const helmet = new THREE.Mesh(new THREE.SphereGeometry(.155, 28, 20), white);
  helmet.position.set(0, .31, -.04);
  body.add(helmet);

  // A leading blade and a raised trailing loop, kept to single line elements.
  trace(body, [[-1.2, -.37, -2.36], [0, -.34, -2.22], [1.2, -.37, -2.36]], .019, cyan);
  trace(body, [[-1.2, -.37, -2.36], [-1.16, -.23, -2.08]], .012, secondary);
  trace(body, [[1.2, -.37, -2.36], [1.16, -.23, -2.08]], .012, secondary);
  trace(body, [[-.76, .37, 1.73], [-.76, .43, 1.99], [.76, .43, 1.99], [.76, .37, 1.73]], .018, cyan, true);
  for (const side of [-1, 1]) trace(body, [[side * .19, -.08, 1.48], [side * .19, .39, 1.85]], .011, secondary);

  const springPoints = Array.from({ length: 121 }, (_, index) => {
    const progress = index / 120;
    const angle = progress * Math.PI * 10;
    return new THREE.Vector3(Math.cos(angle) * .032, progress - .5, Math.sin(angle) * .032);
  });
  const coilGeometry = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(springPoints), 144, .0065, 6, false);
  const updates: (() => void)[] = [];
  const wheels: THREE.Group[] = [];
  const travel: { corner: string; damper: { length: number; compression: number } }[] = [];
  const bodyAnchor = new THREE.Vector3();
  const tireMaterial = new THREE.MeshStandardMaterial({
    color: 0x142b31, emissive: 0x123a42, emissiveIntensity: .24,
    roughness: .78, metalness: .08, side: THREE.DoubleSide,
  });

  // Front axle sits well ahead of the helmet; rear axle is behind the engine spine.
  for (const side of [-1, 1]) for (const axleZ of [-1.65, 1.5]) {
    const front = axleZ < 0;
    const wheel = new THREE.Group();
    wheel.position.set(side * 1.1, .43, axleZ);
    wheel.userData.isWheel = true;
    rig.add(wheel);
    wheels.push(wheel);
    const width = front ? .32 : .44;
    wheel.userData.tireWidth = width;
    // A broad, quiet barrel gives the cyan outlines real tire volume. Both
    // faces remain open at the rim so the inboard suspension stays readable.
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(.414, .414, width, 48, 1, true), tireMaterial);
    barrel.rotation.z = Math.PI / 2;
    wheel.add(barrel);
    for (const face of [-width / 2, width / 2]) {
      const shoulder = new THREE.Mesh(new THREE.TorusGeometry(.407, .018, 9, 48), cyan);
      shoulder.rotation.y = Math.PI / 2;
      shoulder.position.x = face;
      const sidewall = new THREE.Mesh(new THREE.RingGeometry(.315, .407, 48), tireMaterial);
      sidewall.rotation.y = Math.PI / 2;
      sidewall.position.x = face;
      const rim = new THREE.Mesh(new THREE.TorusGeometry(.315, .008, 6, 40), faint);
      rim.rotation.y = Math.PI / 2;
      rim.position.x = face;
      wheel.add(shoulder, sidewall, rim);
      for (let i = 0; i < 3; i++) {
        const angle = i * Math.PI * 2 / 3;
        trace(wheel, [[face, 0, 0], [face, Math.cos(angle) * .315, Math.sin(angle) * .315]], .0075, secondary);
      }
      dot(wheel, [face, 0, 0], .026, cyan);
    }
    trace(wheel, [[-width / 2 + .025, .418, 0], [width / 2 - .025, .418, 0]], .006, amber);

    const hubX = side * (1.1 - width / 2 - .04);
    const upperHub = new THREE.Vector3(hubX, .59, axleZ);
    const lowerHub = new THREE.Vector3(hubX, .28, axleZ);
    trace(rig, [[hubX, .28, axleZ], [hubX, .59, axleZ]], .014, secondary);
    trace(rig, [[hubX, .43, axleZ], [side * 1.1, .43, axleZ]], .013, secondary);
    dot(rig, [hubX, .28, axleZ], .024, cyan);
    dot(rig, [hubX, .59, axleZ], .024, cyan);
    // Two V-shaped wishbones per wheel, attached low on the nose and gearbox.
    for (const [localY, hub] of [[-.2, lowerHub], [.025, upperHub]] as const) {
      for (const foreAft of [-1, 1]) {
        const anchor = new THREE.Vector3(side * (front ? .2 : .28), localY, axleZ + foreAft * .22);
        const transformed = new THREE.Vector3();
        const arm = link(rig, .011, secondary);
        dot(body, [anchor.x, anchor.y, anchor.z], .018, cyan);
        updates.push(() => { transformed.copy(anchor).applyMatrix4(body.matrix); arm(transformed, hub); });
      }
    }

    // The diagonal pushrod drives a compact inboard bellcrank and horizontal coil.
    const rockerZ = axleZ + (front ? .19 : -.2);
    const pivotLocal = new THREE.Vector3(side * .32, .13, rockerZ);
    const springMountLocal = new THREE.Vector3(side * .02, .25, rockerZ);
    const lower = new THREE.Vector3(hubX, .31, axleZ);
    const pivot = new THREE.Vector3();
    const pushrodTip = new THREE.Vector3();
    const springTip = new THREE.Vector3();
    const springMount = new THREE.Vector3();
    const pushrod = link(rig, .013, cyan);
    const rockerOut = link(rig, .012, amber);
    const rockerIn = link(rig, .012, amber);
    const spring = coil(rig, coilGeometry, amber, secondary);
    travel.push({ corner: `${front ? 'front' : 'rear'}-${side < 0 ? 'left' : 'right'}`, damper: spring.state });
    dot(body, [pivotLocal.x, pivotLocal.y, pivotLocal.z], .026, amber);
    dot(body, [springMountLocal.x, springMountLocal.y, springMountLocal.z], .019, amber);
    updates.push(() => {
      pivot.copy(pivotLocal).applyMatrix4(body.matrix);
      bodyAnchor.set(side * .26, .025, axleZ).applyMatrix4(body.matrix);
      const displacement = bodyAnchor.y - .685;
      const angle = -THREE.MathUtils.clamp(displacement * 2, -.58, .58) * side;
      const cos = Math.cos(angle), sin = Math.sin(angle);
      const ax = side * .09, ay = .16;
      pushrodTip.set(pivotLocal.x + ax * cos - ay * sin, pivotLocal.y + ax * sin + ay * cos, rockerZ).applyMatrix4(body.matrix);
      const bx = side * -.08, by = .14;
      springTip.set(pivotLocal.x + bx * cos - by * sin, pivotLocal.y + bx * sin + by * cos, rockerZ).applyMatrix4(body.matrix);
      springMount.copy(springMountLocal).applyMatrix4(body.matrix);
      pushrod(lower, pushrodTip);
      rockerOut(pivot, pushrodTip);
      rockerIn(pivot, springTip);
      spring.update(springMount, springTip);
    });
  }

  const updatePose = ({ rollDeg, pitchDeg, wheelAngle }: Pose) => {
    body.rotation.set(-THREE.MathUtils.degToRad(finite(pitchDeg)), 0, THREE.MathUtils.degToRad(finite(rollDeg)), 'YXZ');
    body.updateMatrix();
    for (const update of updates) update();
    for (const wheel of wheels) wheel.rotation.x = finite(wheelAngle);
  };
  rig.userData.body = body;
  rig.userData.wheels = wheels;
  rig.userData.wheelRadius = .425;
  rig.userData.updatePose = updatePose;
  rig.userData.suspensionTravel = travel;
  rig.userData.poseMode = 'grounded-schematic-suspension';
  rig.userData.motionLabel = 'Conceptual pushrod articulation; not measured suspension travel';
  updatePose({ rollDeg: 0, pitchDeg: 0, wheelAngle: 0 });
  return rig;
}

export const TRON_F1_CONCEPT = {
  id: 'tron-f1',
  name: 'Light chassis',
  description: 'One cyan F1 outline, a helmet sphere, grounded wheel hoops and small inboard pushrod springs.',
  build: buildLightChassis,
};
