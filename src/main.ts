/**
 * Bootstrap placeholder (T-0001). Renders a single rotating wireframe cube on
 * a WebGLRenderer and shows a "NAVIGATION — bootstrapping" HUD line. T-0010
 * replaces this file with the real first-person scene and ASCII post-process.
 */
import * as THREE from 'three';

/** DOM element ids read from index.html. */
const VIEW_ID = 'view';
const HUD_ID = 'hud';

/** Mesh rotation increment applied each frame (radians). */
const SPIN_SPEED = 0.01;

/** Initialise the WebGL renderer, scene, camera and cube; then loop. */
function main(): void {
  const view = document.getElementById(VIEW_ID);
  if (!(view instanceof HTMLCanvasElement)) {
    throw new Error(`Expected a <canvas id="${VIEW_ID}">`);
  }

  const renderer = new THREE.WebGLRenderer({ canvas: view, antialias: true });
  renderer.setSize(window.innerWidth, window.innerHeight);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);

  const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
  camera.position.z = 3;

  const geometry = new THREE.BoxGeometry();
  const material = new THREE.MeshBasicMaterial({
    color: 0x48e06a,
    wireframe: true,
  });
  const cube = new THREE.Mesh(geometry, material);
  scene.add(cube);

  // Resize the renderer and keep the camera aspect ratio in sync.
  window.addEventListener('resize', () => {
    const w = window.innerWidth;
    const h = window.innerHeight;
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    renderer.setSize(w, h);
  });

  const hud = document.getElementById(HUD_ID);
  if (hud) hud.textContent = 'NAVIGATION — bootstrapping';

  // Simple animation loop: spin the cube and draw.
  const animate = (): void => {
    requestAnimationFrame(animate);
    cube.rotation.x += SPIN_SPEED;
    cube.rotation.y += SPIN_SPEED;
    renderer.render(scene, camera);
  };
  animate();
}

main();
