import * as THREE from 'three';

export interface TextSpriteOptions {
  color?: string;
  background?: string;
  fontSize?: number;
  scale?: number;
}

/** A billboarded text label (canvas texture on a THREE.Sprite). Always faces
 * the camera, which is what the axis/hinge/dimension labels need. */
export function createTextSprite(text: string, opts: TextSpriteOptions = {}): THREE.Sprite {
  const fontSize = opts.fontSize ?? 48;
  const color = opts.color ?? '#e8edf7';
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  ctx.font = `600 ${fontSize}px "JetBrains Mono", monospace`;
  const metrics = ctx.measureText(text);
  const padding = fontSize * 0.4;
  canvas.width = Math.ceil(metrics.width + padding * 2);
  canvas.height = Math.ceil(fontSize * 1.6);

  ctx.font = `600 ${fontSize}px "JetBrains Mono", monospace`;
  if (opts.background) {
    ctx.fillStyle = opts.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.fillStyle = color;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(text, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  const scale = opts.scale ?? 6;
  const aspect = canvas.width / canvas.height;
  sprite.scale.set(scale * aspect, scale, 1);
  return sprite;
}

export function updateTextSprite(sprite: THREE.Sprite, text: string, opts: TextSpriteOptions = {}): void {
  const material = sprite.material;
  material.map?.dispose();
  const fresh = createTextSprite(text, opts);
  sprite.material.map = fresh.material.map;
  sprite.scale.copy(fresh.scale);
  material.needsUpdate = true;
}
