import * as THREE from 'three';

export function createBoardMaterials(): { outer: THREE.MeshStandardMaterial; inner: THREE.MeshStandardMaterial } {
  const outer = new THREE.MeshStandardMaterial({
    color: 0xf6f6f0,
    roughness: 1,
    metalness: 0,
    flatShading: true,
    side: THREE.FrontSide,

    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1
  });
  const inner = new THREE.MeshStandardMaterial({
    color: 0xdcdcd0,
    roughness: 1,
    metalness: 0,
    flatShading: true,
    side: THREE.BackSide,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1
  });
  return { outer, inner };
}

export function disposeMaterials(materials: { outer: THREE.Material; inner: THREE.Material }): void {
  materials.outer.dispose();
  materials.inner.dispose();
}
