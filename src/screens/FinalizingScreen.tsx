import { useEffect } from 'react'
import { useStore } from '../store'
import { finalizeV2, renderAll, setBackendUrl } from '../utils/api'

export function FinalizingScreen() {
  const {
    compositeImage,
    originalImage,
    maskImages,
    backendUrl,
    batchMode,
    batchItems,
    setFinalImage,
    setPhase,
    clearBatchItems,
  } = useStore()

  useEffect(() => {
    setBackendUrl(backendUrl)

    if (batchMode && batchItems.length > 0) {
      // ── Batch render-all flow ──
      const items = batchItems.map(item => ({
        x: item.imgX,
        y: item.imgY,
        materialImage: item.materialB64,
      }))

      console.log('[FinalizingScreen] Starting render-all, items count:', items.length)
      console.time('[FinalizingScreen] renderAll total')

      renderAll(originalImage!, maskImages, items)
        .then((result) => {
          console.timeEnd('[FinalizingScreen] renderAll total')
          setFinalImage(result.finalImage)
          clearBatchItems()
          setPhase('done')
        })
        .catch((err) => {
          console.timeEnd('[FinalizingScreen] renderAll total')
          console.error('Batch render-all failed:', err)
          setPhase('editing')
        })
    } else {
      // ── Original finalize flow ──
      const imageToFinalize = compositeImage || originalImage
      if (!imageToFinalize) return

      finalizeV2(imageToFinalize)
        .then((result) => {
          setFinalImage(result.finalImage)
          setPhase('done')
        })
        .catch((err) => {
          console.error('Finalize failed:', err)
          setPhase('editing')
        })
    }
  }, [])

  return (
    <div className="fixed inset-0 bg-black/70 flex flex-col items-center justify-center">
      {/* Particle animation */}
      <div className="particles-container absolute inset-0 pointer-events-none" />

      {/* Ring spinner */}
      <div className="relative z-10 flex flex-col items-center gap-6">
        <div className="w-20 h-20 rounded-full border-4 border-purple-500 border-t-transparent animate-spin" />
        <p className="text-white text-lg font-medium">
          {batchMode ? '正在批量渲染...' : '正在魔法渲染...'}
        </p>
        <p className="text-gray-500 text-sm">
          {batchMode
            ? `正在处理 ${batchItems.length} 个区域，请耐心等待`
            : '请耐心等待，AI 正在施展魔法'}
        </p>
      </div>
    </div>
  )
}
