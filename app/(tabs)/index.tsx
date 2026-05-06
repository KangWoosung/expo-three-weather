import { Image } from 'expo-image';
import { Button, StyleSheet, Text } from 'react-native';

import { HelloWave } from '@/components/hello-wave';
import ParallaxScrollView from '@/components/ParallaxScrollView';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { WEATHER_TYPES } from '@/constants/weather-types';
import { Link } from 'expo-router';
import { useState } from 'react';

const headerImageSource = require('@/assets/images/seoul_night.png')

export default function HomeScreen() {
  const [particlesCnt] = useState(800)
  const [weatherType, setWeatherType] = useState<typeof WEATHER_TYPES[keyof typeof WEATHER_TYPES]>(WEATHER_TYPES.CLOUDY);

  return (
    <ParallaxScrollView
      headerBackgroundColor={{ light: '#768BD0', dark: '#1D3D47' }}
      headerImage={
        <Image
          source={headerImageSource}
          contentFit="cover"
          contentPosition="top center"
          style={styles.headerImage}
        />
      }
      rainBackgroundSource={headerImageSource}
      snowCount={particlesCnt}
      weatherType={weatherType}
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
          <Button title="Cloudy" onPress={() => setWeatherType(WEATHER_TYPES.CLOUDY)} />
          <Button title="Rainy" onPress={() => setWeatherType(WEATHER_TYPES.RAINY)} />
          <Button title="Snowy" onPress={() => setWeatherType(WEATHER_TYPES.SNOWY)} />
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
