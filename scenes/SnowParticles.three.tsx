/**
 * SnowParticles.three.tsx
 *
 * React Native / Expo 용 눈 파티클 컴포넌트.
 * @react-three/fiber (RN 모드) + expo-gl 기반.
 *
 * ▸ DOM API (document, canvas, OffscreenCanvas) 일절 사용하지 않음.
 * ▸ assets/textures/sprites 의 snowflake*.png 를 포인트 스프라이트로 사용.
 *
 * 의존성:
 *   npx expo install expo-gl three
 *   npm install @react-three/fiber
 *
 * 사용법:
 *   <SnowParticles letItSnow={true} />
 *
 * ParallaxScrollView 위에 오버레이:
 *   <View style={{ flex: 1 }}>
 *     <ParallaxScrollView ...>...</ParallaxScrollView>
 *     <SnowParticles letItSnow={isSnowing} />
 *   </View>
 */

/* eslint-disable react/no-unknown-property */

import { Canvas, useFrame, useThree } from '@react-three/fiber/native'
import { Asset } from 'expo-asset'
import React, {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Image as RNImage, StyleSheet, View } from 'react-native'
import * as THREE from 'three'

// ─── 타입 ─────────────────────────────────────────────────────────────────────
interface SnowLayerConfig {
  hsl: [number, number, number]
  size: number
  rotation: [number, number, number]
}

export interface SnowParticlesProps {
  /** 눈발 켜기/끄기 (기본 false) */
  letItSnow?: boolean
  /** 파티클 최대 개수 (기본 8000 — 모바일 부하 고려) */
  maxCount?: number
  /** 색상 Hue 변동 (기본 true) */
  hueVariation?: boolean
  /** 웹 구현의 cameraState처럼 카메라를 살짝 이동시키는 효과 (기본 true) */
  cameraFollow?: boolean
}

// ─── PRNG (결정론적 난수) ─────────────────────────────────────────────────────
function mulberry32(seed: number) {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ─── 레이어 설정 ──────────────────────────────────────────────────────────────
function makeLayerConfigs(): SnowLayerConfig[] {
  const rnd = mulberry32(0x7f4a7c15)
  return [
    { hsl: [1.00, 0.12, 0.94], size: 20, rotation: [rnd() * 6, rnd() * 6, rnd() * 6] },
    { hsl: [0.95, 0.06, 0.96], size: 15, rotation: [rnd() * 6, rnd() * 6, rnd() * 6] },
    { hsl: [0.90, 0.03, 0.97], size: 10, rotation: [rnd() * 6, rnd() * 6, rnd() * 6] },
    { hsl: [0.85, 0.00, 0.98], size: 8, rotation: [rnd() * 6, rnd() * 6, rnd() * 6] },
    { hsl: [0.80, 0.00, 1.00], size: 5, rotation: [rnd() * 6, rnd() * 6, rnd() * 6] },
  ]
}

const SNOWFLAKE_TEXTURE_MODULES = [
  require('@/assets/textures/sprites/snowflake2.png'),
  require('@/assets/textures/sprites/snowflake3.png'),
  require('@/assets/textures/sprites/snowflake1.png'),
  require('@/assets/textures/sprites/snowflake5.png'),
  require('@/assets/textures/sprites/snowflake4.png'),
]

// ─── 파티클 지오메트리 ────────────────────────────────────────────────────────
function useSnowGeometry(maxCount: number) {
  return useMemo(() => {
    const rnd = mulberry32(0x9e3779b9)
    const vertices = new Float32Array(maxCount * 3)
    const speeds = new Float32Array(maxCount)
    const phases = new Float32Array(maxCount)
    const wobbles = new Float32Array(maxCount)
    const spins = new Float32Array(maxCount)
    const spinSpeeds = new Float32Array(maxCount)

    for (let i = 0; i < maxCount; i++) {
      vertices[i * 3] = rnd() * 2000 - 1000
      vertices[i * 3 + 1] = rnd() * 2000 - 1000
      vertices[i * 3 + 2] = rnd() * 2000 - 1000
      speeds[i] = 18 + rnd() * 46
      phases[i] = rnd() * Math.PI * 2
      wobbles[i] = 10 + rnd() * 45
      spins[i] = rnd() * Math.PI * 2
      spinSpeeds[i] = (rnd() * 2 - 1) * (0.45 + rnd() * 1.4)
    }

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3))
    geo.setAttribute('aSpeed', new THREE.Float32BufferAttribute(speeds, 1))
    geo.setAttribute('aPhase', new THREE.Float32BufferAttribute(phases, 1))
    geo.setAttribute('aWobble', new THREE.Float32BufferAttribute(wobbles, 1))
    geo.setAttribute('aSpin', new THREE.Float32BufferAttribute(spins, 1))
    geo.setAttribute('aSpinSpeed', new THREE.Float32BufferAttribute(spinSpeeds, 1))
    return geo
  }, [maxCount])
}

async function makeTextureFromAsset(moduleId: number) {
  const [asset] = await Asset.loadAsync(moduleId)
  const uri = asset.localUri ?? asset.uri
  let width = asset.width ?? 0
  let height = asset.height ?? 0

  if ((!width || !height) && uri) {
    const size = await new Promise<{ width: number; height: number }>((resolve, reject) => {
      RNImage.getSize(uri, (nextWidth, nextHeight) => {
        resolve({ width: nextWidth, height: nextHeight })
      }, reject)
    })
    width = size.width
    height = size.height
  }

  const texture = new THREE.Texture()
  texture.image = {
    data: asset,
    width,
    height,
  }
    ; (texture as THREE.Texture & { isDataTexture?: boolean }).isDataTexture = true
  texture.colorSpace = THREE.SRGBColorSpace
  texture.flipY = false
  texture.generateMipmaps = false
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearFilter
  texture.wrapS = THREE.ClampToEdgeWrapping
  texture.wrapT = THREE.ClampToEdgeWrapping
  texture.needsUpdate = true
  return texture
}

function useSnowflakeTextures() {
  const [textures, setTextures] = useState<THREE.Texture[] | null>(null)

  useEffect(() => {
    let cancelled = false

    Promise.all(SNOWFLAKE_TEXTURE_MODULES.map(makeTextureFromAsset))
      .then((nextTextures) => {
        if (!cancelled) setTextures(nextTextures)
      })
      .catch((error) => {
        console.warn('Failed to load snowflake textures', error)
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    return () => {
      textures?.forEach((texture) => texture.dispose())
    }
  }, [textures])

  return textures
}

const SNOW_VERTEX_SHADER = `
  uniform float uTime;
  uniform float uSize;
  uniform float uLayer;

  attribute float aSpeed;
  attribute float aPhase;
  attribute float aWobble;
  attribute float aSpin;
  attribute float aSpinSpeed;

  varying float vFade;
  varying float vRotation;

  void main() {
    vec3 p = position;

    float layerSpeed = 0.78 + uLayer * 0.18;
    p.y = mod(p.y - uTime * aSpeed * layerSpeed + 1000.0, 2000.0) - 1000.0;
    p.x += sin(uTime * (0.55 + uLayer * 0.08) + aPhase + p.z * 0.006) * aWobble * (1.0 + uLayer * 0.18);
    p.z += cos(uTime * (0.28 + uLayer * 0.05) + aPhase) * aWobble * 0.22;

    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = uSize * (1000.0 / max(180.0, -mvPosition.z));
    gl_Position = projectionMatrix * mvPosition;

    vFade = (1.0 - smoothstep(650.0, 1000.0, p.y)) * smoothstep(-1000.0, -750.0, p.y);
    vRotation = aSpin + uTime * aSpinSpeed * (0.65 + uLayer * 0.15);
  }
`

const SNOW_FRAGMENT_SHADER = `
  precision mediump float;

  uniform sampler2D uMap;
  uniform vec3 uColor;

  varying float vFade;
  varying float vRotation;

  void main() {
    vec2 centered = gl_PointCoord - vec2(0.5);
    float s = sin(vRotation);
    float c = cos(vRotation);
    vec2 rotatedUv = vec2(
      centered.x * c - centered.y * s,
      centered.x * s + centered.y * c
    ) + vec2(0.5);

    if (
      rotatedUv.x < 0.0 || rotatedUv.x > 1.0 ||
      rotatedUv.y < 0.0 || rotatedUv.y > 1.0
    ) discard;

    vec4 sprite = texture2D(uMap, rotatedUv);
    float luminance = dot(sprite.rgb, vec3(0.299, 0.587, 0.114));
    // alphaMask: 텍스처의 어두운 외곽(배경)은 투명, 밝은 눈송이만 통과
    float alphaMask = smoothstep(0.03, 0.22, luminance);
    float alpha = sprite.a * alphaMask * vFade;
    if (alpha < 0.01) discard;

    // 스프라이트 rgb 를 섞지 않고 uColor(밝은 흰색 계열)를 직접 사용.
    // 텍스처 루미넌스로 약하게 디테일만 살림 (0.08 → 어둡게 끌어내리지 않음).
    vec3 snowColor = uColor * (0.92 + luminance * 0.08);
    gl_FragColor = vec4(snowColor, alpha);
  }
`

function makeSnowMaterial(config: SnowLayerConfig, layerIndex: number, texture: THREE.Texture) {
  const color = new THREE.Color().setHSL(...config.hsl)

  return new THREE.ShaderMaterial({
    uniforms: {
      uMap: { value: texture },
      uTime: { value: 0 },
      uSize: { value: config.size },
      uLayer: { value: layerIndex },
      uColor: { value: color },
    },
    vertexShader: SNOW_VERTEX_SHADER,
    fragmentShader: SNOW_FRAGMENT_SHADER,
    transparent: true,
    depthTest: false,
    depthWrite: false,
    blending: THREE.NormalBlending,
  })
}

// ─── 내부 씬 컴포넌트 ─────────────────────────────────────────────────────────
interface SceneProps {
  letItSnow: boolean
  maxCount: number
  hueVariation: boolean
  cameraFollow: boolean
}

function SnowScene({ letItSnow, maxCount, hueVariation, cameraFollow }: SceneProps) {
  const { camera } = useThree()
  const groupRef = useRef<THREE.Group>(null)
  const materialsRef = useRef<THREE.ShaderMaterial[]>([])
  const letItSnowRef = useRef(letItSnow)
  const textures = useSnowflakeTextures()

  useEffect(() => { letItSnowRef.current = letItSnow }, [letItSnow])

  // 지오메트리
  const geometry = useSnowGeometry(maxCount)

  const { layers, materials } = useMemo(() => {
    const layers = makeLayerConfigs()
    const materials = textures
      ? layers.map((layer, i) => makeSnowMaterial(layer, i, textures[i]))
      : []
    return { layers, materials }
  }, [textures])

  useLayoutEffect(() => {
    materialsRef.current = materials
  }, [materials])

  // 카메라 초기 설정
  useEffect(() => {
    camera.position.set(0, 0, 1000)
    camera.lookAt(0, 0, 0)
    if (camera instanceof THREE.PerspectiveCamera) {
      camera.fov = 75
      camera.near = 1
      camera.far = 2000
      camera.updateProjectionMatrix()
    }
  }, [camera])

  useFrame((state) => {
    if (!letItSnowRef.current) return

    const elapsed = state.clock.elapsedTime
    const time = elapsed * 0.05
    const points = (groupRef.current?.children.filter(
      (o): o is THREE.Points => o instanceof THREE.Points
    ) ?? [])

    if (cameraFollow) {
      camera.position.x += (-360 - camera.position.x) * 0.05
      camera.position.y += (-140 - camera.position.y) * 0.05
      camera.lookAt(0, 0, 0)
    }

    // 레이어별 회전
    points.forEach((obj, i) => {
      obj.rotation.y = time * (i < 4 ? i + 1 : -(i + 1))
    })

    // Hue 변동
    if (hueVariation) {
      materialsRef.current.forEach((mat, i) => {
        const h = ((layers[i].hsl[0] + time) * 360) % 360 / 360
        // lightness는 원본값(0.94~1.0)을 유지 — hue cycling 중 어둬지지 않도록
        ;(mat.uniforms.uColor.value as THREE.Color).setHSL(h, layers[i].hsl[1], layers[i].hsl[2])
      })
    }

    materialsRef.current.forEach((mat) => {
      mat.uniforms.uTime.value = elapsed
    })
  })

  if (!letItSnow || !textures) return null

  return (
    <group ref={groupRef}>
      {layers.map(({ rotation }, i) => (
        <points
          key={i}
          geometry={geometry}
          material={materials[i]}
          rotation={rotation as [number, number, number]}
        />
      ))}
    </group>
  )
}

// ─── 공개 컴포넌트 ────────────────────────────────────────────────────────────
export default function SnowParticles({
  letItSnow = false,
  maxCount = 1000,
  hueVariation = true,
  cameraFollow = true,
}: SnowParticlesProps) {
  if (!letItSnow) return null   // 꺼져 있으면 마운트 자체를 안 함

  return (
    <View style={styles.overlay} pointerEvents="none">
      <Canvas
        style={styles.canvas}
        /**
         * native에서는 demand invalidation이 끊기면 정지 화면처럼 보일 수 있어
         * 눈이 켜져 있는 동안 Canvas 자체를 마운트하고 기본 프레임 루프로 움직인다.
         */
        gl={{ antialias: false, alpha: true }}
        camera={{ position: [0, 0, 1000], fov: 75, near: 1, far: 2000 }}
        onCreated={({ gl }) => {
          gl.setClearColor(0x000000, 0)
        }}
      >
        <SnowScene
          letItSnow={letItSnow}
          maxCount={maxCount}
          hueVariation={hueVariation}
          cameraFollow={cameraFollow}
        />
      </Canvas>
    </View>
  )
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    // 터치 이벤트를 하위 ScrollView 로 통과시킴
    // pointerEvents="none" 은 View prop으로 전달
    zIndex: 10,
  },
  canvas: {
    flex: 1,
    backgroundColor: 'transparent',
  },
})