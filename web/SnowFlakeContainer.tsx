'use client' 
import { Canvas, invalidate, useFrame, useLoader, useThree } from '@react-three/fiber'
import { Environment, OrbitControls } from '@react-three/drei';
import React, { useEffect, useMemo, useRef, useState } from 'react'
import * as THREE from 'three'
import { SnowParticles } from './SnowParticles'
import { useFrostedGlassEffectStore } from '@/zustand/useFrostedGlassEffectStore'
import { isColorString } from '@/utils/colorUtils'


/** Canvas 내부: 이미지 URL일 때 씬 배경을 texture로 설정. 원본 비율 유지(cover). */
function SceneBackgroundImage({ url }: { url: string }) {
  const sourceTexture = useLoader(THREE.TextureLoader, url)
  const size = useThree((state) => state.size)

  const texture = useMemo(() => {
    const tex = sourceTexture.clone()
    const img = tex.image as HTMLImageElement | undefined
    if (!img?.width || !img?.height || !size.width || !size.height) return tex

    const imageAspect = img.width / img.height
    const viewportAspect = size.width / size.height
    const factor = imageAspect / viewportAspect

    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping
    if (factor > 1) {
      tex.offset.set((1 - 1 / factor) / 2, 0)
      tex.repeat.set(1 / factor, 1)
    } else {
      tex.offset.set(0, (1 - factor) / 2)
      tex.repeat.set(1, factor)
    }
    return tex
  }, [sourceTexture, size.width, size.height])

  return <primitive object={texture} attach="background" />
}

type SnowFlakeContainerProps = {
  children: React.ReactNode
  /** 눈발(파티클) 최대 개수 (기본 10000) */
  maxCount?: number
  /** 씬 배경: 색상(hex/rgb/이름) 또는 이미지 URL. 라이트 모드에서는 "#f8fafc" 등 밝은 색 권장 */
  background?: string
}

const SnowFlakeContainer = ({ children, background: backgroundProp }: SnowFlakeContainerProps) => {
  const maxCountState = useFrostedGlassEffectStore((state) => state.maxCount)
  const mouseInteractionState = useFrostedGlassEffectStore((state) => state.mouseInteraction)
  const backgroundFromStore = useFrostedGlassEffectStore((state) => state.background)
  const background = backgroundProp ?? backgroundFromStore
  const hueVariationState = useFrostedGlassEffectStore((state) => state.hueVariation)
  const letItSnow = useFrostedGlassEffectStore((state) => state.letItSnow)
  const [cameraState, setCameraState] = useState(false)

  const boxRef = useRef<THREE.Mesh>(null)

  // 프레임 애니메이션을 위해 500ms 뒤에 카메라 state 를 변경함
  useEffect(() => {
    const timer = setTimeout(() => {
      setCameraState((prev) => !prev)
    }, 500)
    return () => clearTimeout(timer)
  }, [])

  return (
    <div className="w-full h-full flex-[2] min-w-0
    border-2 border-yellow-500 rounded-md relative overflow-hidden">

      <div className="absolute inset-0 z-0 pointer-events-none">
        <Canvas frameloop="demand" >

          {/* Use a preset and apply blur */}
          {/* <Environment
            preset="city"          // or "forest", "warehouse", etc.
            background
            backgroundBlurriness={0.1} // Blur factor between 0 and 1
          /> */}

          {background !== '' && isColorString(background) && (
            <color attach="background" args={[background]} />
          )}
          {background !== '' && !isColorString(background) && (
            <SceneBackgroundImage url={background} />
          )}
          <SnowFlakeBox />
          <SnowParticles
            mouseInteraction={mouseInteractionState}
            maxCount={maxCountState}
            hueVariation={hueVariationState}
            letItSnow={letItSnow}
            cameraState={cameraState}
            setCameraState={setCameraState}
          />
          <OrbitControls />
        </Canvas>
      </div>

      <div
        className="relative inset-0 w-full h-full z-10 border-0 border-blue-500"

      >
        {children}
      </div>
    </div>
  )
}

export default SnowFlakeContainer

const SnowFlakeBox = () => {
  const boxRef = useRef<THREE.Mesh>(null)
  useFrame((state, delta) => {
    if (!boxRef.current) return
    boxRef.current.rotation.x += delta
  })
  return (
    <mesh>
      <boxGeometry args={[40, 40, 40]} />
      <meshBasicMaterial color="yellow" transparent opacity={0.5} side={THREE.DoubleSide} />
    </mesh>
  )
}