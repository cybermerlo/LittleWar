import assert from 'node:assert/strict';
import * as THREE from 'three';
import { moveOnSphere, sphereOrientation } from '../client/utils/SphereUtils.js';

function angleAfterStep({ theta, phi, heading, delta }) {
  const before = sphereOrientation(THREE, theta, phi, heading);
  const moved = moveOnSphere(theta, phi, heading, delta);
  const after = sphereOrientation(THREE, moved.theta, moved.phi, moved.heading);
  return { moved, angle: before.angleTo(after) };
}

{
  const result = angleAfterStep({
    theta: 0.02,
    phi: 0.7,
    heading: Math.PI,
    delta: 0.03,
  });

  assert.ok(
    result.angle < 0.2,
    `Pole crossing should keep airplane orientation continuous; got jump ${result.angle} rad with phi ${result.moved.phi} and heading ${result.moved.heading}`,
  );
}

{
  const result = angleAfterStep({
    theta: Math.PI - 0.02,
    phi: 1.1,
    heading: 0,
    delta: 0.03,
  });

  assert.ok(
    result.angle < 0.2,
    `South pole crossing should keep airplane orientation continuous; got jump ${result.angle} rad with phi ${result.moved.phi} and heading ${result.moved.heading}`,
  );
}

console.log('sphere pole regression test passed');
