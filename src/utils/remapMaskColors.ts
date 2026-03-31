import type { MaskInfo } from '../types'

/**
 * Squared Euclidean snap threshold (40 units ≈ typical JPEG artefact range).
 * Pixels closer than this to a known mask color → snapped to that color.
 * Pixels farther from ALL mask colors → set to pure black (background/gap).
 */
const SNAP_THRESHOLD_SQ = 40 * 40

/**
 * Maximally distinct, high-saturation colors for when SAM3 returns
 * two or more regions with visually similar colors.
 */
const PALETTE: [number, number, number][] = [
  [0,   200, 255],  // cyan
  [80,  255, 80],   // lime green
  [255, 60,  60],   // red
  [255, 210, 0],    // yellow
  [180, 0,   255],  // violet
  [255, 120, 0],    // orange
  [0,   220, 170],  // teal
  [255, 30,  160],  // hot pink
  [140, 255, 0],    // yellow-green
  [60,  80,  255],  // indigo
  [255, 0,   80],   // crimson
  [0,   255, 200],  // aqua
]

function extraColor(index: number): [number, number, number] {
  const hue = (index * 137.508) % 360
  const [r, g, b] = hslToRgb(hue / 360, 0.9, 0.55)
  return [r, g, b]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const a = s * Math.min(l, 1 - l)
  const f = (n: number) => {
    const k = (n + h * 12) % 12
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
  }
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)]
}

function colorDistSq(a: [number, number, number], b: [number, number, number]): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2
}

function anyTooSimilar(masks: MaskInfo[], threshold: number): boolean {
  for (let i = 0; i < masks.length; i++) {
    for (let j = i + 1; j < masks.length; j++) {
      if (Math.sqrt(colorDistSq(masks[i].color, masks[j].color)) < threshold) return true
    }
  }
  return false
}

/**
 * Purifies a Seedream-refined mask by snapping every pixel to its nearest
 * known mask color (within SNAP_THRESHOLD) or to pure black (background).
 *
 * This eliminates JPEG compression artifacts — blended boundary pixels that
 * fall between two mask colors — and produces a clean, palette-exact PNG.
 *
 * Additionally, if any two mask colors are too similar (within `dedupThreshold`),
 * all regions are remapped to maximally distinct PALETTE colors.
 */
export async function remapMaskColors(
  refinedMaskBase64: string,
  masks: MaskInfo[],
  dedupThreshold = 60,
): Promise<{ refinedMask: string; masks: MaskInfo[] }> {
  // If colors are too similar, remap to distinct palette entries
  const needsDedup = masks.length > 1 && anyTooSimilar(masks, dedupThreshold)
  const targetColors: [number, number, number][] = needsDedup
    ? masks.map((_, i) => i < PALETTE.length ? PALETTE[i] : extraColor(i))
    : masks.map(m => m.color)
  const newMasks = needsDedup
    ? masks.map((m, i) => ({ ...m, color: targetColors[i] }))
    : masks

  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width  = img.width
      canvas.height = img.height
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      ctx.drawImage(img, 0, 0)

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
      const d = imageData.data

      for (let i = 0; i < d.length; i += 4) {
        const r = d[i], g = d[i + 1], b = d[i + 2]
        if (r === 0 && g === 0 && b === 0) continue   // already pure black — keep

        // Find nearest original SAM3 mask color
        let bestDistSq = Infinity, bestMi = -1
        for (let mi = 0; mi < masks.length; mi++) {
          const dSq = colorDistSq([r, g, b], masks[mi].color)
          if (dSq < bestDistSq) { bestDistSq = dSq; bestMi = mi }
        }

        if (bestMi === -1 || bestDistSq > SNAP_THRESHOLD_SQ) {
          // Too far from every known mask color → background/gap, set black
          d[i] = 0; d[i + 1] = 0; d[i + 2] = 0
        } else {
          // Snap to the target color for this mask region
          const [nr, ng, nb] = targetColors[bestMi]
          d[i] = nr; d[i + 1] = ng; d[i + 2] = nb
        }
      }

      ctx.putImageData(imageData, 0, 0)
      const newRefinedMask = canvas.toDataURL('image/png').split(',')[1]
      resolve({ refinedMask: newRefinedMask, masks: newMasks })
    }
    img.onerror = reject
    img.src = `data:image/png;base64,${refinedMaskBase64}`
  })
}
