import { useEffect } from 'react'
import { useStore } from '../store'
import { finalize, setBackendUrl } from '../utils/api'

export function FinalizingScreen() {
  const {
    compositeImage,
    originalImage,
    dimensions,
    backendUrl,
    debugPrompts,
    setFinalImage,
    setPhase,
  } = useStore()

  useEffect(() => {
    setBackendUrl(backendUrl)
    const imageToFinalize = compositeImage || originalImage
    if (!imageToFinalize) return

    finalize(imageToFinalize, debugPrompts.finalize)
      .then((result) => {
        setFinalImage(result.finalImage)
        setPhase('done')
      })
      .catch((err) => {
        console.error('Finalize failed:', err)
        setPhase('editing')
      })
  }, [])

  return (
    <div className="fixed inset-0 bg-black/70 flex flex-col items-center justify-center">
      {/* Particle animation */}
      <div className="particles-container absolute inset-0 pointer-events-none" />

      {/* Ring spinner */}
      <div className="relative z-10 flex flex-col items-center gap-6">
        <div className="w-20 h-20 rounded-full border-4 border-purple-500 border-t-transparent animate-spin" />
        <p className="text-white text-lg font-medium">正在魔法渲染...</p>
        <p className="text-gray-500 text-sm">请耐心等待，AI 正在施展魔法</p>
      </div>
    </div>
  )
}
