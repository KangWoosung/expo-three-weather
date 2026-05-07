/** Shared by screens and layout components — avoids circular imports via `@/app/(tabs)`. */

export const WEATHER_TYPES = {
  SUNNY: 'sunny',
  CLOUDY: 'cloudy',
  SNOWY: 'snowy',
  RAINY: 'rainy',
  EXTREME_RAINY: 'extreme_rainy',
} as const;

export type WeatherType =
  typeof WEATHER_TYPES[keyof typeof WEATHER_TYPES];
