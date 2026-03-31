import { useRef, useState } from 'react'
import type { MaskInfo } from '../types'
import { remapMaskColors } from '../utils/remapMaskColors'
import { useStore } from '../store'

interface ExampleMeta {
  id: string
  label: string
}

const EXAMPLES: ExampleMeta[] = [
  { id: 'example1', label: '案例 1' },
  { id: 'example2', label: '案例 2' },
  { id: 'example3', label: '案例 3' },
]

interface ExamplesDrawerProps {
  open: boolean
  onToggle: () => void
}

async function imageUrlToBase64(url: string): Promise<{ base64: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      canvas.getContext('2d')!.drawImage(img, 0, 0)
      const base64 = canvas.toDataURL('image/jpeg', 0.95).split(',')[1]
      resolve({ base64, width: img.width, height: img.height })
    }
    img.onerror = reject
    img.crossOrigin = 'anonymous'
    img.src = url
  })
}

async function parseMaskColors(maskUrl: string): Promise<{ masks: MaskInfo[]; maskBase64: string }> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width = img.width
      canvas.height = img.height
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(img, 0, 0)
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)

      const colorMap = new Map<string, [number, number, number]>()
      for (let i = 0; i < data.length; i += 4) {
        const r = data[i], g = data[i + 1], b = data[i + 2]
        if (r === 0 && g === 0 && b === 0) continue
        const key = `${r},${g},${b}`
        if (!colorMap.has(key)) colorMap.set(key, [r, g, b])
      }

      const masks: MaskInfo[] = Array.from(colorMap.values()).map((color, i) => ({
        id: i + 1,
        label: `区域${i + 1}`,
        color,
      }))

      const maskBase64 = canvas.toDataURL('image/png').split(',')[1]
      resolve({ masks, maskBase64 })
    }
    img.onerror = reject
    img.crossOrigin = 'anonymous'
    img.src = maskUrl
  })
}

export function ExamplesDrawer({ open, onToggle }: ExamplesDrawerProps) {
  const { loadExample } = useStore()
  const [loading, setLoading] = useState<string | null>(null)

  const drawerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startY: number; startOpen: boolean; lastY: number; lastTime: number } | null>(null)
  const didDragRef = useRef(false)
  const [translateY, setTranslateY] = useState<number | null>(null)

  function getMaxTranslate() {
    if (!drawerRef.current) return 300
    return drawerRef.current.getBoundingClientRect().height - 56
  }

  function handlePointerDown(e: React.PointerEvent) {
    e.currentTarget.setPointerCapture(e.pointerId)
    didDragRef.current = false
    dragRef.current = {
      startY: e.clientY,
      startOpen: open,
      lastY: e.clientY,
      lastTime: Date.now(),
    }
    setTranslateY(open ? 0 : getMaxTranslate())
  }

  function handlePointerMove(e: React.PointerEvent) {
    if (!dragRef.current) return
    const maxT = getMaxTranslate()
    const base = dragRef.current.startOpen ? 0 : maxT
    const delta = e.clientY - dragRef.current.startY
    const newY = Math.max(0, Math.min(maxT, base + delta))
    if (Math.abs(delta) > 4) didDragRef.current = true
    dragRef.current.lastY = e.clientY
    dragRef.current.lastTime = Date.now()
    setTranslateY(newY)
  }

  function handlePointerUp(e: React.PointerEvent) {
    if (!dragRef.current) return
    const maxT = getMaxTranslate()
    const elapsed = Date.now() - dragRef.current.lastTime
    const velocity = elapsed > 0 ? (e.clientY - dragRef.current.lastY) / elapsed : 0

    let shouldOpen: boolean
    if (Math.abs(velocity) > 0.5) {
      shouldOpen = velocity < 0
    } else {
      const base = dragRef.current.startOpen ? 0 : maxT
      const current = base + (e.clientY - dragRef.current.startY)
      shouldOpen = current < maxT / 2
    }

    dragRef.current = null
    setTranslateY(null)
    if (shouldOpen !== open) onToggle()
  }

  async function handleSelectExample(example: ExampleMeta) {
    if (loading) return
    setLoading(example.id)
    try {
      const basePath = `/examples/${example.id}`
      const [imgData, maskData] = await Promise.all([
        imageUrlToBase64(`${basePath}/original.jpg`),
        parseMaskColors(`${basePath}/mask.png`),
      ])
      const { refinedMask, masks } = await remapMaskColors(maskData.maskBase64, maskData.masks)
      loadExample(imgData.base64, imgData.width, imgData.height, refinedMask, refinedMask, masks)
      onToggle()
    } catch (err) {
      console.error('加载案例失败', err)
    } finally {
      setLoading(null)
    }
  }

  const isDragging = translateY !== null
  const style = isDragging ? { transform: `translateY(${translateY}px)` } : undefined
  const transitionClass = isDragging ? '' : 'transition-transform duration-300'
  const positionClass = isDragging ? '' : (open ? 'translate-y-0' : 'translate-y-[calc(100%-56px)]')

  return (
    <div
      ref={drawerRef}
      className={`fixed bottom-0 inset-x-0 z-30 bg-gray-900/40 backdrop-blur-md border-t border-white/[0.08] rounded-t-2xl shadow-2xl ${transitionClass} ${positionClass}`}
      style={style}
    >
      {/* Handle */}
      <div
        className="flex items-center justify-center h-14 cursor-grab active:cursor-grabbing touch-none select-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onClick={() => { if (!didDragRef.current) onToggle() }}
      >
        <div className="w-10 h-1 rounded-full bg-gray-700" />
        <span className="ml-3 text-gray-400 text-sm">官方案例</span>
      </div>

      {/* Grid */}
      <div className="px-3 pb-safe pb-6 max-h-[60vh] overflow-y-auto">
        <div className="grid grid-cols-3 gap-2">
          {EXAMPLES.map((ex) => (
            <button
              key={ex.id}
              className="relative aspect-[3/4] rounded-xl overflow-hidden bg-gray-800 focus:outline-none active:scale-95 transition-transform"
              onClick={() => handleSelectExample(ex)}
              disabled={!!loading}
            >
              <img
                src={`/examples/${ex.id}/original.jpg`}
                alt={ex.label}
                className="w-full h-full object-cover"
                draggable={false}
              />
              {/* Label overlay */}
              <div className="absolute bottom-0 inset-x-0 bg-gradient-to-t from-black/70 to-transparent px-2 py-1.5">
                <p className="text-white text-xs font-medium truncate">{ex.label}</p>
              </div>
              {/* Loading spinner */}
              {loading === ex.id && (
                <div className="absolute inset-0 bg-black/50 flex items-center justify-center">
                  <div className="w-6 h-6 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
                </div>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
