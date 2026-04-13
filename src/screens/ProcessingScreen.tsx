import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { preprocessImage, setBackendUrl } from '../utils/api'
import type { MaskInfo } from '../types'
import { toImgSrc } from '../types'

function generateUniqueColor(existing: [number, number, number][]): [number, number, number] {
  const MIN_DIST_SQ = 80 * 80
  for (let attempt = 0; attempt < 300; attempt++) {
    const r = Math.floor(Math.random() * 200) + 28
    const g = Math.floor(Math.random() * 200) + 28
    const b = Math.floor(Math.random() * 200) + 28
    let ok = true
    for (const [er, eg, eb] of existing) {
      if ((r - er) ** 2 + (g - eg) ** 2 + (b - eb) ** 2 < MIN_DIST_SQ) { ok = false; break }
    }
    if (ok) return [r, g, b]
  }
  return [255, 128, 0]
}

export function ProcessingScreen() {
  const {
    originalImage,
    dimensions,
    backendUrl,
    setOriginalImage,
    setMasks,
    setPhase,
  } = useStore()

  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    console.log(`[ProcessingScreen] effect triggered, originalImage exists: ${!!originalImage}`)
    setBackendUrl(backendUrl)
    if (!originalImage) return

    const signal = { ignore: false }

    async function run() {
      try {
        console.log('[ProcessingScreen] calling preprocessImage...')
        const result = await preprocessImage(originalImage!)
        if (signal.ignore) return

        console.log(`[ProcessingScreen] received response, enforcedResult length: ${result.enforcedResult?.length}, masks count: ${result.masks?.length}`)

        // Validate response
        if (!result.enforcedResult || !Array.isArray(result.masks) || result.masks.length === 0) {
          throw new Error('Invalid preprocess response: missing enforcedResult or masks')
        }

        // Build MaskInfo array: assign unique colors to each B&W mask
        const colors: [number, number, number][] = []
        const masks: MaskInfo[] = result.masks.map((_, i) => {
          const color = generateUniqueColor(colors)
          colors.push(color)
          return { id: i, label: `wall_${i + 1}`, color }
        })

        setMasks(result.enforcedResult, result.masks, masks)
        console.log('[ProcessingScreen] transitioning to editing phase')
        setTimeout(() => setPhase('editing'), 300)
      } catch (err) {
        if (signal.ignore) return
        console.error('Preprocessing failed:', err)
        console.error('[ProcessingScreen] full error object:', JSON.stringify(err, Object.getOwnPropertyNames(err as object)))
        setError(err instanceof Error ? err.message : '处理失败，请重试')
      }
    }

    run()
    return () => { signal.ignore = true }
  }, [originalImage, backendUrl, setMasks, setPhase])

  return (
    <div className="fixed inset-0 bg-gray-950 flex flex-col items-center justify-center">
      {/* Dimmed original image in background */}
      {originalImage && (
        <div className="absolute inset-0">
          <img
            src={toImgSrc(originalImage)}
            className="w-full h-full object-cover opacity-30"
            crossOrigin="anonymous"
            alt=""
          />
          <div className="absolute inset-0 bg-gray-950/60" />
        </div>
      )}

      <div className="relative z-10 w-full max-w-sm px-6">
        <h2 className="text-white text-center text-lg font-semibold mb-8">AI 分析中...</h2>

        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 bg-blue-500">
            <div className="w-3 h-3 rounded-full border-2 border-white border-t-transparent animate-spin" />
          </div>
          <span className="text-sm text-white">识别墙面区域</span>
        </div>

        {error ? (
          <div className="mt-6 bg-red-900/40 border border-red-700 rounded-xl p-4">
            <p className="text-red-400 text-sm font-medium">处理失败</p>
            <p className="text-red-500 text-xs mt-1">{error}</p>
            <button
              onClick={() => setPhase('upload')}
              className="mt-3 text-xs text-red-400 underline"
            >
              返回重新上传
            </button>
          </div>
        ) : (
          <p className="text-gray-600 text-xs text-center mt-8">请稍候，处理时间约需一分钟</p>
        )}
      </div>
    </div>
  )
}
