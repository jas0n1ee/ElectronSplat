import { Quat, Vec3 } from 'playcanvas';
import { emptyBounds, extendBounds, type V3, type Bounds } from './types';

// Standard PLY display rotation (Z 180°) plus the user's X 90° correction:
// source (x, y, z) -> PlayCanvas (-x, z, y), so source Z+ becomes world Y+.
export const DISPLAY_ROTATION:V3=[90,0,180];
export function displayRotation(stored:V3):Quat {
  return new Quat().setFromEulerAngles(...DISPLAY_ROTATION).mul(new Quat().setFromEulerAngles(...stored).invert()).normalize();
}
export function rotatePoint(rotation:Quat,p:V3):V3 {
  const v=rotation.transformVector(new Vec3(...p));
  return [v.x,v.y,v.z].map(n=>Math.abs(n)<1e-12?0:n) as V3;
}
export function rotateBounds(rotation:Quat,bounds:Bounds):Bounds {
  const result=emptyBounds();
  for(let corner=0;corner<8;corner++)extendBounds(result,rotatePoint(rotation,[bounds[corner&1?'max':'min'][0],bounds[corner&2?'max':'min'][1],bounds[corner&4?'max':'min'][2]]));
  return result;
}
