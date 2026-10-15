import * as THREE from 'three';
import { createSuspensionRig } from './suspension-rig';

type Concept = { id: string; name: string; description: string; build: () => THREE.Group };
type Point = [number, number, number];
type Profile = { z: number; width: number; height: number };

const profiles: Profile[] = [
  { z: -2.65, width: .12, height: -.02 },
  { z: -2.1, width: .2, height: .04 },
  { z: -1.55, width: .29, height: .12 },
  { z: -1.0, width: .38, height: .32 },
  { z: -.45, width: .48, height: .54 },
  { z: .1, width: .53, height: .62 },
  { z: .65, width: .57, height: .53 },
  { z: 1.2, width: .49, height: .34 },
  { z: 1.75, width: .36, height: .15 },
  { z: 2.3, width: .23, height: .01 },
];

function material(color: number, options: THREE.MeshPhysicalMaterialParameters = {}) {
  return new THREE.MeshPhysicalMaterial({ color, roughness: .26, metalness: .25, clearcoat: .65, side: THREE.DoubleSide, ...options });
}

function mesh(geometry: THREE.BufferGeometry, surface: THREE.Material, position: Point = [0, 0, 0]) {
  const result = new THREE.Mesh(geometry, surface);
  result.position.set(...position);
  result.castShadow = true;
  return result;
}

function line(points: Point[], color: number, opacity = 1) {
  return new THREE.Line(new THREE.BufferGeometry().setFromPoints(points.map(point => new THREE.Vector3(...point))), new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
}

function dashed(points: Point[], color: number, opacity = .48) {
  const result = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points.map(point => new THREE.Vector3(...point))), new THREE.LineDashedMaterial({ color, transparent: true, opacity, dashSize: .075, gapSize: .05 }));
  result.computeLineDistances();
  return result;
}

function section(profile: Profile, bottom = -.19) {
  const { width: w, height: h } = profile;
  const shape = new THREE.Shape();
  shape.moveTo(-w, bottom);
  shape.bezierCurveTo(-w * 1.1, bottom + .12, -w * .82, h * .8, -w * .26, h);
  shape.quadraticCurveTo(0, h + .025, w * .26, h);
  shape.bezierCurveTo(w * .82, h * .8, w * 1.1, bottom + .12, w, bottom);
  shape.closePath();
  return shape;
}

function outlinedSection(profile: Profile, surface: THREE.Material, color: number, y = 0, opacity = .85) {
  const group = new THREE.Group();
  group.position.set(0, y, profile.z);
  const shape = section(profile);
  group.add(mesh(new THREE.ShapeGeometry(shape, 28), surface));
  const outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(shape.getPoints(56)), new THREE.LineBasicMaterial({ color, transparent: true, opacity }));
  group.add(outline);
  return group;
}

function plate(width: number, depth: number, y: number, z: number, surface: THREE.Material) {
  return mesh(new THREE.BoxGeometry(width, .025, depth), surface, [0, y, z]);
}

function floorOutline(color: number, y = -.2, opacity = .72) {
  return line([
    [0, y, -2.7], [-.22, y, -1.68], [-.59, y, -.1], [-.46, y, 1.8], [0, y, 2.5],
    [.46, y, 1.8], [.59, y, -.1], [.22, y, -1.68], [0, y, -2.7],
  ], color, opacity);
}

function markCornerStations(body: THREE.Group, color: number) {
  // Small blocks locate the upper body attachments without hiding the springs.
  const surface = material(color, { metalness: .45, roughness: .21 });
  for (const x of [-.4, .4]) for (const z of [-1.75, 1.75]) {
    body.add(mesh(new THREE.BoxGeometry(.13, .065, .65), surface, [x, -.005, z]));
  }
}

function buildLaboratory() {
  const rig = createSuspensionRig({
    style: 'sections',
    colors: { body: 0xcce6dd, arms: 0xc6d8cf, spring: 0xff8d49, wheel: 0x354746, accent: 0x86e1ca },
    coilEmphasis: true,
    ghost: true,
  });
  rig.name = 'Section laboratory';
  const body = rig.userData.body as THREE.Group;
  const glass = material(0x8dd8cf, { transparent: true, opacity: .16, depthWrite: false, metalness: .08, roughness: .18 });
  const cream = material(0xe2d5b9, { roughness: .45, metalness: .12 });
  profiles.forEach((profile, index) => {
    body.add(outlinedSection(profile, glass, index === 0 || index === profiles.length - 1 ? 0xffaf77 : 0x98ddd0));
  });
  body.add(floorOutline(0xd4e8df));
  body.add(plate(2.45, .11, -.17, -2.73, cream));
  body.add(plate(1.95, .14, .11, 2.53, cream));
  markCornerStations(body, 0xffb176);
  // A measured-looking central datum belongs to the moving structure.
  body.add(dashed([[0, -.19, -2.68], [0, -.19, 2.47]], 0xb3d4c7, .7));
  return rig;
}

function buildExploded() {
  const rig = createSuspensionRig({
    style: 'sections',
    colors: { body: 0xead8b8, arms: 0xf0dbb5, spring: 0xff7336, wheel: 0x2f3a38, accent: 0xffab64 },
    explode: .1,
    pushrod: true,
    coilEmphasis: true,
  });
  rig.name = 'Exploded suspension';
  const body = rig.userData.body as THREE.Group;
  const amber = material(0xe8bb85, { transparent: true, opacity: .16, depthWrite: false, roughness: .28, metalness: .18 });
  const pale = material(0xe9ddc7, { metalness: .25, roughness: .31 });
  const orange = material(0xfa9359, { metalness: .3, roughness: .27 });
  // Five separated floating slices leave a large visual opening above the four
  // suspension stations; dashed risers connect that envelope to the flexing body.
  profiles.filter((_, i) => i % 2 === 0).forEach((profile, index) => {
    const raised = .22 + (index % 2) * .08;
    const scaled = { ...profile, width: profile.width * 1.14, height: profile.height * .82 };
    body.add(outlinedSection(scaled, amber, 0xf3bd80, raised, .93));
    for (const side of [-1, 1]) {
      body.add(dashed([[side * scaled.width, -.18, profile.z], [side * scaled.width, raised - .19, profile.z]], 0xf3b36d, .62));
    }
  });
  body.add(floorOutline(0xf1d6aa, -.23, .86));
  // An open ladder, rather than a broad floor, makes the moving pickup points legible.
  for (const x of [-.34, .34]) {
    body.add(mesh(new THREE.BoxGeometry(.055, .055, 3.88), pale, [x, -.19, 0]));
  }
  for (const z of [-1.75, 0, 1.75]) body.add(mesh(new THREE.BoxGeometry(.72, .055, .055), pale, [0, -.19, z]));
  for (const z of [-1.75, 1.75]) {
    const bridge = line([[-.44, .02, z], [-.3, .13, z], [.3, .13, z], [.44, .02, z]], 0xffb674);
    body.add(bridge);
  }
  body.add(plate(2.58, .12, -.15, -2.76, orange));
  body.add(plate(2.1, .12, .32, 2.62, pale));
  body.add(dashed([[0, .02, 2.62], [0, .32, 2.62]], 0xe5c696));
  markCornerStations(body, 0xfcad69);
  return rig;
}

function ghostShell() {
  const positions: number[] = [], indices: number[] = [];
  const pointsPerSection = 40;
  profiles.forEach((profile, index) => {
    const points = section(profile).getSpacedPoints(pointsPerSection);
    points.forEach(point => positions.push(point.x, point.y, profile.z));
    if (index < profiles.length - 1) {
      for (let j = 0; j < pointsPerSection; j++) {
        const a = index * (pointsPerSection + 1) + j, b = a + pointsPerSection + 1;
        indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function buildXray() {
  const rig = createSuspensionRig({
    style: 'sections',
    colors: { body: 0x92cee7, arms: 0x8fb9d2, spring: 0x70e4c4, wheel: 0x334752, accent: 0xb1dce9 },
    pushrod: true,
    ghost: true,
    coilEmphasis: true,
  });
  rig.name = 'X-ray flex';
  const body = rig.userData.body as THREE.Group;
  const shell = material(0xa7d8f2, { transparent: true, opacity: .065, depthWrite: false, metalness: .04, roughness: .12 });
  const slice = material(0x93c5e8, { transparent: true, opacity: .075, depthWrite: false, metalness: 0, roughness: .3 });
  const bone = material(0xd5e5e8, { metalness: .3, roughness: .27 });
  body.add(mesh(ghostShell(), shell));
  // Fewer, sharper cross-sections plus a nearly absent shell emphasize flexing
  // pickup points; the brightest objects are the actual articulated coil units.
  profiles.filter((_, index) => [0, 2, 4, 6, 9].includes(index)).forEach(profile => {
    body.add(outlinedSection(profile, slice, 0x82b4d9, 0, .58));
  });
  body.add(line(profiles.map(profile => [0, profile.height + .02, profile.z] as Point), 0xc4e5ef, .7));
  for (const side of [-1, 1]) {
    body.add(line(profiles.map(profile => [profile.width * side, -.19, profile.z] as Point), 0x7da8c9, .5));
  }
  for (const z of [-1.75, 1.75]) {
    body.add(mesh(new THREE.BoxGeometry(.9, .045, .05), bone, [0, .02, z]));
    for (const side of [-1, 1]) {
      // Bright circular markers visibly travel with the body while the wheel
      // hubs stay fixed. The rig supplies the springs connecting the two.
      const marker = mesh(new THREE.TorusGeometry(.085, .018, 12, 32), bone, [side * .4, .035, z]);
      marker.rotation.x = Math.PI / 2;
      body.add(marker);
    }
  }
  const blade = material(0xb4d5e4, { transparent: true, opacity: .34, depthWrite: false, metalness: .3, roughness: .24 });
  body.add(plate(2.45, .12, -.15, -2.74, blade));
  body.add(plate(1.94, .14, .19, 2.54, blade));
  return rig;
}

export const SUSPENSION_CONCEPTS_B: Concept[] = [
  { id: 'sections-lab', name: 'Section laboratory', description: 'Cyan body slices reveal four bright coils. Fixed wheel contacts make body roll and spring travel easy to read.', build: buildLaboratory },
  { id: 'sections-exploded', name: 'Exploded suspension', description: 'Floating amber slices expose a moving ladder frame, articulated wishbones and oversized orange coils.', build: buildExploded },
  { id: 'sections-xray', name: 'X-ray flex', description: 'A nearly invisible blue shell surrounds luminous springs. Moving body markers show compression against grounded wheels.', build: buildXray },
];
