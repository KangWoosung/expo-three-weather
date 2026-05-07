/**
 * ParallaxScrollView.tsx  (Snow 오버레이 통합 버전) 
 *
 * 기존 Expo 기본 ParallaxScrollView 에
 * SnowParticles Canvas 오버레이를 추가한 버전.
 *
 * 구조:
 *   <View>                          ← 루트 (포지셔닝 컨텍스트)
 *     <Animated.ScrollView>         ← 스크롤 레이어 (z-index 낮음)
 *       headerImage
 *       children
 *     </Animated.ScrollView>
 *     <SnowParticles ... />         ← absoluteFill 오버레이 (pointerEvents=none)
 *   </View>
 *
 * 터치/스크롤:  ScrollView가 받음 (SnowParticles는 pointerEvents="none")
 * 렌더링:      Canvas가 ScrollView 위에 float
 */

import { ThemedView } from '@/components/themed-view';
import { useColorScheme } from '@/hooks/use-color-scheme';
import { useThemeColor } from '@/hooks/use-theme-color';
import React, { PropsWithChildren, ReactElement, useEffect, useRef, useState } from 'react';
import { Button, ImageSourcePropType, StyleSheet, Text, View } from 'react-native';
import Animated, {
  interpolate,
  useAnimatedRef,
  useAnimatedStyle,
  useScrollViewOffset,
} from 'react-native-reanimated';

// import SnowParticles from '@/scenes/SnowParticles.three';
// import SnowParticles from '@/scenes/SnowParticles.skia';
// import SnowParticles from '@/scenes/SnowParticles.skia2';
// import CloudsScene from '@/scenes/Clouds.three';
import { WEATHER_TYPES } from '@/constants/weather-types';
import CloudsScene from '@/scenes/Clouds.three';
import RainDropFX from '@/scenes/RainDropFX.three';
import RainyDayWebView from '@/scenes/RainyDayWebView';
import { RainyGlassRef } from '@/scenes/RainyGlass.three';
import SnowParticles from '@/scenes/SnowParticles.three';
import useWeatherStore from '@/zustand/useWeatherStore';
import Ionicons from '@expo/vector-icons/build/Ionicons';
import WeatherForecastContainer from './WeatherForecastContainer';

export const HEADER_HEIGHT = 450

// ─── Props ────────────────────────────────────────────────────────────────────
type Props = PropsWithChildren<{
  headerImage: ReactElement
  headerBackgroundColor: { dark: string; light: string }
  /** 눈 효과 켜기/끄기 (기본 false) */
  letItSnow?: boolean
  /** 파티클 수 (기본 8000) */
  snowCount?: number
  /** Hue 변동 (기본 true) */
  snowHueVariation?: boolean
  /** Rainy glass droplets sample this image for reflection color. */
  backgroundSource?: ImageSourcePropType
  weatherType: typeof WEATHER_TYPES[keyof typeof WEATHER_TYPES]
}>

// ─── 컴포넌트 ─────────────────────────────────────────────────────────────────
export default function ParallaxScrollView({
  children,
  headerImage,
  headerBackgroundColor,
  letItSnow = true,
  snowCount = 1000,
  snowHueVariation = true,
  backgroundSource,
}: Props) {
  const { weather: weatherType } = useWeatherStore()
  const backgroundColor = useThemeColor({}, 'background')
  const colorScheme = useColorScheme() ?? 'light'
  const scrollRef = useAnimatedRef<Animated.ScrollView>()
  const scrollOffset = useScrollViewOffset(scrollRef)
  const [rainEnabled, setRainEnabled] = useState(true)
  const rainyRef = useRef<RainyGlassRef>(null)
  const { weatherTime } = useWeatherStore()
  const [weatherTimeShortFormat, setWeatherTimeShortFormat] = useState('')
  const [weatherIcon, setWeatherIcon] = useState<string>('sunny-outline')

  useEffect(() => {
    const newWeatherTimeShortFormat = weatherTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    setWeatherTimeShortFormat(newWeatherTimeShortFormat)
  }, [weatherTime.getHours(), weatherTime.getMinutes()])

  useEffect(() => {
    switch (weatherType) {
      case WEATHER_TYPES.SUNNY:
        setWeatherIcon('sunny-outline')
        break
      case WEATHER_TYPES.CLOUDY:
        setWeatherIcon('cloudy-outline')
        break
      case WEATHER_TYPES.SNOWY:
        setWeatherIcon('snow-outline')
        break
      case WEATHER_TYPES.RAINY:
        setWeatherIcon('rainy-outline')
        break
      case WEATHER_TYPES.EXTREME_RAINY:
        setWeatherIcon('extreme-rainy-outline')
        break
      default:
        setWeatherIcon('sunny-outline')
        break
    }
  }, [weatherType])

  const headerAnimatedStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateY: interpolate(
          scrollOffset.value,
          [-HEADER_HEIGHT, 0, HEADER_HEIGHT],
          [-HEADER_HEIGHT / 2, 0, HEADER_HEIGHT * 0.75]
        ),
      },
      {
        scale: interpolate(
          scrollOffset.value,
          [-HEADER_HEIGHT, 0, HEADER_HEIGHT],
          [2, 1, 1]
        ),
      },
    ],
  }))

  return (
    /**
     * 루트 View — position: 'relative' 컨텍스트.
     * SnowParticles의 absoluteFill 이 이 View 를 기준으로 채움.
     */
    <View style={styles.root}>
      {/* ── 스크롤 레이어 ── */}
      <Animated.ScrollView
        ref={scrollRef}
        style={{ backgroundColor, flex: 1 }}
        scrollEventThrottle={16}
      >
        <Animated.View
          style={[
            styles.header,
            { backgroundColor: headerBackgroundColor[colorScheme] },
            headerAnimatedStyle,
          ]}
        >
          {headerImage}
          <View style={styles.headerForeground} pointerEvents="none">
            <Text style={styles.headerTime}>{weatherTimeShortFormat}</Text>
            <Text style={styles.headerTitle}>서울</Text>
            <Ionicons name={weatherIcon as any} size={40} color="white" />
          </View>

          {/* Weather ForeCast */}
          <WeatherForecastContainer />

          {weatherType === WEATHER_TYPES.CLOUDY && (
            <CloudsScene
              enabled={true}
              cloudScale={0.9}
              speed={0.02}
              evolutionSpeed={0.06}
              cloudDark={0.6}
              cloudLight={0.3}
              cloudCover={0.04}
              cloudDensity={0.16}
              cloudAlpha={8.0}
              cloudOpacity={0.42}
              alphaThreshold={0.18}
              flowDirection={[1, 1]}
            />)}

          {/* <RainyGlassThree
            enabled={rainEnabled}
            maxFps={30}
            speed={0.04}
            rainScale={1}
            dropStrength={1}
            trailStrength={0.72}
            rippleStrength={0.018}
            opacity={0.55}
            brightness={1}
            reflectionStrength={0.78}
            flowDirection={[0.08, 1]}
            backgroundSource={backgroundSource}
          /> */}

          {weatherType === WEATHER_TYPES.SNOWY && (
            <SnowParticles
              letItSnow={letItSnow}
              maxCount={400}
              hueVariation={snowHueVariation}
            />)}

          {/* {weatherType === WEATHER_TYPES.RAINY && (
            <RainyGlass
              enabled={rainEnabled}
              source={backgroundSource as ImageSourcePropType}
              ref={rainyRef}
              maxDrops={100}
              dropScale={1.2}
              backgroundContentPosition="top"
            />)} */}

          {weatherType === WEATHER_TYPES.RAINY && (
            <RainyDayWebView backgroundImage={backgroundSource as ImageSourcePropType} />
          )}

          {weatherType === WEATHER_TYPES.EXTREME_RAINY && (
            <RainDropFX
              enabled={rainEnabled}
              source={backgroundSource as ImageSourcePropType}
            />
          )}

        </Animated.View>

        <Button title="Toggle Rain" onPress={() => setRainEnabled(s => !s)} />
        <ThemedView style={styles.content}>{children}</ThemedView>
      </Animated.ScrollView>
    </View>
  )
}

// ─── 독립 사용 예시 ───────────────────────────────────────────────────────────
/**
 * 외부에서 눈 토글 버튼을 두고 싶을 때:
 *
 * function HomeScreen() {
 *   const [snow, setSnow] = useState(false)
 *   return (
 *     <ParallaxScrollView
 *       headerImage={<Image ... />}
 *       headerBackgroundColor={{ dark: '#1D3D47', light: '#A1CEDC' }}
 *       letItSnow={snow}
 *     >
 *       <Button title={snow ? '☀️ 멈추기' : '❄️ 눈 내리기'} onPress={() => setSnow(s => !s)} />
 *       ...
 *     </ParallaxScrollView>
 *   )
 * }
 */

const styles = StyleSheet.create({
  root: {
    flex: 1,
    overflow: 'hidden',
    position: 'relative',
  },
  header: {
    height: HEADER_HEIGHT,
    overflow: 'hidden',
    position: 'relative',
  },
  headerForeground: {
    position: 'absolute',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 0,
    top: 60,
    right: 48,
    zIndex: 20,
  },
  headerTitle: {
    color: 'floralwhite',
    fontSize: 40,
    fontWeight: 'bold',
    textShadowColor: 'rgb(29 29 29)',
    textShadowOffset: { width: 0, height: 4 },
    textShadowRadius: 24,
  },
  headerTime: {
    color: 'floralwhite',
    fontSize: 14,
    fontWeight: 'normal',
    textShadowColor: 'rgb(30 30 30)',
    textShadowOffset: { width: 0, height: 4 },
    textShadowRadius: 12,
  },
  content: {
    flex: 1,
    padding: 32,
    gap: 16,
    overflow: 'hidden',
  },
})
