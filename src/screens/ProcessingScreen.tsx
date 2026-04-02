import { useEffect, useState } from 'react'
import { useStore } from '../store'
import { enhanceImage, processMasks, debugSegment, setBackendUrl } from '../utils/api'

const STEPS = [
  '增强原图',
  '清理场景',
  '识别区域',
  '精炼蒙版',
]

const DEBUG_STEPS = [
  '识别区域',
]

async function waitForModel(url: string, onStatusChange: (msg: string) => void, signal: { ignore: boolean }): Promise<void> {
  let attempts = 0
  while (!signal.ignore) {
    try {
      const resp = await fetch(`${url}/health`)
      if (resp.ok) {
        const health = await resp.json()
        if (health.model_loaded) return
        onStatusChange(`SAM3 模型加载中... (${attempts + 1})`)
      } else {
        onStatusChange('等待后端启动...')
      }
    } catch {
      onStatusChange('等待后端启动...')
    }
    attempts++
    await new Promise(r => setTimeout(r, 3000))
  }
}

export function ProcessingScreen() {
  const {
    originalImage,
    dimensions,
    processingStep,
    backendUrl,
    debugPrompts,
    debugMode,
    setProcessingStep,
    setOriginalImage,
    setMasks,
    setPhase,
  } = useStore()

  const [waitingMsg, setWaitingMsg] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setBackendUrl(backendUrl)
    if (!originalImage) return

    const signal = { ignore: false }

    async function run() {
      try {
        if (debugMode) {
          // Debug mode: skip preprocessing, just SAM3
          setProcessingStep(1)
          const result = await debugSegment(originalImage!)
          if (signal.ignore) return
          setProcessingStep(4)
          setMasks(result.refinedMask, result.rawMask, result.masks)
          setTimeout(() => setPhase('editing'), 300)
        } else {
          // Normal mode: full pipeline
          setProcessingStep(0)
          setWaitingMsg('SAM3 模型加载中...')
          await waitForModel(backendUrl, setWaitingMsg, signal)
          if (signal.ignore) return
          setWaitingMsg(null)

          setProcessingStep(1)
          const enh = await enhanceImage(originalImage!, dimensions.width, dimensions.height, debugPrompts.enhance)
          if (signal.ignore) return
          setOriginalImage(enh.enhancedImage, dimensions.width, dimensions.height)

          setProcessingStep(2)
          const result = await processMasks(enh.enhancedImage, debugPrompts.clean, debugPrompts.refine)
          if (signal.ignore) return
          setProcessingStep(4)
          setMasks(result.refinedMask, result.rawMask, result.masks)
          setTimeout(() => setPhase('editing'), 300)
        }
      } catch (err) {
        if (signal.ignore) return
        console.error('Processing failed:', err)
        setError(err instanceof Error ? err.message : '处理失败，请重试')
      }
    }

    run()

    return () => { signal.ignore = true }
  }, [])

  return (
    <div className="fixed inset-0 bg-gray-950 flex flex-col items-center justify-center">
      {/* Dimmed image */}
      {originalImage && (
        <div className="absolute inset-0">
          <img
            src={`data:image/jpeg;base64,${originalImage}`}
            className="w-full h-full object-cover opacity-30"
            alt=""
          />
          <div className="absolute inset-0 bg-gray-950/60" />
        </div>
      )}

      {/* Progress UI */}
      <div className="relative z-10 w-full max-w-sm px-6">
        <h2 className="text-white text-center text-lg font-semibold mb-8">
          {debugMode ? 'SAM3 识别中...' : 'AI 分析中...'}
        </h2>

        {/* Model waiting state */}
        {waitingMsg && (
          <div className="mb-6 flex items-center gap-3 bg-gray-800/80 rounded-xl px-4 py-3">
            <div className="w-4 h-4 rounded-full border-2 border-yellow-400 border-t-transparent animate-spin flex-shrink-0" />
            <span className="text-yellow-300 text-sm">{waitingMsg}</span>
          </div>
        )}

        <div className="space-y-4">
          {(debugMode ? DEBUG_STEPS : STEPS).map((label, index) => {
            const stepNum = index + 1
            const isCompleted = processingStep > stepNum
            const isActive = processingStep === stepNum && !waitingMsg
            const isPending = processingStep < stepNum

            return (
              <div key={label} className="flex items-center gap-3">
                <div className={`w-8 h-8 rounded-full flex items-center justify-center flex-shrink-0 ${
                  isCompleted ? 'bg-green-500' :
                  isActive ? 'bg-blue-500' :
                  'bg-gray-800'
                }`}>
                  {isCompleted ? (
                    <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                    </svg>
                  ) : isActive ? (
                    <div className="w-3 h-3 rounded-full border-2 border-white border-t-transparent animate-spin" />
                  ) : (
                    <span className="text-gray-600 text-xs">{stepNum}</span>
                  )}
                </div>
                <span className={`text-sm ${
                  isCompleted ? 'text-green-400' :
                  isActive ? 'text-white' :
                  isPending ? 'text-gray-600' : 'text-gray-400'
                }`}>
                  {label}
                </span>
              </div>
            )
          })}
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
