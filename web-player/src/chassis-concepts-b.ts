import * as THREE from 'three';

type Concept = { id: string; name: string; description: string; build: () => THREE.Group };
type Point = [number, number, number];

const wheelLocations = [
  { name: 'front-left', x: -1.36, z: -1.8 },
  { name: 'front-right', x: 1.36, z: -1.8 },
  { name: 'rear-left', x: -1.36, z: 1.8 },
  { name: 'rear-right', x: 1.36, z: 1.8 },
];

function physical(color: THREE.ColorRepresentation, options: THREE.MeshPhysicalMaterialParameters = {}) {
  return new THREE.MeshPhysicalMaterial({ color, roughness: .26, metalness: .3, clearcoat: 1, clearcoatRoughness: .16, ...options });
}

function solid(geometry: THREE.BufferGeometry, material: THREE.Material, position: Point = [0, 0, 0]) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...position);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  return mesh;
}

function rod(from: Point, to: Point, radius: number, material: THREE.Material) {
  const a = new THREE.Vector3(...from), b = new THREE.Vector3(...to);
  const mesh = solid(new THREE.CylinderGeometry(radius, radius, a.distanceTo(b), 12), material);
  mesh.position.copy(a).add(b).multiplyScalar(.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.sub(a).normalize());
  return mesh;
}

function curve(points: Point[], radius: number, material: THREE.Material, closed = false) {
  const path = new THREE.CatmullRomCurve3(points.map(point => new THREE.Vector3(...point)), closed, 'centripetal');
  return solid(new THREE.TubeGeometry(path, 90, radius, 10, closed), material);
}

function ring(radius: number, thickness: number, material: THREE.Material) {
  const mesh = solid(new THREE.TorusGeometry(radius, thickness, 14, 80), material);
  mesh.rotation.y = Math.PI / 2;
  return mesh;
}

function wheel(name: string, x: number, y: number, z: number) {
  const group = new THREE.Group();
  group.name = `wheel-${name}`;
  group.position.set(x, y, z);
  group.userData.isWheel = true;
  group.userData.spinAxis = 'x';
  return group;
}

function sculpture(name: string) {
  const group = new THREE.Group();
  group.name = name;
  group.userData.frontAxis = '-z';
  group.userData.conceptual = true;
  return group;
}

/** A continuous, thickened strip. The centerline turns up into the rear aerofoil. */
function flowingBand() {
  const centers = new THREE.CatmullRomCurve3([
    [0, .34, -3.02], [0, .39, -2.62], [0, .38, -1.95],
    [0, .62, -.9], [0, 1.12, -.12], [0, 1.25, .46],
    [0, .71, 1.2], [0, .63, 1.95], [0, 1.14, 2.55], [0, 1.24, 2.92],
  ].map(point => new THREE.Vector3(...point)));
  const samples = 140;
  const positions: number[] = [], indices: number[] = [];
  const widths = [1.43, 1.32, .21, .24, .35, .4, .62, .43, .68, 1.1];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const p = centers.getPoint(t);
    const tangent = centers.getTangent(t);
    const normal = new THREE.Vector3(0, tangent.z, -tangent.y).normalize();
    const widthIndex = t * (widths.length - 1);
    const lower = Math.min(widths.length - 2, Math.floor(widthIndex));
    const blend = widthIndex - lower;
    const width = THREE.MathUtils.lerp(widths[lower], widths[lower + 1], blend * blend * (3 - 2 * blend));
    // A fine crowned surface catches a broad softbox highlight without a car body.
    for (const [x, side] of [[-width, 1], [0, 1], [width, 1], [width, -1], [0, -1], [-width, -1]]) {
      const crown = x === 0 ? .045 : 0;
      positions.push(p.x + x, p.y + normal.y * (.035 * side + crown), p.z + normal.z * (.035 * side + crown));
    }
    if (i < samples) {
      for (let j = 0; j < 6; j++) {
        const a = i * 6 + j, b = i * 6 + (j + 1) % 6;
        indices.push(a, a + 6, b, b, a + 6, b + 6);
      }
    }
  }
  // End caps keep the sheet visibly solid from every gallery camera.
  indices.push(0, 5, 1, 1, 5, 4, 1, 4, 2, 2, 4, 3);
  const end = samples * 6;
  indices.push(end, end + 1, end + 5, end + 1, end + 4, end + 5, end + 1, end + 2, end + 4, end + 2, end + 3, end + 4);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function buildRibbon() {
  const group = sculpture('06 / Ribbon chassis');
  const satin = physical(0xecc49a, { metalness: .74, roughness: .2, side: THREE.DoubleSide });
  const copper = physical(0xf27b43, { metalness: .62, roughness: .22 });
  const dark = physical(0x253332, { metalness: .6, roughness: .3 });
  group.add(solid(flowingBand(), satin));
  // Only the axle-level threads connect the strip to the four open wheel hoops.
  for (const z of [-1.8, 1.8]) {
    group.add(curve([[-1.34, .49, z], [-.55, .42, z + .12], [0, .37, z], [.55, .42, z + .12], [1.34, .49, z]], .027, copper));
  }
  for (const location of wheelLocations) {
    const hoop = wheel(location.name, location.x, .49, location.z);
    hoop.add(ring(.435, .055, dark));
    const edge = ring(.435, .022, copper);
    edge.position.x = Math.sign(location.x) * .065;
    hoop.add(edge);
    // One fine chord makes rotation legible while retaining a nearly empty wheel.
    hoop.add(rod([0, -.38, -.12], [0, .38, .12], .012, satin));
    group.add(hoop);
  }
  return group;
}

function dropletBody() {
  const rings = 64, steps = 48;
  const positions: number[] = [], indices: number[] = [];
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const z = THREE.MathUtils.lerp(-2.78, 2.46, t);
    const envelope = Math.sin(Math.PI * t) ** .78;
    const halfWidth = envelope * (.16 + .43 * t);
    const height = envelope * (.16 + .15 * Math.sin(Math.PI * t));
    const center = .57 + .035 * Math.sin(Math.PI * t);
    for (let j = 0; j <= steps; j++) {
      const angle = j / steps * Math.PI * 2;
      positions.push(Math.cos(angle) * halfWidth, center + Math.sin(angle) * height, z);
      if (i < rings && j < steps) {
        const a = i * (steps + 1) + j, b = a + steps + 1;
        indices.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function buildMercury() {
  const group = sculpture('07 / Mercury chassis');
  const chrome = physical(0xd5e1df, { metalness: 1, roughness: .075, clearcoatRoughness: .03, envMapIntensity: 1.8 });
  const darkChrome = physical(0x465759, { metalness: 1, roughness: .14, envMapIntensity: 1.6 });
  const orange = physical(0xff8955, { metalness: .45, roughness: .14 });
  group.add(solid(dropletBody(), chrome));
  for (const side of [-1, 1]) {
    const frontDrop = solid(new THREE.SphereGeometry(1, 48, 28), chrome, [side * .72, .42, -2.58]);
    frontDrop.scale.set(.8, .105, .25);
    frontDrop.rotation.y = side * -.15;
    group.add(frontDrop);
  }
  const rearDrop = solid(new THREE.SphereGeometry(1, 48, 28), chrome, [0, .94, 2.55]);
  rearDrop.scale.set(1.14, .115, .26);
  group.add(rearDrop);
  // A suspended droplet replaces a cockpit; no bodywork, suspension or tire tread.
  const cockpit = solid(new THREE.SphereGeometry(.18, 40, 24), orange, [0, 1.035, .19]);
  cockpit.scale.set(.8, .74, 1.65);
  group.add(cockpit);
  for (const location of wheelLocations) {
    const globe = wheel(location.name, location.x, .5, location.z);
    const sphere = solid(new THREE.SphereGeometry(.49, 48, 32), darkChrome);
    sphere.scale.x = .72;
    globe.add(sphere);
    const liquidSeam = ring(.477, .012, chrome);
    globe.add(liquidSeam);
    const satellite = solid(new THREE.SphereGeometry(.055, 20, 16), orange, [Math.sign(location.x) * .357, .19, -.1]);
    globe.add(satellite);
    group.add(globe);
  }
  return group;
}

function sectionShape(width: number, height: number) {
  const shape = new THREE.Shape();
  shape.moveTo(-width, .32);
  shape.bezierCurveTo(-width * 1.08, .49, -width * .8, height * .87, -width * .3, height);
  shape.quadraticCurveTo(0, height + .045, width * .3, height);
  shape.bezierCurveTo(width * .8, height * .87, width * 1.08, .49, width, .32);
  shape.closePath();
  return shape;
}

function buildSections() {
  const group = sculpture('08 / Section study');
  const ghost = physical(0x8ce5db, { metalness: .05, roughness: .19, transparent: true, opacity: .24, depthWrite: false, side: THREE.DoubleSide });
  const endGhost = physical(0xeccaa3, { metalness: .25, roughness: .23, transparent: true, opacity: .38, depthWrite: false, side: THREE.DoubleSide });
  const edges = new THREE.LineBasicMaterial({ color: 0x97e4d6, transparent: true, opacity: .83 });
  const amberEdges = new THREE.LineBasicMaterial({ color: 0xffb681, transparent: true, opacity: .9 });
  const widths = [.17, .23, .31, .42, .54, .63, .66, .58, .44, .29];
  const heights = [.5, .57, .63, .86, 1.23, 1.36, 1.17, .94, .75, .6];
  widths.forEach((width, index) => {
    const geometry = new THREE.ShapeGeometry(sectionShape(width, heights[index]), 32);
    const panel = solid(geometry, index === 0 || index === 9 ? endGhost : ghost, [0, 0, -2.58 + index * .55]);
    panel.renderOrder = index;
    group.add(panel);
    const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(sectionShape(width, heights[index]).getPoints(48)), index === 0 || index === 9 ? amberEdges : edges);
    outline.position.z = panel.position.z;
    group.add(outline);
  });
  // Separated drafting planes suggest the wings without filling in a solid car.
  for (const [z, y, width] of [[-2.94, .39, 2.98], [2.73, 1.02, 2.34]]) {
    const plane = solid(new THREE.PlaneGeometry(width, .14), endGhost, [0, y, z]);
    group.add(plane);
    const outline = new THREE.LineSegments(new THREE.EdgesGeometry(plane.geometry), amberEdges);
    outline.position.copy(plane.position);
    group.add(outline);
  }
  const hoopMat = physical(0xb3d9d3, { metalness: .4, roughness: .21, transparent: true, opacity: .65 });
  for (const location of wheelLocations) {
    const stack = wheel(location.name, location.x, .49, location.z);
    for (const dx of [-.12, 0, .12]) {
      const hoop = ring(.455, .025, hoopMat);
      hoop.position.x = dx;
      stack.add(hoop);
    }
    group.add(stack);
  }
  return group;
}

function graphicPlate(points: [number, number][], y: number, material: THREE.Material, depth = .055) {
  const shape = new THREE.Shape();
  points.forEach(([x, z], i) => i ? shape.lineTo(x, z) : shape.moveTo(x, z));
  shape.closePath();
  const mesh = solid(new THREE.ExtrudeGeometry(shape, { depth, bevelEnabled: false }), material, [0, y, 0]);
  mesh.rotation.x = Math.PI / 2;
  return mesh;
}

function buildVector() {
  const group = sculpture('09 / Vector chassis');
  const chalk = physical(0xf2e5cf, { metalness: .08, roughness: .55 });
  const orange = physical(0xff6a32, { metalness: .15, roughness: .38 });
  const teal = physical(0x79c5b8, { metalness: .36, roughness: .28 });
  const black = physical(0x334141, { metalness: .5, roughness: .4 });
  group.add(graphicPlate([[0, -3.12], [.47, -1.2], [.12, -.9], [.12, 2.6], [-.12, 2.6], [-.12, -.9], [-.47, -1.2]], .65, chalk));
  const chevron = (z: number, width: number, length: number, y: number, material: THREE.Material) =>
    graphicPlate([[0, z - length], [width, z], [width, z + .22], [0, z - length + .34], [-width, z + .22], [-width, z]], y, material);
  group.add(chevron(-2.18, 1.48, .67, .39, orange));
  group.add(chevron(.45, .74, 1.06, .84, teal));
  group.add(chevron(1.74, .86, .83, .94, chalk));
  group.add(chevron(2.79, 1.16, .38, .79, orange));
  for (const location of wheelLocations) {
    const offset = Math.sign(location.x) * .13;
    const contact = wheel(location.name, location.x, .48, location.z + offset);
    contact.add(ring(.435, .041, black));
    const bright = ring(.435, .014, chalk);
    bright.position.x = Math.sign(location.x) * .062;
    contact.add(bright);
    // A single circular dot makes each contact form a graphic mark, not a tire.
    const dot = solid(new THREE.SphereGeometry(.054, 16, 12), orange, [Math.sign(location.x) * .07, .305, -.305]);
    contact.add(dot);
    group.add(contact);
  }
  return group;
}

function buildMobile() {
  const group = sculpture('10 / Counterweight mobile');
  const ivory = physical(0xe5d8bc, { metalness: .16, roughness: .4 });
  const black = physical(0x25312f, { metalness: .26, roughness: .5 });
  const orange = physical(0xf2713a, { metalness: .1, roughness: .37 });
  const brass = physical(0xb69b68, { metalness: .82, roughness: .28 });
  // The chassis is a suspended balance beam: extremely slender, visibly empty.
  group.add(curve([[0, .73, -2.9], [0, 1.03, -1.6], [0, 1.28, 0], [0, 1.18, 1.6], [0, 1.37, 2.78]], .055, ivory));
  group.add(curve([[-1.38, .93, -1.8], [-.7, 1.05, -1.61], [0, 1.03, -1.8], [.71, 1.19, -1.92], [1.38, 1.1, -1.8]], .026, brass));
  group.add(curve([[-1.38, 1.13, 1.8], [-.58, 1.38, 1.94], [0, 1.24, 1.8], [.7, 1.49, 1.62], [1.38, 1.32, 1.8]], .026, brass));
  for (const location of wheelLocations) {
    const rear = location.z > 0;
    const suspensionTop = rear ? (location.x < 0 ? 1.13 : 1.32) : (location.x < 0 ? .93 : 1.1);
    group.add(rod([location.x, suspensionTop, location.z], [location.x, .48, location.z], .009, brass));
    const contact = wheel(location.name, location.x, .48, location.z);
    contact.add(ring(.435, .042, black));
    contact.add(rod([0, -.35, -.25], [0, .35, .25], .016, ivory));
    const hub = solid(new THREE.SphereGeometry(.095, 24, 16), orange);
    hub.scale.x = .42;
    contact.add(hub);
    group.add(contact);
  }
  // Asymmetric enamel weights and fine wire branches express load transfer.
  const weights: { anchor: Point; center: Point; size: Point }[] = [
    { anchor: [0, 1.31, .15], center: [-.7, .76, -.3], size: [.42, .075, .26] },
    { anchor: [0, 1.27, .7], center: [.82, .86, .82], size: [.33, .065, .51] },
    { anchor: [0, 1.37, 2.66], center: [-.49, 1.03, 2.7], size: [.78, .065, .22] },
  ];
  for (const weight of weights) {
    const elbow: Point = [weight.center[0], weight.anchor[1] + .13, weight.center[2]];
    group.add(rod(weight.anchor, elbow, .012, brass));
    group.add(rod(elbow, weight.center, .008, brass));
    const disk = solid(new THREE.SphereGeometry(1, 32, 20), orange, weight.center);
    disk.scale.set(...weight.size);
    disk.rotation.z = weight.center[0] < 0 ? -.12 : .19;
    group.add(disk);
  }
  group.add(graphicPlate([[0, -3.05], [1.1, -2.62], [.45, -2.48], [0, -2.76], [-1.16, -2.42], [-1.44, -2.56]], .48, ivory, .032));
  const counterpoint = solid(new THREE.SphereGeometry(.075, 20, 16), brass, [0, 1.36, .05]);
  group.add(counterpoint);
  return group;
}

export const CONCEPTS_B: Concept[] = [
  { id: 'ribbon', name: 'Ribbon', description: 'A single flowing champagne-metal strip bends from front aerofoil to raised tail, held between four open copper-edged hoops.', build: buildRibbon },
  { id: 'mercury', name: 'Mercury', description: 'A low liquid-metal teardrop, suspended aero droplets and four reflective globes turn the chassis into a weightless chrome sculpture.', build: buildMercury },
  { id: 'sections', name: 'Sections', description: 'Ten translucent cross-sections and layered wheel circles describe an absent Formula 1 body, like a luminous physical scan.', build: buildSections },
  { id: 'vector', name: 'Vector', description: 'A precise directional spine and four floating chevrons reduce the car to speed, balance and circular points of contact.', build: buildVector },
  { id: 'mobile', name: 'Counterweight', description: 'A suspended ivory beam, fine brass branches and asymmetric orange weights make every roll and pitch feel like a kinetic mobile.', build: buildMobile },
];
