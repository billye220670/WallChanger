import { useStore } from '../store'

export function ResultSheet() {
  const { finalImage, setPhase } = useStore()

  function handleSave() {
    if (!finalImage) return

    const link = document.createElement('a')
    link.href = `data:image/png;base64,${finalImage}`
    link.download = `wallchanger-${Date.now()}.png`
    link.click()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end">
      <div className="absolute inset-0 bg-black/60" onClick={() => setPhase('editing')} />

      <div className="relative w-full bg-gray-900 rounded-t-2xl shadow-2xl animate-slide-up pb-safe">
        <div className="flex items-center justify-between p-4 border-b border-gray-800">
          <h2 className="text-white font-semibold">渲染完成</h2>
          <button
            onClick={() => setPhase('editing')}
            className="text-gray-400 hover:text-white"
          >
            <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-4">
          {finalImage && (
            <img
              src={`data:image/png;base64,${finalImage}`}
              alt="Final result"
              className="w-full rounded-lg"
            />
          )}
        </div>

        <div className="px-4 pb-4 space-y-2">
          <button
            onClick={handleSave}
            className="w-full bg-blue-600 hover:bg-blue-500 text-white rounded-lg py-3 font-medium transition-colors"
          >
            保存图片
          </button>
          <button
            onClick={() => setPhase('editing')}
            className="w-full bg-gray-800 hover:bg-gray-700 text-white rounded-lg py-3 font-medium transition-colors"
          >
            继续编辑
          </button>
        </div>
      </div>
    </div>
  )
}
