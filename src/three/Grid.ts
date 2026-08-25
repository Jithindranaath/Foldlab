import * as THREE from 'three';

/** Millimetre ground grid: 10 mm minor lines, 50 mm major lines, fading with
 * distance via per-helper opacity/fog rather than a custom shader. */
export function createGroundGrid(size = 400): THREE.Group {
  const group = new THREE.Group();
  group.name = 'ground-grid';

  const majorDivisions = Math.round(size / 50);
  const minorDivisions = Math.round(size / 10);

  const major = new THREE.GridHelper(size, majorDivisions, 0x0d0d0d, 0x0d0d0d);
  const majorMat = major.material as THREE.Material & { opacity: number; transparent: boolean };
  majorMat.opacity = 0.35;
  majorMat.transparent = true;

  const minor = new THREE.GridHelper(size, minorDivisions, 0x8f8f86, 0x8f8f86);
  const minorMat = minor.material as THREE.Material & { opacity: number; transparent: boolean };
  minorMat.opacity = 0.18;
  minorMat.transparent = true;
  minor.position.y = -0.02;

  group.add(minor, major);
  // GridHelper lies in the XZ plane by default; the fold model's flat sheet
  // lies in XY (z=0, folding moves panels toward -z), so rotate the grid
  // into that same plane. Viewport sets camera.up to +Z to match.
  group.rotation.x = Math.PI / 2;
  return group;
}

export function disposeGrid(group: THREE.Group): void {
  group.traverse((obj) => {
    if (obj instanceof THREE.GridHelper) {
      obj.geometry.dispose();
      (obj.material as THREE.Material).dispose();
    }
  });
}
