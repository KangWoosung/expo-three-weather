/* eslint-disable react/no-unknown-property */

import { Canvas, useThree } from '@react-three/fiber/native'
import React, { useEffect, useMemo, useRef } from 'react'
import { StyleSheet, View } from 'react-native'
import * as THREE from 'three' 

export type CloudsSceneProps = {
  enabled?: boolean
  /** Noise pattern scale. Higher values make clouds more detailed and smaller. */
  cloudScale?: number
  /** Animation speed for the drifting cloud field. */
  speed?: number
  /** Secondary in-place morphing speed for cloud birth/fade motion. */
  evolutionSpeed?: number
  /** Base brightness of the cloud body. */
  cloudDark?: number
  /** Bright highlight contribution inside the cloud body. */
  cloudLight?: number
  /** Original shader coverage control. Higher values produce more visible cloud area. */
  cloudCover?: number
  /** Friendlier alias for cloudCover. If set, it takes precedence over cloudCover. */
  cloudDensity?: number
  /** Density contrast for the generated cloud mask. Higher values make clouds thicker. */
  cloudAlpha?: number
  /** Final layer opacity after the cloud mask is generated. Does not create more clouds. */
  cloudOpacity?: number
  /** Alpha cutoff for thin haze. Higher values remove more faint cloud edges. */
  alphaThreshold?: number
  /** UV flow direction. Default [1, 1] reads visually as upper-right to lower-left drift. */
  flowDirection?: [number, number]
  /** Tint applied to visible cloud pixels. */
  cloudColor?: THREE.ColorRepresentation
  /** Limits cloud redraws to reduce long-running GPU heat on older Android devices. */
  maxFps?: number
}

const VERTEX_SHADER = `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

const FRAGMENT_SHADER = `
  precision mediump float;

  uniform vec2 iResolution;
  uniform sampler2D uCloudMap;
  uniform float uCloudScale;
  uniform float uCloudDark;
  uniform float uCloudLight;
  uniform float uCloudCover;
  uniform float uCloudAlpha;
  uniform float uCloudOpacity;
  uniform float uAlphaThreshold;
  uniform vec2 uLowOffset;
  uniform vec2 uMidOffset;
  uniform vec2 uHighOffset;
  uniform vec3 uCloudColor;

  varying vec2 vUv;

  void main() {
    vec2 p = vUv;
    vec2 aspect = vec2(iResolution.x / max(iResolution.y, 1.0), 1.0);

    vec2 baseUv = p * aspect * uCloudScale * 0.72;
    vec2 lowUv = fract(baseUv + uLowOffset);
    vec2 midUv = fract(baseUv * 1.37 + vec2(baseUv.y, -baseUv.x) * 0.17 + uMidOffset);
    vec2 highUv = fract(baseUv * 2.11 + vec2(-baseUv.y, baseUv.x) * 0.23 + uHighOffset);
    vec4 low = texture2D(uCloudMap, lowUv);
    vec4 mid = texture2D(uCloudMap, midUv);
    vec4 high = texture2D(uCloudMap, highUv);

    float cloudField = low.r * 0.58 + mid.g * 0.30 + high.b * 0.12;
    float contrast = max(uCloudAlpha * 0.16, 0.2);
    cloudField = clamp((cloudField - 0.5) * contrast + 0.5, 0.0, 1.0);

    float density = clamp(uCloudCover, 0.0, 1.0);
    float cutoff = mix(0.82, 0.36, density);
    float softness = max(uAlphaThreshold, 0.08);
    float cloudMask = smoothstep(cutoff - softness, cutoff + softness, cloudField);
    float alpha = cloudMask * uCloudOpacity;
    vec3 cloudColour = uCloudColor * clamp(uCloudDark + uCloudLight * cloudField, 0.0, 1.0);

    gl_FragColor = vec4(cloudColour, alpha);
  }
`

const CLOUD_TEXTURE_SIZE = 256
const CLOUD_OCTAVE_SIZES = [4, 8, 16, 32, 64]

function mulberry32(seed: number) {
  let a = seed | 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function smooth(t: number) {
  return t * t * (3 - 2 * t)
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t
}

function sampleGrid(grid: Float32Array, gridSize: number, x: number, y: number) {
  const floorX = Math.floor(x)
  const floorY = Math.floor(y)
  const x0 = ((floorX % gridSize) + gridSize) % gridSize
  const y0 = ((floorY % gridSize) + gridSize) % gridSize
  const x1 = (x0 + 1) % gridSize
  const y1 = (y0 + 1) % gridSize
  const tx = smooth(x - Math.floor(x))
  const ty = smooth(y - Math.floor(y))
  const a = grid[y0 * gridSize + x0]
  const b = grid[y0 * gridSize + x1]
  const c = grid[y1 * gridSize + x0]
  const d = grid[y1 * gridSize + x1]
  return lerp(lerp(a, b, tx), lerp(c, d, tx), ty)
}

function makeOctaveGrid(gridSize: number, rnd: () => number) {
  const grid = new Float32Array(gridSize * gridSize)
  for (let i = 0; i < grid.length; i++) grid[i] = rnd()
  return grid
}

function makeCloudTexture() {
  const size = CLOUD_TEXTURE_SIZE
  const rnd = mulberry32(0x4c0a9d5)
  const grids = Array.from({ length: 3 }, () => (
    CLOUD_OCTAVE_SIZES.map((gridSize) => makeOctaveGrid(gridSize, rnd))
  ))
  const data = new Uint8Array(size * size * 4)

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const offset = (y * size + x) * 4

      for (let channel = 0; channel < 3; channel++) {
        let value = 0
        let amplitude = 1
        let totalAmplitude = 0

        for (let octave = 0; octave < CLOUD_OCTAVE_SIZES.length; octave++) {
          const gridSize = CLOUD_OCTAVE_SIZES[octave]
          value += sampleGrid(
            grids[channel][octave],
            gridSize,
            (x / size) * gridSize,
            (y / size) * gridSize
          ) * amplitude
          totalAmplitude += amplitude
          amplitude *= 0.5
        }

        value /= totalAmplitude
        value = smooth(Math.min(1, Math.max(0, value)))
        data[offset + channel] = Math.round(Math.min(1, Math.max(0, value)) * 255)
      }

      data[offset + 3] = 255
    }
  }

  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat)
  texture.wrapS = THREE.RepeatWrapping
  texture.wrapT = THREE.RepeatWrapping
  texture.magFilter = THREE.LinearFilter
  texture.minFilter = THREE.LinearFilter
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}

function wrapUnit(value: number) {
  return ((value % 1) + 1) % 1
}

function CloudsPlane({
  enabled = true,
  maxFps = 30,
  cloudScale = 1.1,
  speed = 0.12,
  evolutionSpeed = 0.08,
  cloudDark = 0.5,
  cloudLight = 0.3,
  cloudCover = 0.2,
  cloudDensity,
  cloudAlpha = 8.0,
  cloudOpacity = 0.42,
  alphaThreshold = 0.18,
  flowDirection = [1, 1],
  cloudColor = new THREE.Color(1.1, 1.1, 0.9),
}: CloudsSceneProps) {
  const materialRef = useRef<THREE.ShaderMaterial>(null)
  const size = useThree((state) => state.size)
  const invalidate = useThree((state) => state.invalidate)
  const effectiveCloudCover = cloudDensity ?? cloudCover
  const cloudMap = useMemo(makeCloudTexture, [])
  const offsetsRef = useRef({
    low: new THREE.Vector2(0, 0),
    mid: new THREE.Vector2(0.37, 0.19),
    high: new THREE.Vector2(0.73, 0.41),
  })

  const uniforms = useMemo(() => ({
    iResolution: { value: new THREE.Vector2(1, 1) },
    uCloudMap: { value: cloudMap },
    uCloudScale: { value: cloudScale },
    uCloudDark: { value: cloudDark },
    uCloudLight: { value: cloudLight },
    uCloudCover: { value: effectiveCloudCover },
    uCloudAlpha: { value: cloudAlpha },
    uCloudOpacity: { value: cloudOpacity },
    uAlphaThreshold: { value: alphaThreshold },
    uLowOffset: { value: offsetsRef.current.low },
    uMidOffset: { value: offsetsRef.current.mid },
    uHighOffset: { value: offsetsRef.current.high },
    uCloudColor: { value: new THREE.Color(cloudColor) },
  }), [alphaThreshold, cloudAlpha, cloudColor, cloudDark, cloudLight, cloudMap, cloudOpacity, cloudScale, effectiveCloudCover])

  useEffect(() => () => {
    cloudMap.dispose()
  }, [cloudMap])

  useEffect(() => {
    uniforms.iResolution.value.set(size.width || 1, size.height || 1)
    invalidate()
  }, [invalidate, size.height, size.width, uniforms])

  useEffect(() => {
    uniforms.uCloudScale.value = cloudScale
    uniforms.uCloudDark.value = cloudDark
    uniforms.uCloudLight.value = cloudLight
    uniforms.uCloudCover.value = effectiveCloudCover
    uniforms.uCloudAlpha.value = cloudAlpha
    uniforms.uCloudOpacity.value = cloudOpacity
    uniforms.uAlphaThreshold.value = alphaThreshold
    uniforms.uCloudColor.value.set(cloudColor)
    invalidate()
  }, [alphaThreshold, cloudAlpha, cloudColor, cloudDark, cloudLight, cloudOpacity, cloudScale, effectiveCloudCover, invalidate, uniforms])

  useEffect(() => {
    if (!enabled) {
      invalidate()
      return
    }

    let frameId: number | null = null
    let lastFrameAt = 0
    const frameInterval = 1000 / Math.max(1, maxFps)
    const flowLength = Math.hypot(flowDirection[0], flowDirection[1])
    const flowX = flowLength > 0.0001 ? flowDirection[0] / flowLength : 1 / Math.SQRT2
    const flowY = flowLength > 0.0001 ? flowDirection[1] / flowLength : 1 / Math.SQRT2

    const tick = (now: number) => {
      frameId = requestAnimationFrame(tick)

      if (now - lastFrameAt < frameInterval) return

      const deltaSeconds = lastFrameAt > 0 ? (now - lastFrameAt) * 0.001 : 0
      lastFrameAt = now
      const material = materialRef.current

      if (!material) return

      const offsets = offsetsRef.current
      offsets.low.set(
        wrapUnit(offsets.low.x + (flowX * speed + evolutionSpeed * 0.08) * deltaSeconds),
        wrapUnit(offsets.low.y + (flowY * speed - evolutionSpeed * 0.04) * deltaSeconds)
      )
      offsets.mid.set(
        wrapUnit(offsets.mid.x + (-flowX * speed * 0.36 - evolutionSpeed * 0.07) * deltaSeconds),
        wrapUnit(offsets.mid.y + (-flowY * speed * 0.36 + evolutionSpeed * 0.1) * deltaSeconds)
      )
      offsets.high.set(
        wrapUnit(offsets.high.x + (flowX * speed * 0.18 + evolutionSpeed * 0.14) * deltaSeconds),
        wrapUnit(offsets.high.y + (flowY * speed * 0.18 + evolutionSpeed * 0.14) * deltaSeconds)
      )
      invalidate()
    }

    frameId = requestAnimationFrame(tick)

    return () => {
      if (frameId !== null) cancelAnimationFrame(frameId)
    }
  }, [enabled, evolutionSpeed, flowDirection, invalidate, maxFps, speed])

  return (
    <mesh frustumCulled={false} visible={enabled}>
      <planeGeometry args={[2, 2]} />
      <shaderMaterial
        ref={materialRef}
        uniforms={uniforms}
        vertexShader={VERTEX_SHADER}
        fragmentShader={FRAGMENT_SHADER}
        transparent
        depthTest={false}
        depthWrite={false}
        blending={THREE.NormalBlending}
      />
    </mesh>
  )
}

export default function CloudsScene({
  enabled = true,
  maxFps = 30,
  cloudScale = 1.1,
  speed = 0.12,
  evolutionSpeed = 0.08,
  cloudDark = 0.5,
  cloudLight = 0.3,
  cloudCover = 0.2,
  cloudDensity,
  cloudAlpha = 8.0,
  cloudOpacity = 0.42,
  alphaThreshold = 0.18,
  flowDirection = [1, 1],
  cloudColor = new THREE.Color(1.1, 1.1, 0.9),
}: CloudsSceneProps) {
  return (
    <View style={styles.overlay} pointerEvents="none">
      <Canvas
        frameloop="demand"
        style={styles.canvas}
        gl={{ antialias: false, alpha: true }}
        onCreated={({ gl }) => {
          gl.setClearColor(0x000000, 0)
        }}>
        <CloudsPlane
          enabled={enabled}
          maxFps={maxFps}
          cloudScale={cloudScale}
          speed={speed}
          evolutionSpeed={evolutionSpeed}
          cloudDark={cloudDark}
          cloudLight={cloudLight}
          cloudCover={cloudCover}
          cloudDensity={cloudDensity}
          cloudAlpha={cloudAlpha}
          cloudOpacity={cloudOpacity}
          alphaThreshold={alphaThreshold}
          flowDirection={flowDirection}
          cloudColor={cloudColor}
        />
      </Canvas>
    </View>
  )
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 9,
  },
  canvas: {
    flex: 1,
    backgroundColor: 'transparent',
  },
})