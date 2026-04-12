import * as THREE from 'three';
import { sphericalToCartesian, sphereOrientation } from '../utils/SphereUtils.js';
import { FLY_ALTITUDE, WEAPON_CONFIGS } from '../../shared/constants.js';

function buildAirplaneMesh(color) {
  const group = new THREE.Group();
  const mat = (c) => new THREE.MeshLambertMaterial({ color: c, flatShading: true });

  const bodyColor = new THREE.Color(color);
  const darkColor = bodyColor.clone().multiplyScalar(0.65);
  const lightColor = bodyColor.clone().lerp(new THREE.Color(0xffffff), 0.35);

  // Fusoliera
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.28, 0.28), mat(bodyColor));
  body.position.set(0, 0, 0);

  // Muso (cono)
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.5, 5), mat(lightColor));
  nose.rotation.z = -Math.PI / 2;
  nose.position.set(0.95, 0, 0);

  // Ali principali
  const wings = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.06, 2.2), mat(darkColor));
  wings.position.set(-0.1, 0, 0);

  // Coda verticale
  const tailV = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.38, 0.22), mat(darkColor));
  tailV.position.set(-0.6, 0.2, 0);

  // Coda orizzontale
  const tailH = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.05, 0.8), mat(darkColor));
  tailH.position.set(-0.6, 0.05, 0);

  // Elica (cosmetica)
  const propeller = new THREE.Group();
  const blade1 = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.55, 0.07), mat(0x333333));
  const blade2 = blade1.clone();
  blade2.rotation.z = Math.PI / 2;
  propeller.add(blade1, blade2);
  propeller.position.set(1.22, 0, 0);

  group.add(body, nose, wings, tailV, tailH, propeller);

  // Scudo (alone azzurro, nascosto di default)
  const shieldGeo = new THREE.SphereGeometry(1.6, 10, 10);
  const shieldMat = new THREE.MeshBasicMaterial({
    color: 0x44aaff,
    transparent: true,
    opacity: 0.25,
    side: THREE.FrontSide,
    depthWrite: false,
  });
  const shieldMesh = new THREE.Mesh(shieldGeo, shieldMat);
  shieldMesh.visible = false;
  shieldMesh.name = 'shield';
  group.add(shieldMesh);

  // Nickname label (semplice sprite testuale via canvas)
  group.userData.propeller = propeller;
  group.userData.shield = shieldMesh;

  return group;
}

export class Airplane {
  constructor(scene, THREE_ref, color = '#ff4444', isLocal = false) {
    this.THREE = THREE_ref;
    this.mesh = buildAirplaneMesh(color);
    this.mesh.userData.isAirplane = true;
    scene.add(this.mesh);
    this.isLocal = isLocal;

    // Stato sférico
    this.theta = Math.PI / 2;
    this.phi = 0;
    this.heading = 0;
  }

  update(theta, phi, heading, weaponLevel, hasShield) {
    this.theta = theta;
    this.phi = phi;
    this.heading = heading;

    const pos = sphericalToCartesian(theta, phi, FLY_ALTITUDE);
    this.mesh.position.set(pos.x, pos.y, pos.z);

    const q = sphereOrientation(this.THREE, theta, phi, heading);
    this.mesh.quaternion.copy(q);

    // Elica
    if (this.mesh.userData.propeller) {
      this.mesh.userData.propeller.rotation.x += 0.3;
    }

    // Scudo
    if (this.mesh.userData.shield) {
      this.mesh.userData.shield.visible = hasShield;
    }
  }

  dispose(scene) {
    scene.remove(this.mesh);
  }
}
