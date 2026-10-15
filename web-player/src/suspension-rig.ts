import * as THREE from 'three';

export interface SuspensionRigOptions {
  style: 'points' | 'sections';
  colors?: { body?: number; arms?: number; spring?: number; wheel?: number; accent?: number };
  explode?: number;
  pushrod?: boolean;
  ghost?: boolean;
  coilEmphasis?: boolean;
}

export interface SuspensionPose {
  rollDeg: number;
  pitchDeg: number;
  wheelAngle: number;
}

type V = [number, number, number];
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const radians = (degrees: number) => THREE.MathUtils.degToRad(Number.isFinite(degrees) ? degrees : 0);

function material(color: number, extra: THREE.MeshPhysicalMaterialParameters = {}) {
  return new THREE.MeshPhysicalMaterial({ color, roughness: .28, metalness: .55, clearcoat: .4, side: THREE.DoubleSide, ...extra });
}

function line(points: V[], color: number, opacity = 1) {
  return new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(points.map(p => new THREE.Vector3(...p))),
    new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }),
  );
}

/** No mesh, geometry, vector, or material allocation occurs in a strut update. */
function createStrut(parent: THREE.Group, radius: number, appearance: THREE.Material) {
  const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 1, 10), appearance);
  const direction = new THREE.Vector3();
  parent.add(mesh);
  return (start: THREE.Vector3, end: THREE.Vector3) => {
    direction.subVectors(end, start);
    const length = Math.max(.001, direction.length());
    mesh.position.copy(start).add(end).multiplyScalar(.5);
    mesh.scale.y = length;
    mesh.quaternion.setFromUnitVectors(Y_AXIS, direction.multiplyScalar(1 / length));
  };
}

function fixedStrut(parent: THREE.Group, a: V, b: V, radius: number, appearance: THREE.Material) {
  createStrut(parent, radius, appearance)(new THREE.Vector3(...a), new THREE.Vector3(...b));
}

function joint(parent: THREE.Group, location: V, appearance: THREE.Material, radius = .045) {
  const sphere = new THREE.Mesh(new THREE.SphereGeometry(radius, 14, 10), appearance);
  sphere.position.set(...location);
  parent.add(sphere);
  return sphere;
}

function springGeometry(radius: number, turns: number, wire: number) {
  const points = Array.from({ length: turns * 24 + 1 }, (_, i) => {
    const progress = i / (turns * 24);
    const angle = progress * Math.PI * 2 * turns;
    return new THREE.Vector3(Math.cos(angle) * radius, progress - .5, Math.sin(angle) * radius);
  });
  return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(points), turns * 32, wire, 7, false);
}

function createDamper(parent: THREE.Group, spring: THREE.Material, hardware: THREE.Material, shaft: THREE.Material, coil: THREE.BufferGeometry, emphasis: boolean) {
  const assembly = new THREE.Group();
  const direction = new THREE.Vector3();
  parent.add(assembly);
  const cylinder = new THREE.Mesh(new THREE.CylinderGeometry(emphasis ? .043 : .032, emphasis ? .043 : .032, 1, 14), hardware);
  const piston = new THREE.Mesh(new THREE.CylinderGeometry(.014, .014, 1, 12), shaft);
  const helix = new THREE.Mesh(coil, spring);
  const collarMaterial = hardware;
  const collars = [-1, 1].map(() => {
    const collar = new THREE.Mesh(new THREE.CylinderGeometry(emphasis ? .105 : .077, emphasis ? .105 : .077, .025, 24), collarMaterial);
    assembly.add(collar);
    return collar;
  });
  const eyes = [-1, 1].map(() => {
    const eye = new THREE.Mesh(new THREE.TorusGeometry(.04, .014, 8, 20), hardware);
    assembly.add(eye);
    return eye;
  });
  assembly.add(cylinder, piston, helix);
  let neutralLength = 0;
  const state = { length: 0, compression: 0 };
  return {
    state,
    update(lower: THREE.Vector3, upper: THREE.Vector3) {
      direction.subVectors(upper, lower);
      const length = Math.max(.08, direction.length());
      if (neutralLength === 0) neutralLength = length;
      state.length = length;
      state.compression = neutralLength - length;
      assembly.position.copy(lower).add(upper).multiplyScalar(.5);
      assembly.quaternion.setFromUnitVectors(Y_AXIS, direction.multiplyScalar(1 / length));
      cylinder.scale.y = Math.min(.34, length * .47);
      cylinder.position.y = length * .25;
      piston.scale.y = length * .63;
      piston.position.y = -length * .15;
      helix.scale.y = length * .56;
      helix.position.y = -.01 * length;
      collars[0].position.y = -length * .29;
      collars[1].position.y = length * .27;
      eyes[0].position.y = -length / 2;
      eyes[1].position.y = length / 2;
    },
  };
}

/**
 * Schematic suspension, not measured damper travel or a rigid-link physics solve.
 * Body anchors follow the replay; grounded wheel hubs remain fixed. Wishbones,
 * telescoping dampers and coils visibly articulate between those two references.
 * add geometry to userData.body in local coordinates around y=0 (neutral pivot .88).
 * Call userData.updatePose with the already-amplified display angles.
 */
export function createSuspensionRig(options: SuspensionRigOptions): THREE.Group {
  const rig = new THREE.Group();
  const body = new THREE.Group();
  body.position.y = .88;
  rig.add(body);
  const palette = {
    body: options.colors?.body ?? 0xaed6cc,
    arms: options.colors?.arms ?? 0xb9c7c3,
    spring: options.colors?.spring ?? 0xd7f88c,
    wheel: options.colors?.wheel ?? 0x5d7374,
    accent: options.colors?.accent ?? 0xe8f0e2,
  };
  const bodyMaterial = material(palette.body);
  const armMaterial = material(palette.arms, { metalness: .8, roughness: .3 });
  const springMaterial = material(palette.spring, { roughness: .22, metalness: .35 });
  const wheelMaterial = material(palette.wheel, { roughness: .45, metalness: .6 });
  const accentMaterial = material(palette.accent, { metalness: .65, roughness: .2 });
  const darkMaterial = material(0x18262d, { roughness: .5 });
  const explode = THREE.MathUtils.clamp(options.explode ?? 0, 0, 1);
  const coilGeometry = springGeometry(
    options.pushrod ? .052 : options.coilEmphasis ? .084 : .06,
    options.pushrod ? 5 : options.coilEmphasis ? 8 : 7,
    options.pushrod ? .009 : options.coilEmphasis ? .014 : .011,
  );
  const wheels: THREE.Group[] = [];
  const updates: (() => void)[] = [];
  const springStates: { corner: string; damper: { length: number; compression: number } }[] = [];

  // A small anchor frame makes the body reference legible even without a shell.
  for (const x of [-.4, .4]) fixedStrut(body, [x, -.12, -1.98], [x, -.12, 1.98], .018, bodyMaterial);
  for (const z of [-1.75, 0, 1.75]) fixedStrut(body, [-.4, -.12, z], [.4, -.12, z], .018, bodyMaterial);
  if (options.style === 'points') {
    const plane = new THREE.Mesh(new THREE.PlaneGeometry(.78, 4.15), material(palette.body, { transparent: true, opacity: .075, depthWrite: false, metalness: 0, roughness: .7 }));
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = -.11;
    body.add(plane);
    body.add(line([[-.18, -.1, -1.98], [0, -.1, -2.25], [.18, -.1, -1.98]], palette.spring));
  }

  for (const side of [-1, 1]) for (const z of [-1.75, 1.75]) {
    const x = side * 1.2;
    const uprightX = side * 1.015;
    const wheel = new THREE.Group();
    wheel.position.set(x, .48, z);
    wheel.userData.isWheel = true;
    rig.add(wheel);
    wheels.push(wheel);
    // Open, graphic wheel hoops leave the suspension mechanisms visible.
    for (const offset of [-.12, .12]) {
      const tire = new THREE.Mesh(new THREE.TorusGeometry(.42, .045, 12, 48), wheelMaterial);
      tire.rotation.y = Math.PI / 2;
      tire.position.x = offset;
      wheel.add(tire);
    }
    const rim = new THREE.Mesh(new THREE.TorusGeometry(.315, .018, 10, 40), accentMaterial);
    rim.rotation.y = Math.PI / 2;
    rim.position.x = side * .13;
    wheel.add(rim);
    for (let i = 0; i < 5; i++) {
      const angle = i / 5 * Math.PI * 2;
      fixedStrut(wheel, [side * .13, 0, 0], [side * .13, Math.cos(angle) * .31, Math.sin(angle) * .31], .014, wheelMaterial);
    }
    fixedStrut(wheel, [side * .135, .37, -.05], [side * .135, .37, .05], .016, springMaterial);
    joint(wheel, [side * .13, 0, 0], springMaterial, .05);
    const uprightBottom = new THREE.Vector3(uprightX, .31, z);
    const uprightTop = new THREE.Vector3(uprightX, .7, z);
    fixedStrut(rig, [uprightX, .31, z], [uprightX, .7, z], .033, darkMaterial);
    fixedStrut(rig, [uprightX, .48, z], [x, .48, z], .035, accentMaterial);
    joint(rig, [uprightX, .31, z], springMaterial, .045);
    joint(rig, [uprightX, .7, z], springMaterial, .045);

    const anchorHalfSpan = .29 + explode * .12;
    for (const [anchorY, hub] of [[-.22, uprightBottom], [.04, uprightTop]] as const) {
      for (const foreAft of [-1, 1]) {
        const anchor = new THREE.Vector3(side * .4, anchorY, z + foreAft * anchorHalfSpan);
        const world = new THREE.Vector3();
        const updateArm = createStrut(rig, anchorY < 0 ? .022 : .018, armMaterial);
        joint(body, [anchor.x, anchor.y, anchor.z], bodyMaterial, .036);
        updates.push(() => { world.copy(anchor).applyMatrix4(body.matrix); updateArm(world, hub); });
      }
    }
    const damper = createDamper(rig, springMaterial, darkMaterial, accentMaterial, coilGeometry, Boolean(options.coilEmphasis && !options.pushrod));
    springStates.push({ corner: `${z < 0 ? 'front' : 'rear'}-${side < 0 ? 'left' : 'right'}`, damper: damper.state });
    const lower = new THREE.Vector3(side * .96, .37, z);
    if (!options.pushrod) {
      const upperLocal = new THREE.Vector3(side * (.3 + explode * .06), .33 + explode * .16, z);
      const upper = new THREE.Vector3();
      joint(body, [upperLocal.x, upperLocal.y, upperLocal.z], springMaterial, .05);
      updates.push(() => { upper.copy(upperLocal).applyMatrix4(body.matrix); damper.update(lower, upper); });
    } else {
      // Stylized bellcrank rotates from relative hub/body displacement. Its two
      // arms transfer outboard pushrod motion to an inboard horizontal spring.
      const pivotLocal = new THREE.Vector3(side * .4, .23, z);
      const bodySpringMount = new THREE.Vector3(side * -.07, .39, z);
      const pivot = new THREE.Vector3();
      const rockerTip = new THREE.Vector3();
      const springTip = new THREE.Vector3();
      const springMount = new THREE.Vector3();
      const bodyReference = new THREE.Vector3();
      const pushrod = createStrut(rig, .022, accentMaterial);
      const rockerA = createStrut(rig, .035, springMaterial);
      const rockerB = createStrut(rig, .035, springMaterial);
      const tipJoint = joint(rig, [0, 0, 0], springMaterial, .045);
      joint(body, [.4 * side, .23, z], accentMaterial, .055);
      joint(body, [-.07 * side, .39, z], accentMaterial, .045);
      updates.push(() => {
        pivot.copy(pivotLocal).applyMatrix4(body.matrix);
        bodyReference.set(side * .4, -.22, z).applyMatrix4(body.matrix);
        const travel = bodyReference.y - .66;
        const angle = -THREE.MathUtils.clamp(travel * 1.7, -.65, .65) * side;
        const cos = Math.cos(angle), sin = Math.sin(angle);
        const ax = side * .13, ay = .19;
        rockerTip.set(pivotLocal.x + ax * cos - ay * sin, pivotLocal.y + ax * sin + ay * cos, z).applyMatrix4(body.matrix);
        const bx = side * -.1, by = .2;
        springTip.set(pivotLocal.x + bx * cos - by * sin, pivotLocal.y + bx * sin + by * cos, z).applyMatrix4(body.matrix);
        springMount.copy(bodySpringMount).applyMatrix4(body.matrix);
        pushrod(lower, rockerTip);
        rockerA(pivot, rockerTip);
        rockerB(pivot, springTip);
        tipJoint.position.copy(rockerTip);
        damper.update(springMount, springTip);
      });
    }
    const contact = new THREE.Mesh(new THREE.RingGeometry(.15, .165, 32), new THREE.MeshBasicMaterial({ color: palette.spring, transparent: true, opacity: .6, side: THREE.DoubleSide }));
    contact.rotation.x = -Math.PI / 2;
    contact.scale.x = .6;
    contact.position.set(x, .012, z);
    rig.add(contact);
  }

  if (options.ghost) {
    const neutral = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([[-.53, .76, -2.16], [.53, .76, -2.16], [.53, .76, 2.16], [-.53, .76, 2.16], [-.53, .76, -2.16]].map(p => new THREE.Vector3(...p))),
      new THREE.LineDashedMaterial({ color: palette.body, transparent: true, opacity: .3, dashSize: .1, gapSize: .1 }),
    );
    neutral.computeLineDistances();
    rig.add(neutral);
  }

  const updatePose = ({ rollDeg, pitchDeg, wheelAngle }: SuspensionPose) => {
    body.rotation.set(-radians(pitchDeg), 0, radians(rollDeg), 'YXZ');
    body.updateMatrix();
    for (const update of updates) update();
    const angle = Number.isFinite(wheelAngle) ? wheelAngle : 0;
    for (const wheel of wheels) wheel.rotation.x = angle;
  };
  rig.userData.body = body;
  rig.userData.wheels = wheels;
  rig.userData.wheelRadius = .465;
  rig.userData.updatePose = updatePose;
  rig.userData.suspensionTravel = springStates;
  rig.userData.poseMode = 'grounded-schematic-suspension';
  rig.userData.motionLabel = 'Illustrative suspension travel; not measured damper motion';
  updatePose({ rollDeg: 0, pitchDeg: 0, wheelAngle: 0 });
  return rig;
}
