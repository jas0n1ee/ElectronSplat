import type { V3 } from './types';

const DEG_TO_RAD = Math.PI / 180;

/**
 * World-space movement delta for a first-person camera.
 *
 * The basis is yaw only: forward = (-sin, 0, -cos), right = (cos, 0, -sin).
 * Pitch is deliberately absent, so looking up or down never changes altitude
 * and `up` stays the only height control. At pitch 0 this is identical to the
 * camera's own forward/right vectors.
 *
 * @param yaw - Camera yaw in degrees (the Euler Y passed to setEulerAngles).
 * @param forward - +1 for W, -1 for S.
 * @param strafe - +1 for D, -1 for A.
 * @param up - +1 for E, -1 for Q.
 * @param distance - Distance to travel this frame.
 * @returns The movement delta in world space.
 */
export function moveDelta(yaw:number,forward:number,strafe:number,up:number,distance:number):V3 {
  const a=yaw*DEG_TO_RAD;
  const sin=Math.sin(a),cos=Math.cos(a);
  let x=-sin*forward+cos*strafe;
  let y=up;
  let z=-cos*forward-sin*strafe;
  // Normalize the combined vector so moving on two axes is no faster than one.
  const lengthSq=x*x+y*y+z*z;
  if(lengthSq>0) {
    const k=distance/Math.sqrt(lengthSq);
    x*=k;y*=k;z*=k;
  }
  return [x,y,z];
}
