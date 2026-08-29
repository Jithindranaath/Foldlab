
import * as THREE from 'three';
import type { FoldEdge, FoldSchedule, Panel, Vec2 } from '../core/types.ts';
import { angleAtT, easeInOutCubic } from '../core/kinematics.ts';
import { createBoardMaterials, disposeMaterials } from './Materials.ts';

export const PANEL_OPEN_ANGLE = (114 * Math.PI) / 180;

interface PanelNode {
  container: THREE.Group;
  meshes: THREE.Mesh[];
  geometry: THREE.BufferGeometry;

  ownAxisPoint: Vec2;
  ownAxisDir: Vec2;
}

function buildGeometry(points: Vec2[]): THREE.BufferGeometry {
  const shape = new THREE.Shape(points.map((p) => new THREE.Vector2(p.x, p.y)));
  const geometry = new THREE.ShapeGeometry(shape);
  return geometry;
}

function toLocalDir(v: Vec2, dir: Vec2): Vec2 {
  return { x: v.x * dir.x + v.y * dir.y, y: -v.x * dir.y + v.y * dir.x };
}
function toLocalPoint(p: Vec2, origin: Vec2, dir: Vec2): Vec2 {
  return toLocalDir({ x: p.x - origin.x, y: p.y - origin.y }, dir);
}

export class PanelTree {
  readonly root: THREE.Group;
  private nodes = new Map<string, PanelNode>();
  private materials: { outer: THREE.MeshStandardMaterial; inner: THREE.MeshStandardMaterial };
  private edgeByChild = new Map<string, FoldEdge>();

  private edgeLineMaterial = new THREE.LineBasicMaterial({ color: 0x0d0d0d });
  private edgeGeometries: THREE.BufferGeometry[] = [];

  constructor(schedule: FoldSchedule) {
    this.root = new THREE.Group();
    this.materials = createBoardMaterials();

    const panelsById = new Map<string, Panel>(schedule.panels.map((p) => [p.id, p]));
    for (const e of schedule.edges) this.edgeByChild.set(e.child, e);

    const rootPanel = panelsById.get(schedule.root);
    if (!rootPanel) return;

    const rootContainer = new THREE.Group();
    this.root.add(rootContainer);
    this.addPanelMeshes(rootContainer, rootPanel.polygon, rootPanel.id);
    this.nodes.set(rootPanel.id, {
      container: rootContainer,
      meshes: [...rootContainer.children] as THREE.Mesh[],
      geometry: (rootContainer.children[0] as THREE.Mesh).geometry,

      ownAxisPoint: { x: 0, y: 0 },
      ownAxisDir: { x: 1, y: 0 }
    });

    const edgesByParent = new Map<string, FoldEdge[]>();
    for (const e of schedule.edges) {
      if (!edgesByParent.has(e.parent)) edgesByParent.set(e.parent, []);
      edgesByParent.get(e.parent)!.push(e);
    }

    const queue: string[] = [rootPanel.id];
    while (queue.length > 0) {
      const parentId = queue.shift()!;
      const parentNode = this.nodes.get(parentId);
      if (!parentNode) continue;

      for (const edge of edgesByParent.get(parentId) ?? []) {
        const childPanel = panelsById.get(edge.child);
        if (!childPanel) continue;

        const a = toLocalPoint(edge.hinge.axisPoint, parentNode.ownAxisPoint, parentNode.ownAxisDir);
        const dirRaw = toLocalDir(edge.hinge.axisDir, parentNode.ownAxisDir);
        const dirLen = Math.hypot(dirRaw.x, dirRaw.y) || 1;
        const dir = { x: dirRaw.x / dirLen, y: dirRaw.y / dirLen };

        const hingeFrame = new THREE.Group();
        hingeFrame.position.set(a.x, a.y, 0);

        hingeFrame.quaternion.setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.atan2(dir.y, dir.x));

        const foldGroup = new THREE.Group();
        hingeFrame.add(foldGroup);

        const ownA = edge.hinge.axisPoint;
        const ownDir = edge.hinge.axisDir;
        const relativePolygon = childPanel.polygon.map((p) => toLocalPoint(p, ownA, ownDir));
        this.addPanelMeshes(foldGroup, relativePolygon, edge.child);

        parentNode.container.add(hingeFrame);
        this.nodes.set(edge.child, {
          ownAxisPoint: ownA,
          ownAxisDir: ownDir,
          container: foldGroup,
          meshes: [...foldGroup.children] as THREE.Mesh[],
          geometry: (foldGroup.children[0] as THREE.Mesh).geometry
        });
        queue.push(edge.child);
      }
    }
  }

  private addPanelMeshes(container: THREE.Group, points: Vec2[], panelId: string): void {
    const geometry = buildGeometry(points);
    const outer = new THREE.Mesh(geometry, this.materials.outer);
    const inner = new THREE.Mesh(geometry, this.materials.inner);
    outer.userData.panelId = panelId;
    inner.userData.panelId = panelId;
    container.add(outer, inner);

    const edgeGeometry = new THREE.EdgesGeometry(geometry);
    const outline = new THREE.LineSegments(edgeGeometry, this.edgeLineMaterial);
    outline.renderOrder = 2;
    this.edgeGeometries.push(edgeGeometry);
    container.add(outline);
  }

  setFoldParameter(t: number, openedPanelId: string | null = null, openProgress = 0): void {
    for (const [childId, edge] of this.edgeByChild) {
      const node = this.nodes.get(childId);
      if (!node) continue;
      const closedAngle = angleAtT(edge, t);
      if (childId === openedPanelId && openProgress > 0) {
        const eased = easeInOutCubic(openProgress);
        node.container.rotation.x = closedAngle + (PANEL_OPEN_ANGLE - closedAngle) * eased;
      } else {
        node.container.rotation.x = closedAngle;
      }
    }
  }

  panelIdForObject(object: THREE.Object3D): string | null {
    const id = object.userData['panelId'];
    return typeof id === 'string' && this.edgeByChild.has(id) ? id : null;
  }

  getPanelWorldMatrix(panelId: string): THREE.Matrix4 | null {
    const node = this.nodes.get(panelId);
    if (!node) return null;
    node.container.updateWorldMatrix(true, false);
    return node.container.matrixWorld;
  }

  getContainer(panelId: string): THREE.Group | null {
    return this.nodes.get(panelId)?.container ?? null;
  }

  dispose(): void {
    const seenGeometries = new Set<THREE.BufferGeometry>();
    for (const node of this.nodes.values()) {
      if (!seenGeometries.has(node.geometry)) {
        node.geometry.dispose();
        seenGeometries.add(node.geometry);
      }
    }
    for (const edgeGeometry of this.edgeGeometries) edgeGeometry.dispose();
    this.edgeGeometries = [];
    this.edgeLineMaterial.dispose();
    disposeMaterials(this.materials);
    this.nodes.clear();
  }
}
