import * as THREE from 'three';

/** Concepts use front = -Z. Wheel pivots rotate around X and sit in userData.wheels. */
export interface ChassisConceptA {
  id: string;
  name: string;
  description: string;
  build: () => THREE.Group;
}

type Point = [number, number, number];
type Profile = [number, number, number, number];

function conceptGroup() {
  const group = new THREE.Group();
  group.userData.wheels = [] as THREE.Group[];
  group.userData.wheelRadius = .45;
  return group;
}

function physical(color: number, extra: THREE.MeshPhysicalMaterialParameters = {}) {
  return new THREE.MeshPhysicalMaterial({ color, roughness: .25, metalness: .3, clearcoat: .8, side: THREE.DoubleSide, ...extra });
}

function stroke(points: Point[], radius: number, material: THREE.Material, smooth = false, closed = false) {
  const vectors = points.map(point => new THREE.Vector3(...point));
  const curve = smooth
    ? new THREE.CatmullRomCurve3(vectors, closed, 'centripetal')
    : new THREE.CurvePath<THREE.Vector3>();
  if (curve instanceof THREE.CurvePath) {
    for (let i = 1; i < vectors.length; i++) curve.add(new THREE.LineCurve3(vectors[i - 1], vectors[i]));
    if (closed) curve.add(new THREE.LineCurve3(vectors[vectors.length - 1], vectors[0]));
  }
  return new THREE.Mesh(new THREE.TubeGeometry(curve, Math.max(24, points.length * 12), radius, 8, closed), material);
}

function polygon(vertices: Point[], triangles: number[], material: THREE.Material) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices.flat(), 3));
  geometry.setIndex(triangles);
  geometry.computeVertexNormals();
  return new THREE.Mesh(geometry, material);
}

/** Sculpted cross-sections: z, half-width, bottom, top. */
function loft(profiles: Profile[], material: THREE.Material) {
  const vertices: Point[] = [];
  const triangles: number[] = [];
  const n = 16;
  profiles.forEach(([z, width, bottom, top], row) => {
    for (let i = 0; i < n; i++) {
      const angle = i / n * Math.PI * 2;
      vertices.push([Math.cos(angle) * width, (top + bottom) / 2 + Math.sin(angle) * (top - bottom) / 2, z]);
    }
    if (row > 0) for (let i = 0; i < n; i++) {
      const a = (row - 1) * n + i;
      const b = (row - 1) * n + (i + 1) % n;
      triangles.push(a, a + n, b, b, a + n, b + n);
    }
  });
  for (let i = 1; i < n - 1; i++) {
    triangles.push(0, i + 1, i);
    const end = (profiles.length - 1) * n;
    triangles.push(end, end + i, end + i + 1);
  }
  return polygon(vertices, triangles, material);
}

function wheelPivot(group: THREE.Group, x: number, z: number) {
  const pivot = new THREE.Group();
  pivot.position.set(x, -.015, z);
  group.add(pivot);
  (group.userData.wheels as THREE.Group[]).push(pivot);
  return pivot;
}

function hoop(radius: number, thickness: number, material: THREE.Material, segments = 64) {
  const mesh = new THREE.Mesh(new THREE.TorusGeometry(radius, thickness, 12, segments), material);
  mesh.rotation.y = Math.PI / 2;
  return mesh;
}

function bead(position: Point, radius: number, material: THREE.Material) {
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(radius, 16, 12), material);
  mesh.position.set(...position);
  return mesh;
}

function buildMonocoque() {
  const group = conceptGroup();
  const pearl = physical(0xf1eee2, { roughness: .18, metalness: .15 });
  const obsidian = physical(0x172226, { roughness: .2, metalness: .65 });
  const silver = physical(0x94a29e, { roughness: .17, metalness: .8 });
  const citrus = physical(0xe0f08d, { roughness: .25 });

  // A single carved volume flows from a needle nose into broad rear shoulders.
  group.add(loft([
    [-2.34, .045, -.16, -.04], [-2, .11, -.15, .02], [-1.4, .17, -.15, .16],
    [-.8, .3, -.16, .36], [-.25, .44, -.16, .55], [.35, .45, -.16, .6],
    [.95, .36, -.15, .47], [1.55, .18, -.1, .23], [1.95, .045, -.04, .04],
  ], pearl));
  group.add(loft([
    [-1.05, .17, -.22, -.11], [-.55, .72, -.22, -.05], [.25, .79, -.22, -.05],
    [1.1, .65, -.2, -.05], [1.7, .26, -.17, -.04],
  ], obsidian));
  // Two floating blades are deliberately reduced to the F1 proportions.
  group.add(polygon([
    [-1.22, -.15, -2.36], [0, -.07, -2.12], [1.22, -.15, -2.36],
    [-1.16, -.13, -2.05], [0, .005, -1.98], [1.16, -.13, -2.05],
  ], [0, 1, 3, 1, 4, 3, 1, 2, 4, 2, 5, 4], pearl));
  group.add(polygon([
    [-.85, .52, 1.84], [0, .61, 1.79], [.85, .52, 1.84],
    [-.85, .5, 2.16], [0, .58, 2.09], [.85, .5, 2.16],
  ], [0, 1, 3, 1, 4, 3, 1, 2, 4, 2, 5, 4], pearl));
  group.add(stroke([[0, .1, 1.56], [0, .56, 1.98]], .024, silver));
  group.add(stroke([[0, .03, -1.95], [0, .185, -1.4], [0, .39, -.8], [0, .575, -.25], [0, .625, .35], [0, .49, .95]], .012, citrus, true));

  for (const x of [-1.05, 1.05]) for (const z of [-1.42, 1.36]) {
    const wheel = wheelPivot(group, x, z);
    wheel.add(hoop(.42, .065, obsidian), hoop(.32, .014, silver));
    const outer = hoop(.43, .025, pearl);
    outer.position.x = Math.sign(x) * .065;
    wheel.add(outer);
    wheel.add(stroke([[0, 0, 0], [0, .35, 0]], .02, citrus));
    wheel.add(bead([0, 0, 0], .05, obsidian));
    group.add(stroke([[Math.sign(x) * .28, -.08, z], [x, -.015, z]], .018, silver));
  }
  return group;
}

function buildNeon() {
  const group = conceptGroup();
  const lime = new THREE.MeshBasicMaterial({ color: 0xddfa92 });
  const ice = new THREE.MeshBasicMaterial({ color: 0x9be8e3 });
  const faint = new THREE.MeshBasicMaterial({ color: 0x86b7bd, transparent: true, opacity: .33, depthWrite: false });
  const glow = new THREE.MeshBasicMaterial({ color: 0xc4f493, transparent: true, opacity: .09, depthWrite: false });
  const outline: Point[] = [[0, .05, -2.36], [.14, .12, -1.8], [.24, .27, -.8], [.59, .2, -.35], [.7, .14, .55], [.47, .16, 1.36], [0, .23, 1.9], [-.47, .16, 1.36], [-.7, .14, .55], [-.59, .2, -.35], [-.24, .27, -.8], [-.14, .12, -1.8]];
  group.add(stroke(outline, .017, lime, true, true));
  group.add(stroke(outline, .065, glow, true, true));
  group.add(stroke([[0, .05, -2.36], [0, .34, -.7], [0, .58, .2], [0, .4, .95], [0, .23, 1.9]], .015, ice, true));
  group.add(stroke([[-1.24, -.14, -2.3], [-1.24, .02, -1.98], [-.25, .02, -2.1], [0, .05, -2.36], [.25, .02, -2.1], [1.24, .02, -1.98], [1.24, -.14, -2.3]], .02, ice));
  group.add(stroke([[-1.24, -.14, -2.3], [0, -.14, -2.4], [1.24, -.14, -2.3]], .014, lime));
  group.add(stroke([[-.83, .57, 1.91], [-.83, .72, 2.13], [.83, .72, 2.13], [.83, .57, 1.91]], .021, lime, false, true));
  for (const x of [-.35, .35]) group.add(stroke([[x, .17, 1.45], [x, .62, 2.02]], .014, faint));
  for (const z of [-1.42, 1.36]) group.add(stroke([[-1.04, 0, z], [1.04, 0, z]], .012, faint));
  for (const x of [-1.04, 1.04]) for (const z of [-1.42, 1.36]) {
    const wheel = wheelPivot(group, x, z);
    wheel.add(hoop(.44, .018, lime), hoop(.37, .009, faint));
    const companion = hoop(.44, .009, ice);
    companion.position.x = Math.sign(x) * .16;
    wheel.add(companion);
    wheel.add(stroke([[0, .44, 0], [Math.sign(x) * .16, .44, 0]], .019, ice));
    wheel.add(bead([0, .44, 0], .037, ice));
  }
  return group;
}

function buildOrigami() {
  const group = conceptGroup();
  const paper = physical(0xf0e7d4, { flatShading: true, metalness: .05, roughness: .65, clearcoat: 0 });
  const shade = physical(0xb9b8a8, { flatShading: true, metalness: .1, roughness: .5, clearcoat: 0 });
  const ember = physical(0xf78955, { flatShading: true, roughness: .5, metalness: .05, clearcoat: 0 });
  const graphite = physical(0x2a3a3e, { roughness: .7, metalness: .1, clearcoat: 0 });
  // Every plane is intentional: paper folds converge on one central ridge.
  group.add(polygon([
    [0, -.05, -2.3], [-.2, -.1, -1.2], [.2, -.1, -1.2], [0, .32, -.6],
    [-.65, -.15, -.1], [.65, -.15, -.1], [0, .68, .45],
    [-.6, -.12, 1.3], [.6, -.12, 1.3], [0, .12, 1.95],
  ], [0, 1, 3, 0, 3, 2, 1, 4, 3, 2, 3, 5, 3, 4, 6, 3, 6, 5, 6, 4, 7, 6, 8, 5, 6, 7, 9, 6, 9, 8], paper));
  group.add(polygon([[-.65, -.15, -.1], [-.83, -.23, .45], [-.6, -.12, 1.3], [0, .68, .45]], [0, 1, 3, 1, 2, 3], shade));
  group.add(polygon([[.65, -.15, -.1], [.83, -.23, .45], [.6, -.12, 1.3], [0, .68, .45]], [0, 3, 1, 1, 3, 2], ember));
  group.add(polygon([
    [-1.22, .04, -2.39], [-1.1, -.19, -1.96], [0, -.08, -2.19],
    [1.22, .04, -2.39], [1.1, -.19, -1.96], [0, -.22, -2.46],
  ], [0, 1, 2, 3, 2, 4, 0, 2, 5, 3, 5, 2], paper));
  group.add(polygon([
    [-.86, .65, 1.85], [-.72, .32, 2.19], [0, .52, 2.02],
    [.86, .65, 1.85], [.72, .32, 2.19], [0, .78, 2.14],
  ], [0, 1, 2, 2, 4, 3, 0, 2, 5, 3, 5, 2], ember));
  group.add(polygon([[0, .13, 1.85], [-.14, .52, 2.02], [.14, .52, 2.02]], [0, 1, 2], graphite));
  for (const x of [-1.05, 1.05]) for (const z of [-1.42, 1.36]) {
    const wheel = wheelPivot(group, x, z);
    const outer = hoop(.43, .055, graphite, 6);
    const inner = hoop(.335, .015, paper, 6);
    wheel.add(outer, inner);
    wheel.add(polygon([[0, 0, 0], [0, .34, -.19], [0, .34, .19]], [0, 1, 2], ember));
    group.add(stroke([[Math.sign(x) * .2, -.11, z], [x, -.015, z]], .017, graphite));
  }
  return group;
}

function buildSpine() {
  const group = conceptGroup();
  const bone = physical(0xe8ddc5, { metalness: .2, roughness: .3 });
  const bronze = physical(0xc79159, { metalness: .8, roughness: .25 });
  const shadow = physical(0x23373a, { metalness: .7, roughness: .25 });
  // Isolated vertebrae and open ribs suggest force travelling through the car.
  for (let i = 0; i < 13; i++) {
    const z = -2.12 + i * .31;
    const hump = Math.sin((i / 12) * Math.PI);
    const y = .03 + hump * .27;
    const width = .12 + Math.sin((i / 12) * Math.PI) * .56;
    const vertebra = new THREE.Mesh(new THREE.CapsuleGeometry(.055 + hump * .03, .17, 4, 12), bone);
    vertebra.rotation.x = Math.PI / 2;
    vertebra.position.set(0, y, z);
    group.add(vertebra);
    if (i < 12) group.add(bead([0, y, z + .155], .035, bronze));
    if (i > 1 && i < 12) {
      group.add(stroke([[-width, -.12, z], [-width * .96, y - .01, z], [-width * .6, y + .13, z], [0, y + .19, z], [width * .6, y + .13, z], [width * .96, y - .01, z], [width, -.12, z]], .024, i % 3 === 0 ? bronze : bone, true));
    }
  }
  group.add(stroke([[-1.22, -.11, -2.29], [-.65, .025, -2.21], [0, .11, -2.15], [.65, .025, -2.21], [1.22, -.11, -2.29]], .034, bronze, true));
  group.add(stroke([[-1.17, -.2, -2.05], [0, -.08, -1.97], [1.17, -.2, -2.05]], .02, bone, true));
  group.add(stroke([[-.84, .48, 2.07], [-.4, .64, 1.95], [0, .68, 1.92], [.4, .64, 1.95], [.84, .48, 2.07]], .032, bronze, true));
  for (const x of [-.3, .3]) group.add(stroke([[x, -.08, 1.56], [x, .55, 1.99]], .016, shadow));
  for (const x of [-1.04, 1.04]) for (const z of [-1.42, 1.36]) {
    const wheel = wheelPivot(group, x, z);
    wheel.add(hoop(.43, .025, bronze), hoop(.35, .012, bone));
    wheel.add(bead([0, 0, 0], .055, bronze));
    for (let i = 0; i < 4; i++) {
      const a = i * Math.PI / 2;
      wheel.add(stroke([[0, 0, 0], [.04, Math.cos(a) * .18, Math.sin(a) * .18], [0, Math.cos(a + .32) * .34, Math.sin(a + .32) * .34]], .016, bone, true));
    }
    group.add(stroke([[Math.sign(x) * .18, .08, z], [x, -.015, z]], .022, shadow));
    group.add(bead([Math.sign(x) * .18, .08, z], .06, bronze));
  }
  return group;
}

function buildContact() {
  const group = conceptGroup();
  const mint = new THREE.MeshBasicMaterial({ color: 0xd3edaf });
  const gray = new THREE.MeshBasicMaterial({ color: 0x829c9b, transparent: true, opacity: .65 });
  const dark = physical(0x344c50, { metalness: .7, roughness: .25 });
  const transparent = physical(0xa9d4c6, { transparent: true, opacity: .075, depthWrite: false, metalness: 0, roughness: .6, clearcoat: 0 });
  const plane: Point[] = [[-.9, -.07, -1.78], [0, -.07, -2.35], [.9, -.07, -1.78], [.9, -.07, 1.78], [0, -.07, 2.12], [-.9, -.07, 1.78]];
  group.add(polygon(plane, [0, 1, 2, 0, 2, 3, 0, 3, 5, 3, 4, 5], transparent));
  group.add(stroke(plane, .009, gray, false, true));
  group.add(stroke([[0, -.045, -2.2], [0, -.045, 1.95]], .012, mint));
  group.add(stroke([[-1.12, -.045, -1.42], [1.12, -.045, -1.42]], .01, gray));
  group.add(stroke([[-1.12, -.045, 1.36], [1.12, -.045, 1.36]], .01, gray));
  group.add(stroke([[-.18, -.03, -1.96], [0, -.03, -2.23], [.18, -.03, -1.96]], .018, mint));
  const pivotRing = new THREE.Mesh(new THREE.TorusGeometry(.23, .012, 8, 48), mint);
  pivotRing.rotation.x = Math.PI / 2;
  group.add(pivotRing);
  group.add(bead([0, 0, 0], .035, mint));
  for (const x of [-1.03, 1.03]) for (const z of [-1.42, 1.36]) {
    const wheel = wheelPivot(group, x, z);
    wheel.add(hoop(.43, .023, dark), hoop(.36, .009, gray));
    const arc = new THREE.Mesh(new THREE.TorusGeometry(.43, .025, 8, 32, Math.PI * .58), mint);
    arc.rotation.y = Math.PI / 2;
    wheel.add(arc);
    // Tiny contact ellipses reveal the plane's roll without adding bodywork.
    const contact = new THREE.Mesh(new THREE.RingGeometry(.12, .14, 32), gray);
    contact.rotation.x = -Math.PI / 2;
    contact.scale.x = .65;
    contact.position.set(x, -.46, z);
    group.add(contact);
    group.add(stroke([[x, -.42, z], [x, -.19, z]], .008, gray));
  }
  return group;
}

export const CONCEPTS_A: ChassisConceptA[] = [
  { id: 'monocoque', name: 'Monocoque', description: 'A carved pearl volume, carbon shadow and four floating wheel hoops.', build: buildMonocoque },
  { id: 'neon', name: 'Light circuit', description: 'The entire car reduced to one luminous electric drawing in space.', build: buildNeon },
  { id: 'origami', name: 'Folded force', description: 'Sharp paper planes and hexagonal wheels, folded around a central ridge.', build: buildOrigami },
  { id: 'spine', name: 'Kinetic spine', description: 'An articulated backbone with floating ivory ribs and warm metal joints.', build: buildSpine },
  { id: 'contact', name: 'Four points', description: 'Only the contact rings, a translucent motion plane and the direction of travel.', build: buildContact },
];
