import {
  BULLET_SPEED,
  BULLET_LIFETIME,
  BULLET_HIT_RADIUS,
  FLY_ALTITUDE,
  TICK_INTERVAL,
} from '../shared/constants.js';

const TICK_DT = TICK_INTERVAL / 1000; // secondi per tick

let nextProjectileId = 1;

function sphericalToUnit(theta, phi) {
  const sinTheta = Math.sin(theta);
  return {
    x: sinTheta * Math.cos(phi),
    y: Math.cos(theta),
    z: sinTheta * Math.sin(phi),
  };
}

function cross(a, b) {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  };
}

function dot(a, b) {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

function normalize(v) {
  const len = Math.hypot(v.x, v.y, v.z);
  if (len < 1e-9) return null;
  return { x: v.x / len, y: v.y / len, z: v.z / len };
}

function rotateAroundAxis(v, axis, angle) {
  const cosA = Math.cos(angle);
  const sinA = Math.sin(angle);
  const kCrossV = cross(axis, v);
  const kDotV = dot(axis, v);
  return {
    x: v.x * cosA + kCrossV.x * sinA + axis.x * kDotV * (1 - cosA),
    y: v.y * cosA + kCrossV.y * sinA + axis.y * kDotV * (1 - cosA),
    z: v.z * cosA + kCrossV.z * sinA + axis.z * kDotV * (1 - cosA),
  };
}

export class Projectile {
  constructor(ownerId, theta, phi, heading, speed = BULLET_SPEED, lifetime = BULLET_LIFETIME) {
    this.id = String(nextProjectileId++);
    this.ownerId = ownerId;
    this.theta = theta;
    this.phi = phi;
    this.heading = heading;
    this.speed = speed;
    this.lifetime = lifetime;
    this.createdAt = Date.now();
    this._unitPos = sphericalToUnit(theta, phi);
    this._axis = this._buildTrajectoryAxis(theta, phi, heading);
  }

  _buildTrajectoryAxis(theta, phi, heading) {
    const unitPos = this._unitPos;
    const east = normalize({
      x: -Math.sin(phi),
      y: 0,
      z: Math.cos(phi),
    });
    if (!east) return { x: 0, y: 1, z: 0 };

    const north = normalize(cross(unitPos, east));
    if (!north) return { x: 0, y: 1, z: 0 };

    const tangent = normalize({
      x: Math.cos(heading) * north.x + Math.sin(heading) * east.x,
      y: Math.cos(heading) * north.y + Math.sin(heading) * east.y,
      z: Math.cos(heading) * north.z + Math.sin(heading) * east.z,
    });
    if (!tangent) return { x: 0, y: 1, z: 0 };

    const axis = normalize(cross(unitPos, tangent));
    if (axis) return axis;
    // Fallback numerico vicino a casi degeneri.
    return { x: 0, y: 1, z: 0 };
  }

  update() {
    const angularStep = this.speed * TICK_DT;
    this._unitPos = normalize(rotateAroundAxis(this._unitPos, this._axis, angularStep)) ?? this._unitPos;

    this.theta = Math.acos(Math.max(-1, Math.min(1, this._unitPos.y)));
    this.phi = Math.atan2(this._unitPos.z, this._unitPos.x);
  }

  isExpired() {
    return Date.now() - this.createdAt > this.lifetime;
  }

  // Distanza cartesiana da un giocatore (theta2, phi2)
  distanceTo(theta2, phi2) {
    const r = FLY_ALTITUDE;
    const x1 = r * Math.sin(this.theta) * Math.cos(this.phi);
    const y1 = r * Math.cos(this.theta);
    const z1 = r * Math.sin(this.theta) * Math.sin(this.phi);
    const x2 = r * Math.sin(theta2) * Math.cos(phi2);
    const y2 = r * Math.cos(theta2);
    const z2 = r * Math.sin(theta2) * Math.sin(phi2);
    return Math.sqrt((x1 - x2) ** 2 + (y1 - y2) ** 2 + (z1 - z2) ** 2);
  }

  toState() {
    return {
      id: this.id,
      ownerId: this.ownerId,
      theta: this.theta,
      phi: this.phi,
    };
  }
}
