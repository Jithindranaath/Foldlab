import * as THREE from 'three';
import { createTextSprite } from './TextSprite.ts';

const AXIS_COLORS = { x: 0xff5c5c, y: 0x4ade80, z: 0x5b8cff };

/** Right-handed world XYZ triad at the origin, with billboarded labels. */
export function createWorldAxes(length = 60): THREE.Group {
  const group = new THREE.Group();
  group.name = 'world-axes';

  const axes: { dir: THREE.Vector3; color: number; label: string }[] = [
    { dir: new THREE.Vector3(1, 0, 0), color: AXIS_COLORS.x, label: 'X' },
    { dir: new THREE.Vector3(0, 1, 0), color: AXIS_COLORS.y, label: 'Y' },
    { dir: new THREE.Vector3(0, 0, 1), color: AXIS_COLORS.z, label: 'Z' }
  ];

  for (const axis of axes) {
    const arrow = new THREE.ArrowHelper(axis.dir, new THREE.Vector3(0, 0, 0), length, axis.color, length * 0.08, length * 0.05);
    group.add(arrow);
    const label = createTextSprite(axis.label, {
      color: `#${axis.color.toString(16).padStart(6, '0')}`,
      background: 'rgba(255,255,255,0.85)',
      scale: 8
    });
    label.position.copy(axis.dir).multiplyScalar(length + 10);
    group.add(label);
  }

  return group;
}

/** A small triad at a panel's local origin, for the toggleable per-panel
 * frames overlay. Caller positions/parents this into the panel's own
 * container so it inherits that panel's live fold transform. */
export function createLocalFrame(size = 15): THREE.Group {
  const group = new THREE.Group();
  const axes: { dir: THREE.Vector3; color: number }[] = [
    { dir: new THREE.Vector3(1, 0, 0), color: AXIS_COLORS.x },
    { dir: new THREE.Vector3(0, 1, 0), color: AXIS_COLORS.y },
    { dir: new THREE.Vector3(0, 0, 1), color: AXIS_COLORS.z }
  ];
  for (const axis of axes) {
    const arrow = new THREE.ArrowHelper(axis.dir, new THREE.Vector3(0, 0, 0), size, axis.color, size * 0.25, size * 0.15);
    group.add(arrow);
  }
  return group;
}

export function disposeAxesGroup(group: THREE.Group): void {
  group.traverse((obj) => {
    if (obj instanceof THREE.ArrowHelper) obj.dispose();
    if (obj instanceof THREE.Sprite) {
      obj.material.map?.dispose();
      obj.material.dispose();
    }
  });
}
