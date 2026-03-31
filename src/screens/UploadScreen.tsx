import { useRef, useState } from 'react'
import { useStore } from '../store'
import { SettingsDrawer } from '../components/SettingsDrawer'
import { ExamplesDrawer } from '../components/ExamplesDrawer'

export function UploadScreen() {
  const { setOriginalImage, setPhase } = useStore()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [examplesOpen, setExamplesOpen] = useState(false)
  const [dragging, setDragging] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  function handleFile(file: File) {
    if (!file.type.startsWith('image/')) return

    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      const reader = new FileReader()
      reader.onload = (e) => {
        const base64 = (e.target?.result as string).split(',')[1]
        setOriginalImage(base64, img.width, img.height)
        setPhase('processing')
        URL.revokeObjectURL(url)
      }
      reader.readAsDataURL(file)
    }
    img.src = url
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    setDragging(false)
    const file = e.dataTransfer.files[0]
    if (file) handleFile(file)
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (file) handleFile(file)
  }

  return (
    <div className="fixed inset-0 bg-gray-950 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-safe pt-4 pb-2">
        <h1 className="text-white text-xl font-bold tracking-wide">WallChanger</h1>
        <button
          onClick={() => setSettingsOpen(true)}
          className="text-gray-400 hover:text-white p-2 rounded-full hover:bg-gray-800 transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
        </button>
      </div>

      {/* Upload zone */}
      <div className="flex-1 flex flex-col items-center justify-center px-6 pb-12">
        <div
          className={`w-full max-w-sm aspect-[3/4] rounded-2xl border-2 border-dashed flex flex-col items-center justify-center gap-4 cursor-pointer transition-colors ${
            dragging ? 'border-blue-400 bg-blue-950/30' : 'border-gray-700 bg-gray-900/50'
          }`}
          onClick={() => fileInputRef.current?.click()}
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
        >
          <div className="w-16 h-16 rounded-full bg-gray-800 flex items-center justify-center">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
          <div className="text-center">
            <p className="text-white font-medium">上传室内照片</p>
            <p className="text-gray-500 text-sm mt-1">点击选择或拖拽图片</p>
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          className="hidden"
          onChange={handleInputChange}
        />

        <p className="text-gray-600 text-xs mt-6 text-center">
          上传后将自动开始 AI 处理
        </p>

        <button
          onClick={() => setExamplesOpen(true)}
          className="mt-4 flex items-center gap-2 text-blue-400 hover:text-blue-300 text-sm transition-colors"
        >
          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
          使用官方案例
        </button>
      </div>

      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ExamplesDrawer open={examplesOpen} onToggle={() => setExamplesOpen(o => !o)} />
    </div>
  )
}
