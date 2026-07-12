// Screen surfaces: planes of Screen voxels the backend draws markdown or
// SVG onto. The backend owns geometry and content (GET/POST /api/screens);
// this module just renders what it is told and refreshes when the version
// counter changes.

import { rasterizeMarkdown, rasterizeSvg } from '/js/markdown.js';

const PX_PER_BLOCK = 128;

export function createScreenManager({ THREE, scene3, getSceneName }) {
  const screens = new Map(); // id -> {meta, mesh, canvas, texture}

  function buildMesh(meta, texture) {
    const geo = new THREE.PlaneGeometry(meta.w, meta.h);
    const mat = new THREE.MeshBasicMaterial({ map: texture });
    const mesh = new THREE.Mesh(geo, mat);
    const [x0, y0, z0] = meta.origin;
    const off = 0.012; // in front of the voxel wall, avoids z-fighting
    if (meta.facing === '+z') {
      mesh.position.set(x0 + meta.w / 2, y0 + meta.h / 2, z0 + 1 + off);
    } else if (meta.facing === '-z') {
      mesh.position.set(x0 + meta.w / 2, y0 + meta.h / 2, z0 - off);
      mesh.rotation.y = Math.PI;
    } else if (meta.facing === '+x') {
      mesh.position.set(x0 + 1 + off, y0 + meta.h / 2, z0 + meta.w / 2);
      mesh.rotation.y = Math.PI / 2;
    } else { // '-x'
      mesh.position.set(x0 - off, y0 + meta.h / 2, z0 + meta.w / 2);
      mesh.rotation.y = -Math.PI / 2;
    }
    return mesh;
  }

  async function renderContent(entry) {
    const { type, data } = entry.meta.content;
    const ok = type === 'svg'
      ? await rasterizeSvg(data, entry.canvas)
      : await rasterizeMarkdown(data, entry.canvas);
    if (!ok) {
      const ctx = entry.canvas.getContext('2d');
      ctx.fillStyle = '#1a0d0d';
      ctx.fillRect(0, 0, entry.canvas.width, entry.canvas.height);
      ctx.fillStyle = '#ff7f7f';
      ctx.font = `${entry.canvas.width / 16}px sans-serif`;
      ctx.fillText('content failed to render', 20, 60);
    }
    entry.texture.needsUpdate = true;
  }

  function remove(id) {
    const entry = screens.get(id);
    if (!entry) return;
    scene3.remove(entry.mesh);
    entry.mesh.geometry.dispose();
    entry.mesh.material.dispose();
    entry.texture.dispose();
    screens.delete(id);
  }

  async function load() {
    const sceneName = getSceneName();
    let payload;
    try {
      const res = await fetch(`/api/screens?scene=${sceneName}`);
      if (!res.ok) return;
      payload = await res.json();
    } catch { return; }
    if (getSceneName() !== sceneName) return; // scene switched mid-fetch

    const seen = new Set();
    for (const meta of payload.screens) {
      seen.add(meta.id);
      let entry = screens.get(meta.id);
      const geomChanged = entry && (
        entry.meta.w !== meta.w || entry.meta.h !== meta.h ||
        entry.meta.facing !== meta.facing ||
        entry.meta.origin.join() !== meta.origin.join());
      if (entry && geomChanged) { remove(meta.id); entry = null; }
      if (!entry) {
        const canvas = document.createElement('canvas');
        canvas.width = meta.w * PX_PER_BLOCK;
        canvas.height = meta.h * PX_PER_BLOCK;
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        entry = { meta, canvas, texture, mesh: buildMesh(meta, texture) };
        scene3.add(entry.mesh);
        screens.set(meta.id, entry);
        await renderContent(entry);
      } else if (entry.meta.version !== meta.version) {
        entry.meta = meta;
        await renderContent(entry);
      }
    }
    for (const id of [...screens.keys()]) {
      if (!seen.has(id)) remove(id);
    }
  }

  // Called with {id: version} from the /api/updates poll.
  function applyVersions(versions) {
    let stale = false;
    for (const [id, v] of Object.entries(versions)) {
      const entry = screens.get(id);
      if (!entry || entry.meta.version !== v) stale = true;
    }
    for (const id of screens.keys()) {
      if (!(id in versions)) stale = true;
    }
    if (stale) load();
  }

  function clear() {
    for (const id of [...screens.keys()]) remove(id);
  }

  return { load, applyVersions, clear, screens };
}
