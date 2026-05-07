/*
2026-05-08 00:00:12



*/

import { WEATHER_TYPES } from '@/constants/weather-types'
import { ImageSourcePropType } from 'react-native'
import { create } from 'zustand'

export const headerImageSourceNight: ImageSourcePropType = require('@/assets/images/seoul_night.png')
export const headerImageSourceDay: ImageSourcePropType = require('@/assets/images/seoul_day.png')

type WeatherStore = {
    headerImage: ImageSourcePropType
    setHeaderImage: (headerImage: ImageSourcePropType) => void
    weatherTime: Date
    setWeatherTime: (weatherTime: Date) => void
    weather: typeof WEATHER_TYPES[keyof typeof WEATHER_TYPES]
    setWeather: (weather: typeof WEATHER_TYPES[keyof typeof WEATHER_TYPES]) => void
    setWeatherAndTime: (weather: typeof WEATHER_TYPES[keyof typeof WEATHER_TYPES], currentTime: Date) => void
}

const useWeatherStore = create<WeatherStore>((set) => ({
    headerImage: headerImageSourceNight,
    setHeaderImage: (headerImage) => set({ headerImage }),
    weatherTime: (() => {
        // Return new Date() in KST (GMT+9)
        const now = new Date();
        const utc = now.getTime() + now.getTimezoneOffset() * 60000;
        return new Date(utc + 9 * 60 * 60 * 1000);
    })(),
    setWeatherTime: (weatherTime) => {
        // Always convert to KST before storing
        const utc = weatherTime.getTime() + weatherTime.getTimezoneOffset() * 60000;
        const kstDate = new Date(utc + 9 * 60 * 60 * 1000);
        set({ weatherTime: kstDate });
    },
    weather: WEATHER_TYPES.CLOUDY,
    setWeather: (weather) => set({ weather }),
    setWeatherAndTime: (weather, weatherTime) => set({ weather, weatherTime }),
}))

export default useWeatherStore