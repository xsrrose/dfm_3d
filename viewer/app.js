// Standalone browser viewer for the extracted HM radar 3D maps.
//
// Loads the .glb files produced by lib/hsp2glb.mjs, renders them with three.js
// and offers the same view affordances the original in-game radar has
// (orbit / fly / top camera, per-object toggles, bounds fitting), plus
// inspection tools the original does not expose.
import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';
import { MeshoptDecoder } from './vendor/meshopt_decoder.js';
import { RoomEnvironment } from './vendor/RoomEnvironment.js';

const $ = id => document.getElementById(id);
const state = {
  maps: [], map: null, variant: 'full', cameraMode: 'orbit',
  wireframe: false, sky: 'gradient', modelInfo: null,
  localModels: false,
  // 'smooth' keeps mipmaps and relies on max anisotropy for sharpness, which
  // is what actually removes the grazing-angle blur without reintroducing
  // aliasing. 'source' mirrors the shader's LOD 0 but will alias.
  texMode: 'smooth', texQuality: null,
};
const clock = new THREE.Clock();

// ------------------------------------------------------------------ render
const stage = $('stage');
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
stage.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0a0d10);
scene.fog = new THREE.Fog(0x0a0d10, 4000, 20000);

const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.5, 60000);
camera.position.set(900, 700, 900);

const orbit = new OrbitControls(camera, renderer.domElement);
orbit.enableDamping = true;
orbit.dampingFactor = 0.08;
orbit.screenSpacePanning = false;
orbit.maxPolarAngle = Math.PI * 0.495;
orbit.zoomSpeed = 1.4;

// ------------------------------------------------------------------ lights
// The source renderer lights the map with a scene environment (IBL) plus a
// sun. A single directional light leaves PBR materials almost black, so we
// build a PMREM environment and keep a hemisphere + sun on top of it.
const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader?.();
const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
scene.environment = envRT.texture;
scene.environmentIntensity = 1.0;

const hemi = new THREE.HemisphereLight(0xcfe3f2, 0x4a4a46, 0.40);
const ambient = new THREE.AmbientLight(0xffffff, 0.10);
const sun = new THREE.DirectionalLight(0xfff4e2, 1.70);
sun.position.set(1200, 1800, 800);
const fill = new THREE.DirectionalLight(0x9db8ff, 0.30);
fill.position.set(-1000, 600, -900);
const lights = new THREE.Group().add(hemi, ambient, sun, fill);
scene.add(lights);

const BASE_INTENSITY = { hemi: hemi.intensity, ambient: ambient.intensity, sun: sun.intensity, fill: fill.intensity };

// ----------------------------------------------------------------- helpers
const helpers = new THREE.Group();
scene.add(helpers);

let grid = null, axes = null, boundsBox = null;
function rebuildGrid(radius) {
  if (grid) { helpers.remove(grid); grid.geometry.dispose(); grid.material.dispose(); }
  const size = Math.max(200, Math.pow(10, Math.ceil(Math.log10(radius * 2.2))));
  grid = new THREE.GridHelper(size, 40, 0x2c4652, 0x18262e);
  grid.position.y = 0;
  grid.visible = $('chk-grid').checked;
  helpers.add(grid);
}
function rebuildAxes(radius) {
  if (axes) helper_remove(axes);
  axes = new THREE.AxesHelper(Math.max(200, radius * 0.5));
  axes.visible = $('chk-axes').checked;
  helpers.add(axes);
}
function helper_remove(o) { helpers.remove(o); o.geometry?.dispose?.(); o.material?.dispose?.(); }
function rebuildBounds(box) {
  if (boundsBox) helper_remove(boundsBox);
  if (!box) return;
  boundsBox = new THREE.Box3Helper(box, 0x4ee0c8);
  boundsBox.visible = $('chk-bounds').checked;
  helpers.add(boundsBox);
}

/** Reproduce the source shader's texture sampling policy.
 *
 * The site never lets the GPU pick a mip freely: its fragment shader uses
 *   - non-atlas families: lod = 0.0   -> full resolution, never blurred
 *   - atlas families:     an analytic LOD from the *unwrapped* UV derivative
 * A glTF viewer instead derives LOD from the baked UVs. Without anisotropic
 * filtering the GPU takes an isotropic LOD from the largest derivative, which
 * over-blurs grazing ground; enabling max anisotropy is the correct fix and
 * keeps mipmaps (so high-frequency detail does not alias into speckle).
 *
 * Modes:
 *   smooth (default) - mipmaps + trilinear + max anisotropy
 *   source           - mirror the shader: no mipmaps for non-atlas families
 *                      (sharpest, but high-frequency maps will alias)
 *   sharp            - no mipmaps anywhere
 */
const TEX_KEYS = ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap'];
// Procedural maps we generated ourselves are high frequency and must stay mipmapped.
const ALWAYS_MIPMAPPED = /water-ripple/i;

function applyTextureQuality(root, mode = state.texMode) {
  const maxAniso = Math.min(16, renderer.capabilities.getMaxAnisotropy?.() || 1);
  const seen = new Set();
  let atlasMaterials = 0, plainMaterials = 0, mipmapped = 0, sharp = 0;

  root.traverse(o => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      const isAtlas = m.userData?.atlas === true || /ATLAS/i.test(m.name || '');
      if (isAtlas) atlasMaterials++; else plainMaterials++;
      for (const key of TEX_KEYS) {
        const t = m[key];
        if (!t || seen.has(t.uuid)) continue;
        seen.add(t.uuid);
        const force = ALWAYS_MIPMAPPED.test(t.name || '');
        const useMips = force ? true : mode === 'smooth' ? true : mode === 'sharp' ? false : isAtlas;
        t.anisotropy = maxAniso;
        t.generateMipmaps = useMips;
        t.minFilter = useMips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.needsUpdate = true;
        if (useMips) mipmapped++; else sharp++;
      }
    }
  });
  return { textures: seen.size, anisotropy: maxAniso, mode, atlasMaterials, plainMaterials, mipmapped, sharp };
}

// ------------------------------------------------------------------ model
let model = null;
let modelRoot = new THREE.Group();
scene.add(modelRoot);

function disposeModel() {
  if (!model) return;
  modelRoot.clear();
  model.traverse(o => {
    if (o.isMesh) {
      o.geometry?.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'emissiveMap']) {
          m[key]?.dispose?.();
        }
        m.dispose?.();
      }
    }
  });
  model = null;
}

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);

// Model resolution order:
//   1. `urlFull` / `urlOverview` from maps.json (e.g. GitHub Release assets)
//   2. a local ./models/<name>.glb next to the viewer (fully offline)
//   3. the ../out/<name>/<name>.glb layout of the extraction workspace
function glbUrl(map, variant) {
  const name = variant === 'overview' ? `${map.slug}-overview` : `${map.slug}-full`;
  const remote = variant === 'overview' ? map.urlOverview : map.urlFull;
  if (remote) return remote;
  // `localModels` is a top-level flag in maps.json.
  if (state.localModels) return `./models/${name}.glb`;
  return `../out/${name}/${name}.glb`;
}

function progress(pct, text) {
  $('loading-bar').style.width = `${Math.round(pct * 100)}%`;
  if (text) $('loading-detail').textContent = text;
}

async function loadMap(slug, variant) {
  const map = state.maps.find(m => m.slug === slug);
  if (!map) return toast(`未找到地图 ${slug}`, true);
  const url = glbUrl(map, variant);
  const available = variant === 'overview' ? map.hasOverview : map.hasFull;
  if (!available) return toast(`${map.label} 未导出${variant === 'overview' ? '概览' : '全图'}模型`, true);

  state.map = map; state.variant = variant;
  disposeModel();
  $('loading').classList.remove('done');
  $('loading-retry').hidden = true;
  $('loading-title').textContent = `正在加载 ${map.label}`;
  progress(0, `下载 ${url}`);

  try {
    const gltf = await new Promise((resolve, reject) => {
      loader.load(url, resolve, e => {
        if (e.lengthComputable) progress(e.loaded / e.total, `下载中 ${(e.loaded / 1048576).toFixed(1)} / ${(e.total / 1048576).toFixed(1)} MB`);
        else progress(0.15, `下载中 ${(e.loaded / 1048576).toFixed(1)} MB`);
      }, reject);
    });
    progress(0.9, '解析模型…');
    model = gltf.scene;
    modelRoot.add(model);
    await new Promise(r => requestAnimationFrame(r));
    finishLoad(map, variant, gltf, url);
  } catch (error) {
    console.error(error);
    $('loading').classList.remove('done');
    $('loading-title').textContent = '加载失败';
    const msg = String(error?.message || error);
    $('loading-detail').textContent = /404|Failed to fetch|ERR_/.test(msg)
      ? `模型文件不存在。请先在仓库根目录运行：node tools/fetch-models.mjs（${url}）`
      : msg;
    $('loading-retry').hidden = false;
    toast('模型加载失败', true);
  }
}

function boxOf(object) { return new THREE.Box3().setFromObject(object); }

function finishLoad(map, variant, gltf, url) {
  const box = boxOf(model);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const radius = size.length() / 2;

  // The map-wide water plane stretches ~23 km while the actual level is ~1.4 km.
  // Framing on the raw bounds parks the camera so far out that the level becomes
  // a speck on an empty slab — which reads as "too dark" and "low detail". Frame
  // on the manifest's content bounds instead.
  const content = (map.bounds?.min && map.bounds?.max)
    ? new THREE.Box3(new THREE.Vector3().fromArray(map.bounds.min), new THREE.Vector3().fromArray(map.bounds.max))
    : box;
  const contentSize = content.getSize(new THREE.Vector3());
  const contentCenter = content.getCenter(new THREE.Vector3());
  const contentRadius = Math.max(10, contentSize.length() / 2);

  const meshes = [];
  const materials = new Set();
  const texSet = new Set();
  let triangles = 0, vertices = 0, bytes = 0;
  model.traverse(o => {
    if (!o.isMesh) return;
    const g = o.geometry;
    const count = g.index ? g.index.count : g.attributes.position.count;
    triangles += count / 3;
    vertices += g.attributes.position.count;
    for (const attr of Object.values(g.attributes)) bytes += attr.array.byteLength;
    if (g.index) bytes += g.index.array.byteLength;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of mats) {
      if (!m) continue;
      materials.add(m.uuid);
      for (const key of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'aoMap']) {
        const t = m[key];
        if (t) texSet.add(t.uuid);
      }
    }
    meshes.push(o);
  });

  state.modelInfo = {
    box, size, center, radius,
    contentBox: content, contentSize, contentCenter, contentRadius,
    meshes, triangles, vertices, bytes, textures: texSet.size, materials: materials.size,
  };

  rebuildGrid(contentRadius);
  rebuildAxes(contentRadius);
  rebuildBounds(box);
  applySky(state.sky);
  state.texQuality = applyTextureQuality(model, state.texMode);
  buildObjectList(meshes);
  buildMeta(map, variant, url, { box, size, center, radius, triangles, vertices, bytes, materials: materials.size, textures: texSet.size, contentRadius, contentSize });

  camera.near = Math.max(0.2, contentRadius / 4000);
  camera.far = Math.max(radius * 40, contentRadius * 400);
  fitBounds();
  camera.updateProjectionMatrix();

  // URL controls used by the automated visual checks:
  //   ?hide=water     hide meshes whose material name contains the text
  //   ?frame=x,y,z,d  frame the camera on a point at distance d
  const q = new URLSearchParams(location.search);
  const hide = q.get('hide');
  if (hide) {
    const needle = hide.toLowerCase();
    for (const mesh of meshes) {
      const names = (Array.isArray(mesh.material) ? mesh.material : [mesh.material])
        .map(m => m?.name || '').join(' ').toLowerCase();
      if (names.includes(needle)) mesh.visible = false;
    }
    document.querySelectorAll('#obj-list label').forEach((label, i) => {
      const cb = label.querySelector('input');
      if (cb && meshes[i]) cb.checked = meshes[i].visible;
    });
  }
  const frame = q.get('frame');
  if (frame) {
    const [fx, fy, fz, fd] = frame.split(',').map(Number);
    if ([fx, fy, fz, fd].every(Number.isFinite)) {
      orbit.target.set(fx, fy, fz);
      camera.position.set(fx + fd * 0.62, fy + fd * 0.5, fz + fd * 0.62);
      camera.near = Math.max(0.1, fd / 500);
      camera.far = Math.max(2000, fd * 20);
      camera.updateProjectionMatrix();
      orbit.update();
    }
  }

  $('map-title').textContent = map.label;
  $('map-sub').textContent = `${map.slug} · ${variant === 'overview' ? '概览模型' : '全图模型'} · ${map.regionCount} 区域`;
  document.title = `${map.label} 3D 模型`;

  progress(1, '完成');
  setTimeout(() => $('loading').classList.add('done'), 120);
  history.replaceState(null, '', `?map=${map.slug}&variant=${variant}`);
}

function buildObjectList(meshes) {
  const list = $('obj-list');
  list.replaceChildren();
  $('obj-count').textContent = `(${meshes.length})`;
  meshes.forEach((mesh, i) => {
    const label = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = true;
    cb.addEventListener('change', () => { mesh.visible = cb.checked; });
    const span = document.createElement('span');
    span.textContent = mesh.name || `对象 ${i}`;
    label.append(cb, span);
    list.append(label);
  });
}

function buildMeta(map, variant, url, s) {
  const rows = [
    ['地图', map.label], ['slug', map.slug], ['区域数', map.regionCount],
    ['三角面', Math.round(s.triangles).toLocaleString()],
    ['顶点', s.vertices.toLocaleString()],
    ['材质', s.materials], ['贴图', s.textures],
    ['几何', `${(s.bytes / 1048576).toFixed(1)} MB`],
    ['尺寸', `${s.size.x.toFixed(0)} × ${s.size.y.toFixed(0)} × ${s.size.z.toFixed(0)} m`],
    ['中心', `${s.center.x.toFixed(0)}, ${s.center.y.toFixed(0)}, ${s.center.z.toFixed(0)}`],
    ['文件', url.split('/').pop()],
  ];
  const dl = $('meta');
  dl.replaceChildren();
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd'); dd.textContent = v;
    dl.append(dt, dd);
  }
}

// -------------------------------------------------------------- view modes
function fitBounds() {
  const info = state.modelInfo;
  if (!info) return;
  const center = info.contentCenter || info.center;
  const radius = info.contentRadius || info.radius;
  const dist = radius / Math.sin((camera.fov * Math.PI / 180) / 2) * 0.95;
  orbit.target.copy(center);
  camera.position.set(center.x + dist * 0.55, center.y + dist * 0.62, center.z + dist * 0.55);
  orbit.update();
}

const views = {
  bounds: () => fitBounds(),
  origin: () => { const c = state.modelInfo?.contentCenter || new THREE.Vector3(); const r = state.modelInfo?.contentRadius || 500; orbit.target.copy(c); camera.position.set(c.x + r, c.y + r * 0.8, c.z + r); orbit.update(); },
  xz: () => topView(true),
  xy: () => {
    const info = state.modelInfo; const c = info ? (info.contentCenter || info.center) : new THREE.Vector3();
    const r = info ? (info.contentRadius || info.radius) : 500;
    orbit.target.copy(c);
    camera.position.set(c.x, c.y + r * 0.15, c.z + r * 2.6);
    orbit.update();
  },
  iso: () => {
    const info = state.modelInfo; const c = info ? (info.contentCenter || info.center) : new THREE.Vector3();
    const r = info ? (info.contentRadius || info.radius) : 500;
    orbit.target.copy(c);
    camera.position.set(c.x + r * 1.7, c.y + r * 1.7, c.z + r * 1.7);
    orbit.update();
  },
};
function topView(animate) {
  const info = state.modelInfo;
  const c = info ? (info.contentCenter || info.center) : new THREE.Vector3();
  const r = info ? (info.contentRadius || info.radius) : 500;
  orbit.target.copy(c);
  camera.position.set(c.x, c.y + r * 3.2, c.z + 0.01);
  orbit.update();
  if (animate) toast('俯视视角');
}

// ------------------------------------------------------------------ fly
const keys = new Set();
addEventListener('keydown', e => {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  keys.add(e.code);
});
addEventListener('keyup', e => keys.delete(e.code));
let flyYaw = 0, flyPitch = 0, dragging = false;
renderer.domElement.addEventListener('pointerdown', e => { if (state.cameraMode === 'fly') dragging = true; });
addEventListener('pointerup', () => { dragging = false; });
addEventListener('pointermove', e => {
  if (state.cameraMode !== 'fly' || !dragging) return;
  flyYaw -= e.movementX * 0.0025;
  flyPitch = Math.max(-1.45, Math.min(1.45, flyPitch - e.movementY * 0.0025));
});
function updateFly(dt) {
  const dir = new THREE.Vector3(Math.sin(flyYaw) * Math.cos(flyPitch), Math.sin(flyPitch), Math.cos(flyYaw) * Math.cos(flyPitch));
  camera.lookAt(camera.position.clone().add(dir));
  const speed = (keys.has('ShiftLeft') || keys.has('ShiftRight') ? 6 : 2) * Math.max(20, state.modelInfo?.radius * 0.25 || 60) * dt;
  const right = new THREE.Vector3().crossVectors(dir, camera.up).normalize();
  const move = new THREE.Vector3();
  if (keys.has('KeyW')) move.add(dir);
  if (keys.has('KeyS')) move.sub(dir);
  if (keys.has('KeyD')) move.add(right);
  if (keys.has('KeyA')) move.sub(right);
  if (keys.has('Space')) move.y += 1;
  if (keys.has('ControlLeft')) move.y -= 1;
  if (move.lengthSq()) camera.position.addScaledVector(move.normalize(), speed);
}
function switchCamera(mode) {
  state.cameraMode = mode;
  document.querySelectorAll('[data-cam]').forEach(b => b.classList.toggle('on', b.dataset.cam === mode));
  orbit.enabled = mode === 'orbit';
  if (mode === 'fly') {
    const e = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    flyYaw = e.y; flyPitch = e.x;
    toast('飞行模式：WASD 移动 · Shift 加速 · 拖动转向');
  } else if (mode === 'top') { topView(); }
  else toast('环绕模式');
}

// ------------------------------------------------------------- appearance
// A vertical gradient sky provides both the background and (via the PMREM
// environment) the ambient fill, which is what makes the PBR materials read
// correctly instead of crushing to black.
function makeSkyTexture(top, mid, bottom) {
  const c = document.createElement('canvas');
  c.width = 8; c.height = 512;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 512);
  g.addColorStop(0, top); g.addColorStop(0.55, mid); g.addColorStop(1, bottom);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 8, 512);
  const t = new THREE.CanvasTexture(c);
  t.mapping = THREE.EquirectangularReflectionMapping;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const SKIES = {
  gradient: { label: '晴空', top: '#6f8fb8', mid: '#a9c0d4', bottom: '#cbd2cc', fog: 0xa9b6bd, exposure: 0.68, env: 0.45 },
  dusk: { label: '黄昏', top: '#31415f', mid: '#6b7a93', bottom: '#9c9083', fog: 0x76808f, exposure: 0.85, env: 0.42 },
  overcast: { label: '阴天', top: '#c9d2d8', mid: '#c2cace', bottom: '#b4b9bb', fog: 0xc0c6c9, exposure: 0.62, env: 0.55 },
  night: { label: '夜间', top: '#0a0d10', mid: '#121b23', bottom: '#1b242c', fog: 0x151d24, exposure: 1.05, env: 0.30 },
};
const SKY_ORDER = ['gradient', 'dusk', 'overcast', 'night'];
const skyTextures = {};

function applySky(mode) {
  state.sky = SKIES[mode] ? mode : 'gradient';
  const cfg = SKIES[state.sky];
  if (!skyTextures[state.sky]) skyTextures[state.sky] = makeSkyTexture(cfg.top, cfg.mid, cfg.bottom);
  scene.background = skyTextures[state.sky];
  if (!scene.fog) scene.fog = new THREE.Fog(cfg.fog, 1e9, 1e9 + 1);
  scene.fog.color.setHex(cfg.fog);
  renderer.toneMappingExposure = cfg.exposure;
  scene.environmentIntensity = cfg.env;
  $('r-exposure').value = String(cfg.exposure);
  refreshFog();
}

function refreshFog() {
  const k = Number($('r-fog').value);
  const r = state.modelInfo?.radius || 1000;
  if (!scene.fog) return;
  if (k <= 0.001) { scene.fog.near = 1e9; scene.fog.far = 1e9 + 1; }
  else { scene.fog.near = r * 0.9 / k; scene.fog.far = r * 5 / k; }
  scene.fog.color.copy(scene.background.isColor ? scene.background : new THREE.Color(SKIES[state.sky].fog));
}

// ---------------------------------------------------------------- UI wiring
function toast(msg, isError = false) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.toggle('err', isError);
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2600);
}

$('map-select').addEventListener('change', e => loadMap(e.target.value, $('variant-select').value));
$('variant-select').addEventListener('change', e => loadMap($('map-select').value, e.target.value));
document.querySelectorAll('[data-cam]').forEach(b => b.addEventListener('click', () => switchCamera(b.dataset.cam)));
document.querySelectorAll('[data-view]').forEach(b => b.addEventListener('click', () => views[b.dataset.view]()));
$('btn-reset').addEventListener('click', () => { flyYaw = flyPitch = 0; fitBounds(); if (state.cameraMode === 'fly') switchCamera('orbit'); });
$('btn-wire').addEventListener('click', () => {
  state.wireframe = !state.wireframe;
  $('btn-wire').classList.toggle('on', state.wireframe);
  model?.traverse(o => { if (o.isMesh) { const m = Array.isArray(o.material) ? o.material : [o.material]; m.forEach(x => { if (x) x.wireframe = state.wireframe; }); } });
  toast(state.wireframe ? '线框开' : '线框关');
});
$('btn-sky').addEventListener('click', () => {
  const next = SKY_ORDER[(SKY_ORDER.indexOf(state.sky) + 1) % SKY_ORDER.length];
  applySky(next);
  $('btn-sky').classList.toggle('on', next !== 'gradient');
  toast(`环境：${SKIES[next].label}`);
});
$('btn-fold').addEventListener('click', () => { $('panel').classList.toggle('hidden'); $('btn-fold').classList.toggle('on'); });
$('loading-retry').addEventListener('click', () => loadMap($('map-select').value, $('variant-select').value));

$('chk-grid').addEventListener('change', e => { if (grid) grid.visible = e.target.checked; });
$('chk-axes').addEventListener('change', e => { if (axes) axes.visible = e.target.checked; });
$('chk-bounds').addEventListener('change', e => { if (boundsBox) boundsBox.visible = e.target.checked; });
$('chk-lights').addEventListener('change', e => { lights.visible = e.target.checked; });
$('chk-flip').addEventListener('change', e => { modelRoot.rotation.x = e.target.checked ? -Math.PI / 2 : 0; toast(e.target.checked ? '已旋转为 Y-up' : '恢复原始坐标系'); });
$('r-exposure').addEventListener('input', e => { renderer.toneMappingExposure = Number(e.target.value); });
$('r-env').addEventListener('input', e => { scene.environmentIntensity = Number(e.target.value); });
$('r-fog').addEventListener('input', refreshFog);
$('tex-mode').addEventListener('change', e => {
  state.texMode = e.target.value;
  if (model) state.texQuality = applyTextureQuality(model, state.texMode);
  toast(`纹理：${{ source: '源站一致（不模糊）', smooth: '平滑', sharp: '锐利' }[state.texMode]}`);
});
$('r-light').addEventListener('input', e => {
  const k = Number(e.target.value);
  hemi.intensity = BASE_INTENSITY.hemi * k;
  ambient.intensity = BASE_INTENSITY.ambient * k;
  sun.intensity = BASE_INTENSITY.sun * k;
  fill.intensity = BASE_INTENSITY.fill * k;
});

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ------------------------------------------------------------------- loop
let fpsAcc = 0, fpsFrames = 0, fpsShown = 0;
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.1);
  if (state.cameraMode === 'fly') updateFly(dt);
  else if (state.cameraMode === 'orbit') orbit.update();
  else orbit.update();
  renderer.render(scene, camera);

  fpsAcc += dt; fpsFrames++;
  if (fpsAcc >= 0.5) {
    fpsShown = Math.round(fpsFrames / fpsAcc);
    $('m-fps').textContent = String(fpsShown);
    fpsAcc = 0; fpsFrames = 0;
    const info = state.modelInfo;
    if (info) {
      $('m-tri').textContent = Math.round(info.triangles).toLocaleString();
      $('m-obj').textContent = String(info.meshes.filter(m => m.visible).length);
      const mem = renderer.info.memory;
      $('m-mem').textContent = `${((info.bytes + mem.textures * 1.3e6) / 1048576).toFixed(0)}`;
    }
  }
}
animate();

// ------------------------------------------------------------------- boot
// Debug/automation hook: lets the headless test harness inspect real scene state.
window.__viewer = { scene, camera, orbit, renderer, state, modelRoot, helpers, THREE, get model() { return model; } };

(async function boot() {
  try {
    const res = await fetch('./maps.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`maps.json HTTP ${res.status}`);
    const data = await res.json();
    state.maps = data.maps || [];
    state.localModels = data.localModels === true;
    if (!state.maps.length) throw new Error('maps.json 中没有可用地图');

    const q = new URLSearchParams(location.search);
    const slug = q.get('map') || data.default || state.maps[0].slug;
    const variant = q.get('variant') === 'overview' ? 'overview' : 'full';

    const sel = $('map-select');
    sel.replaceChildren();
    for (const m of state.maps) {
      const o = document.createElement('option');
      o.value = m.slug;
      o.textContent = `${m.label}${m.hasFull ? '' : ' (仅概览)'}`;
      sel.append(o);
    }
    sel.value = state.maps.some(m => m.slug === slug) ? slug : state.maps[0].slug;
    $('variant-select').value = variant;
    await loadMap(sel.value, variant);
  } catch (error) {
    console.error(error);
    $('loading-title').textContent = '初始化失败';
    $('loading-detail').textContent = `${error.message} — 请通过 HTTP 服务器打开（见 README）`;
    $('loading-retry').hidden = false;
    $('loading-retry').onclick = () => location.reload();
  }
})();
