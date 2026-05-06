import {
  Canvas,
  Fill,
  Shader,
  Skia,
  useClock,
} from '@shopify/react-native-skia';
import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useDerivedValue, useSharedValue } from 'react-native-reanimated';

export interface SnowParticlesProps {
  letItSnow?: boolean
  maxCount?: number
  hueVariation?: boolean
}

const MAX_SHADER_PARTICLES = 400

const snowShader = Skia.RuntimeEffect.Make(`
uniform float2 resolution;
uniform float time;
uniform float count;
uniform float hueVariation;

float hash11(float n) {
  return fract(sin(n) * 43758.5453123);
}

float2 rotate2(float2 p, float a) {
  float s = sin(a);
  float c = cos(a);
  return float2(p.x * c - p.y * s, p.x * s + p.y * c);
}

float lineMask(float2 p, float angle, float len, float width) {
  float2 q = rotate2(p, -angle);
  float body = 1.0 - smoothstep(width, width + 0.014, abs(q.y));
  float cap = smoothstep(0.0, 0.05, q.x) * (1.0 - smoothstep(len - 0.05, len, q.x));
  return body * cap;
}

float segmentMask(float2 p, float2 a, float2 b, float width) {
  float2 pa = p - a;
  float2 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  float d = length(pa - ba * h);
  return 1.0 - smoothstep(width, width + 0.018, d);
}

float circleMask(float r, float radius, float feather) {
  return 1.0 - smoothstep(radius, radius + feather, r);
}

float snowflake(float2 p, float variant) {
  float r = length(p);
  if (r > 1.2) {
    return 0.0;
  }

  float a = atan(p.y, p.x);
  float kind = mod(variant, 5.0);
  float center = circleMask(r, 0.14, 0.025);
  float mask = circleMask(r, 0.46, 0.035);

  if (kind >= 1.0 && kind < 2.0) {
    mask = max(center, (1.0 - smoothstep(0.035, 0.075, abs(r - 0.52))) * circleMask(r, 0.88, 0.03));
  } else if (kind >= 2.0 && kind < 3.0) {
    float arms = 0.0;
    for (int j = 0; j < 6; j++) {
      float angle = float(j) * 1.04719755;
      arms = max(arms, lineMask(p, angle, 0.96, 0.038));
      float2 q = rotate2(p, -angle);
      arms = max(arms, segmentMask(q, float2(0.28, 0.0), float2(0.52, 0.16), 0.03));
      arms = max(arms, segmentMask(q, float2(0.28, 0.0), float2(0.52, -0.16), 0.03));
    }
    mask = max(center, arms);
  } else if (kind >= 3.0 && kind < 4.0) {
    float starRadius = 0.42 + 0.48 * pow(abs(cos(a * 3.0)), 3.0);
    mask = max(center, circleMask(r, starRadius, 0.032));
  } else if (kind >= 4.0) {
    float cross = max(
      max(lineMask(p, 0.0, 0.86, 0.045), lineMask(p, 1.5707963, 0.86, 0.045)),
      max(lineMask(p, 0.7853982, 0.72, 0.032), lineMask(p, -0.7853982, 0.72, 0.032))
    );
    mask = max(center, cross);
  }

  return clamp(mask, 0.0, 1.0);
}

half4 main(float2 fragcoord) {
  if (resolution.x <= 1.0 || resolution.y <= 1.0) {
    return half4(0.0);
  }

  float alpha = 0.0;
  float3 colorSum = float3(0.0);
  float maxDim = max(resolution.x, resolution.y);

  for (int i = 0; i < ${MAX_SHADER_PARTICLES}; i++) {
    float fi = float(i);
    if (fi >= count) {
      break;
    }

    float layer = mod(fi, 5.0);
    float behavior = mod(fi, 4.0);
    float seed = fi * 17.173 + 9.31;
    float depth = hash11(seed + 3.7);
    float phase = hash11(seed + 8.9) * 6.2831853;

    float baseX = hash11(seed + 1.1) * resolution.x;
    float baseY = hash11(seed + 2.3) * (resolution.y + 180.0) - 90.0;
    float verticalSpeed = mix(16.0, 82.0, hash11(seed + 4.1)) * (0.8 + layer * 0.18);
    float y = mod(baseY + time * verticalSpeed, resolution.y + 180.0) - 90.0;

    if (behavior >= 1.0 && behavior < 2.0) {
      y = mod(baseY - time * verticalSpeed * 0.72 + resolution.y + 90.0, resolution.y + 180.0) - 90.0;
    } else if (behavior >= 3.0) {
      y = mod(baseY + time * verticalSpeed * 0.45 + sin(time * 0.9 + phase) * 38.0, resolution.y + 180.0) - 90.0;
    }

    float sway = sin(time * (0.75 + layer * 0.13) + phase + y * 0.018) * mix(18.0, 70.0, hash11(seed + 5.2));
    float gust = sin(time * (1.8 + hash11(seed + 12.0) * 1.4) + phase) * mix(10.0, 50.0, hash11(seed + 13.0));
    float x = baseX + sway + cos(time * (0.22 + layer * 0.05) + phase) * 20.0;

    if (behavior >= 2.0 && behavior < 3.0) {
      float sideSpeed = mix(80.0, 220.0, hash11(seed + 7.6));
      float direction = hash11(seed + 7.9) < 0.5 ? -1.0 : 1.0;
      x = baseX + direction * time * sideSpeed + gust;
      y += sin(time * 2.2 + phase) * 18.0;
    } else if (behavior >= 3.0) {
      x += time * mix(36.0, 98.0, hash11(seed + 15.0)) + gust;
    }

    x = mod(x + resolution.x + 80.0, resolution.x + 160.0) - 80.0;

    float size = mix(6.0, 17.0, depth) * (1.22 + layer * 0.1) * (maxDim / 450.0);
    float rotation = phase + time * mix(-1.7, 1.7, hash11(seed + 6.4)) * (0.85 + depth);
    float mask = snowflake(rotate2((fragcoord - float2(x, y)) / size, rotation), layer + seed);
    float fade = smoothstep(-80.0, 20.0, y) * (1.0 - smoothstep(resolution.y - 20.0, resolution.y + 80.0, y));
    float flakeAlpha = mask * fade * mix(0.28, 0.82, depth);

    float tintPhase = time * 0.035 + seed;
    float3 tint = float3(
      1.0,
      0.992 + 0.008 * sin(tintPhase + 1.7),
      0.984 + 0.016 * sin(tintPhase + 3.4)
    );
    float3 color = mix(float3(1.0), tint, hueVariation * 0.08);

    alpha += flakeAlpha;
    colorSum += color * flakeAlpha;
  }

  alpha = clamp(alpha, 0.0, 0.95);
  float3 color = alpha > 0.0 ? colorSum / max(alpha, 0.001) : float3(0.0);
  color = mix(color, float3(1.0), 0.34);

  return half4(color, alpha);
}
`)

export default function SnowParticles({
  letItSnow = false,
  maxCount = 1000,
  hueVariation = true,
}: SnowParticlesProps) {
  const clock = useClock()
  const [size, setSize] = useState({ width: 0, height: 0 })
  const count = useSharedValue(0)
  const hue = useSharedValue(hueVariation ? 1 : 0)

  useEffect(() => {
    const normalized = maxCount <= 0 ? 0 : Math.min(1, maxCount / 10000)
    count.value = Math.max(0, Math.min(MAX_SHADER_PARTICLES, Math.round(normalized * MAX_SHADER_PARTICLES)))
  }, [count, maxCount])

  useEffect(() => {
    hue.value = hueVariation ? 1 : 0
  }, [hue, hueVariation])

  const uniforms = useDerivedValue(() => ({
    resolution: [size.width, size.height],
    time: clock.value / 1000,
    count: count.value,
    hueVariation: hue.value,
  }), [size.width, size.height])

  if (!letItSnow || !snowShader) return null

  return (
    <View
      style={styles.overlay}
      pointerEvents="none"
      onLayout={(event) => {
        const { width, height } = event.nativeEvent.layout
        setSize({ width, height })
      }}>
      <Canvas style={styles.canvas}>
        {size.width > 0 && size.height > 0 && (
          <Fill>
            <Shader source={snowShader} uniforms={uniforms} />
          </Fill>
        )}
      </Canvas>
    </View>
  )
}

const styles = StyleSheet.create({
  overlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10,
  },
  canvas: {
    flex: 1,
    backgroundColor: 'transparent',
  },
})
