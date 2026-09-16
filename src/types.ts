export type V3 = [number, number, number];
export type Bounds = { min: V3; max: V3 };
export type CameraPose = { position: V3; pitch: number; yaw: number };
export type SceneManifest = {
  format: 'portable-3dgs'; version: 2; id: string; name: string;
  createdAt: string; cover: string; collision: string; collisionFormat?: 'playcanvas-voxel'; bounds: Bounds;
  camera: CameraPose; cameraSource?: 'cover'; streams: { file: string; lodLevels: number; pointCount: number; background: boolean }[];
  resources: { file: string; bytes: number }[]; leafCount: number; pointCount: number; sourceBytes: number;
  conversion: { method: string; chunkSize: number; sh: boolean; scale: number; rotation: V3 };
};
export type ConvertOptions = {
  id: string; name: string; scale: number; rotation: V3;
  cellSize: number; opacity: number; sh: boolean;
  chunkSize: number;
};
export type SceneRecord = {
  manifest: SceneManifest; files: Map<string, Blob>; saved: boolean;
  resourceSizes?: Record<string, number>;
  nativeToken?: string;
  assetUrl?: (path: string) => string;
  sourceCoverUrl?: string;
  loadFile?: (path: string) => Promise<Blob>;
};
export type Progress = { stage: string; fraction: number; detail: string };
export const emptyBounds = (): Bounds => ({ min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] });
export function extendBounds(b: Bounds, p: V3): void {
  for (let a = 0; a < 3; a++) { b.min[a] = Math.min(b.min[a], p[a]); b.max[a] = Math.max(b.max[a], p[a]); }
}
export function spawnPose(): CameraPose {
  return { position: [0, 1.4, 0], yaw: 0, pitch: 0 };
}
