import { useStore } from '../store'

interface DragPreviewProps {
  x: number
  y: number
}

export function DragPreview({ x, y }: DragPreviewProps) {
  const { draggingMaterial, backendUrl } = useStore()
  if (!draggingMaterial) return null

  return (
    <div
      className="fixed pointer-events-none z-50"
      style={{
        left: x - 36,
        top: y - 36,
        width: 72,
        height: 72,
      }}
    >
      <div className="w-full h-full rounded-full overflow-hidden border-2 border-white shadow-2xl opacity-90">
        <img
          src={`${backendUrl}/materials/${draggingMaterial.filename}`}
          alt={draggingMaterial.name}
          className="w-full h-full object-cover"
          crossOrigin="anonymous"
        />
      </div>
    </div>
  )
}
