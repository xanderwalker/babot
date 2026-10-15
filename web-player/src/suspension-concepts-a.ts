import * as THREE from 'three';
import { createSuspensionRig } from './suspension-rig';

export interface SuspensionConceptA {
  id: string;
  name: string;
  description: string;
  build: () => THREE.Group;
}

function buildLoadPaths() {
  return createSuspensionRig({
    style: 'points',
    ghost: true,
    colors: { body: 0xa6d6d0, arms: 0xc5d6d0, spring: 0xd6f490, wheel: 0x647c7b, accent: 0xe2f0dc },
  });
}

function buildCoilStudy() {
  const rig = createSuspensionRig({
    style: 'points',
    coilEmphasis: true,
    explode: .65,
    ghost: true,
    colors: { body: 0x7ca4b8, arms: 0xb1cad1, spring: 0xf4b260, wheel: 0x546c78, accent: 0xe8e1d1 },
  });
  const body = rig.userData.body as THREE.Group;
  const mountingColor = new THREE.MeshPhysicalMaterial({ color: 0x7ca4b8, metalness: .65, roughness: .3, transparent: true, opacity: .5 });
  for (const z of [-1.75, 1.75]) {
    const arch = new THREE.Mesh(new THREE.TorusGeometry(.34, .012, 8, 36, Math.PI), mountingColor);
    arch.position.set(0, .23, z);
    body.add(arch);
  }
  return rig;
}

function buildPushrodSkeleton() {
  const rig = createSuspensionRig({
    style: 'points',
    pushrod: true,
    coilEmphasis: true,
    colors: { body: 0xc4c8d4, arms: 0x9eabba, spring: 0xc4b2fb, wheel: 0x5b657c, accent: 0xe4e7e8 },
  });
  const body = rig.userData.body as THREE.Group;
  const material = new THREE.MeshPhysicalMaterial({ color: 0xc4b2fb, roughness: .3, metalness: .65 });
  const spine = new THREE.Mesh(new THREE.CylinderGeometry(.025, .025, 3.8, 12), material);
  spine.rotation.x = Math.PI / 2;
  spine.position.y = -.08;
  body.add(spine);
  return rig;
}

export const SUSPENSION_CONCEPTS_A: SuspensionConceptA[] = [
  { id: 'points-load-paths', name: 'Load paths', description: 'Four grounded contacts. Twin wishbones trace the load into a floating motion plane.', build: buildLoadPaths },
  { id: 'points-coil-study', name: 'Coil study', description: 'Exposed amber springs expand and compress around telescoping dampers.', build: buildCoilStudy },
  { id: 'points-pushrod', name: 'Pushrod skeleton', description: 'Outboard pushrods drive visible rockers and inboard violet coil springs.', build: buildPushrodSkeleton },
];
