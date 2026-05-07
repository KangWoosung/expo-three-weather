/**
 * RainDropFX.three.tsx
 *
 * raindrop-fx (SardineFish/raindrop-fx) → RN Expo-GL + Three.js faithful port
 *
 * ── 원본 raindrop-fx 알고리즘 분석 ───────────────────────────────────────────
 *
 * raindrop-fx 는 두 개의 핵심 GPU 패스로 구성됩니다.
 *
 * [Pass 1] Normal Accumulation  (offscreen RenderTarget)
 *   각 빗방울을 "반구 노멀맵 스프라이트"로 NormalRT 에 누적.
 *   - 노멀 인코딩: R=Nx, G=Ny  (0.5 = flat), A = opacity mask
 *   - 방울 형상: 정지 = 원, 낙하 = 수직으로 늘어진 teardrop
 *   - smoother 모드: additive blend → 인접 방울 노멀이 합산되어
 *     메타볼처럼 "뭉쳐 보이는" 효과
 *   - 작은 droplet(미세 물방울)도 동일 RT에 작은 반구로 누적
 *
 * [Pass 2] Composite / Refraction  (screen)
 *   NormalRT R/G → UV offset → 배경 텍스처 왜곡 샘플링 (굴절).
 *   - mask 외부: 블러 배경 (frosted glass)
 *   - mask 내부: 굴절된 선명한 배경 + Blinn-Phong 라이팅
 *   - 라이팅: diffuse(NdotL) + specular(Blinn-Phong) + shadow crescent
 *
 * [CPU Simulation]  — GRAVITY_NON_LINEAR 변형
 *   각 Drop: position, radius, mass, velocity, spread, slipState, trailY
 *   - slipRate: 정지 → 낙하 전환 확률
 *   - motionInterval FSM: 정지↔낙하 주기적 전환
 *   - 충돌: colliderSize 반경 내 인접 drop 흡수 (큰 쪽 생존)
 *   - 증발: evaporate px²/s 로 mass 감소 → r 감소 → 소멸
 *   - Trail: 낙하 중 trailDistance 간격마다 작은 drop 스폰
 *
 * ── Three.js 구현 전략 ───────────────────────────────────────────────────────
 *   NormalRT   : WebGLRenderTarget + InstancedMesh (NORMAL_VERT/FRAG)
 *   Composite  : fullscreen PlaneGeometry (COMPOSITE_VERT/FRAG)
 *   CPU Pool   : 고정 크기 TypedArray (runtime allocation 없음)
 *   Background : expo-asset 으로 로드, computeCoverMapping 으로 AR 유지
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

export interface RainDropFXOptions {
  // ── Simulation ─────────────────────────────────────────────────────────────
  /** Spawn interval [min, max] seconds. Default [0.1, 0.2] */
  spawnInterval?: [number, number];
  /** Drop diameter range [min, max] logical px. Default [30, 80] */
  spawnSize?: [number, number];
  /** Max live primary drops (pool hard cap). Default 200 */
  spawnLimit?: number;
  /** Probability stationary drop starts sliding each FSM tick. Default 0.5 */
  slipRate?: number;
  /** Time between motion-state changes [min, max] seconds. Default [0.1, 0.4] */
  motionInterval?: [number, number];
  /** Horizontal velocity relative to vertical [min, max]. Default [0, 0.1] */
  xShifting?: [number, number];
  /** Collision radius multiplier. Default 1.0 */
  colliderSize?: number;
  /** Mass lost per trail drop. Default 0.2 */
  trailDropDensity?: number;
  /** Trail drop size fraction of parent [min, max]. Default [0.3, 0.5] */
  trailDropSize?: [number, number];
  /** Distance between trail drops [min, max] px. Default [20, 30] */
  trailDistance?: [number, number];
  /** Vertical spread of trail drops. Default 0.6 */
  trailSpread?: number;
  /** Initial spread on spawn hit. Default 0.5 */
  initialSpread?: number;
  /** Spread shrink rate per second. Default 0.01 */
  shrinkRate?: number;
  /** Spread added by downward velocity. Default 0.3 */
  velocitySpread?: number;
  /** Mass evaporation per second (px²/s). Default 10 */
  evaporate?: number;
  /** Gravity acceleration px/s². Default 2400 */
  gravity?: number;

  // ── Rendering ──────────────────────────────────────────────────────────────
  /** Background blur mip-bias (0 = sharp). Default 3 */
  backgroundBlurSteps?: number;
  /** Micro-droplet spawn rate per second. Default 300 */
  dropletsPerSeconds?: number;
  /** Micro-droplet radius range [min, max] px. Default [3, 10] */
  dropletSize?: [number, number];
  /** Drop edge smoothstep range [a, b]. Default [0.96, 0.99] */
  smoothRaindrop?: [number, number];
  /** Base refraction UV offset scale. Default 0.4 */
  refractBase?: number;
  /** Size-scaled refraction UV offset. Default 0.6 */
  refractScale?: number;
  /** Light [x,y,z,w] — w=0 direction, w=1 position in screen UV. Default [-1,1,2,0] */
  raindropLightPos?: [number, number, number, number];
  /** Lambertian diffuse color [r,g,b]. Default [0.2, 0.2, 0.2] */
  raindropDiffuseLight?: [number, number, number];
  /** Shadow darkening threshold. Default 0.8 */
  raindropShadowOffset?: number;
  /** Specular color [r,g,b]. Default [0,0,0] (disabled) */
  raindropSpecularLight?: [number, number, number];
  /** Blinn-Phong shininess. Default 256 */
  raindropSpecularShininess?: number;
  /** Normal bump scale — larger = flatter. Default 0.6 */
  raindropLightBump?: number;
  /** Vertical anchor when image is taller than viewport. Default 'center' */
  backgroundContentPosition?: 'center' | 'top';
}

export interface RainDropFXRef {
  pause: () => void;
  resume: () => void;
  reset: () => void;
}

interface Props extends RainDropFXOptions {
  source: ImageSourcePropType;
  style?: object;
  enabled?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults  (mirrors raindrop-fx internal defaults)
// ─────────────────────────────────────────────────────────────────────────────

const D: Required<RainDropFXOptions> = {
  spawnInterval:             [0.1, 0.2],
  spawnSize:                 [30, 80],
  spawnLimit:                200,
  slipRate:                  0.5,
  motionInterval:            [0.1, 0.4],
  xShifting:                 [0, 0.1],
  colliderSize:              1.0,
  trailDropDensity:          0.2,
  trailDropSize:             [0.3, 0.5],
  trailDistance:             [20, 30],
  trailSpread:               0.6,
  initialSpread:             0.5,
  shrinkRate:                0.01,
  velocitySpread:            0.3,
  evaporate:                 10,
  gravity:                   2400,
  backgroundBlurSteps:       3,
  dropletsPerSeconds:        300,
  dropletSize:               [3, 10],
  smoothRaindrop:            [0.96, 0.99],
  refractBase:               0.4,
  refractScale:              0.6,
  raindropLightPos:          [-1, 1, 2, 0],
  raindropDiffuseLight:      [0.2, 0.2, 0.2],
  raindropShadowOffset:      0.8,
  raindropSpecularLight:     [0, 0, 0],
  raindropSpecularShininess: 256,
  raindropLightBump:         0.6,
  backgroundContentPosition: 'center',
};

// Pool rotation: start recycling oldest when 90% full
const POOL_ROTATE_AT = 0.9;

// ─────────────────────────────────────────────────────────────────────────────
// Cover-mapping  (identical to RainyGlass approach)
// ─────────────────────────────────────────────────────────────────────────────

function computeCoverMapping(
  viewW: number, viewH: number,
  imgW: number, imgH: number,
  yAlign: 'center' | 'top',
): { scale: [number, number]; offset: [number, number] } {
  const va = viewW / viewH, ia = imgW / imgH;
  if (va > ia) {
    const s = va / ia;
    return { scale: [1, 1 / s], offset: [0, yAlign === 'top' ? 0 : (1 - 1 / s) * 0.5] };
  } else {
    const s = ia / va;
    return { scale: [1 / s, 1], offset: [(1 - 1 / s) * 0.5, 0] };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Drop pool  (fixed-size typed arrays — zero runtime allocation)
// ─────────────────────────────────────────────────────────────────────────────

interface DropPool {
  x:          Float32Array;
  y:          Float32Array;
  r:          Float32Array;
  mass:       Float32Array;
  vy:         Float32Array;
  vx:         Float32Array;
  spread:     Float32Array;
  trailY:     Float32Array;
  motionT:    Float32Array;
  slipping:   Uint8Array;
  alive:      Uint8Array;
  isDroplet:  Uint8Array;
}

function allocPool(n: number): DropPool {
  return {
    x:          new Float32Array(n),
    y:          new Float32Array(n),
    r:          new Float32Array(n),
    mass:       new Float32Array(n),
    vy:         new Float32Array(n),
    vx:         new Float32Array(n),
    spread:     new Float32Array(n),
    trailY:     new Float32Array(n),
    motionT:    new Float32Array(n),
    slipping:   new Uint8Array(n),
    alive:      new Uint8Array(n),
    isDroplet:  new Uint8Array(n),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// GLSL — Normal accumulation pass  (InstancedMesh → NormalRT)
//
// Each drop is a bounding-box quad; the fragment computes hemisphere normal
// at each covered pixel, discards outside the shape, and outputs:
//   R = Nx * 0.5 + 0.5
//   G = Ny * 0.5 + 0.5
//   A = mask (opacity)
//
// Blend mode: AdditiveBlending — adjacent drop normals sum together,
// mimicking raindrop-fx "smoother" compose mode (metaball-like merging).
// ─────────────────────────────────────────────────────────────────────────────

const NORMAL_VERT = /* glsl */`
  precision highp float;

  attribute vec2  aCenter;    // centre in logical px
  attribute float aRadius;    // radius  in logical px
  attribute float aSpread;    // 0..1 spread factor
  attribute float aStretch;   // 0..1.5 vertical elongation (falling drops)
  attribute float aAlive;

  uniform vec2  uResolution;  // physical px (drawingBuffer)
  uniform float uPixelRatio;

  varying vec2  vUV;      // [-1,1] local coords
  varying float vSpread;
  varying float vStretch;

  void main() {
    if (aAlive < 0.5) {
      // Clip dead instances to degenerate position
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      return;
    }

    vUV     = uv * 2.0 - 1.0;
    vSpread = aSpread;
    vStretch = aStretch;

    vec2  cPx  = aCenter * uPixelRatio;
    float rPx  = aRadius * uPixelRatio;

    vec2  ndcC = cPx / uResolution * 2.0 - 1.0;
    ndcC.y     = -ndcC.y;

    // Bounding quad grows with spread (wider) and stretch (taller)
    vec2 halfNDC = rPx / uResolution
      * vec2(2.2 + aSpread * 1.0, 2.2 + aStretch * 2.0 + aSpread * 1.0);

    gl_Position = vec4(ndcC + position.xy * halfNDC, 0.0, 1.0);
  }
`;

const NORMAL_FRAG = /* glsl */`
  precision highp float;

  uniform vec2 uSmoothRaindrop;  // [a, b] edge smoothstep

  varying vec2  vUV;
  varying float vSpread;
  varying float vStretch;

  void main() {
    // Vertical stretch for falling drops (teardrop silhouette)
    vec2  q = vec2(vUV.x, vUV.y / max(1.0 + vStretch, 1.0));
    float d = length(q);

    // Spread widens silhouette (edge moves outward)
    float edgeA = uSmoothRaindrop.x * (1.0 - vSpread * 0.4);
    float edgeB = uSmoothRaindrop.y * (1.0 - vSpread * 0.4);
    float mask  = 1.0 - smoothstep(edgeA, edgeB, d);
    if (mask < 0.002) discard;

    // Hemisphere (dome) normal at this UV point
    float zm = sqrt(max(1.0 - d * d, 1e-6));
    vec3  N  = normalize(vec3(q, zm));

    // Encode: 0.5 = flat, >0.5 = positive, <0.5 = negative
    gl_FragColor = vec4(N.x * 0.5 + 0.5, N.y * 0.5 + 0.5, 0.5, mask);
  }
`;

// ─────────────────────────────────────────────────────────────────────────────
// GLSL — Composite pass  (fullscreen quad, reads NormalRT + bg texture)
//
// 1. Decode N.xy from NormalRT
// 2. Compute refraction UV offset from N.xy
// 3. Sample bg texture at (screenUV + refractOffset) via coverUV()
// 4. Apply Blinn-Phong lighting with the decoded normal
// 5. Blend frosted background (blur approx) with lit drop at mask edges
// ─────────────────────────────────────────────────────────────────────────────

const COMPOSITE_VERT = /* glsl */`
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

const COMPOSITE_FRAG = /* glsl */`
  precision highp float;

  uniform sampler2D uBgTexture;
  uniform sampler2D uNormalRT;
  uniform vec2      uResolution;
  uniform vec2      uBgScale;
  uniform vec2      uBgOffset;
  uniform float     uRefractBase;
  uniform float     uRefractScale;
  uniform float     uBlurStrength;
  uniform vec4      uLightPos;        // xyz, w=0 dir / w=1 pos
  uniform vec3      uDiffuseLight;
  uniform vec3      uSpecularLight;
  uniform float     uShininess;
  uniform float     uShadowOffset;
  uniform float     uLightBump;

  varying vec2 vUv;

  // Same cover formula as background shader → correct texel per pixel
  vec2 coverUV(vec2 uv) {
    return clamp(uv * uBgScale + uBgOffset, 0.001, 0.999);
  }

  // 9-tap approximate blur for frosted-glass background
  vec3 blurBg(vec2 uv, float str) {
    float s = str * 0.0035;
    vec3 c =
        texture2D(uBgTexture, coverUV(uv + vec2(-s,-s))).rgb
      + texture2D(uBgTexture, coverUV(uv + vec2( 0,-s))).rgb
      + texture2D(uBgTexture, coverUV(uv + vec2( s,-s))).rgb
      + texture2D(uBgTexture, coverUV(uv + vec2(-s, 0))).rgb
      + texture2D(uBgTexture, coverUV(uv             )).rgb * 2.0
      + texture2D(uBgTexture, coverUV(uv + vec2( s, 0))).rgb
      + texture2D(uBgTexture, coverUV(uv + vec2(-s, s))).rgb
      + texture2D(uBgTexture, coverUV(uv + vec2( 0, s))).rgb
      + texture2D(uBgTexture, coverUV(uv + vec2( s, s))).rgb;
    return c / 10.0;
  }

  void main() {
    vec4  nSample = texture2D(uNormalRT, vUv);
    float mask    = nSample.a;

    vec3 bgBlur = blurBg(vUv, uBlurStrength);

    // Outside any drop → frosted background
    if (mask < 0.008) {
      gl_FragColor = vec4(bgBlur, 1.0);
      return;
    }

    // Decode surface normal from NormalRT
    vec3 N = normalize(vec3(
      (nSample.r - 0.5) * 2.0 * uLightBump,
      (nSample.g - 0.5) * 2.0 * uLightBump,
      1.0
    ));
    vec3 V = vec3(0.0, 0.0, 1.0);

    // Refraction: offset bg UV by surface normal XY (flip Y for GL convention)
    float refAmt = uRefractBase + uRefractScale * mask;
    vec2  refUV  = vUv + N.xy * refAmt * vec2(1.0, -1.0);
    vec3  bgDrop = texture2D(uBgTexture, coverUV(refUV)).rgb;

    // Light direction (direction mode or position mode)
    vec3 L;
    if (uLightPos.w < 0.5) {
      L = normalize(uLightPos.xyz);
    } else {
      vec2 lDelta = uLightPos.xy - vUv;
      L = normalize(vec3(lDelta, uLightPos.z * 0.5));
    }

    float NdotL  = max(dot(N, L), 0.0);
    float NdotV  = max(dot(N, V), 0.0);

    // Shadow crescent: darken the side away from light
    float shadow = smoothstep(0.0, 1.0, NdotL - uShadowOffset + 0.5);

    // Diffuse
    vec3 diffuse = uDiffuseLight * NdotL;

    // Specular (Blinn-Phong)
    vec3  H    = normalize(L + V);
    float spec = pow(max(dot(N, H), 0.0), uShininess);
    vec3 specular = uSpecularLight * spec;

    // Composite: refracted bg + lighting
    vec3 col = bgDrop * (vec3(1.0) - uDiffuseLight + diffuse) + specular;
    col     *= shadow;
    col      = clamp(col, 0.0, 1.0);

    // Blend at drop edges with blurred background
    col = mix(bgBlur, col, min(mask * 3.0, 1.0));

    gl_FragColor = vec4(col, 1.0);
  }
`;

// ─────────────────────────────────────────────────────────────────────────────
// Asset helper
// ─────────────────────────────────────────────────────────────────────────────

async function resolveImageSize(src: ImageSourcePropType) {
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

const RainDropFX = forwardRef<RainDropFXRef, Props>(function RainDropFX(props, ref) {
  const {
    source,
    style,
    enabled                   = true,
    spawnInterval             = D.spawnInterval,
    spawnSize                 = D.spawnSize,
    spawnLimit                = D.spawnLimit,
    slipRate                  = D.slipRate,
    motionInterval            = D.motionInterval,
    xShifting                 = D.xShifting,
    colliderSize              = D.colliderSize,
    trailDropDensity          = D.trailDropDensity,
    trailDropSize             = D.trailDropSize,
    trailDistance             = D.trailDistance,
    trailSpread               = D.trailSpread,
    initialSpread             = D.initialSpread,
    shrinkRate                = D.shrinkRate,
    velocitySpread            = D.velocitySpread,
    evaporate                 = D.evaporate,
    gravity                   = D.gravity,
    backgroundBlurSteps       = D.backgroundBlurSteps,
    dropletsPerSeconds        = D.dropletsPerSeconds,
    dropletSize               = D.dropletSize,
    smoothRaindrop            = D.smoothRaindrop,
    refractBase               = D.refractBase,
    refractScale              = D.refractScale,
    raindropLightPos          = D.raindropLightPos,
    raindropDiffuseLight      = D.raindropDiffuseLight,
    raindropShadowOffset      = D.raindropShadowOffset,
    raindropSpecularLight     = D.raindropSpecularLight,
    raindropSpecularShininess  = D.raindropSpecularShininess,
    raindropLightBump         = D.raindropLightBump,
    backgroundContentPosition  = D.backgroundContentPosition,
  } = props;

  // ── Renderer / scene ──────────────────────────────────────────────────────
  const glRef       = useRef<WebGLRenderingContext | null>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const sceneRef    = useRef<THREE.Scene | null>(null);      // composite
  const rtSceneRef  = useRef<THREE.Scene | null>(null);      // normal pass
  const camRef      = useRef<THREE.OrthographicCamera | null>(null);
  const rtCamRef    = useRef<THREE.OrthographicCamera | null>(null);
  const normalRTRef = useRef<THREE.WebGLRenderTarget | null>(null);

  // ── Animation ─────────────────────────────────────────────────────────────
  const rafRef    = useRef(0);
  const pausedRef = useRef(!enabled);
  const frameRef  = useRef<() => void>(() => {});

  // ── Physics timing ────────────────────────────────────────────────────────
  const lastTimeRef     = useRef(0);
  const spawnTimerRef   = useRef(0);
  const dropletAccRef   = useRef(0);  // fractional droplet accumulator

  // ── Drop pool ─────────────────────────────────────────────────────────────
  // Pool size: primary drops + micro-droplet budget (2s worth)
  const TOTAL_POOL  = spawnLimit + Math.min(Math.ceil(dropletsPerSeconds * 2), 800);
  const poolRef     = useRef<DropPool>(allocPool(TOTAL_POOL));
  const activeRef   = useRef(0);
  const nextSlotRef = useRef(0);

  // ── GPU instance attributes ───────────────────────────────────────────────
  const meshRef      = useRef<THREE.InstancedMesh | null>(null);
  const attrCenter   = useRef<THREE.InstancedBufferAttribute | null>(null);
  const attrRadius   = useRef<THREE.InstancedBufferAttribute | null>(null);
  const attrSpread   = useRef<THREE.InstancedBufferAttribute | null>(null);
  const attrStretch  = useRef<THREE.InstancedBufferAttribute | null>(null);
  const attrAlive    = useRef<THREE.InstancedBufferAttribute | null>(null);

  // ── Uniforms ──────────────────────────────────────────────────────────────
  const dprRef      = useRef(Math.max(PixelRatio.get(), 1));
  const viewSizeRef = useRef({ w: 0, h: 0 });
  const imgSizeRef  = useRef({ w: 1, h: 1 });

  const normURef = useRef<Record<string, THREE.IUniform>>({
    uResolution:     { value: new THREE.Vector2(1, 1) },
    uPixelRatio:     { value: dprRef.current },
    uSmoothRaindrop: { value: new THREE.Vector2(smoothRaindrop[0], smoothRaindrop[1]) },
  });

  const compURef = useRef<Record<string, THREE.IUniform>>({
    uBgTexture:    { value: null },
    uNormalRT:     { value: null },
    uResolution:   { value: new THREE.Vector2(1, 1) },
    uBgScale:      { value: new THREE.Vector2(1, 1) },
    uBgOffset:     { value: new THREE.Vector2(0, 0) },
    uRefractBase:  { value: refractBase },
    uRefractScale: { value: refractScale },
    uBlurStrength: { value: backgroundBlurSteps },
    uLightPos:     { value: new THREE.Vector4(...raindropLightPos) },
    uDiffuseLight: { value: new THREE.Vector3(...raindropDiffuseLight) },
    uSpecularLight: { value: new THREE.Vector3(...raindropSpecularLight) },
    uShininess:    { value: raindropSpecularShininess },
    uShadowOffset: { value: raindropShadowOffset },
    uLightBump:    { value: raindropLightBump },
  });

  // ── Cover mapping ─────────────────────────────────────────────────────────
  const updateCoverMapping = useCallback(() => {
    const { w: vw, h: vh } = viewSizeRef.current;
    const { w: iw, h: ih } = imgSizeRef.current;
    if (!(vw > 0 && vh > 0 && iw > 0 && ih > 0)) return;
    const { scale, offset } = computeCoverMapping(vw, vh, iw, ih, backgroundContentPosition);
    (compURef.current.uBgScale.value as THREE.Vector2).set(scale[0], scale[1]);
    (compURef.current.uBgOffset.value as THREE.Vector2).set(offset[0], offset[1]);
  }, [backgroundContentPosition]);

  const onContainerLayout = useCallback((e: LayoutChangeEvent) => {
    const { width: lw, height: lh } = e.nativeEvent.layout;
    if (!(lw > 1 && lh > 1)) return;
    viewSizeRef.current = { w: lw, h: lh };
    updateCoverMapping();
  }, [updateCoverMapping]);

  // ── Prop-sync effects ─────────────────────────────────────────────────────
  useEffect(() => {
    (compURef.current.uLightPos.value as THREE.Vector4).set(...raindropLightPos);
    (compURef.current.uDiffuseLight.value as THREE.Vector3).set(...raindropDiffuseLight);
    (compURef.current.uSpecularLight.value as THREE.Vector3).set(...raindropSpecularLight);
    compURef.current.uShininess.value    = raindropSpecularShininess;
    compURef.current.uShadowOffset.value = raindropShadowOffset;
    compURef.current.uLightBump.value    = raindropLightBump;
    compURef.current.uRefractBase.value  = refractBase;
    compURef.current.uRefractScale.value = refractScale;
    compURef.current.uBlurStrength.value = backgroundBlurSteps;
    (normURef.current.uSmoothRaindrop.value as THREE.Vector2)
      .set(smoothRaindrop[0], smoothRaindrop[1]);
  }, [
    raindropLightPos, raindropDiffuseLight, raindropSpecularLight,
    raindropSpecularShininess, raindropShadowOffset, raindropLightBump,
    refractBase, refractScale, backgroundBlurSteps, smoothRaindrop,
  ]);

  useEffect(() => { updateCoverMapping(); }, [backgroundContentPosition, updateCoverMapping]);

  // ─────────────────────────────────────────────────────────────────────────
  // Pool helpers
  // ─────────────────────────────────────────────────────────────────────────
  const resetPool = useCallback(() => {
    const p = poolRef.current;
    p.alive.fill(0); p.x.fill(0); p.y.fill(0); p.r.fill(0);
    p.mass.fill(0); p.vy.fill(0); p.vx.fill(0); p.spread.fill(0);
    p.trailY.fill(0); p.motionT.fill(0); p.slipping.fill(0); p.isDroplet.fill(0);
    activeRef.current   = 0;
    nextSlotRef.current = 0;
    spawnTimerRef.current   = 0;
    dropletAccRef.current   = 0;
    lastTimeRef.current     = 0;
  }, []);

  /** Ring-buffer slot allocation with forced rotation under pressure */
  const findSlot = useCallback((): number => {
    const p = poolRef.current, n = TOTAL_POOL;
    const start = nextSlotRef.current;
    for (let i = 0; i < n; i++) {
      const idx = (start + i) % n;
      if (!p.alive[idx]) { nextSlotRef.current = (idx + 1) % n; return idx; }
    }
    if (activeRef.current >= n * POOL_ROTATE_AT) {
      const s = nextSlotRef.current;
      nextSlotRef.current = (s + 1) % n;
      return s;
    }
    return -1;
  }, [TOTAL_POOL]);

  const spawnDrop = useCallback((
    cW: number, cH: number,
    x?: number, y?: number,
    minR = spawnSize[0] * 0.5, maxR = spawnSize[1] * 0.5,
    isDroplet = false,
  ) => {
    const slot = findSlot();
    if (slot < 0) return;
    const p = poolRef.current;
    const r = minR + Math.random() * (maxR - minR);

    const wasAlive      = p.alive[slot];
    p.x[slot]           = x ?? Math.random() * cW;
    p.y[slot]           = y ?? Math.random() * cH * 0.35;
    p.r[slot]           = r;
    p.mass[slot]        = r * r;
    p.vy[slot]          = 0;
    p.vx[slot]          = 0;
    p.spread[slot]      = isDroplet ? 0.05 : initialSpread;
    p.trailY[slot]      = p.y[slot];
    p.motionT[slot]     = motionInterval[0] + Math.random() * (motionInterval[1] - motionInterval[0]);
    p.slipping[slot]    = 0;
    p.isDroplet[slot]   = isDroplet ? 1 : 0;
    p.alive[slot]       = 1;
    if (!wasAlive) activeRef.current = Math.min(activeRef.current + 1, TOTAL_POOL);
  }, [findSlot, spawnSize, initialSpread, motionInterval, TOTAL_POOL]);

  // ── Imperative handle ─────────────────────────────────────────────────────
  useImperativeHandle(ref, () => ({
    pause:  () => { pausedRef.current = true; cancelAnimationFrame(rafRef.current); },
    resume: () => {
      if (pausedRef.current) {
        pausedRef.current = false;
        lastTimeRef.current = performance.now();
        cancelAnimationFrame(rafRef.current);
        rafRef.current = requestAnimationFrame(frameRef.current);
      }
    },
    reset: resetPool,
  }));

  useEffect(() => {
    if (enabled === false) {
      pausedRef.current = true; cancelAnimationFrame(rafRef.current);
    } else if (glRef.current && rendererRef.current) {
      pausedRef.current = false;
      lastTimeRef.current = performance.now();
      cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(frameRef.current);
    }
  }, [enabled]);

  // ─────────────────────────────────────────────────────────────────────────
  // Physics  — GRAVITY_NON_LINEAR variant  (dt in seconds)
  // ─────────────────────────────────────────────────────────────────────────
  const stepPhysics = useCallback((cW: number, cH: number, dt: number) => {
    const p = poolRef.current, n = TOTAL_POOL;
    let alive = 0;

    for (let i = 0; i < n; i++) {
      if (!p.alive[i]) continue;

      // ── Evaporation ─────────────────────────────────────────────────────
      p.mass[i] -= evaporate * dt;
      if (p.mass[i] <= 0) { p.alive[i] = 0; continue; }
      p.r[i] = Math.sqrt(p.mass[i]);

      // ── Spread decay ────────────────────────────────────────────────────
      p.spread[i] = Math.max(0, p.spread[i] - shrinkRate * dt);

      // ── Motion FSM (primary drops only) ─────────────────────────────────
      if (!p.isDroplet[i]) {
        p.motionT[i] -= dt;
        if (p.motionT[i] <= 0) {
          p.motionT[i] = motionInterval[0] + Math.random() * (motionInterval[1] - motionInterval[0]);
          if (!p.slipping[i]) {
            if (Math.random() < slipRate) p.slipping[i] = 1;
          } else {
            if (Math.random() < 0.25) p.slipping[i] = 0;
          }
        }

        if (p.slipping[i]) {
          // Gravity + horizontal drift
          p.vy[i] += gravity * dt;
          p.vx[i] += (xShifting[0] + Math.random() * (xShifting[1] - xShifting[0])) * p.vy[i] * dt;

          // Spread from downward velocity
          p.spread[i] = Math.min(p.spread[i] + velocitySpread * p.vy[i] * 0.00004, 0.9);

          p.y[i] += p.vy[i] * dt;
          p.x[i] += p.vx[i] * dt;

          // ── Trail drops ────────────────────────────────────────────────
          if (p.y[i] - p.trailY[i] >= trailDistance[0] + Math.random() * (trailDistance[1] - trailDistance[0])) {
            p.trailY[i] = p.y[i];
            const tFrac = trailDropSize[0] + Math.random() * (trailDropSize[1] - trailDropSize[0]);
            const tR    = p.r[i] * tFrac;
            const massLost = tR * tR * trailDropDensity;
            if (p.mass[i] > massLost * 2) {
              p.mass[i] -= massLost;
              spawnDrop(
                cW, cH,
                p.x[i] + (Math.random() * 2 - 1) * p.r[i] * 0.3,
                p.y[i] - p.r[i] * trailSpread,
                tR, tR, false,
              );
            }
          }
        } else {
          // Decelerate when stopped
          p.vy[i] *= Math.max(0, 1 - dt * 6);
          p.vx[i] *= Math.max(0, 1 - dt * 6);
        }
      }

      // ── Cull ────────────────────────────────────────────────────────────
      if (p.y[i] - p.r[i] > cH || p.x[i] - p.r[i] > cW || p.x[i] + p.r[i] < 0) {
        p.alive[i] = 0; continue;
      }
      alive++;
    }

    // ── Collision  (primary drops only, O(n²) on small n = spawnLimit) ────
    for (let i = 0; i < n; i++) {
      if (!p.alive[i] || p.isDroplet[i]) continue;
      for (let j = i + 1; j < n; j++) {
        if (!p.alive[j] || p.isDroplet[j]) continue;
        const dx = p.x[i] - p.x[j], dy = p.y[i] - p.y[j];
        const rs = (p.r[i] + p.r[j]) * colliderSize;
        if (Math.abs(dx) < rs && Math.abs(dy) < rs && Math.sqrt(dx*dx + dy*dy) < rs) {
          const [big, sml] = p.r[i] >= p.r[j] ? [i, j] : [j, i];
          p.mass[big]      += p.mass[sml];
          p.r[big]          = Math.sqrt(p.mass[big]);
          p.spread[big]     = Math.min(p.spread[big] + p.spread[sml] * 0.5, 0.9);
          if (p.slipping[sml]) p.slipping[big] = 1;
          p.alive[sml]      = 0;
        }
      }
    }

    activeRef.current = alive;
  }, [
    TOTAL_POOL, evaporate, shrinkRate, motionInterval, slipRate,
    gravity, xShifting, velocitySpread, trailDistance, trailDropSize,
    trailDropDensity, trailSpread, colliderSize, spawnDrop,
  ]);

  // ─────────────────────────────────────────────────────────────────────────
  // GPU upload
  // ─────────────────────────────────────────────────────────────────────────
  const uploadInstances = useCallback(() => {
    const p  = poolRef.current, n = TOTAL_POOL;
    const ac = attrCenter.current, ar = attrRadius.current;
    const as = attrSpread.current,  at = attrStretch.current, aa = attrAlive.current;
    if (!ac || !ar || !as || !at || !aa) return;

    const cArr = ac.array as Float32Array, rArr = ar.array as Float32Array;
    const sArr = as.array as Float32Array, tArr = at.array as Float32Array;
    const aArr = aa.array as Float32Array;

    for (let i = 0; i < n; i++) {
      cArr[i*2]   = p.x[i]; cArr[i*2+1] = p.y[i];
      rArr[i]     = p.r[i];
      sArr[i]     = p.spread[i];
      // Vertical stretch proportional to vy, only when slipping
      tArr[i]     = p.slipping[i] ? Math.min(p.vy[i] * 0.0006, 1.2) : 0;
      aArr[i]     = p.alive[i];
    }
    ac.needsUpdate = ar.needsUpdate = as.needsUpdate = at.needsUpdate = aa.needsUpdate = true;
  }, [TOTAL_POOL]);

  // ─────────────────────────────────────────────────────────────────────────
  // Animation frame
  // ─────────────────────────────────────────────────────────────────────────
  const frame = useCallback(() => {
    if (pausedRef.current) return;

    const renderer = rendererRef.current, scene = sceneRef.current;
    const rtScene  = rtSceneRef.current,  cam   = camRef.current;
    const rtCam    = rtCamRef.current,    rt    = normalRTRef.current;
    if (!renderer || !scene || !rtScene || !cam || !rtCam || !rt) return;

    const now = performance.now();
    const dt  = Math.min((now - (lastTimeRef.current || now)) / 1000, 0.1);
    lastTimeRef.current = now;

    const dpr = dprRef.current;
    const res = compURef.current.uResolution.value as THREE.Vector2;
    const cW  = res.x / dpr;
    const cH  = res.y / dpr;

    // ── Spawn primary drops ─────────────────────────────────────────────────
    spawnTimerRef.current += dt;
    const targetInterval = spawnInterval[0] + Math.random() * (spawnInterval[1] - spawnInterval[0]);
    if (spawnTimerRef.current >= targetInterval && activeRef.current < spawnLimit) {
      spawnTimerRef.current = 0;
      spawnDrop(cW, cH);
    }

    // ── Spawn micro-droplets ────────────────────────────────────────────────
    dropletAccRef.current += dropletsPerSeconds * dt;
    while (dropletAccRef.current >= 1) {
      dropletAccRef.current -= 1;
      const dr = dropletSize[0] + Math.random() * (dropletSize[1] - dropletSize[0]);
      spawnDrop(cW, cH,
        Math.random() * cW,
        Math.random() * cH,
        dr, dr, true,
      );
    }

    // ── Physics + GPU upload ────────────────────────────────────────────────
    stepPhysics(cW, cH, dt);
    uploadInstances();

    // ── Pass 1: render normal map → RT ──────────────────────────────────────
    renderer.setRenderTarget(rt);
    renderer.setClearColor(new THREE.Color(0.5, 0.5, 0.5), 0);
    renderer.clear();
    renderer.render(rtScene, rtCam);

    // ── Pass 2: composite → screen ──────────────────────────────────────────
    renderer.setRenderTarget(null);
    renderer.setClearColor(0x000000, 1);
    renderer.render(scene, cam);

    (glRef.current as (WebGLRenderingContext & { endFrameEXP?: () => void }) | null)
      ?.endFrameEXP?.();

    rafRef.current = requestAnimationFrame(frameRef.current);
  }, [
    spawnInterval, spawnLimit, dropletsPerSeconds, dropletSize,
    spawnDrop, stepPhysics, uploadInstances,
  ]);

  frameRef.current = frame;

  // ─────────────────────────────────────────────────────────────────────────
  // GL context setup
  // ─────────────────────────────────────────────────────────────────────────
  const onContextCreate = useCallback(async (gl: WebGLRenderingContext) => {
    glRef.current = gl;
    const { drawingBufferWidth: W, drawingBufferHeight: H } = gl;

    dprRef.current = Math.max(PixelRatio.get(), 0.5);
    normURef.current.uPixelRatio.value = dprRef.current;
    (normURef.current.uResolution.value as THREE.Vector2).set(W, H);
    (compURef.current.uResolution.value as THREE.Vector2).set(W, H);

    // ── Renderer ──────────────────────────────────────────────────────────
    const renderer = new Renderer({ gl });
    renderer.setSize(W, H);
    renderer.setClearColor(0x000000, 1);
    rendererRef.current = renderer;

    // ── Scenes & cameras ──────────────────────────────────────────────────
    const cam   = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    const rtCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);
    camRef.current   = cam;
    rtCamRef.current = rtCam;
    sceneRef.current   = new THREE.Scene();
    rtSceneRef.current = new THREE.Scene();

    // ── Normal Render Target ──────────────────────────────────────────────
    const rt = new THREE.WebGLRenderTarget(W, H, {
      minFilter:     THREE.LinearFilter,
      magFilter:     THREE.LinearFilter,
      format:        THREE.RGBAFormat,
      type:          THREE.UnsignedByteType,
      depthBuffer:   false,
      stencilBuffer: false,
    });
    normalRTRef.current = rt;
    compURef.current.uNormalRT.value = rt.texture;

    // ── Background texture ────────────────────────────────────────────────
    let bgTexture: THREE.Texture;
    try {
      const { TextureLoader } = await import('expo-three');
      bgTexture = await new TextureLoader().loadAsync(source as string);
      bgTexture.needsUpdate = true;
    } catch {
      bgTexture = new THREE.DataTexture(
        new Uint8Array([80, 100, 120, 255]), 1, 1, THREE.RGBAFormat,
      );
      bgTexture.needsUpdate = true;
    }
    compURef.current.uBgTexture.value = bgTexture;

    const imgSize = await resolveImageSize(source);
    if (imgSize) {
      imgSizeRef.current = { w: imgSize.width, h: imgSize.height };
    } else {
      const img = bgTexture.image as { width?: number; height?: number } | undefined;
      if (img?.width && img?.height) imgSizeRef.current = { w: img.width, h: img.height };
    }
    updateCoverMapping();

    // ── Normal pass — InstancedMesh ───────────────────────────────────────
    const n       = TOTAL_POOL;
    const dropGeo = new THREE.PlaneGeometry(2, 2);

    const mkAttr = (count: number, comps: number) => {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(count * comps), comps);
      a.setUsage(THREE.DynamicDrawUsage);
      return a;
    };

    const iaCenter  = mkAttr(n, 2);
    const iaRadius  = mkAttr(n, 1);
    const iaSpread  = mkAttr(n, 1);
    const iaStretch = mkAttr(n, 1);
    const iaAlive   = mkAttr(n, 1);

    dropGeo.setAttribute('aCenter',  iaCenter);
    dropGeo.setAttribute('aRadius',  iaRadius);
    dropGeo.setAttribute('aSpread',  iaSpread);
    dropGeo.setAttribute('aStretch', iaStretch);
    dropGeo.setAttribute('aAlive',   iaAlive);

    attrCenter.current  = iaCenter;
    attrRadius.current  = iaRadius;
    attrSpread.current  = iaSpread;
    attrStretch.current = iaStretch;
    attrAlive.current   = iaAlive;

    const normalMat = new THREE.ShaderMaterial({
      vertexShader:   NORMAL_VERT,
      fragmentShader: NORMAL_FRAG,
      uniforms:       normURef.current,
      transparent:    true,
      depthWrite:     false,
      depthTest:      false,
      // AdditiveBlending → normals of adjacent drops accumulate (smoother compose)
      blending:       THREE.AdditiveBlending,
    });

    const dropMesh = new THREE.InstancedMesh(dropGeo, normalMat, n);
    dropMesh.frustumCulled = false;
    meshRef.current = dropMesh;
    rtSceneRef.current.add(dropMesh);

    // ── Composite pass — fullscreen quad ──────────────────────────────────
    const compMesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        vertexShader:   COMPOSITE_VERT,
        fragmentShader: COMPOSITE_FRAG,
        uniforms:       compURef.current,
        depthWrite:     false,
        depthTest:      false,
      }),
    );
    sceneRef.current.add(compMesh);

    // ── Go ────────────────────────────────────────────────────────────────
    resetPool();
    lastTimeRef.current = performance.now();
    if (!pausedRef.current) {
      rafRef.current = requestAnimationFrame(frameRef.current);
    }
  }, [source, TOTAL_POOL, resetPool, updateCoverMapping]);

  // ── Cleanup ───────────────────────────────────────────────────────────────
  useEffect(() => () => {
    pausedRef.current = true;
    cancelAnimationFrame(rafRef.current);
    rendererRef.current?.dispose();
    normalRTRef.current?.dispose();
    meshRef.current?.geometry.dispose();
  }, []);

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <View style={[styles.container, style]} onLayout={onContainerLayout}>
      <GLView style={StyleSheet.absoluteFill} onContextCreate={onContextCreate} />
    </View>
  );
});

export default RainDropFX;

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
//  import RainDropFX, { RainDropFXRef } from './RainDropFX.three';
//
//  const ref = useRef<RainDropFXRef>(null);
//
//  <RainDropFX
//    ref={ref}
//    source={require('./assets/images/window.jpg')}
//    style={{ width: '100%', height: '100%' }}
//    spawnInterval={[0.08, 0.18]}
//    spawnSize={[20, 70]}
//    spawnLimit={150}
//    slipRate={0.5}
//    gravity={2400}
//    evaporate={8}
//    trailDistance={[20, 35]}
//    dropletsPerSeconds={200}
//    dropletSize={[3, 9]}
//    refractBase={0.35}
//    refractScale={0.55}
//    raindropLightPos={[-1, 1, 2, 0]}
//    raindropDiffuseLight={[0.2, 0.2, 0.2]}
//    raindropShadowOffset={0.75}
//    raindropSpecularLight={[0.05, 0.05, 0.05]}
//    raindropSpecularShininess={256}
//    backgroundBlurSteps={3}
//    backgroundContentPosition="center"
//    enabled={true}
//  />
//
//  ref.current?.pause();
//  ref.current?.resume();
//  ref.current?.reset();
// ─────────────────────────────────────────────────────────────────────────────
