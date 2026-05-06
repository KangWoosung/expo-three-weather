/* eslint-disable react/no-unknown-property */

import { Canvas, useThree } from '@react-three/fiber/native'
import { Asset } from 'expo-asset'
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Image as RNImage, StyleSheet, View } from 'react-native'
import * as THREE from 'three'

export type RainyGlassProps = {
  enabled?: boolean
  maxFps?: number
  /** Overall rain movement speed. */
  speed?: number
  /** Size of the rain pattern. Higher values create smaller/more frequent drops. */
  rainScale?: number
  /** Strength of the visible droplet refraction highlight. */
  dropStrength?: number
  /** Strength of thin trailing water streaks. */
  trailStrength?: number
  /** Fine glass ripple intensity. */
  rippleStrength?: number
  /** Final overlay opacity. */
  opacity?: number
  /** Brightness of rain highlights. */
  brightness?: number
  /** How strongly droplets reflect the background image. */
  reflectionStrength?: number
  /** Drop drift direction in UV space. */
  flowDirection?: [number, number]
  color?: THREE.ColorRepresentation
  backgroundSource?: number
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

  const int MAX_DROPS = 96;

  uniform vec2 iResolution;
  uniform float uDropStrength;
  uniform float uOpacity;
  uniform float uBrightness;
  uniform float uReflectionStrength;
  uniform float uHasBackground;
  uniform sampler2D uBackgroundMap;
  uniform vec4 uDrops[MAX_DROPS];
  uniform vec3 uColor;

  varying vec2 vUv;

  #define S(x, y, z) smoothstep(x, y, z)
  #define sat(x) clamp(x, 0.0, 1.0)

  void main() {
    vec2 aspect = vec2(iResolution.x / max(iResolution.y, 1.0), 1.0);
    float mask = 0.0;
    vec2 offset = vec2(0.0);
    vec3 dropReflection = vec3(0.0);
    float reflectionWeight = 0.0;
    float rimLight = 0.0;
    float bounceLight = 0.0;
    float shadowLight = 0.0;

    for (int i = 0; i < MAX_DROPS; i++) {
      vec4 drop = uDrops[i];
      float radius = drop.z;
      if (radius <= 0.0) continue;

      vec2 delta = (vUv - drop.xy) * aspect;
      float dist = length(delta);
      float body = S(radius, radius * 0.58, dist);
      float rim = body * (1.0 - S(radius * 0.86, radius * 0.38, dist));
      vec2 normal = delta / max(dist, 0.0001);
      vec2 lightPosition = vec2(1.08, 1.06);
      vec2 lightVector = normalize((lightPosition - drop.xy) * aspect);
      float lightDistance = length((lightPosition - drop.xy) * aspect);
      float lightPower = S(1.18, 0.12, lightDistance);
      float primaryWidth = mix(28.0, 4.0, lightPower);
      float bounceWidth = mix(42.0, 10.0, lightPower);
      float primaryRim = rim * pow(sat(dot(normal, lightVector)), primaryWidth) * lightPower;
      float secondaryRim = rim * pow(sat(dot(normal, -lightVector)), bounceWidth) * lightPower * 0.28;
      float shadowRim = rim * pow(sat(dot(normal, -lightVector)), 3.0) * (0.25 + lightPower * 0.35);
      float contribution = body * (1.0 - mask);

      offset += normalize(delta + vec2(0.0001)) * contribution * radius * 1.8;
      dropReflection += texture2D(uBackgroundMap, clamp(drop.xy, 0.001, 0.999)).rgb * contribution;
      reflectionWeight += contribution;
      mask = sat(mask + contribution * uDropStrength);
      rimLight = sat(rimLight + primaryRim * contribution);
      bounceLight = sat(bounceLight + secondaryRim * contribution);
      shadowLight = sat(shadowLight + shadowRim * contribution);
    }

    float bodyAlpha = mask * 0.035;
    float alpha = sat(bodyAlpha + rimLight * 0.48 + bounceLight * 0.16 + shadowLight * 0.18) * uOpacity;

    vec2 reflectedUv = clamp(vUv + offset * 0.42 + vec2(0.0, -0.01), 0.001, 0.999);
    vec3 refractedColor = texture2D(uBackgroundMap, reflectedUv).rgb;
    vec3 centerColor = reflectionWeight > 0.0001 ? dropReflection / reflectionWeight : uColor;
    vec3 reflectedColor = mix(centerColor, refractedColor, 0.42);
    reflectedColor = mix(uColor, reflectedColor, uHasBackground * uReflectionStrength);

    vec3 lightColor = vec3(1.0, 0.96, 0.88);
    vec3 shadowColor = reflectedColor * 0.42;
    vec3 rainColor = reflectedColor * uBrightness;
    rainColor = mix(rainColor, shadowColor, sat(shadowLight * 0.85));
    rainColor = mix(rainColor, lightColor, sat(rimLight * 0.95));
    rainColor = mix(rainColor, lightColor, sat(bounceLight * 0.32));
    gl_FragColor = vec4(rainColor, alpha);
  }
`

const MAX_DROPS = 96


function makeFallbackTexture(): THREE.Texture {
  const data = new Uint8Array([210, 225, 245, 255])
  const texture = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat)
  texture.needsUpdate = true
  return texture
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

function useBackgroundTexture(backgroundSource?: number) {
  const [texture, setTexture] = useState<THREE.Texture | null>(null)

  useEffect(() => {
    if (!backgroundSource) {
      setTexture(null)
      return
    }

    let cancelled = false

    makeTextureFromAsset(backgroundSource)
      .then((nextTexture) => {
        if (cancelled) {
          nextTexture.dispose()
          return
        }

        setTexture((previousTexture) => {
          previousTexture?.dispose()
          return nextTexture
        })
      })
      .catch((error) => {
        console.warn('Failed to load rainy glass background texture', error)
      })

    return () => {
      cancelled = true
    }
  }, [backgroundSource])

  useEffect(() => () => {
    texture?.dispose()
  }, [texture])

  return texture
}

function makeDropUniforms() {
  return Array.from({ length: MAX_DROPS }, () => new THREE.Vector4(0, 0, 0, 0))
}

function RainyGlassPlane({
  enabled = true,
  dropStrength = 1,
  opacity = 0.55,
  brightness = 1,
  reflectionStrength = 0.72,
  color = new THREE.Color(0.82, 0.92, 1),
  backgroundSource,
}: RainyGlassProps) {
  const materialRef = useRef<THREE.ShaderMaterial>(null)
  const size = useThree((state) => state.size)
  const invalidate = useThree((state) => state.invalidate)
  const backgroundTexture = useBackgroundTexture(backgroundSource)
  const fallbackTexture = useMemo(makeFallbackTexture, [])
  const drops = useMemo(makeDropUniforms, [])
  const nextDropIndexRef = useRef(0)

  const uniforms = useMemo(() => ({
    iResolution: { value: new THREE.Vector2(1, 1) },
    uDropStrength: { value: dropStrength },
    uOpacity: { value: opacity },
    uBrightness: { value: brightness },
    uReflectionStrength: { value: reflectionStrength },
    uHasBackground: { value: 0 },
    uBackgroundMap: { value: fallbackTexture },
    uDrops: { value: drops },
    uColor: { value: new THREE.Color(color) },
  }), [brightness, color, dropStrength, drops, fallbackTexture, opacity, reflectionStrength])

  useEffect(() => () => {
    fallbackTexture.dispose()
  }, [fallbackTexture])

  useEffect(() => {
    uniforms.uBackgroundMap.value = backgroundTexture ?? fallbackTexture
    uniforms.uHasBackground.value = backgroundTexture ? 1 : 0
    invalidate()
  }, [backgroundTexture, fallbackTexture, invalidate, uniforms])

  useEffect(() => {
    uniforms.iResolution.value.set(size.width || 1, size.height || 1)
    invalidate()
  }, [invalidate, size.height, size.width, uniforms])

  useEffect(() => {
    uniforms.uDropStrength.value = dropStrength
    uniforms.uOpacity.value = opacity
    uniforms.uBrightness.value = brightness
    uniforms.uReflectionStrength.value = reflectionStrength
    uniforms.uColor.value.set(color)
    invalidate()
  }, [brightness, color, dropStrength, invalidate, opacity, reflectionStrength, uniforms])

  useEffect(() => {
    if (!enabled) {
      invalidate()
      return
    }

    let timeoutId: ReturnType<typeof setTimeout> | null = null
    nextDropIndexRef.current = 0
    drops.forEach((drop) => drop.set(0, 0, 0, 0))
    invalidate()

    const spawnDrop = () => {
      const dropIndex = nextDropIndexRef.current

      if (!materialRef.current || dropIndex >= MAX_DROPS) return

      const radius = 0.012 + Math.random() * 0.026
      const x = 0.06 + Math.random() * 0.88
      const y = 0.06 + Math.random() * 0.88
      drops[dropIndex].set(x, y, radius, Math.random())
      nextDropIndexRef.current = dropIndex + 1
      invalidate()

      if (nextDropIndexRef.current < MAX_DROPS) {
        timeoutId = setTimeout(spawnDrop, 100 + Math.random() * 800)
      }
    }

    timeoutId = setTimeout(spawnDrop, 100 + Math.random() * 800)

    return () => {
      if (timeoutId !== null) clearTimeout(timeoutId)
    }
  }, [drops, enabled, invalidate])

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

export default function RainyGlassThree({
  enabled = true,
  maxFps = 30,
  speed = 0.18,
  rainScale = 1,
  dropStrength = 1,
  trailStrength = 0.72,
  rippleStrength = 0.018,
  opacity = 0.55,
  brightness = 1,
  reflectionStrength = 0.72,
  flowDirection = [0.08, 1],
  color = new THREE.Color(0.82, 0.92, 1),
  backgroundSource,
}: RainyGlassProps) {
  return (
    <View style={styles.overlay} pointerEvents="none">
      <Canvas
        frameloop="demand"
        style={styles.canvas}
        gl={{ antialias: false, alpha: true }}
        onCreated={({ gl }) => {
          gl.setClearColor(0x000000, 0)
        }}>
        <RainyGlassPlane
          enabled={enabled}
          maxFps={maxFps}
          speed={speed}
          rainScale={rainScale}
          dropStrength={dropStrength}
          trailStrength={trailStrength}
          rippleStrength={rippleStrength}
          opacity={opacity}
          brightness={brightness}
          reflectionStrength={reflectionStrength}
          flowDirection={flowDirection}
          color={color}
          backgroundSource={backgroundSource}
        />
      </Canvas>
    </View>
  )
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 11,
  },
  canvas: {
    flex: 1,
    backgroundColor: 'transparent',
  },
})
