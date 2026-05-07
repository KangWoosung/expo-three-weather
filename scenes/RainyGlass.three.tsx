/**
 * RainyGlass.three.tsx 
 *
 * rainyday.js → RN Expo-GL + Three.js port
 *
 * Algorithm origins (rainyday.js):
 *   - Reflection : REFLECTION_MINIATURE  (hemisphere lens refraction)
 *   - Lighting   : radial falloff; Blinn-Phong highlight + shadow crescent
 *   - Gravity    : GRAVITY_NON_LINEAR    (seed-based skip/slow/accelerate)
 *   - Trail      : TRAIL_DROPS           (small child drops behind moving parent)
 *   - Collision  : COLLISION_SIMPLE      (merge on radius overlap)
 *
 * Background aspect-ratio fix:
 *   Two uniforms — uBgScale (vec2) + uBgOffset (vec2) — are computed once
 *   on the CPU via computeCoverMapping() whenever the view size or the image
 *   intrinsic size is known.  BOTH the BG shader and the drop shader use the
 *   same formula:
 *
 *       texUV = screenUV * uBgScale + uBgOffset
 *
 *   This guarantees that a drop at screen position (x, y) always samples the
 *   texel that is actually visible there — no distortion, no wrong-pixel
 *   reflection.
 *
 * Dependencies:
 *   npx expo install expo-gl expo-three expo-asset && npm i three
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

// ─────────────────────────────────────────────────────────────────────────────
// Public types
// ─────────────────────────────────────────────────────────────────────────────

export interface RainyGlassUniforms {
  /** Hard cap on simultaneous live drops (pool size). Default 100 */
  maxDrops?: number;
  /** Milliseconds between spawn attempts. Default 50 */
  spawnInterval?: number;
  /** Probability [0–1] of spawning a drop each interval. Default 0.5 */
  spawnChance?: number;
  /** Radius (logical px) threshold before a drop starts falling. Default 3 */
  gravityThreshold?: number;
  /** Minimum spawn radius in logical px. Default 3 */
  dropMinRadius?: number;
  /** Maximum spawn radius in logical px. Default 6 */
  dropMaxRadius?: number;
  /** Uniform scale applied to all drop radii. Default 1.2 */
  dropScale?: number;
  /** Light position in normalized [0,1]; y=1 is top of view (same uv as BG). Default { x: 0.5, y: 0.8 } */
  lightPosition?: { x: number; y: number };
  /** Light tint. Default white */
  lightColor?: { r: number; g: number; b: number };
  /** Physics FPS target. Default 24 */
  fps?: number;
  /** Frosted-glass blur strength (0 = sharp). Default 0 */
  bgBlur?: number;
  /**
   * Vertical anchor when the image is taller than the viewport after
   * object-fit:cover scaling. 'top' pins the top edge; 'center' (default)
   * centres vertically.
   */
  backgroundContentPosition?: 'center' | 'top';
}

export interface RainyGlassRef {
  pause: () => void;
  resume: () => void;
  reset: () => void;
}

interface Props extends RainyGlassUniforms {
  source: ImageSourcePropType;
  style?: object;
  /** When false the animation is paused. Default true */
  enabled?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULTS = {
  maxDrops: 100,
  spawnInterval: 50,
  spawnChance: 0.5,
  gravityThreshold: 3,
  dropMinRadius: 20,
  dropMaxRadius: 20,
  dropScale: 1.2,
  lightPosition: { x: 0.5, y: 0.8 },
  lightColor: { r: 1, g: 1, b: 1 },
  fps: 24,
  bgBlur: 0,
  backgroundContentPosition: 'center' as const,
};

const POOL_ROTATE_AT = 0.9; // recycle when pool is 90 % full

// ─────────────────────────────────────────────────────────────────────────────
// Drop physics pool  (fixed-size typed arrays — zero runtime allocation)
// ─────────────────────────────────────────────────────────────────────────────

interface DropPool {
  x: Float32Array; y: Float32Array; r: Float32Array;
  yspeed: Float32Array; xspeed: Float32Array;
  seed: Int32Array;
  skipping: Uint8Array; slowing: Uint8Array;
  collided: Uint8Array; alive: Uint8Array;
  trailY: Float32Array;
}

function allocPool(n: number): DropPool {
  return {
    x: new Float32Array(n), y: new Float32Array(n), r: new Float32Array(n),
    yspeed: new Float32Array(n), xspeed: new Float32Array(n),
    seed: new Int32Array(n),
    skipping: new Uint8Array(n), slowing: new Uint8Array(n),
    collided: new Uint8Array(n), alive: new Uint8Array(n),
    trailY: new Float32Array(n),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cover-mapping helper  (CPU-side, called once on resize / image-load)
//
// Returns uBgScale and uBgOffset such that:
//   texUV = screenUV * scale + offset
// reproduces object-fit:cover for any viewport / image AR combination.
// ─────────────────────────────────────────────────────────────────────────────

function computeCoverMapping(
  viewW: number, viewH: number,
  imgW: number, imgH: number,
  yAlign: 'center' | 'top',
): { scale: [number, number]; offset: [number, number] } {
  const viewAR = viewW / viewH;
  const imgAR = imgW / imgH;

  if (viewAR > imgAR) {
    // viewport wider than image → fit width, letterbox top/bottom
    const s = viewAR / imgAR;  // scale factor > 1
    const offsetY = yAlign === 'top' ? 0 : (1 - 1 / s) * 0.5;
    return { scale: [1, 1 / s], offset: [0, offsetY] };
  } else {
    // viewport taller than image → fit height, pillarbox left/right
    const s = imgAR / viewAR;  // scale factor > 1
    return { scale: [1 / s, 1], offset: [(1 - 1 / s) * 0.5, 0] };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// GLSL — background shader
// ─────────────────────────────────────────────────────────────────────────────

const BG_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const BG_FRAG = /* glsl */`
  precision mediump float;

  uniform sampler2D uBgTexture;
  uniform vec2      uBgScale;
  uniform vec2      uBgOffset;
  uniform float     uBlur;

  varying vec2 vUv;

  vec2 coverUV(vec2 uv) {
    return clamp(uv * uBgScale + uBgOffset, 0.001, 0.999);
  }

  void main() {
    if (uBlur < 0.0001) {
      gl_FragColor = texture2D(uBgTexture, coverUV(vUv));
      return;
    }
    float s = uBlur;
    vec4 col =
        texture2D(uBgTexture, coverUV(vUv + vec2(-s,-s)))
      + texture2D(uBgTexture, coverUV(vUv + vec2( 0,-s)))
      + texture2D(uBgTexture, coverUV(vUv + vec2( s,-s)))
      + texture2D(uBgTexture, coverUV(vUv + vec2(-s, 0)))
      + texture2D(uBgTexture, coverUV(vUv             )) * 2.0
      + texture2D(uBgTexture, coverUV(vUv + vec2( s, 0)))
      + texture2D(uBgTexture, coverUV(vUv + vec2(-s, s)))
      + texture2D(uBgTexture, coverUV(vUv + vec2( 0, s)))
      + texture2D(uBgTexture, coverUV(vUv + vec2( s, s)));
    gl_FragColor = col / 10.0;
  }
`;

// ─────────────────────────────────────────────────────────────────────────────
// GLSL — drop vertex shader
//
// aCenter is in logical pixels. Converts to NDC via uResolution + uPixelRatio.
// vDropUV is screen-space UV [0,1] matching the fullscreen BG quad (same as vUv mapping).
// ─────────────────────────────────────────────────────────────────────────────

const DROP_VERT = /* glsl */`
  precision highp float;

  attribute vec2  aCenter;  // logical px
  attribute float aRadius;  // logical px
  attribute float aYSpeed;
  attribute float aAlive;

  uniform vec2  uResolution;  // physical px (drawingBuffer)
  uniform float uPixelRatio;

  varying vec2  vUV;       // [-1,1] local to drop silhouette
  varying vec2  vDropUV;   // [0,1] screen UV of this fragment
  varying float vRadius;
  varying float vYSpeed;

  void main() {
    if (aAlive < 0.5) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    vUV = uv * 2.0 - 1.0;

    vec2  cPx    = aCenter * uPixelRatio;
    float rPx    = aRadius * uPixelRatio;
    vec2  ndcC   = cPx / uResolution * 2.0 - 1.0;
    ndcC.y       = -ndcC.y;  // GL vs screen Y

    vec2  ndcPos = ndcC + position.xy * (rPx * 2.2 / uResolution);
    gl_Position  = vec4(ndcPos, 0.0, 1.0);

    vDropUV      = ndcPos * 0.5 + 0.5;

    vRadius = aRadius;
    vYSpeed = aYSpeed;
  }
`;

// ─────────────────────────────────────────────────────────────────────────────
// GLSL — drop fragment shader
//
// Uses the same coverUV() as BG_FRAG (identical uBgScale / uBgOffset uniforms)
// so every refracted background sample is guaranteed to be the correct texel.
//
// Lighting: rainyday-ish base +
//   contactShadow — bottom rim + opposite-light emphasis (glass contact)
//   innerRimDark  — thin dark outline, boosted next to specular on the silhouette
// ─────────────────────────────────────────────────────────────────────────────

const DROP_FRAG = /* glsl */`
  precision highp float;

  uniform sampler2D uBgTexture;
  uniform vec2      uResolution;
  uniform float     uPixelRatio;
  uniform vec2      uBgScale;
  uniform vec2      uBgOffset;
  uniform vec2      uLightPos;
  uniform vec3      uLightColor;
  uniform float     uTime;

  varying vec2  vUV;
  varying vec2  vDropUV;
  varying float vRadius;
  varying float vYSpeed;

  vec2 coverUV(vec2 screenUv) {
    return clamp(screenUv * uBgScale + uBgOffset, 0.001, 0.999);
  }

  void main() {
    // ── Silhouette  ────────────────────────────────────────────────────────
    float stretch = 1.0 + 0.14 * clamp(vYSpeed / 6.0, 0.0, 1.0);
    vec2  sq      = vec2(vUV.x, vUV.y * stretch);
    float qr      = length(sq);
    if (qr >= 1.002) discard;
    float mask    = 1.0 - smoothstep(0.97, 1.0, qr);

    // ── Hemisphere normal  ─────────────────────────────────────────────────
    float zm  = sqrt(max(1.0 - qr * qr, 1e-5));
    vec3  N   = normalize(vec3(sq.x, sq.y, zm));
    vec3  V   = vec3(0.0, 0.0, 1.0);

    // ── Light direction  ───────────────────────────────────────────────────
    float bufAR = uResolution.x / max(uResolution.y, 1.0);
    vec2  lDelt = uLightPos - vDropUV;
    vec3  L     = normalize(vec3(lDelt.x * 1.15, -lDelt.y * bufAR * 1.15, 0.72));

    // ── Refraction + mirror reflection — both use coverUV  ─────────────────
    vec2  logRes = uResolution / max(uPixelRatio, 0.25);
    float pl     = 0.52 * vRadius / max(min(logRes.x, logRes.y), 1.0);
    vec3  I      = vec3(0.0, 0.0, -1.0);

    vec3 Tr = refract(I, N, 1.0 / 1.33);
    if (dot(Tr, Tr) < 1e-8) Tr = reflect(I, N);
    vec3 base = texture2D(uBgTexture,
      coverUV(vDropUV + Tr.xy * pl / max(abs(Tr.z), 0.12))).rgb;

    vec3 Rm   = reflect(I, N);
    vec3 refl = texture2D(uBgTexture,
      coverUV(vDropUV + Rm.xy * pl * 0.38 / max(abs(Rm.z), 0.12))).rgb;

    // ── Fresnel  ───────────────────────────────────────────────────────────
    float NdotV   = max(dot(N, V), 0.0);
    float fresnel = 0.035 + 0.965 * pow(1.0 - NdotV, 5.0);

    // ── Specular  ──────────────────────────────────────────────────────────
    vec3  H    = normalize(L + V);
    float spec = pow(max(dot(N,  H), 0.0), 96.0);
    float spe2 = pow(max(dot(reflect(-L, N), V), 0.0), 44.0);

    // ── Diffuse + hemispherical crescent away from light  ──────────────────
    float NdotL      = max(dot(N, L), 0.0);
    float diffLift   = mix(0.26, 1.0, NdotL);
    float shadowBand = pow(1.0 - NdotL, 1.85) * 0.46;

    // ── Contact / volume shadow: bottom of silhouette + opposing light ───────
    // Plane UV: sq.y negative → fragment toward screen bottom → glass contact band.
    float nearSil    = smoothstep(0.58, 0.994, qr);
    float bottomCres = clamp((-sq.y - 0.06) / 0.72, 0.0, 1.0);
    float opposeLight = pow(1.0 - NdotL, 1.35);
    float contactShadow =
      nearSil * clamp(0.55 * bottomCres + 0.42 * opposeLight, 0.0, 1.0);
    contactShadow = min(contactShadow * 1.06, 0.78);

    // ── Inner rim: perimeter darkening, extra band beside specular lobe ────
    float rimBand    = smoothstep(0.78, 0.992, qr);
    float specNear   = pow(max(dot(N, H), 0.0), 4.5);
    float litFacing  = smoothstep(0.28, 0.9, NdotL);
    // Sharp dark line hugging outline where highlight hits the edge
    float rimBySpec =
      rimBand * litFacing * clamp(specNear * 4.8 + spe2 * 2.8, 0.0, 1.0);
    float perimeterRim =
      rimBand * smoothstep(0.93, 0.997, qr) * (0.34 + 0.28 * litFacing);
    float innerRimDark = clamp(0.62 * rimBySpec + perimeterRim * 0.85, 0.0, 0.72);

    // ── Global light glow (far → transparent, near → 99 % lit)  ───────────
    float glo = pow(1.0 - clamp(length(vDropUV - uLightPos) / 0.88, 0.0, 1.0), 1.15);

    // ── Composite  ─────────────────────────────────────────────────────────
    vec3 col = base * diffLift;
    col = mix(col, refl, fresnel * 0.28);
    float shadeAmt = clamp(shadowBand + contactShadow * 0.92 + innerRimDark * 0.88, 0.0, 0.92);
    col *= (1.0 - shadeAmt);
    col += uLightColor * (spec * 0.7 + spe2 * 0.42) * glo;
    col += uLightColor * fresnel * 0.1;
    col  = clamp(col, 0.0, 1.0);

    float alpha = mask * mix(0.09, 0.62, NdotV)
                + mask * fresnel * 0.38
                + mask * (spec + spe2) * 0.48;

    gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
  }
`;

// ─────────────────────────────────────────────────────────────────────────────
// Asset helper — resolve intrinsic image dimensions from bundled require()
// ─────────────────────────────────────────────────────────────────────────────

async function resolveImageSize(
  src: ImageSourcePropType,
): Promise<{ width: number; height: number } | null> {
  if (typeof src !== 'number') return null;
  try {
    const asset = Asset.fromModule(src);
    if (!(asset.width && asset.height)) await asset.downloadAsync();
    if (asset.width && asset.height) return { width: asset.width, height: asset.height };
  } catch { /* ignore */ }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

const RainyGlass = forwardRef<RainyGlassRef, Props>(function RainyGlass(props, ref) {
  const {
    source,
    style,
    enabled = true,
    maxDrops = DEFAULTS.maxDrops,
    spawnInterval = DEFAULTS.spawnInterval,
    spawnChance = DEFAULTS.spawnChance,
    gravityThreshold = DEFAULTS.gravityThreshold,
    dropMinRadius = DEFAULTS.dropMinRadius,
    dropMaxRadius = DEFAULTS.dropMaxRadius,
    dropScale = DEFAULTS.dropScale,
    lightPosition = DEFAULTS.lightPosition,
    lightColor = DEFAULTS.lightColor,
    fps = DEFAULTS.fps,
    bgBlur = DEFAULTS.bgBlur,
    backgroundContentPosition = DEFAULTS.backgroundContentPosition,
  } = props;

  // ── Renderer / scene ──────────────────────────────────────────────────────
  const glRef = useRef<WebGLRenderingContext | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.OrthographicCamera | null>(null);

  // ── Animation control ─────────────────────────────────────────────────────
  const rafRef = useRef(0);
  const pausedRef = useRef(!enabled);
  const frameRef = useRef<() => void>(() => { }); // stable RAF target

  // ── Physics constants (derived from fps, matching rainyday.js) ────────────
  const lastSpawnRef = useRef(0);
  const GFY = useRef((fps * 0.001) / 25);
  const GFX = useRef(0);

  // ── Drop pool ─────────────────────────────────────────────────────────────
  const poolRef = useRef<DropPool>(allocPool(maxDrops));
  const activeRef = useRef(0);
  const nextSlotRef = useRef(0);

  // ── GPU instance attributes ───────────────────────────────────────────────
  const meshRef = useRef<THREE.InstancedMesh | null>(null);
  const attrCenter = useRef<THREE.InstancedBufferAttribute | null>(null);
  const attrRadius = useRef<THREE.InstancedBufferAttribute | null>(null);
  const attrYSpeed = useRef<THREE.InstancedBufferAttribute | null>(null);
  const attrAlive = useRef<THREE.InstancedBufferAttribute | null>(null);

  // ── Layout / image size (used by cover-mapping) ───────────────────────────
  const dprRef = useRef(Math.max(PixelRatio.get(), 1));
  const viewSizeRef = useRef({ w: 0, h: 0 });
  const imgSizeRef = useRef({ w: 1, h: 1 });

  // ── Uniforms — single source of truth, mutated in-place ──────────────────
  const uniformsRef = useRef<Record<string, THREE.IUniform>>({
    uBgTexture: { value: null },
    uResolution: { value: new THREE.Vector2(1, 1) },
    uPixelRatio: { value: dprRef.current },
    uBgScale: { value: new THREE.Vector2(1, 1) },
    uBgOffset: { value: new THREE.Vector2(0, 0) },
    uBlur: { value: bgBlur },
    uLightPos: { value: new THREE.Vector2(lightPosition.x, lightPosition.y) },
    uLightColor: { value: new THREE.Vector3(lightColor.r, lightColor.g, lightColor.b) },
    uTime: { value: 0 },
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Cover-mapping updater — pushes uBgScale / uBgOffset to both shaders
  // ─────────────────────────────────────────────────────────────────────────
  const updateCoverMapping = useCallback(() => {
    const { w: vw, h: vh } = viewSizeRef.current;
    const { w: iw, h: ih } = imgSizeRef.current;
    if (!(vw > 0 && vh > 0 && iw > 0 && ih > 0)) return;
    const { scale, offset } = computeCoverMapping(vw, vh, iw, ih, backgroundContentPosition);
    (uniformsRef.current.uBgScale.value as THREE.Vector2).set(scale[0], scale[1]);
    (uniformsRef.current.uBgOffset.value as THREE.Vector2).set(offset[0], offset[1]);
  }, [backgroundContentPosition]);

  // ── Prop-sync effects ─────────────────────────────────────────────────────
  useEffect(() => { uniformsRef.current.uBlur.value = bgBlur; }, [bgBlur]);
  useEffect(() => {
    (uniformsRef.current.uLightPos.value as THREE.Vector2).set(lightPosition.x, lightPosition.y);
    (uniformsRef.current.uLightColor.value as THREE.Vector3).set(lightColor.r, lightColor.g, lightColor.b);
  }, [lightPosition, lightColor]);
  useEffect(() => { updateCoverMapping(); }, [backgroundContentPosition, updateCoverMapping]);

  // ── Layout handler ────────────────────────────────────────────────────────
  const onContainerLayout = useCallback((e: LayoutChangeEvent) => {
    const { width: lw, height: lh } = e.nativeEvent.layout;
    if (!(lw > 1 && lh > 1)) return;
    viewSizeRef.current = { w: lw, h: lh };
    updateCoverMapping();
  }, [updateCoverMapping]);

  // ─────────────────────────────────────────────────────────────────────────
  // Pool management
  // ─────────────────────────────────────────────────────────────────────────
  const resetPool = useCallback(() => {
    const p = poolRef.current;
    p.alive.fill(0); p.x.fill(0); p.y.fill(0); p.r.fill(0);
    p.yspeed.fill(0); p.xspeed.fill(0); p.seed.fill(0);
    p.skipping.fill(0); p.slowing.fill(0); p.collided.fill(0); p.trailY.fill(0);
    activeRef.current = 0;
    nextSlotRef.current = 0;
  }, []);

  const spawnDrop = useCallback((
    cW: number, cH: number,
    cx?: number, cy?: number,
    minR = 3, baseR = 5,
  ) => {
    const p = poolRef.current;
    const n = maxDrops;

    // Find a free slot (ring-buffer scan, then forced rotation)
    let slot = -1;
    const start = nextSlotRef.current;
    for (let i = 0; i < n; i++) {
      const idx = (start + i) % n;
      if (!p.alive[idx]) { slot = idx; break; }
    }
    if (slot === -1) {
      if (activeRef.current >= n * POOL_ROTATE_AT) slot = nextSlotRef.current;
      else return;
    }
    nextSlotRef.current = (slot + 1) % n;

    const wasAlive = p.alive[slot];
    p.x[slot] = cx ?? Math.random() * cW;
    p.y[slot] = cy ?? Math.random() * cH;
    p.r[slot] = Math.ceil(Math.random() * baseR + minR);
    p.yspeed[slot] = 0;
    p.xspeed[slot] = 0;
    p.seed[slot] = 0;
    p.skipping[slot] = 0;
    p.slowing[slot] = 0;
    p.collided[slot] = 0;
    p.trailY[slot] = p.y[slot];
    p.alive[slot] = 1;
    if (!wasAlive) activeRef.current = Math.min(activeRef.current + 1, n);
  }, [maxDrops]);

  // ── Imperative handle ─────────────────────────────────────────────────────
  useImperativeHandle(ref, () => ({
    pause: () => { pausedRef.current = true; cancelAnimationFrame(rafRef.current); },
    resume: () => {
      if (pausedRef.current) {
        pausedRef.current = false;
        lastSpawnRef.current = performance.now();
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(frameRef.current);
      }
    },
    reset: resetPool,
  }));

  // ── enabled prop ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (enabled === false) {
      pausedRef.current = true;
      cancelAnimationFrame(rafRef.current);
    } else if (glRef.current && rendererRef.current) {
      pausedRef.current = false;
      cancelAnimationFrame(rafRef.current);
      lastSpawnRef.current = performance.now();
      rafRef.current = requestAnimationFrame(frameRef.current);
    }
  }, [enabled]);

  // ─────────────────────────────────────────────────────────────────────────
  // Physics — GRAVITY_NON_LINEAR + TRAIL_DROPS + COLLISION_SIMPLE
  // ─────────────────────────────────────────────────────────────────────────
  const stepPhysics = useCallback((cW: number, cH: number) => {
    const p = poolRef.current;
    const n = maxDrops;
    const gfy = GFY.current;
    const gfx = GFX.current;
    const gTh = gravityThreshold * dropScale;
    let alive = 0;

    for (let i = 0; i < n; i++) {
      if (!p.alive[i]) continue;
      const r = p.r[i];

      if (r > gTh) {
        // Gravity FSM (rainyday.js GRAVITY_NON_LINEAR)
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
            p.yspeed[i] /= 1.1; p.xspeed[i] /= 1.1;
            if (p.yspeed[i] < gfy) p.slowing[i] = 0;
          } else if (p.skipping[i]) {
            p.yspeed[i] = gfy; p.xspeed[i] = gfx;
          } else {
            p.yspeed[i] += gfy * Math.floor(r);
            p.xspeed[i] += gfx * Math.floor(r);
          }
        } else {
          p.yspeed[i] = gfy; p.xspeed[i] = gfx;
        }

        p.y[i] += Math.floor(p.yspeed[i]);
        p.x[i] += Math.floor(p.xspeed[i]);

        // Trail drops
        if (!p.trailY[i] || p.y[i] - p.trailY[i] >= Math.random() * 100 * r) {
          p.trailY[i] = p.y[i];
          const tr = Math.ceil(r / 5);
          if (tr >= 1) {
            spawnDrop(
              cW, cH,
              Math.floor(p.x[i] + (Math.random() * 2 - 1) * Math.random()),
              p.y[i] - r - 5,
              tr, 0,
            );
          }
        }
      }

      // Cull out-of-bounds
      if (p.y[i] - r > cH || p.x[i] - r > cW || p.x[i] + r < 0) {
        p.alive[i] = 0; continue;
      }
      alive++;
    }

    // Collision — O(n²), acceptable for n ≤ 200
    for (let i = 0; i < n; i++) {
      if (!p.alive[i] || p.r[i] <= gTh) continue;
      for (let j = i + 1; j < n; j++) {
        if (!p.alive[j] || p.r[j] <= gTh || p.y[j] <= p.y[i]) continue;
        const dx = p.x[i] - p.x[j], dy = p.y[i] - p.y[j];
        const rs = p.r[i] + p.r[j];
        if (Math.abs(dx) < rs && Math.abs(dy) < rs && Math.sqrt(dx * dx + dy * dy) < rs) {
          const lo = p.y[i] > p.y[j] ? i : j;
          const hi = lo === i ? j : i;
          p.r[lo] = Math.max(p.r[lo], p.r[hi]) * 1.001;
          p.alive[hi] = 0;
          p.collided[lo] = 1;
        }
      }
    }

    activeRef.current = alive;
  }, [maxDrops, gravityThreshold, fps, dropScale, spawnDrop]);

  // ─────────────────────────────────────────────────────────────────────────
  // GPU upload
  // ─────────────────────────────────────────────────────────────────────────
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
      cArr[i * 2] = p.x[i]; cArr[i * 2 + 1] = p.y[i];
      rArr[i] = p.r[i];
      yArr[i] = p.yspeed[i];
      aArr[i] = p.alive[i];
    }
    ac.needsUpdate = ar.needsUpdate = ay.needsUpdate = aa.needsUpdate = true;
  }, [maxDrops]);

  // ─────────────────────────────────────────────────────────────────────────
  // Animation frame
  // ─────────────────────────────────────────────────────────────────────────
  const frame = useCallback(() => {
    if (pausedRef.current) return;
    const renderer = rendererRef.current;
    const scene = sceneRef.current;
    const camera = cameraRef.current;
    if (!renderer || !scene || !camera) return;

    const now = performance.now();
    const dpr = dprRef.current;
    const res = uniformsRef.current.uResolution.value as THREE.Vector2;
    const wLog = res.x / dpr;
    const hLog = res.y / dpr;

    if (now - lastSpawnRef.current >= spawnInterval) {
      lastSpawnRef.current = now;
      if (Math.random() < spawnChance) {
        const minR = dropMinRadius * dropScale;
        const baseR = Math.max(1, (dropMaxRadius - dropMinRadius) * dropScale);
        spawnDrop(wLog, hLog, undefined, undefined, minR, baseR);
      }
    }

    stepPhysics(wLog, hLog);
    uploadInstances();
    uniformsRef.current.uTime.value = now * 0.001;

    renderer.render(scene, camera);
    (glRef.current as (WebGLRenderingContext & { endFrameEXP?: () => void }) | null)
      ?.endFrameEXP?.();

    rafRef.current = requestAnimationFrame(frameRef.current);
  }, [
    spawnInterval, spawnChance,
    dropMinRadius, dropMaxRadius, dropScale,
    spawnDrop, stepPhysics, uploadInstances,
  ]);

  frameRef.current = frame; // keep stable RAF target in sync

  // ─────────────────────────────────────────────────────────────────────────
  // GL context setup
  // ─────────────────────────────────────────────────────────────────────────
  const onContextCreate = useCallback(async (gl: WebGLRenderingContext) => {
    glRef.current = gl;
    const { drawingBufferWidth: W, drawingBufferHeight: H } = gl;

    dprRef.current = Math.max(PixelRatio.get(), 0.5);
    uniformsRef.current.uPixelRatio.value = dprRef.current;
    uniformsRef.current.uResolution.value.set(W, H);

    // Renderer & scene
    const renderer = new Renderer({ gl });
    renderer.setSize(W, H);
    renderer.setClearColor(0x000000, 0);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    sceneRef.current = scene;
    cameraRef.current = camera;

    // Background texture
    let bgTexture: THREE.Texture;
    try {
      const { TextureLoader } = await import('expo-three');
      bgTexture = await new TextureLoader().loadAsync(source as string);
      bgTexture.needsUpdate = true;
    } catch {
      bgTexture = new THREE.DataTexture(
        new Uint8Array([180, 200, 220, 255]), 1, 1, THREE.RGBAFormat,
      );
      bgTexture.needsUpdate = true;
    }
    uniformsRef.current.uBgTexture.value = bgTexture;

    // Resolve intrinsic image size → compute cover mapping
    const imgSize = await resolveImageSize(source);
    if (imgSize) {
      imgSizeRef.current = { w: imgSize.width, h: imgSize.height };
    } else {
      const img = bgTexture.image as { width?: number; height?: number } | undefined;
      if (img?.width && img?.height) imgSizeRef.current = { w: img.width, h: img.height };
    }
    updateCoverMapping();

    // Sync remaining uniforms
    uniformsRef.current.uBlur.value = bgBlur;
    (uniformsRef.current.uLightPos.value as THREE.Vector2).set(lightPosition.x, lightPosition.y);
    (uniformsRef.current.uLightColor.value as THREE.Vector3).set(lightColor.r, lightColor.g, lightColor.b);

    // Background plane — only needs the 4 BG-specific uniforms
    const bgUniforms = {
      uBgTexture: uniformsRef.current.uBgTexture,
      uBgScale: uniformsRef.current.uBgScale,
      uBgOffset: uniformsRef.current.uBgOffset,
      uBlur: uniformsRef.current.uBlur,
    };
    const bgMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        vertexShader: BG_VERT,
        fragmentShader: BG_FRAG,
        uniforms: bgUniforms,
        depthWrite: false, depthTest: false,
      }),
    );
    bgMesh.renderOrder = 0;
    scene.add(bgMesh);

    // Drop instanced mesh
    const n = maxDrops;
    const mkAttr = (count: number, components: number) => {
      const a = new THREE.InstancedBufferAttribute(
        new Float32Array(count * components), components,
      );
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };

    const dropGeo = new THREE.PlaneGeometry(2, 2);
    const iaCenter = mkAttr(n, 2);
    const iaRadius = mkAttr(n, 1);
    const iaYSpeed = mkAttr(n, 1);
    const iaAlive = mkAttr(n, 1);

    dropGeo.setAttribute('aCenter', iaCenter);
    dropGeo.setAttribute('aRadius', iaRadius);
    dropGeo.setAttribute('aYSpeed', iaYSpeed);
    dropGeo.setAttribute('aAlive', iaAlive);

    attrCenter.current = iaCenter;
    attrRadius.current = iaRadius;
    attrYSpeed.current = iaYSpeed;
    attrAlive.current = iaAlive;

    const dropMesh = new THREE.InstancedMesh(
      dropGeo,
      new THREE.ShaderMaterial({
        vertexShader: DROP_VERT,
        fragmentShader: DROP_FRAG,
        uniforms: uniformsRef.current, // includes uBgScale + uBgOffset
        transparent: true,
        depthWrite: false,
        depthTest: false,
        blending: THREE.NormalBlending,
      }),
      n,
    );
    dropMesh.renderOrder = 1;
    dropMesh.frustumCulled = false;
    meshRef.current = dropMesh;
    scene.add(dropMesh);

    resetPool();
    lastSpawnRef.current = performance.now();
    if (!pausedRef.current) {
      rafRef.current = requestAnimationFrame(frameRef.current);
    }
  }, [source, maxDrops, bgBlur, lightPosition, lightColor, resetPool, updateCoverMapping]);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  useEffect(() => () => {
    pausedRef.current = true;
    cancelAnimationFrame(rafRef.current);
    rendererRef.current?.dispose();
    meshRef.current?.geometry.dispose();
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <View style={[styles.container, style]} onLayout={onContainerLayout}>
      <GLView style={StyleSheet.absoluteFill} onContextCreate={onContextCreate} />
    </View>
  );
});

export default RainyGlass;

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    overflow: 'hidden',
  },
});

// ─────────────────────────────────────────────────────────────────────────────
// Usage
//
//  import RainyGlass, { RainyGlassRef } from './RainyGlass.three';
//
//  const ref = useRef<RainyGlassRef>(null);
//
//  <RainyGlass
//    ref={ref}
//    source={require('./assets/window.jpg')}
//    style={{ width: '100%', height: 400 }}
//    maxDrops={120}
//    spawnInterval={60}
//    spawnChance={0.6}
//    gravityThreshold={3}
//    dropMinRadius={3}
//    dropMaxRadius={8}
//    dropScale={1.4}
//    bgBlur={0.002}
//    lightPosition={{ x: 0.3, y: 0.85 }}
//    lightColor={{ r: 1.0, g: 0.97, b: 0.9 }}
//    backgroundContentPosition="center"
//    fps={24}
//  />
//
//  ref.current?.pause();
//  ref.current?.resume();
//  ref.current?.reset();
// ─────────────────────────────────────────────────────────────────────────────
