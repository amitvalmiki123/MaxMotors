import * as THREE from 'three';
import { createPostProcessing } from './graphics.js';

/**
 * Contact shadow + post-processing owner for the scene.
 *
 * The contact shadow is a soft blob that follows the car and fades out when the
 * wheels leave the ground — cheap on mobile and it stops the car looking like it
 * floats over the low-resolution shadows of a phone GPU.
 */

function createContactShadowTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext('2d');
  const gradient = context.createRadialGradient(64, 64, 4, 64, 64, 62);
  gradient.addColorStop(0, 'rgba(0,0,0,0.55)');
  gradient.addColorStop(0.55, 'rgba(0,0,0,0.28)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createSceneGraphics({ renderer, scene, camera, tier, container }) {
  const postprocessing = createPostProcessing({ renderer, scene, camera, tier });

  const contactShadow = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      map: createContactShadowTexture(),
      transparent: true,
      depthWrite: false,
      opacity: 0.85,
    }),
  );
  contactShadow.rotation.x = -Math.PI / 2;
  contactShadow.renderOrder = 1;
  contactShadow.name = 'contact-shadow';
  scene.add(contactShadow);

  let width = 1;
  let height = 1;

  return {
    postprocessing,
    contactShadow,
    resize(nextWidth, nextHeight) {
      width = Math.max(1, nextWidth);
      height = Math.max(1, nextHeight);
      postprocessing.setSize(width, height);
    },
    /** Places the blob under the car, fading as the chassis lifts off. */
    updateContactShadow(physics, carSize) {
      if (!physics?.chassisBody) return;
      const body = physics.chassisBody;
      const groundY = physics.groundHeight ?? 0;
      const height2 = Math.max(0, body.position.y - groundY);
      const fade = Math.max(0, 1 - Math.max(0, height2 - 0.85) / 0.9);
      contactShadow.visible = fade > 0.02;
      if (!contactShadow.visible) return;
      contactShadow.position.set(body.position.x, groundY + 0.02, body.position.z);
      contactShadow.quaternion.set(0, 0, 0, 1);
      const yaw = Math.atan2(
        2 * (body.quaternion.w * body.quaternion.y + body.quaternion.x * body.quaternion.z),
        1 - 2 * (body.quaternion.y ** 2 + body.quaternion.x ** 2),
      );
      contactShadow.rotation.z = -yaw;
      const length = (carSize?.length ?? 4.5) * 1.05;
      const widthScale = (carSize?.width ?? 1.9) * 1.25;
      contactShadow.scale.set(widthScale, length, 1);
      contactShadow.material.opacity = 0.85 * fade;
    },
    render(deltaTime) {
      postprocessing.render(deltaTime);
    },
    dispose() {
      contactShadow.geometry.dispose();
      contactShadow.material.map?.dispose();
      contactShadow.material.dispose();
      contactShadow.removeFromParent();
      postprocessing.dispose();
    },
    get size() {
      return { width, height };
    },
    setTrack() {
      /* reserved for per-track post tweaks */
    },
  };
}
