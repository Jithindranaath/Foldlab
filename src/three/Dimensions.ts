import * as THREE from 'three';
import type { FoldSchedule } from '../core/types.ts';
import { createTextSprite } from './TextSprite.ts';

export interface DimensionsHandle {
  group: THREE.Group;
  setOpacity(opacity: number): void;
  dispose(): void;
}

const ACCENT = '#0d0d0d';

/** L/H/D leader-line callouts on the closed box, anchored to the root
 * panel's (unrotated) flat bbox. Root never moves, so these are static —
 * the caller crossfades `setOpacity` in as the fold finishes rather than
 * flipping visibility, for one continuous motion instead of a pop. */
export function createDimensionCallouts(schedule: FoldSchedule): DimensionsHandle {
  const group = new THREE.Group();
  group.name = 'dimension-callouts';

  const root = schedule.panels.find((p) => p.id === schedule.root);
  if (!root) return { group, setOpacity: () => {}, dispose: () => {} };

  const { x: bx, y: by, w, h } = root.bbox;
  const D = schedule.dims.D;
  const lineMats: THREE.LineBasicMaterial[] = [];
  const lineMat = (): THREE.LineBasicMaterial => {
    const m = new THREE.LineBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.85, depthTest: false });
    lineMats.push(m);
    return m;
  };
  const geometries: THREE.BufferGeometry[] = [];
  const sprites: THREE.Sprite[] = [];

  function addLine(points: THREE.Vector3[]): void {
    const geom = new THREE.BufferGeometry().setFromPoints(points);
    const mat = lineMat();
    const line = new THREE.Line(geom, mat);
    line.renderOrder = 10;
    group.add(line);
    geometries.push(geom);
  }

  function addLabel(text: string, pos: THREE.Vector3): void {
    const sprite = createTextSprite(text, { color: ACCENT, background: '#d4ff2b', scale: 7 });
    sprite.position.copy(pos);
    sprite.renderOrder = 11;
    group.add(sprite);
    sprites.push(sprite);
  }

  // L (length, along X) — leader below the root panel.
  const lY = by - 12;
  addLine([new THREE.Vector3(bx, by, 0), new THREE.Vector3(bx, lY, 0)]);
  addLine([new THREE.Vector3(bx + w, by, 0), new THREE.Vector3(bx + w, lY, 0)]);
  addLine([new THREE.Vector3(bx, lY, 0), new THREE.Vector3(bx + w, lY, 0)]);
  addLabel(`L = ${round1(w)}`, new THREE.Vector3(bx + w / 2, lY - 8, 0));

  // H (height, along Y) — leader to the left of the root panel.
  const hX = bx - 12;
  addLine([new THREE.Vector3(bx, by, 0), new THREE.Vector3(hX, by, 0)]);
  addLine([new THREE.Vector3(bx, by + h, 0), new THREE.Vector3(hX, by + h, 0)]);
  addLine([new THREE.Vector3(hX, by, 0), new THREE.Vector3(hX, by + h, 0)]);
  addLabel(`H = ${round1(h)}`, new THREE.Vector3(hX - 14, by + h / 2, 0));

  // D (depth, along -Z) — leader from the root's plane to the closed box's far face.
  const dX = bx + w + 10;
  const dY = by + h / 2;
  addLine([new THREE.Vector3(dX, dY, 0), new THREE.Vector3(dX, dY, -D)]);
  addLabel(`D = ${round1(D)}`, new THREE.Vector3(dX + 12, dY, -D / 2));

  const baseLineOpacity = 0.85;
  const baseSpriteOpacity = 1;

  function setOpacity(opacity: number): void {
    const c = Math.min(1, Math.max(0, opacity));
    for (const m of lineMats) m.opacity = baseLineOpacity * c;
    for (const s of sprites) s.material.opacity = baseSpriteOpacity * c;
  }

  function dispose(): void {
    for (const g of geometries) g.dispose();
    for (const m of lineMats) m.dispose();
    for (const s of sprites) {
      s.material.map?.dispose();
      s.material.dispose();
    }
  }

  return { group, setOpacity, dispose };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
