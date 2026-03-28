import { useStore } from '../store'

interface RegionHighlightProps {
  maskId: number | null
  variant?: 'hover' | 'shimmer'
  active?: boolean
}

export function RegionHighlight({ maskId, variant = 'hover', active = false }: RegionHighlightProps) {
  const { masks, processingRegions } = useStore()

  if (maskId === null) return null

  const mask = masks.find((m) => m.id === maskId)
  if (!mask) return null

  const [r, g, b] = mask.color
  const color = `rgb(${r}, ${g}, ${b})`

  if (variant === 'shimmer' && (active || processingRegions.has(maskId))) {
    return (
      <div
        className="absolute inset-0 pointer-events-none overflow-hidden"
        style={{ borderRadius: 'inherit', zIndex: 25 }}
      >
        <div
          className="absolute inset-0 shimmer-overlay"
          style={{
            background: `linear-gradient(
              90deg,
              ${color}00 0%,
              ${color}80 40%,
              ${color}cc 50%,
              ${color}80 60%,
              ${color}00 100%
            )`,
            animation: 'shimmer 1.5s infinite',
          }}
        />
      </div>
    )
  }

  return (
    <div
      className="absolute inset-0 pointer-events-none"
      style={{
        border: `3px solid ${color}`,
        backgroundColor: `${color}33`,
        borderRadius: '4px',
      }}
    />
  )
}
