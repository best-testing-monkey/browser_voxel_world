// Fluids on the main thread: owns the two fluid workers and draws the
// fluid surfaces. The rules (which materials are faucets, what lava+water
// makes, what burns, what cools) come from the backend's /api/config
// "fluids" section; the workers execute them.
//
//   fluidsim.worker.js   simulation: 5 cm cells with fill levels 1..8,
//                        mass-conserving flow, settling, cross effects
//   fluidmesh.worker.js  marching-cubes surface per 1 m block per type
//
// The two talk directly over a MessageChannel (the simulation streams the
// changed blocks every tick), so fluids use at most two cores and never
// block rendering. This module only swaps finished geometry in and feeds
// the shaders (time, sun, sky colour, day factor) every frame.
//
// Fluid cells are ephemeral (not persisted); their *effects* are real world
// edits: obsidian from lava+water, burned wood, cooled magma.

const NOISE_GLSL = `
float fl_hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
float fl_noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(fl_hash(i), fl_hash(i + vec2(1.0, 0.0)), u.x),
             mix(fl_hash(i + vec2(0.0, 1.0)), fl_hash(i + vec2(1.0, 1.0)), u.x),
             u.y);
}
float fl_fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * fl_noise(p);
    p = p * 2.03 + vec2(1.7, 9.2);
    a *= 0.5;
  }
  return s;
}
vec2 fl_grad(vec2 p) {
  const float e = 0.06;
  return vec2(fl_fbm(p + vec2(e, 0.0)) - fl_fbm(p - vec2(e, 0.0)),
              fl_fbm(p + vec2(0.0, e)) - fl_fbm(p - vec2(0.0, e))) / (2.0 * e);
}
// Surface parameterisation: horizontal-ish faces use world xz; steep faces
// (waterfalls, pool walls) use (x + z, y).
vec2 fl_coords(vec3 wp, vec3 n) {
  return abs(n.y) > 0.5 ? wp.xz : vec2(wp.x + wp.z, wp.y);
}
// Flow direction in those coordinates: horizontal flow on top faces,
// streaming downward on steep faces.
vec2 fl_dir(vec3 n, vec3 flow) {
  return abs(n.y) > 0.5 ? flow.xy : vec2(0.0, -(0.6 + flow.z));
}
// Two-phase flow-map blend: two noise layers scroll along the flow and
// reset half a cycle apart, cross-faded so the reset is never visible.
vec2 fl_flowGrad(vec2 uv, vec2 dir, float time, float cycle, float dist) {
  float ph0 = fract(time / cycle);
  float ph1 = fract(time / cycle + 0.5);
  float w0 = 1.0 - abs(1.0 - 2.0 * ph0);
  vec2 g0 = fl_grad(uv - dir * ph0 * dist);
  vec2 g1 = fl_grad(uv - dir * ph1 * dist + vec2(0.37, 0.71));
  return g0 * w0 + g1 * (1.0 - w0);
}
float fl_flowNoise(vec2 uv, vec2 dir, float time, float cycle, float dist) {
  float ph0 = fract(time / cycle);
  float ph1 = fract(time / cycle + 0.5);
  float w0 = 1.0 - abs(1.0 - 2.0 * ph0);
  return fl_fbm(uv - dir * ph0 * dist) * w0 +
         fl_fbm(uv - dir * ph1 * dist + vec2(0.37, 0.71)) * (1.0 - w0);
}
`;

const VERTEX = `
attribute float aDepth;
attribute vec3 aFlow;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vDepth;
varying vec3 vFlow;
#include <fog_pars_vertex>
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldPos = wp.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
  vDepth = aDepth;
  vFlow = aFlow;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const COMMON_FRAG = `
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSky;
uniform float uDay;
varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vDepth;
varying vec3 vFlow;
#include <fog_pars_fragment>
${NOISE_GLSL}
`;

const WATER_FRAG = `${COMMON_FRAG}
void main() {
  vec3 N = normalize(vNormal);
  if (!gl_FrontFacing) N = -N;           // seen from under the surface
  vec3 V = normalize(cameraPosition - vWorldPos);
  vec2 uv = fl_coords(vWorldPos, N) * 3.0;
  vec2 dir = fl_dir(N, vFlow);
  float speed = length(dir);

  // Wavy normals: still water ripples gently, flowing water more.
  vec2 drift = vec2(uTime * 0.05, uTime * 0.037);
  vec2 g = fl_flowGrad(uv + drift, dir, uTime, 2.0, 1.2);
  float amp = 0.10 + 0.20 * min(speed, 1.5);
  vec3 T = abs(N.y) > 0.5 ? vec3(1.0, 0.0, 0.0)
                          : normalize(cross(vec3(0.0, 1.0, 0.0), N));
  vec3 B = abs(N.y) > 0.5 ? vec3(0.0, 0.0, 1.0) : vec3(0.0, 1.0, 0.0);
  N = normalize(N - (T * g.x + B * g.y) * amp);

  // Fresnel (Schlick, water F0 ~ 0.02).
  float cosT = clamp(dot(N, V), 0.0, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);

  // Reflection of the sky: horizon colour to a deeper zenith, plus a sun
  // glint.
  vec3 R = reflect(-V, N);
  vec3 zenith = uSky * 0.65 + vec3(0.02, 0.05, 0.12) * uDay;
  vec3 sky = mix(uSky, zenith, clamp(R.y, 0.0, 1.0));
  float sun = pow(max(dot(R, normalize(uSunDir)), 0.0), 220.0) * 4.0 * uDay;

  // Depth colouring: shallow water is clear turquoise, deep water dark blue.
  float k = 1.0 - exp(-vDepth * 1.8);
  vec3 body = mix(vec3(0.20, 0.58, 0.64), vec3(0.02, 0.10, 0.24), k);
  float diffuse = 0.55 + 0.45 * max(dot(N, normalize(uSunDir)), 0.0);
  body *= 0.10 + 0.90 * uDay * diffuse;

  // Foam where it falls or runs fast.
  float churn = clamp(vFlow.z + 0.35 * length(vFlow.xy) - 0.15, 0.0, 1.0);
  float foam = smoothstep(0.55, 0.85, fl_flowNoise(uv * 1.7, dir, uTime, 1.5, 1.5))
               * churn;

  vec3 col = mix(body, sky * (0.25 + 0.75 * uDay), F) + vec3(sun);
  col = mix(col, vec3(0.92, 0.96, 1.0) * (0.25 + 0.75 * uDay), foam);
  float alpha = clamp(mix(0.42, 0.9, k) + F * 0.5 + foam, 0.0, 1.0);
  gl_FragColor = vec4(col, alpha);
  #include <fog_fragment>
}
`;

const LAVA_FRAG = `${COMMON_FRAG}
void main() {
  vec3 N = normalize(vNormal);
  vec2 uv = fl_coords(vWorldPos, N) * 1.4;
  vec2 dir = fl_dir(N, vFlow);
  // Slow, glowing flow: a molten field with a crust that cracks open.
  float n = fl_flowNoise(uv, dir, uTime, 7.0, 0.6);
  float cracks = fl_flowNoise(uv * 3.1 + n * 1.5, dir, uTime, 5.0, 0.9);
  float heat = smoothstep(0.30, 0.72, n + 0.12 * sin(uTime * 0.7 + n * 7.0));
  vec3 crust = vec3(0.13, 0.035, 0.02);
  vec3 hot = vec3(1.0, 0.30, 0.04);
  vec3 white = vec3(1.0, 0.86, 0.38);
  vec3 col = mix(crust, hot, heat);
  col = mix(col, white, smoothstep(0.62, 0.9, heat * (0.6 + cracks)));
  col *= 0.85 + 0.15 * N.y;
  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
}
`;

const SAND_FRAG = `${COMMON_FRAG}
uniform vec3 uColor;
void main() {
  vec3 N = normalize(vNormal);
  vec3 p = vWorldPos * 40.0;
  float grain = fl_noise(vec2(p.x + p.y * 0.61, p.z - p.y * 0.37)) * 0.6 +
                fl_hash(floor(vec2(p.x * 2.1 + p.y, p.z * 2.1 - p.y))) * 0.4;
  vec3 col = uColor * (0.82 + 0.3 * grain);
  float diffuse = max(dot(N, normalize(uSunDir)), 0.0);
  col *= 0.18 + 0.22 * uDay + 0.65 * uDay * diffuse;
  gl_FragColor = vec4(col, 1.0);
  #include <fog_fragment>
}
`;

export function createFluidSim({ THREE, scene3, config, dims, materials,
                                 toast, getEpoch, applyEffect }) {
  const sim = new Worker('/js/fluidsim.worker.js', { type: 'module' });
  const surf = new Worker('/js/fluidmesh.worker.js', { type: 'module' });
  const channel = new MessageChannel();
  sim.postMessage({ type: 'init', dims, materials, config });
  sim.postMessage({ type: 'port', port: channel.port1 }, [channel.port1]);
  surf.postMessage({ type: 'init', cellMm: config.cellMm || 50,
                     port: channel.port2 }, [channel.port2]);

  const counts = { sand: 0, water: 0, lava: 0 };         // active cells
  const settledCounts = { sand: 0, water: 0, lava: 0 };  // settled cells
  const perf = { tickMs: 0 };                             // last sim tick

  // ---- materials ----
  const uniforms = {
    uTime: { value: 0 },
    uSunDir: { value: new THREE.Vector3(0.45, 1, 0.3) },
    uSky: { value: new THREE.Color(0x87b5e0) },
    uDay: { value: 1 },
  };
  const make = (frag, extra = {}, opts = {}) => new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, extra]),
    vertexShader: VERTEX,
    fragmentShader: frag,
    fog: true,
    ...opts,
  });
  const colors = config.colors || {};
  const mats = {
    water: make(WATER_FRAG, {}, {
      transparent: true, depthWrite: false, side: THREE.DoubleSide }),
    lava: make(LAVA_FRAG),
    sand: make(SAND_FRAG, { uColor: { value: new THREE.Color(colors.sand || '#d7cd9d') } }),
  };
  // Share the per-frame uniforms (merge() cloned them).
  for (const m of Object.values(mats)) Object.assign(m.uniforms, uniforms);

  // ---- surface meshes: "bx,by,bz" -> {water?, lava?, sand?} ----
  const blocks = new Map();

  function disposeBlock(entry) {
    for (const mesh of Object.values(entry)) {
      scene3.remove(mesh);
      mesh.geometry.dispose();
    }
  }

  surf.onmessage = (e) => {
    const msg = e.data;
    if (msg.type !== 'surface' || msg.epoch !== getEpoch()) return;
    const key = `${msg.bx},${msg.by},${msg.bz}`;
    const old = blocks.get(key);
    if (old) disposeBlock(old);
    const entry = {};
    for (const [type, g] of Object.entries(msg.meshes)) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(g.positions, 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(g.normals, 3));
      geo.setAttribute('aDepth', new THREE.BufferAttribute(g.depth, 1));
      geo.setAttribute('aFlow', new THREE.BufferAttribute(g.flow, 3));
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, mats[type]);
      mesh.position.set(msg.bx, msg.by, msg.bz);
      mesh.renderOrder = type === 'water' ? 2 : 0;
      scene3.add(mesh);
      entry[type] = mesh;
    }
    if (Object.keys(entry).length) blocks.set(key, entry);
    else blocks.delete(key);
  };
  surf.onerror = (e) => console.error('fluid surface worker error', e.message || e);

  sim.onmessage = (e) => {
    const msg = e.data;
    if (msg.type === 'toast') toast(msg.text);
    if (msg.epoch !== getEpoch()) return;
    if (msg.type === 'effects') {
      for (const effect of msg.list) applyEffect(effect);
    } else if (msg.type === 'stats') {
      Object.assign(counts, msg.counts);
      Object.assign(settledCounts, msg.settledCounts);
      perf.tickMs = msg.tickMs;
    }
  };
  sim.onerror = (e) => console.error('fluid simulation worker error', e.message || e);

  let time = 0;
  function frame(dt, camera, sunDir, skyColor, day) {
    time += dt;
    uniforms.uTime.value = time;
    uniforms.uSunDir.value.copy(sunDir);
    uniforms.uSky.value.copy(skyColor);
    uniforms.uDay.value = day;
    if (scene3.fog) {
      for (const m of Object.values(mats)) {
        m.uniforms.fogColor.value.copy(scene3.fog.color);
        m.uniforms.fogNear.value = scene3.fog.near;
        m.uniforms.fogFar.value = scene3.fog.far;
      }
    }
  }

  // Scene switch: the simulation worker is cleared through the regular
  // world-worker 'clear' message; drop our meshes and stale surfaces.
  function clear() {
    for (const entry of blocks.values()) disposeBlock(entry);
    blocks.clear();
    surf.postMessage({ type: 'clear', epoch: getEpoch() });
    for (const k of Object.keys(counts)) {
      counts[k] = 0;
      settledCounts[k] = 0;
    }
  }

  // Fill a box given in metres (world coordinates) with fluid, e.g.
  // __voxel.getFluids().fill('water', [x0, y0, z0], [x1, y1, z1]).
  function fill(fluid, min, max) {
    const c = (v) => Math.round(v * 1000 / (config.cellMm || 50));
    sim.postMessage({ type: 'fill', fluid,
                      box: [c(min[0]), c(min[1]), c(min[2]),
                            c(max[0]), c(max[1]), c(max[2])] });
  }

  return { worker: sim, surfaceWorker: surf, frame, clear, fill, counts,
           settledCounts, perf, blocks, materials: mats,
           budgetPerType: config.maxCellsPerType || 4000 };
}
