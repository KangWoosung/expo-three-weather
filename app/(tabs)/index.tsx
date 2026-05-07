import { Image } from 'expo-image';
import { Button, StyleSheet, Text } from 'react-native';

import { HelloWave } from '@/components/hello-wave';
import ParallaxScrollView from '@/components/ParallaxScrollView';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { WEATHER_TYPES } from '@/constants/weather-types';
import useWeatherStore, { headerImageSourceDay, headerImageSourceNight } from '@/zustand/useWeatherStore';
import { Link } from 'expo-router';
import { useEffect, useState } from 'react';


export default function HomeScreen() {
  const [particlesCnt] = useState(800)
  const { weather, setWeather, weatherTime, headerImage, setHeaderImage } = useWeatherStore()

  useEffect(() => {
    // 밤과 낮을 getHours()로 단순히 판단하면, 로컬 타임존이나 새벽/이른 아침 경계 등의 문제가 있음
    // dateTime 기준(예: yyyy-MM-ddTHH:mm:ss, 24시간제)으로, 
    // 06:00 ~ 17:59까지를 '낮', 18:00 ~ 05:59까지를 '밤'으로 구별
    // -> 밤: 18:00이상 또는 06:00미만, 낮: 06:00이상 18:00미만
    const hour = Number(
      weatherTime
        .toISOString()
        .substring(11, 13)
    );
    // ISO 문자열 기준, UTC이므로 실제 로컬 시간대 필요시 보정 필요(아래는 local 기준으로 직접 가져오기)
    // const hour = weatherTime.getHours();

    const isDay =
      hour > 6 && hour < 18;
    const imageSource = isDay
      ? headerImageSourceDay
      : headerImageSourceNight;
    setHeaderImage(imageSource)
  }, [weatherTime, setHeaderImage])

  return (
    <ParallaxScrollView
      headerBackgroundColor={{ light: '#768BD0', dark: '#1D3D47' }}
      headerImage={
        <Image
          source={headerImage}
          contentFit="cover"
          contentPosition="top center"
          style={styles.headerImage}
        />
      }
      backgroundSource={headerImage}
      snowCount={particlesCnt}
      weatherType={weather}
    >
      <ThemedView style={styles.titleContainer}>
        <ThemedText type="title">Welcome!</ThemedText>
        <HelloWave />
      </ThemedView>
      <ThemedView style={styles.stepContainer}>
        <ThemedText type="subtitle">
          <Text className="text-red-500">Step</Text>
          1: Try out it
        </ThemedText>
        <ThemedText>
          <Button title="Cloudy" onPress={() => setWeather(WEATHER_TYPES.CLOUDY)} />
          <Button title="Snowy" onPress={() => setWeather(WEATHER_TYPES.SNOWY)} />
          <Button title="Rainy" onPress={() => setWeather(WEATHER_TYPES.RAINY)} />
          <Button title="Extreme Rainy" onPress={() => setWeather(WEATHER_TYPES.EXTREME_RAINY)} />
        </ThemedText>
      </ThemedView>
      <ThemedView style={styles.stepContainer}>
        <Link href="/modal">
          <Link.Trigger>
            <ThemedText type="subtitle">Step 2: Explore</ThemedText>
          </Link.Trigger>
          <Link.Preview />
          <Link.Menu>
            <Link.MenuAction title="Action" icon="cube" onPress={() => alert('Action pressed')} />
            <Link.MenuAction
              title="Share"
              icon="square.and.arrow.up"
              onPress={() => alert('Share pressed')}
            />
            <Link.Menu title="More" icon="ellipsis">
              <Link.MenuAction
                title="Delete"
                icon="trash"
                destructive
                onPress={() => alert('Delete pressed')}
              />
            </Link.Menu>
          </Link.Menu>
        </Link>

        <ThemedText>
          {`Tap the Explore tab to learn more about what's included in this starter app.`}
        </ThemedText>
      </ThemedView>
      <ThemedView style={styles.stepContainer}>
        <ThemedText type="subtitle">Step 3: Get a fresh start</ThemedText>
        <ThemedText>
          {`When you're ready, run `}
          <ThemedText type="defaultSemiBold">npm run reset-project</ThemedText> to get a fresh{' '}
          <ThemedText type="defaultSemiBold">app</ThemedText> directory. This will move the current{' '}
          <ThemedText type="defaultSemiBold">app</ThemedText> to{' '}
          <ThemedText type="defaultSemiBold">app-example</ThemedText>.
        </ThemedText>
      </ThemedView>
    </ParallaxScrollView>
  );
}

const styles = StyleSheet.create({
  titleContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  stepContainer: {
    gap: 8,
    marginBottom: 80,
    marginTop: 80,
  },
  headerImage: {
    height: '100%',
    width: '100%',
  },
});
