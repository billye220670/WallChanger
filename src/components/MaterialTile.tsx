import { useRef, useEffect } from 'react'
import type { Material } from '../types'
import { useStore } from '../store'

interface MaterialTileProps {
  material: Material
  onDragStart: (material: Material, x: number, y: number) => void
  onDragMove: (x: number, y: number) => void
  onDragEnd: (x: number, y: number) => void
}

export function MaterialTile({ material, onDragStart, onDragMove, onDragEnd }: MaterialTileProps) {
  const { backendUrl } = useStore()
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isDragging = useRef(false)
  const startPos = useRef({ x: 0, y: 0 })
  const divRef = useRef<HTMLDivElement>(null)

  // Refs for stable callbacks (avoid stale closures in native listeners)
  const onDragStartRef = useRef(onDragStart)
  const onDragMoveRef = useRef(onDragMove)
  const onDragEndRef = useRef(onDragEnd)
  onDragStartRef.current = onDragStart
  onDragMoveRef.current = onDragMove
  onDragEndRef.current = onDragEnd

  useEffect(() => {
    const el = divRef.current
    if (!el) return

    let capturedId: number | null = null
    let currentX = 0
    let currentY = 0

    function handlePointerDown(e: PointerEvent) {
      capturedId = e.pointerId
      startPos.current = { x: e.clientX, y: e.clientY }
      currentX = e.clientX
      currentY = e.clientY
      isDragging.current = false

      longPressTimer.current = setTimeout(() => {
        isDragging.current = true
        el.setPointerCapture(capturedId!)
        onDragStartRef.current(material, currentX, currentY)
      }, 300)
    }

    function handlePointerMove(e: PointerEvent) {
      if (e.pointerId !== capturedId) return
      currentX = e.clientX
      currentY = e.clientY

      if (!isDragging.current) {
        const dx = e.clientX - startPos.current.x
        const dy = e.clientY - startPos.current.y
        if (Math.sqrt(dx * dx + dy * dy) > 10) {
          clearTimeout(longPressTimer.current!)
        }
        return
      }

      onDragMoveRef.current(e.clientX, e.clientY)
    }

    function handlePointerUp(e: PointerEvent) {
      if (e.pointerId !== capturedId) return
      clearTimeout(longPressTimer.current!)
      if (!isDragging.current) {
        capturedId = null
        return
      }
      onDragEndRef.current(e.clientX, e.clientY)
      isDragging.current = false
      capturedId = null
    }

    el.addEventListener('pointerdown', handlePointerDown)
    el.addEventListener('pointermove', handlePointerMove)
    el.addEventListener('pointerup', handlePointerUp)
    el.addEventListener('pointercancel', handlePointerUp)

    return () => {
      el.removeEventListener('pointerdown', handlePointerDown)
      el.removeEventListener('pointermove', handlePointerMove)
      el.removeEventListener('pointerup', handlePointerUp)
      el.removeEventListener('pointercancel', handlePointerUp)
    }
  }, [material])

  return (
    <div
      ref={divRef}
      className="relative rounded-xl overflow-hidden aspect-square cursor-grab active:cursor-grabbing"
    >
      <img
        src={`${backendUrl}/materials/${material.filename}`}
        alt={material.name}
        className="w-full h-full object-cover"
        crossOrigin="anonymous"
        draggable={false}
      />
    </div>
  )
}
