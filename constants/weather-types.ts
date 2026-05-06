/** Shared by screens and layout components — avoids circular imports via `@/app/(tabs)`. */

export const WEATHER_TYPES = {
  CLOUDY: 'cloudy',
  RAINY: 'rainy',
  SNOWY: 'snowy',
} as const;

export type WeatherType =
  typeof WEATHER_TYPES[keyof typeof WEATHER_TYPES];
