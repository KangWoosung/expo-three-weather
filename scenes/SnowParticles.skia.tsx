import {
  Atlas,
  Canvas,
  FilterMode,
  MipmapMode,
  Skia,
  type SkImage,
  type SkRect,
  useClock,
  useImage,
  useRSXformBuffer,
} from "@shopify/react-native-skia";
import React, { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { type SharedValue, useSharedValue } from 'react-native-reanimated';

export interface SnowParticlesProps {
  letItSnow?: boolean
  maxCount?: number
  hueVariation?: boolean
}


const TEXTURE_COUNT = 5
const MAX_ATLAS_PARTICLES = 1600
const sampling = { filter: FilterMode.Linear, mipmap: MipmapMode.None }

type SnowLayerProps = {
  image: SkImage
  layerIndex: number
  particleCount: number
  hueVariation: boolean
  width: SharedValue<number>
  height: SharedValue<number>
  clock: SharedValue<number>
}

function getLayerCount(total: number, layerIndex: number) {
  return Math.max(0, Math.floor((total + TEXTURE_COUNT - 1 - layerIndex) / TEXTURE_COUNT))
}

function makeSprites(count: number, sprite: SkRect) {
  return Array.from({ length: count }, () => sprite)
}

function makeSnowColorMatrix(hueVariation: boolean, layerIndex: number) {
  const tintStrength = hueVariation ? 1 : 0
  const green = 1 - tintStrength * (0.008 + layerIndex * 0.0015)
  const blue = 1 - tintStrength * (0.018 - layerIndex * 0.001)

  // LumaColorFilter 이후에는 alpha가 snowflake 마스크가 된다. 그 alpha를 RGB로 복사한다.
  return [
    0, 0, 0, 1, 0,
    0, 0, 0, green, 0,
    0, 0, 0, blue, 0,
    0, 0, 0, 1, 0,
  ]
}

function makeMaskedSnowflakeImage(image: SkImage, hueVariation: boolean, layerIndex: number) {
  const width = image.width()
  const height = image.height()
  const surface = Skia.Surface.Make(width, height)

  if (!surface) return image

  const canvas = surface.getCanvas()
  const paint = Skia.Paint()
  const luma = Skia.ColorFilter.MakeLumaColorFilter()
  const colorize = Skia.ColorFilter.MakeMatrix(makeSnowColorMatrix(hueVariation, layerIndex))

  paint.setColorFilter(Skia.ColorFilter.MakeCompose(colorize, luma))
  canvas.clear(Skia.Color('rgba(0,0,0,0)'))
  canvas.drawImageRect(
    image,
    Skia.XYWHRect(0, 0, width, height),
    Skia.XYWHRect(0, 0, width, height),
    paint
  )
  surface.flush()

  return surface.makeImageSnapshot()
}

function SnowAtlasLayer({
  image,
  layerIndex,
  particleCount,
  width,
  height,
  clock,
}: SnowLayerProps) {
  const sprite = useMemo(() => {
    return Skia.XYWHRect(0, 0, image.width(), image.height())
  }, [image])

  const sprites = useMemo(() => makeSprites(particleCount, sprite), [particleCount, sprite])

  const transforms = useRSXformBuffer(particleCount, (transform, index) => {
    'worklet'

    const w = width.value
    const h = height.value

    if (w <= 1 || h <= 1) {
      transform.set(0, 0, -10000, -10000)
      return
    }

    const fract = (n: number) => {
      'worklet'
      return n - Math.floor(n)
    }
    const rand = (n: number) => {
      'worklet'
      return fract(Math.sin(n) * 43758.5453123)
    }
    const mix = (a: number, b: number, t: number) => {
      'worklet'
      return a + (b - a) * t
    }

    const time = clock.value / 1000
    const fi = index * TEXTURE_COUNT + layerIndex
    const seed = fi * 17.173 + 9.31
    const depth = rand(seed + 3.7)
    const phase = rand(seed + 8.9) * Math.PI * 2
    const behavior = fi % 4

    const baseX = rand(seed + 1.1) * w
    const baseY = rand(seed + 2.3) * (h + 180) - 90
    const verticalSpeed = mix(16, 78, rand(seed + 4.1)) * (0.82 + layerIndex * 0.18)
    let y = ((baseY + time * verticalSpeed) % (h + 180)) - 90

    if (behavior === 1) {
      y = ((baseY - time * verticalSpeed * 0.72 + h + 90) % (h + 180)) - 90
    } else if (behavior === 3) {
      y = ((baseY + time * verticalSpeed * 0.45 + Math.sin(time * 0.9 + phase) * 38) % (h + 180)) - 90
    }

    const sway = Math.sin(time * (0.7 + layerIndex * 0.13) + phase + y * 0.018) * mix(18, 68, rand(seed + 5.2))
    const gust = Math.sin(time * (1.8 + rand(seed + 12) * 1.4) + phase) * mix(10, 48, rand(seed + 13))
    const drift = Math.cos(time * (0.22 + layerIndex * 0.05) + phase) * 20
    let x = baseX + sway + drift

    if (behavior === 2) {
      const sideSpeed = mix(80, 210, rand(seed + 7.6))
      const direction = rand(seed + 7.9) < 0.5 ? -1 : 1
      x = baseX + direction * time * sideSpeed + gust
      y += Math.sin(time * 2.2 + phase) * 18
    } else if (behavior === 3) {
      x += time * mix(36, 95, rand(seed + 15)) + gust
    }

    x = ((x + w + 80) % (w + 160)) - 80

    const maxDim = Math.max(w, h)
    const targetSize = mix(10, 34, depth) * (1.12 + layerIndex * 0.08) * (maxDim / 450)
    const scale = targetSize / Math.max(image.width(), image.height())
    const rotation = phase + time * mix(-1.7, 1.7, rand(seed + 6.4)) * (0.85 + depth)
    const scos = Math.cos(rotation) * scale
    const ssin = Math.sin(rotation) * scale
    const px = image.width() / 2
    const py = image.height() / 2
    const tx = x - scos * px + ssin * py
    const ty = y - ssin * px - scos * py

    transform.set(scos, ssin, tx, ty)
  })

  if (particleCount === 0) return null

  return (
    <Atlas
      image={image}
      sprites={sprites}
      transforms={transforms}
      sampling={sampling}
      blendMode="srcOver"
    />
  )
}

const SnowParticles = ({
  letItSnow = false,
  maxCount = 1000,
  hueVariation: _hueVariation = true,
}: SnowParticlesProps) => {
  const clock = useClock()
  const [size, setSize] = useState({ width: 0, height: 0 })
  const width = useSharedValue(0)
  const height = useSharedValue(0)

  const snowflake2 = useImage(require('@/assets/textures/sprites/snowflake2.png'))
  const snowflake3 = useImage(require('@/assets/textures/sprites/snowflake3.png'))
  const snowflake1 = useImage(require('@/assets/textures/sprites/snowflake1.png'))
  const snowflake5 = useImage(require('@/assets/textures/sprites/snowflake5.png'))
  const snowflake4 = useImage(require('@/assets/textures/sprites/snowflake4.png'))

  const particleCount = useMemo(() => {
    if (maxCount <= 0) return 0

    const normalized = Math.min(1, maxCount / 10000)
    return Math.max(12, Math.min(MAX_ATLAS_PARTICLES, Math.round(normalized * MAX_ATLAS_PARTICLES)))
  }, [maxCount])

  useEffect(() => {
    width.value = size.width
    height.value = size.height
  }, [height, size.height, size.width, width])

  const sourceImages = useMemo(() => {
    return [snowflake2, snowflake3, snowflake1, snowflake5, snowflake4]
  }, [snowflake1, snowflake2, snowflake3, snowflake4, snowflake5])
  const ready = sourceImages.every((image): image is SkImage => image !== null)
  const images = useMemo(() => {
    if (!ready) return []

    return sourceImages.map((image, layerIndex) => {
      return makeMaskedSnowflakeImage(image, _hueVariation, layerIndex)
    })
  }, [ready, sourceImages, _hueVariation])

  if (!letItSnow) return null

  return (
    <View
      style={styles.overlay}
      pointerEvents="none"
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout
        setSize({ width, height })
      }}>
      <Canvas style={styles.canvas}>
        {ready && size.width > 0 && size.height > 0 && images.map((image, layerIndex) => (
          <SnowAtlasLayer
            key={layerIndex}
            image={image}
            layerIndex={layerIndex}
            particleCount={getLayerCount(particleCount, layerIndex)}
            hueVariation={_hueVariation}
            width={width}
            height={height}
            clock={clock}
          />
        ))}
      </Canvas>
    </View>
  )
}

export default SnowParticles


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