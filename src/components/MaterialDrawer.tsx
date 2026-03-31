import { useEffect, useRef, useState } from 'react'
import type { Material } from '../types'
import { getMaterials, setBackendUrl } from '../utils/api'
import { MaterialTile } from './MaterialTile'
import { useStore } from '../store'

interface MaterialDrawerProps {
  open: boolean
  onToggle: () => void
  onDragStart: (material: Material, x: number, y: number) => void
  onDragMove: (x: number, y: number) => void
  onDragEnd: (x: number, y: number) => Promise<boolean>
}

export function MaterialDrawer({ open, onToggle, onDragStart, onDragMove, onDragEnd }: MaterialDrawerProps) {
  const { backendUrl } = useStore()
  const [materials, setMaterials] = useState<Material[]>([])
  const [loading, setLoading] = useState(false)

  // Drag state
  const drawerRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<{ startY: number; startOpen: boolean; lastY: number; lastTime: number } | null>(null)
  const didDragRef = useRef(false)
  const [translateY, setTranslateY] = useState<number | null>(null)

  useEffect(() => {
    setBackendUrl(backendUrl)
    setLoading(true)
    getMaterials()
      .then(setMaterials)
      .catch(console.error)
      .finally(() => setLoading(false))
  }, [backendUrl])

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

  const isDragging = translateY !== null
  const style = isDragging ? { transform: `translateY(${translateY}px)` } : undefined
  const transitionClass = isDragging ? '' : 'transition-transform duration-300'
  const positionClass = isDragging ? '' : (open ? 'translate-y-0' : 'translate-y-[calc(100%-56px)]')

  return (
    <div
      ref={drawerRef}
      className={`fixed bottom-0 inset-x-0 z-50 bg-gray-900/40 backdrop-blur-md border-t border-white/[0.08] rounded-t-2xl shadow-2xl ${transitionClass} ${positionClass}`}
      style={style}
    >
      {/* Handle — drag target */}
      <div
        className="flex items-center justify-center h-14 cursor-grab active:cursor-grabbing touch-none select-none"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onClick={() => { if (!didDragRef.current) onToggle() }}
      >
        <div className="w-10 h-1 rounded-full bg-gray-700" />
        <span className="ml-3 text-gray-400 text-sm">材质库</span>
      </div>

      {/* Grid */}
      <div className="px-3 pb-safe pb-6 max-h-[50vh] overflow-y-auto">
        {loading ? (
          <div className="flex justify-center py-8">
            <div className="w-6 h-6 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
          </div>
        ) : materials.length === 0 ? (
          <div className="text-center py-8">
            <p className="text-gray-600 text-sm">暂无材质</p>
            <p className="text-gray-700 text-xs mt-1">请将图片放入 public/materials 文件夹</p>
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-2">
            {materials.map((m) => (
              <MaterialTile
                key={m.filename}
                material={m}
                onDragStart={(material, x, y) => { if (open) onToggle(); onDragStart(material, x, y) }}
                onDragMove={onDragMove}
                onDragEnd={async (x, y) => { const valid = await onDragEnd(x, y); if (!valid) onToggle() }}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
