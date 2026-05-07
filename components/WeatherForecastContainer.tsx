import React, { useEffect, useState } from 'react'
import { StyleSheet, View } from 'react-native'
import ForecastCard from './ForecastCard'

const FORECAST_FIXED_FIELDS = [
  { weather: 'cloudy', temperature: 20 },
  { weather: 'rainy', temperature: 10 },
  { weather: 'snowy', temperature: 0 },
  { weather: 'extreme rainy', temperature: 10 },
  { weather: 'sunny', temperature: 20 },
] as const

/** Earliest local `…:00` on the 3h grid strictly after `now` (e.g. 18:42 → 21:00, 23:49 → 다음날 00:00). */
function nextThreeHourGridSlot(now: Date): Date {
  // `now.getTime()`은 항상 UTC 기준의 ms 타임스탬프를 리턴합니다.
  // 만약 GMT+9(한국 시간) 기준의 Date 객체를 얻고 싶다면,
  // 9시간을 ms 단위로 더한 별도의 Date 객체를 만들어야 합니다.

  // 예시: now 파라미터가 JS Date (로컬/UTC 혼용)라면, 강제로 GMT+9 기준 Date로 변환
  function toKST(date: Date): Date {
    // JS Date.getTimezoneOffset()은 분 단위, UTC-KST는 -540 (즉, +9시간)
    // KST = UTC + 9h = UTC - getTimezoneOffset + 9h - (현 오프셋)
    const utc = date.getTime() + (date.getTimezoneOffset() * 60000)
    // add 9시간 (9 * 60 * 60 * 1000 = 32400000)
    return new Date(utc + 9 * 60 * 60 * 1000)
  }
  // 여기서는 내부 계산 용 now를 항상 KST Date로 변환해서 전달하도록 하면 됩니다.
  now = toKST(now)
  const cand = new Date(now.getTime())
  cand.setMilliseconds(0)
  cand.setSeconds(0)
  const floorHr = new Date(cand.getFullYear(), cand.getMonth(), cand.getDate(), cand.getHours(), 0, 0, 0)
  const nextHrMs =
    floorHr.getTime() <= cand.getTime() ? floorHr.getTime() + 60 * 60 * 1000 : floorHr.getTime()
  cand.setTime(nextHrMs)
  cand.setMilliseconds(0)
  cand.setSeconds(0)
  cand.setMinutes(0)

  let h = cand.getHours()
  const r = ((h % 3) + 3) % 3
  if (r !== 0) {
    cand.setHours(h + (3 - r), 0, 0, 0)
  }
  if (cand.getTime() <= now.getTime()) {
    cand.setHours(cand.getHours() + 3, 0, 0, 0)
  }
  return cand
}

function buildForecastDummyData(now: Date): { date: Date; weather: string; temperature: number }[] {
  const start = nextThreeHourGridSlot(now)
  const stepMs = 3 * 60 * 60 * 1000
  return FORECAST_FIXED_FIELDS.map((fields, i) => {
    const d = new Date(start.getTime() + i * stepMs)
    d.setMilliseconds(0)
    d.setSeconds(0)
    d.setMinutes(0)
    return {
      date: d,
      weather: fields.weather,
      temperature: fields.temperature,
    }
  })
}

const WeatherForecastContainer = () => {
  const [, setNowTick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => setNowTick((n) => n + 1), 30_000)
    return () => clearInterval(id)
  }, [])

  const data = buildForecastDummyData(new Date())

  return (
    <View style={styles.container}>
      {data.map((item) => (
        <ForecastCard key={item.date.getTime()} {...item} />
      ))}
    </View>
  )
}

export default WeatherForecastContainer

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    zIndex: 20,
    left: 20,
    right: 20,
    bottom: 20,
    flex: 1,
    flexDirection: 'row',
    gap: 10,
    justifyContent: 'space-between',
    alignItems: 'center',
    backgroundColor: 'transparent',
    padding: 10,
    borderRadius: 10,
  },
})
