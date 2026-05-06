/**
 * RainyGlass.three.tsx
 *
 * rainyday.js → RN-Expo-GL + Three.js faithful port
 *
 * Algorithm origins (rainyday.js):
 *   - Drop shape: circle / mild vertical stretch; shading on a spherical dome
 *     (hemisphere normals + Fresnel), not a teardrop cone
 *   - Reflection : REFLECTION_MINIATURE – down-scaled background sampled per drop
 *   - Lighting   : radial gradient from light pos; reflection-side highlight,
 *                  opposite-side shadow (dark crescent)
 *   - Gravity    : GRAVITY_NON_LINEAR – seed-based skip/slow/accelerate phases
 *   - Trail      : TRAIL_DROPS – small child drops spawned behind moving parent
 *   - Collision  : COLLISION_SIMPLE – merge on radius overlap, larger absorbs smaller
 *
 * Three.js implementation strategy:
 *   - One fullscreen PlaneGeometry with a custom ShaderMaterial (background pass)
 *   - Per-drop rendered via InstancedMesh with a custom ShaderMaterial
 *     (drop pass) — both blended over the background texture
 *   - Drop data lives in typed arrays (Float32Array / Uint8Array) rotated via
 *     a fixed-size pool; no unbounded growth
 *   - Uniforms / props: maxDrops, spawnInterval, gravityThreshold, dropScale,
 *     bgBlur, dropMinRadius / dropMaxRadius, lightPosition, lightColor, fps,
 *     pixelRatio (optional), backgroundContentPosition
 *
 * Background image note:
 *   RainyGlass draws `source` again in WebGL (droplets + tinted glass). It must
 *   use the same intrinsic aspect ratio as the header <Image>. On RN,
 *   `bgTexture.image.width/height` is often unset — we use `expo-asset`
 *   (`downloadAsync`) + decoded bitmap dims. For **correct cover framing**, the
 *   fragment shader uses **`onLayout` width/height** (`uCoverAspect`) because the
 *   GL `drawingBuffer` aspect can differ slightly from the visible view.
 *
 * Background blur note:
 *   rainyday.js pre-blurs the canvas via stackBlurCanvasRGB (CPU). The 9-tap
 *   shader blur here mimics “frosted glass” but is not identical — set bgBlur
 *   to 0 for a clean image; use a small bgBlur (~0.002–0.005) only if/when
 *   you want that effect again.
 *
 * Dependencies (install via expo/npm):
 *   expo-gl, expo-three, three
 *   npm i expo-gl expo-three three
 */

import { Asset } from 'expo-asset';
import { GLView } from 'expo-gl';
import { Renderer } from 'expo-three';
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
} from 'react';
import {
  PixelRatio,
  StyleSheet,
  View,
  type ImageSourcePropType,
  type LayoutChangeEvent,
} from 'react-native';
import * as THREE from 'three';

/** Sync read (often empty until asset is resolved). Prefer `resolveBundledAspectAsync`. */
function resolveNativeAssetAspectRatio(src: ImageSourcePropType): number | null {
  try {
    if (typeof src !== 'number') return null;
    const asset = Asset.fromModule(src);
    const w = asset.width;
    const h = asset.height;
    if (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) {
      return w / h;
    }
  } catch {
    /* invalid module id */
  }
  return null;
}

async function resolveBundledAspectAsync(
  src: ImageSourcePropType,
): Promise<number | null> {
  if (typeof src !== 'number') return null;
  try {
    const asset = Asset.fromModule(src);
    await asset.downloadAsync();
    const w = asset.width;
    const h = asset.height;
    if (typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0) {
      return w / h;
    }
  } catch {
    /* ignore */
  }
  return null;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RainyGlassUniforms {
  /** Hard cap on simultaneous live drops (pool size). Default 200 */
  maxDrops?: number;
  /** Milliseconds between spawn attempts. Default 50 */
  spawnInterval?: number;
  /** Minimum radius (px) before a drop starts falling. Default 3 */
  gravityThreshold?: number;
  /** Light source position in normalised [0,1] UV space. Default {x:0.5,y:0.2} */
  lightPosition?: { x: number; y: number };
  /** Light tint colour. Default white */
  lightColor?: { r: number; g: number; b: number };
  /** FPS target for physics step. Default 24 */
  fps?: number;
  /** Frosted background blur (normalised UV offset). 0 = sharp image. Default 0 */
  bgBlur?: number;
  /** Minimum drop radius in logical px (before dropScale). Default 5 */
  dropMinRadius?: number;
  /** Maximum drop radius in logical px (before dropScale). Default 22 */
  dropMaxRadius?: number;
  /** Probability [0–1] of spawning a drop each spawnInterval. Default 0.5 */
  spawnChance?: number;
  /**
   * Multiplies spawn radii and gravityThreshold so you can tune perceived drop
   * size without editing min/max. Default 1.5 (drops stay comfortable on phones).
   */
  dropScale?: number;
  /**
   * Override device pixel ratio; omit to use `PixelRatio.get()` so drops are
   * sized in **logical** px and look similar across low-/high-DPR screens.
   */
  pixelRatio?: number;
  /**
   * Vertical crop when content is taller than viewport (object-fit: cover).
   * Match expo-image contentPosition — e.g. `top center` → use `'top'`.
   * Default `'center'`.
   */
  backgroundContentPosition?: 'center' | 'top';
}

export interface RainyGlassRef {
  pause: () => void;
  resume: () => void;
  reset: () => void;
}

interface Props extends RainyGlassUniforms {
  /** React Native image source for the background (require / uri). Required. */
  source: ImageSourcePropType;
  style?: object;
  /** When false the animation is paused. Default true */
  enabled?: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MAX_DROPS = 100;
const DEFAULT_SPAWN_INTERVAL = 50;       // ms
const DEFAULT_GRAVITY_THRESHOLD = 3;     // px radius
const DEFAULT_FPS = 24;

// Pool rotation watermark: when activeCount >= POOL_ROTATE_AT we start
// recycling oldest slots to prevent unbounded live-set growth on long sessions.
const POOL_ROTATE_AT = 0.9; // 90 % of maxDrops

// ---------------------------------------------------------------------------
// Drop physics state (CPU side, typed arrays for cache efficiency)
// ---------------------------------------------------------------------------

interface DropPool {
  // geometry / render
  x: Float32Array;          // centre x  (px, 0..width)
  y: Float32Array;          // centre y  (px, 0..height)
  r: Float32Array;          // radius    (px)
  yspeed: Float32Array;
  xspeed: Float32Array;
  // gravity FSM
  seed: Int32Array;
  skipping: Uint8Array;     // bool
  slowing: Uint8Array;      // bool
  collided: Uint8Array;     // bool
  alive: Uint8Array;        // bool
  // trail
  trailY: Float32Array;
  // collision
  gmx: Int32Array;
  gmy: Int32Array;
}

function allocPool(n: number): DropPool {
  return {
    x: new Float32Array(n),
    y: new Float32Array(n),
    r: new Float32Array(n),
    yspeed: new Float32Array(n),
    xspeed: new Float32Array(n),
    seed: new Int32Array(n),
    skipping: new Uint8Array(n),
    slowing: new Uint8Array(n),
    collided: new Uint8Array(n),
    alive: new Uint8Array(n),
    trailY: new Float32Array(n),
    gmx: new Int32Array(n),
    gmy: new Int32Array(n),
  };
}

// ---------------------------------------------------------------------------
// GLSL — vertex shader (shared)
// ---------------------------------------------------------------------------

const DROP_VERT = /* glsl */`
  precision highp float;

  // Per-instance attributes (set via InstancedBufferAttribute)
  attribute vec2  aCenter;   // drop centre in px
  attribute float aRadius;   // drop radius  in px
  attribute float aYSpeed;   // used to compute teardrop deformation
  attribute float aAlive;    // 0 = dead → collapse to degenerate triangle

  uniform vec2 uResolution;  // drawing buffer size (physical px)
  uniform float uPixelRatio; // devicePixelRatio — pool uses logical px

  varying vec2  vUV;         // normalised UV within the drop bounding circle
  varying vec2  vDropUV;     // UV in screen space (for background sampling)
  varying float vRadius;
  varying float vYSpeed;

  void main() {
    if (aAlive < 0.5) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // clip away
      return;
    }

    // Local quad: position is in [-1,1] with respect to the drop bounding box
    // Three.js PlaneGeometry uv: (0,0) bottom-left → remap to (-1,1)
    vUV = uv * 2.0 - 1.0;

    // aCenter / aRadius are in logical px; map to physical then NDC
    vec2 centrePx = aCenter * uPixelRatio;
    float radPx     = aRadius * uPixelRatio;

    vec2 ndcCenter = (centrePx / uResolution) * 2.0 - 1.0;
    ndcCenter.y    = -ndcCenter.y; // flip Y (GL vs screen)

    vec2 halfPx    = (radPx * 2.2) / uResolution; // 10 % padding
    vec2 ndcPos    = ndcCenter + position.xy * halfPx;

    gl_Position = vec4(ndcPos, 0.0, 1.0);

    // UV in screen space for texture sampling
    vDropUV  = (ndcPos * 0.5 + 0.5);
    vDropUV.y = 1.0 - vDropUV.y;

    vRadius  = aRadius; // logical — fragment uses with logicalRes
    vYSpeed  = aYSpeed;
  }
`;

// ---------------------------------------------------------------------------
// GLSL — fragment shader (drop rendering)
//
// Spherical dome (hemisphere lens), not a teardrop cone:
//   - Surface N from z = sqrt(1 − r²) on the unit disk (orthographic cap)
//   - Air→water refraction (eta ≈ 1/1.33) + weak glossy reflection sample
//   - Schlick Fresnel on rim; Blinn-Phong + mirror spec toward V
//   - Soft “crescent” shadow where N·L is low (back of dome vs light)
// Fast motion: slight vertical stretch → oblate silhouette, still dome normals.
// (Liquid-glass / droplet UI shaders use the same hemisphere + Fresnel idea.)
// ---------------------------------------------------------------------------

const DROP_FRAG = /* glsl */`
  precision highp float;

  uniform sampler2D uBgTexture;
  uniform vec2      uResolution;
  uniform float     uPixelRatio;
  uniform float     uTexAspect;
  uniform float     uCoverYAlign;
  uniform float     uCoverAspect;
  uniform vec2      uLightPos;
  uniform vec3      uLightColor;
  uniform float     uTime;

  varying vec2  vUV;
  varying vec2  vDropUV;
  varying float vRadius;
  varying float vYSpeed;

  vec2 aspectCoverUV(vec2 screenUv) {
    float bufSa = uResolution.x / max(uResolution.y, 1e-5);
    float sa = uCoverAspect > 0.001 ? uCoverAspect : bufSa;
    float ia = uTexAspect;
    if (sa > ia) {
      float w = ia / sa;
      float x = (screenUv.x - 0.5) * w + 0.5;
      return clamp(vec2(x, screenUv.y), vec2(0.001), vec2(0.999));
    } else {
      float w = sa / ia;
      float y = (uCoverYAlign > 0.5)
        ? screenUv.y * w + (1.0 - w)
        : (screenUv.y - 0.5) * w + 0.5;
      return clamp(vec2(screenUv.x, y), vec2(0.001), vec2(0.999));
    }
  }

  void main() {
    // Silhouette: circle in vUV, mild vertical elongation via inverse stretch map
    float stretch = 1.0 + 0.14 * clamp(vYSpeed / 6.0, 0.0, 1.0);
    vec2 inter = vec2(vUV.x, vUV.y * stretch);
    float qrad = length(inter);
    if (qrad >= 1.002) discard;
    float mask = 1.0 - smoothstep(0.97, 1.0, qrad);

    float zm = sqrt(max(1.0 - qrad * qrad, 1e-5));
    vec3 N = normalize(vec3(inter.x, inter.y, zm));
    vec3 V = vec3(0.0, 0.0, 1.0);

    vec2 lhp = uLightPos - vDropUV;
    float bufLt = uResolution.x / max(uResolution.y, 1.0);
    float saLt = uCoverAspect > 0.001 ? uCoverAspect : bufLt;
    vec3 L = normalize(vec3(lhp.x * 1.15, -lhp.y * 1.15 * saLt, 0.72));

    vec2 logicalRes = uResolution.xy / max(uPixelRatio, 0.25);

    vec3  I = vec3(0.0, 0.0, -1.0);
    float eta = 1.0 / 1.33;
    vec3  Tr = refract(I, N, eta);
    if (dot(Tr, Tr) < 1e-8) Tr = reflect(I, N);
    float pl = 0.52 * vRadius / max(min(logicalRes.x, logicalRes.y), 1.0);
    vec2 deltaR = Tr.xy * pl / max(abs(Tr.z), 0.12);
    vec3 base = texture2D(uBgTexture, aspectCoverUV(vDropUV + deltaR)).rgb;

    vec3 Rm = reflect(I, N);
    vec2 deltaM = Rm.xy * pl * 0.38 / max(abs(Rm.z), 0.12);
    vec3 refl = texture2D(uBgTexture, aspectCoverUV(vDropUV + deltaM)).rgb;

    float NdotV = max(dot(N, V), 0.0);
    float fresnel = 0.035 + 0.965 * pow(1.0 - NdotV, 5.0);

    vec3  H = normalize(L + V);
    float spec = pow(max(dot(N, H), 0.0), 96.0);
    float spe2 = pow(max(dot(reflect(-L, N), V), 0.0), 44.0);

    float NdotL = max(dot(N, L), 0.0);
    float shadowBand = pow(1.0 - NdotL, 1.75) * 0.4;
    float diffuseLift = mix(0.28, 1.0, NdotL);

    float glo = 1.0 - clamp(length(vDropUV - uLightPos) / 0.88, 0.0, 1.0);
    glo = pow(glo, 1.15);

    vec3 col = base * diffuseLift;
    col = mix(col, refl, fresnel * 0.28);
    col += uLightColor * (spec * 0.7 + spe2 * 0.42) * glo;
    col += uLightColor * fresnel * 0.1;
    col *= (1.0 - shadowBand);
    col = clamp(col, 0.0, 1.0);

    float alpha = mask * mix(0.09, 0.62, NdotV);
    alpha += mask * fresnel * 0.38;
    alpha += mask * (spec + spe2) * 0.48;

    gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
  }
`;

// ---------------------------------------------------------------------------
// Background vertex / fragment (simple fullscreen textured quad)
// ---------------------------------------------------------------------------

const BG_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    // Bypass camera matrices: PlaneGeometry(2,2) vertex positions are already in NDC
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const BG_FRAG = /* glsl */`
  precision mediump float;
  uniform sampler2D uBgTexture;
  uniform float     uBlur;
  uniform vec2      uResolution;
  uniform float     uTexAspect;
  uniform float     uCoverYAlign;
  uniform float     uCoverAspect;
  varying vec2      vUv;

  vec2 aspectCoverUV(vec2 screenUv) {
    float bufSa = uResolution.x / max(uResolution.y, 1e-5);
    float sa = uCoverAspect > 0.001 ? uCoverAspect : bufSa;
    float ia = uTexAspect;
    if (sa > ia) {
      float w = ia / sa;
      float x = (screenUv.x - 0.5) * w + 0.5;
      return clamp(vec2(x, screenUv.y), vec2(0.001), vec2(0.999));
    } else {
      float w = sa / ia;
      float y = (uCoverYAlign > 0.5)
        ? screenUv.y * w + (1.0 - w)
        : (screenUv.y - 0.5) * w + 0.5;
      return clamp(vec2(screenUv.x, y), vec2(0.001), vec2(0.999));
    }
  }

  void main() {
    vec2 tuv = aspectCoverUV(vUv);
    if (uBlur < 0.0001) {
      gl_FragColor = texture2D(uBgTexture, tuv);
      return;
    }
    vec4 col = vec4(0.0);
    float s  = uBlur;
    col += texture2D(uBgTexture, aspectCoverUV(vUv + vec2(-s, -s)));
    col += texture2D(uBgTexture, aspectCoverUV(vUv + vec2( 0.0, -s)));
    col += texture2D(uBgTexture, aspectCoverUV(vUv + vec2( s, -s)));
    col += texture2D(uBgTexture, aspectCoverUV(vUv + vec2(-s,  0.0)));
    col += texture2D(uBgTexture, aspectCoverUV(vUv + vec2( 0.0,  0.0))) * 2.0;
    col += texture2D(uBgTexture, aspectCoverUV(vUv + vec2( s,  0.0)));
    col += texture2D(uBgTexture, aspectCoverUV(vUv + vec2(-s,  s)));
    col += texture2D(uBgTexture, aspectCoverUV(vUv + vec2( 0.0,  s)));
    col += texture2D(uBgTexture, aspectCoverUV(vUv + vec2( s,  s)));
    gl_FragColor = col / 10.0;
  }
`;

// ---------------------------------------------------------------------------
// RainyGlass component
// ---------------------------------------------------------------------------

const RainyGlass = forwardRef<RainyGlassRef, Props>(function RainyGlass(
  props: Props,
  ref,
) {
  const {
    source,
    style,
    enabled = true,
    maxDrops = DEFAULT_MAX_DROPS,
    spawnInterval = DEFAULT_SPAWN_INTERVAL,
    gravityThreshold = DEFAULT_GRAVITY_THRESHOLD,
    lightPosition = { x: 0.5, y: 0.2 },
    lightColor = { r: 1, g: 1, b: 1 },
    fps = DEFAULT_FPS,
    bgBlur = 0,
    dropMinRadius = 3,
    dropMaxRadius = 6,
    spawnChance = 0.5,
    dropScale = 1.2,
    pixelRatio: pixelRatioProp,
    backgroundContentPosition = 'center',
  } = props;

  // Mutable refs shared across callbacks (no re-render needed)
  const glRef = useRef<WebGLRenderingContext | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.OrthographicCamera | null>(null);
  const rafRef = useRef<number>(0);
  const pausedRef = useRef(!enabled);
  // frameRef holds the latest frame function to avoid stale-closure RAF loops
  const frameRef = useRef<() => void>(() => { });
  /** Device pixel ratio — pool & physics in logical px */
  const dprRef = useRef(Math.max(PixelRatio.get(), 1));

  // Drop pool
  const poolRef = useRef<DropPool>(allocPool(maxDrops));
  const activeRef = useRef(0);     // how many slots are live
  const nextSlotRef = useRef(0);     // ring-buffer pointer for recycling

  // Timing
  const lastSpawnRef = useRef(0);
  const lastFrameRef = useRef(0);

  // Gravity constants (derived from fps, like rainyday.js)
  const GFY = useRef((fps * 0.001) / 25);
  const GFX = useRef(0); // no horizontal gravity by default

  // InstancedMesh refs
  const meshRef = useRef<THREE.InstancedMesh | null>(null);
  const attrCenter = useRef<THREE.InstancedBufferAttribute | null>(null);
  const attrRadius = useRef<THREE.InstancedBufferAttribute | null>(null);
  const attrYSpeed = useRef<THREE.InstancedBufferAttribute | null>(null);
  const attrAlive = useRef<THREE.InstancedBufferAttribute | null>(null);

  // Uniforms live here so we can update them without recreating material
  const uniformsRef = useRef<Record<string, THREE.IUniform>>({
    uBgTexture: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uBlur: { value: 0 },
    uTexAspect: { value: 1 },
    uPixelRatio: { value: Math.max(PixelRatio.get(), 1) },
    uLightPos: { value: new THREE.Vector2(lightPosition.x, lightPosition.y) },
    uLightColor: { value: new THREE.Vector3(lightColor.r, lightColor.g, lightColor.b) },
    uTime: { value: 0 },
    uCoverYAlign: {
      value: backgroundContentPosition === 'top' ? 1.0 : 0.0,
    },
    uCoverAspect: { value: 0 },
  });

  useEffect(() => {
    uniformsRef.current.uCoverYAlign.value =
      backgroundContentPosition === 'top' ? 1.0 : 0.0;
  }, [backgroundContentPosition]);

  useEffect(() => {
    uniformsRef.current.uBlur.value = bgBlur;
  }, [bgBlur]);

  useEffect(() => {
    uniformsRef.current.uLightPos.value.set(
      lightPosition.x,
      lightPosition.y,
    );
    uniformsRef.current.uLightColor.value.set(
      lightColor.r,
      lightColor.g,
      lightColor.b,
    );
  }, [lightPosition, lightColor]);

  useEffect(() => {
    if (pixelRatioProp != null && pixelRatioProp > 0) {
      dprRef.current = pixelRatioProp;
      uniformsRef.current.uPixelRatio.value = pixelRatioProp;
    }
  }, [pixelRatioProp]);

  const onContainerLayout = useCallback((e: LayoutChangeEvent) => {
    const { width: lw, height: lh } = e.nativeEvent.layout;
    if (!(lw > 1 && lh > 1)) return;
    uniformsRef.current.uCoverAspect.value = lw / lh;
  }, []);
  useImperativeHandle(ref, () => ({
    pause: () => {
      pausedRef.current = true;
      cancelAnimationFrame(rafRef.current);
    },
    resume: () => {
      if (pausedRef.current) {
        pausedRef.current = false;
        lastFrameRef.current = performance.now();
        lastSpawnRef.current = performance.now();
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(frameRef.current);
      }
    },
    reset: () => resetPool(),
  }));

  // -------------------------------------------------------------------------
  // Pool helpers
  // -------------------------------------------------------------------------
  const resetPool = useCallback(() => {
    const p = poolRef.current;
    p.alive.fill(0);
    p.x.fill(0); p.y.fill(0); p.r.fill(0);
    p.yspeed.fill(0); p.xspeed.fill(0);
    p.seed.fill(0); p.skipping.fill(0); p.slowing.fill(0);
    p.collided.fill(0); p.trailY.fill(0);
    activeRef.current = 0;
    nextSlotRef.current = 0;
  }, []);

  /** Spawn a drop into the next available slot (ring-buffer). */
  const spawnDrop = useCallback((
    canvasW: number,
    canvasH: number,
    cx?: number,
    cy?: number,
    minR = 3,
    baseR = 5,
  ) => {
    const p = poolRef.current;
    const n = maxDrops;

    // Choose slot: prefer dead slot, else evict oldest (ring)
    let slot = -1;
    // Fast scan from nextSlot for a dead cell (bounded to n iterations)
    const start = nextSlotRef.current;
    for (let i = 0; i < n; i++) {
      const idx = (start + i) % n;
      if (!p.alive[idx]) { slot = idx; break; }
    }
    if (slot === -1) {
      // Pool full – recycle oldest slot (rotation)
      if (activeRef.current >= maxDrops * POOL_ROTATE_AT) {
        slot = nextSlotRef.current;
      } else {
        return; // still room, just couldn't find quickly → skip this frame
      }
    }
    nextSlotRef.current = (slot + 1) % n;

    p.x[slot] = cx !== undefined ? cx : Math.random() * canvasW;
    p.y[slot] = cy !== undefined ? cy : Math.random() * canvasH;
    p.r[slot] = Math.ceil(Math.random() * baseR + minR);
    p.yspeed[slot] = 0;
    p.xspeed[slot] = 0;
    p.seed[slot] = 0;
    p.skipping[slot] = 0;
    p.slowing[slot] = 0;
    p.collided[slot] = 0;
    p.trailY[slot] = p.y[slot];
    p.alive[slot] = 1;
    if (!p.alive[slot]) activeRef.current++;
    activeRef.current = Math.min(activeRef.current + 1, n);
  }, [maxDrops]);

  // -------------------------------------------------------------------------
  // Physics step — GRAVITY_NON_LINEAR port
  // -------------------------------------------------------------------------
  const stepPhysics = useCallback((
    canvasW: number,
    canvasH: number,
    now: number,
  ) => {
    const p = poolRef.current;
    const n = maxDrops;
    const gfy = GFY.current;
    const gfx = GFX.current;
    const gTh = gravityThreshold * dropScale;
    let alive = 0;

    for (let i = 0; i < n; i++) {
      if (!p.alive[i]) continue;

      const r = p.r[i];

      // --- Gravity FSM (GRAVITY_NON_LINEAR) ---
      if (r > gTh) {
        if (p.collided[i]) {
          p.collided[i] = 0;
          p.seed[i] = Math.floor(r * Math.random() * fps);
          p.skipping[i] = 0;
          p.slowing[i] = 0;
        } else if (!p.seed[i] || p.seed[i] < 0) {
          p.seed[i] = Math.floor(r * Math.random() * fps);
          p.skipping[i] = p.skipping[i] ? 0 : 1;
          p.slowing[i] = 1;
        }
        p.seed[i]--;

        if (p.yspeed[i]) {
          if (p.slowing[i]) {
            p.yspeed[i] /= 1.1;
            p.xspeed[i] /= 1.1;
            if (p.yspeed[i] < gfy) p.slowing[i] = 0;
          } else if (p.skipping[i]) {
            p.yspeed[i] = gfy;
            p.xspeed[i] = gfx;
          } else {
            p.yspeed[i] += gfy * Math.floor(r);
            p.xspeed[i] += gfx * Math.floor(r);
          }
        } else {
          p.yspeed[i] = gfy;
          p.xspeed[i] = gfx;
        }

        p.y[i] += Math.floor(p.yspeed[i]);
        p.x[i] += Math.floor(p.xspeed[i]);

        // --- Trail: TRAIL_DROPS ---
        if (
          !p.trailY[i] ||
          p.y[i] - p.trailY[i] >= Math.random() * 100 * r
        ) {
          p.trailY[i] = p.y[i];
          const tr = Math.ceil(r / 5);
          if (tr >= 1) {
            spawnDrop(
              canvasW, canvasH,
              Math.floor(p.x[i] + (Math.random() * 2 - 1) * Math.random()),
              p.y[i] - r - 5,
              tr, 0,
            );
          }
        }
      }

      // --- Cull out-of-bounds ---
      if (
        p.y[i] - r > canvasH ||
        p.x[i] - r > canvasW ||
        p.x[i] + r < 0
      ) {
        p.alive[i] = 0;
        continue;
      }

      alive++;
    }

    // Simple collision pass (COLLISION_SIMPLE) — O(n²) but n is small
    for (let i = 0; i < n; i++) {
      if (!p.alive[i] || p.r[i] <= gTh) continue;
      for (let j = i + 1; j < n; j++) {
        if (!p.alive[j] || p.r[j] <= gTh) continue;
        if (p.y[j] <= p.y[i]) continue; // j must be lower (further down screen)
        const dx = p.x[i] - p.x[j];
        const dy = p.y[i] - p.y[j];
        const rs = p.r[i] + p.r[j];
        if (Math.abs(dx) < rs && Math.abs(dy) < rs) {
          if (Math.sqrt(dx * dx + dy * dy) < rs) {
            // Merge: lower absorbs upper
            const lower = p.y[i] > p.y[j] ? i : j;
            const higher = lower === i ? j : i;
            p.r[lower] = Math.max(p.r[lower], p.r[higher]) * 1.001;
            p.alive[higher] = 0;
            p.collided[lower] = 1;
          }
        }
      }
    }

    activeRef.current = alive;
  }, [maxDrops, gravityThreshold, fps, spawnDrop, dropScale]);

  // -------------------------------------------------------------------------
  // Upload instance attributes to GPU
  // -------------------------------------------------------------------------
  const uploadInstances = useCallback(() => {
    const p = poolRef.current;
    const n = maxDrops;
    const ac = attrCenter.current;
    const ar = attrRadius.current;
    const ay = attrYSpeed.current;
    const aa = attrAlive.current;
    if (!ac || !ar || !ay || !aa) return;

    const cArr = ac.array as Float32Array;
    const rArr = ar.array as Float32Array;
    const yArr = ay.array as Float32Array;
    const aArr = aa.array as Float32Array;

    for (let i = 0; i < n; i++) {
      cArr[i * 2] = p.x[i];
      cArr[i * 2 + 1] = p.y[i];
      rArr[i] = p.r[i];
      yArr[i] = p.yspeed[i];
      aArr[i] = p.alive[i];
    }

    ac.needsUpdate = true;
    ar.needsUpdate = true;
    ay.needsUpdate = true;
    aa.needsUpdate = true;
  }, [maxDrops]);

  // -------------------------------------------------------------------------
  // Animation frame
  // -------------------------------------------------------------------------

  const frame = useCallback(function frameInner() {
    if (pausedRef.current) return;

    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (!renderer || !scene || !camera) return;

    const now = performance.now();
    const W = (uniformsRef.current.uResolution.value as THREE.Vector2).x;
    const H = (uniformsRef.current.uResolution.value as THREE.Vector2).y;
    const dpr = dprRef.current;
    const wLog = W / dpr;
    const hLog = H / dpr;

    // Throttle spawn to spawnInterval ms
    if (now - lastSpawnRef.current >= spawnInterval) {
      lastSpawnRef.current = now;
      if (Math.random() < spawnChance) {
        const minR = dropMinRadius * dropScale;
        const baseR = Math.max(
          1,
          (dropMaxRadius - dropMinRadius) * dropScale,
        );
        spawnDrop(wLog, hLog, undefined, undefined, minR, baseR);
      }
    }

    // Physics step
    stepPhysics(wLog, hLog, now);

    // Upload to GPU
    uploadInstances();

    // Update time uniform
    uniformsRef.current.uTime.value = now * 0.001;

    // Render
    renderer.render(scene, camera);
    (glRef.current as (WebGLRenderingContext & { endFrameEXP?: () => void }) | null)
      ?.endFrameEXP?.();

    // Use frameRef to avoid stale-closure on re-render
    rafRef.current = requestAnimationFrame(frameRef.current);
  }, [spawnDrop, stepPhysics, uploadInstances, spawnInterval, spawnChance, dropMinRadius, dropMaxRadius, dropScale]);

  // Keep frameRef in sync with the latest frame function
  frameRef.current = frame;

  // -------------------------------------------------------------------------
  // GL context setup
  // -------------------------------------------------------------------------
  const onContextCreate = useCallback(async (gl: WebGLRenderingContext) => {
    glRef.current = gl;
    const { drawingBufferWidth: W, drawingBufferHeight: H } = gl;

    const dpr = pixelRatioProp ?? PixelRatio.get();
    dprRef.current = Math.max(dpr, 0.5);
    uniformsRef.current.uPixelRatio.value = dprRef.current;

    // ---- Renderer --------------------------------------------------------
    const renderer = new Renderer({ gl });
    renderer.setSize(W, H);
    renderer.setClearColor(0x000000, 0);
    rendererRef.current = renderer;

    // ---- Scene & Camera --------------------------------------------------
    const scene = new THREE.Scene();
    sceneRef.current = scene;

    // Orthographic camera; near=-1 so the z=0 plane (both meshes) is never clipped
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    cameraRef.current = camera;

    // ---- Background texture from source ----------------------------------
    // expo-three's TextureLoader works with RN image sources
    let bgTexture: THREE.Texture;
    try {
      const { TextureLoader } = await import('expo-three');
      bgTexture = await new TextureLoader().loadAsync(source as string);
      bgTexture.needsUpdate = true;
    } catch {
      // Fallback: solid colour texture
      bgTexture = new THREE.DataTexture(
        new Uint8Array([180, 200, 220, 255]),
        1, 1,
        THREE.RGBAFormat,
      );
      bgTexture.needsUpdate = true;
    }

    uniformsRef.current.uBgTexture.value = bgTexture;
    uniformsRef.current.uResolution.value.set(W, H);

    const img = bgTexture.image as { width?: number; height?: number } | undefined;
    let tw = 1;
    let th = 1;
    if (img && typeof img === 'object' && img.width && img.height) {
      tw = img.width;
      th = img.height;
    }
    const texFallback = tw / Math.max(th, 1e-6);
    const bundledAspect =
      (await resolveBundledAspectAsync(source))
      ?? resolveNativeAssetAspectRatio(source);
    uniformsRef.current.uTexAspect.value =
      (bundledAspect != null && bundledAspect > 0)
        ? bundledAspect
        : (texFallback > 0 ? texFallback : 1);

    uniformsRef.current.uBlur.value = bgBlur;
    uniformsRef.current.uCoverYAlign.value =
      backgroundContentPosition === 'top' ? 1.0 : 0.0;

    uniformsRef.current.uLightPos.value.set(lightPosition.x, lightPosition.y);
    uniformsRef.current.uLightColor.value.set(
      lightColor.r, lightColor.g, lightColor.b,
    );

    // ---- Background plane -----------------------------------------------
    const bgGeo = new THREE.PlaneGeometry(2, 2);
    const bgMat = new THREE.ShaderMaterial({
      vertexShader: BG_VERT,
      fragmentShader: BG_FRAG,
      uniforms: {
        uBgTexture: uniformsRef.current.uBgTexture,
        uBlur: uniformsRef.current.uBlur,
        uResolution: uniformsRef.current.uResolution,
        uTexAspect: uniformsRef.current.uTexAspect,
        uCoverYAlign: uniformsRef.current.uCoverYAlign,
        uCoverAspect: uniformsRef.current.uCoverAspect,
      },
      depthWrite: false,
      depthTest: false,
    });
    const bgMesh = new THREE.Mesh(bgGeo, bgMat);
    bgMesh.renderOrder = 0;
    scene.add(bgMesh);

    // ---- Drop instanced mesh --------------------------------------------
    // Each "instance" is a unit quad; we deform in vertex shader
    const dropGeo = new THREE.PlaneGeometry(2, 2, 1, 1); // quad in [-1,1]

    // Per-instance buffer attributes
    const n = maxDrops;
    const cArr = new Float32Array(n * 2); // x,y centre
    const rArr = new Float32Array(n);     // radius
    const yArr = new Float32Array(n);     // yspeed
    const aArr = new Float32Array(n);     // alive

    const iaCenter = new THREE.InstancedBufferAttribute(cArr, 2);
    const iaRadius = new THREE.InstancedBufferAttribute(rArr, 1);
    const iaYSpeed = new THREE.InstancedBufferAttribute(yArr, 1);
    const iaAlive = new THREE.InstancedBufferAttribute(aArr, 1);
    iaCenter.setUsage(THREE.DynamicDrawUsage);
    iaRadius.setUsage(THREE.DynamicDrawUsage);
    iaYSpeed.setUsage(THREE.DynamicDrawUsage);
    iaAlive.setUsage(THREE.DynamicDrawUsage);

    dropGeo.setAttribute('aCenter', iaCenter);
    dropGeo.setAttribute('aRadius', iaRadius);
    dropGeo.setAttribute('aYSpeed', iaYSpeed);
    dropGeo.setAttribute('aAlive', iaAlive);

    attrCenter.current = iaCenter;
    attrRadius.current = iaRadius;
    attrYSpeed.current = iaYSpeed;
    attrAlive.current = iaAlive;

    const dropMat = new THREE.ShaderMaterial({
      vertexShader: DROP_VERT,
      fragmentShader: DROP_FRAG,
      uniforms: uniformsRef.current,
      transparent: true,
      depthWrite: false,
      depthTest: false,
      blending: THREE.NormalBlending,
    });

    const dropMesh = new THREE.InstancedMesh(dropGeo, dropMat, n);
    dropMesh.renderOrder = 1;
    dropMesh.frustumCulled = false;
    meshRef.current = dropMesh;
    scene.add(dropMesh);

    // ---- Start animation loop (only if enabled) ---------------------------
    resetPool();
    lastFrameRef.current = performance.now();
    lastSpawnRef.current = performance.now();
    if (!pausedRef.current) {
      rafRef.current = requestAnimationFrame(frameRef.current);
    }
  }, [
    source,
    maxDrops,
    lightPosition,
    lightColor,
    bgBlur,
    resetPool,
    pixelRatioProp,
    backgroundContentPosition,
  ]);

  // -------------------------------------------------------------------------
  // enabled prop → pause / resume
  // -------------------------------------------------------------------------
  useEffect(() => {
    if (enabled === false) {
      pausedRef.current = true;
      cancelAnimationFrame(rafRef.current);
    } else {
      pausedRef.current = false;
      // Only restart if GL context is already ready
      if (glRef.current && rendererRef.current) {
        cancelAnimationFrame(rafRef.current);
        lastFrameRef.current = performance.now();
        lastSpawnRef.current = performance.now();
        rafRef.current = requestAnimationFrame(frameRef.current);
      }
    }
  }, [enabled]);

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------
  useEffect(() => {
    return () => {
      pausedRef.current = true;
      cancelAnimationFrame(rafRef.current);
      rendererRef.current?.dispose();
      meshRef.current?.geometry.dispose();
    };
  }, []);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------
  return (
    <View style={[styles.container, style]} onLayout={onContainerLayout}>
      <GLView
        style={StyleSheet.absoluteFill}
        onContextCreate={onContextCreate}
      />
    </View>
  );
});

export default RainyGlass;

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    overflow: 'hidden',
  },
});

// ---------------------------------------------------------------------------
// Usage example (add to your screen):
//
//  import RainyGlass, { RainyGlassRef } from './RainyGlass.three';
//
//  const ref = useRef<RainyGlassRef>(null);
//
//  <RainyGlass
//    ref={ref}
//    source={require('./assets/window.jpg')}
//    style={{ width: '100%', height: 400 }}
//    bgBlur={0}
//    dropScale={1.8}
//    dropMinRadius={4}
//    dropMaxRadius={24}
//    maxDrops={150}
//    spawnInterval={60}
//    gravityThreshold={3}
//    lightPosition={{ x: 0.3, y: 0.15 }}
//    lightColor={{ r: 1.0, g: 0.97, b: 0.9 }}
//    fps={24}
//  />
//
//  // Pause / resume / reset imperatively:
//  ref.current?.pause();
//  ref.current?.resume();
//  ref.current?.reset();
// ---------------------------------------------------------------------------
