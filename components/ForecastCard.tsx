/*
2026-05-07 23:38:44



*/

import { WEATHER_TYPES } from '@/constants/weather-types'
import useWeatherStore from '@/zustand/useWeatherStore'
import React from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

type ForecastCardProps = {
  date: Date
  weather: string
  temperature: number
}

const ForecastCard = ({ date, weather, temperature }: ForecastCardProps) => {
  const { setWeatherAndTime } = useWeatherStore()

  return (
    <Pressable onPress={() =>
      setWeatherAndTime(weather as typeof WEATHER_TYPES[keyof typeof WEATHER_TYPES],
        date)}>
      <View style={styles.container}>
        <Text>
          {(() => {
            const d = new Date(date)
            const pad = (n: number) => String(n).padStart(2, '0')
            return `${pad(d.getHours())}:${pad(d.getMinutes())}`
          })()}
        </Text>
        <Text>
          {(() => {
            // You can expand this mapping as you get more weather types
            switch (weather) {
              case 'cloudy':
                return '☁️'
              case 'rainy':
                return '🌧️'
              case 'snowy':
                return '❄️'
              case 'extreme_rainy':
                return '🌧️⚡'
              default:
                return '🌤️'
            }
          })()}</Text>
        <Text>
          {(() => {
            return `${temperature}°C`
          })()}
        </Text>
      </View>
    </Pressable>
  )
}

export default ForecastCard

const styles = StyleSheet.create({
  container: {
    flex: 1,
    flexDirection: 'column',
    backgroundColor: 'rgba(255, 255, 255, 0.4)',
    padding: 10,
    borderRadius: 10,
    justifyContent: 'center',
    alignItems: 'center',
  },
})
