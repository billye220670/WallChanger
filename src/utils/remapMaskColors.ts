import type { MaskInfo } from '../types'

/**
 * Maximally distinct, high-saturation colors.
 * Spread across hue wheel so even adjacent entries are clearly different.
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

/** Generate an additional distinct color via golden-angle HSL if palette runs out. */
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

function colorDist(a: [number, number, number], b: [number, number, number]): number {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2)
}

function anyTooSimilar(masks: MaskInfo[], threshold = 60): boolean {
  for (let i = 0; i < masks.length; i++) {
    for (let j = i + 1; j < masks.length; j++) {
      if (colorDist(masks[i].color, masks[j].color) < threshold) return true
    }
  }
  return false
}

/**
 * If any two mask colors are too similar (within `threshold` Euclidean distance),
 * reassigns ALL masks to palette colors and remaps the mask image pixels accordingly.
 * Returns the original data unchanged if all colors are already sufficiently distinct.
 */
export async function remapMaskColors(
  refinedMaskBase64: string,
  masks: MaskInfo[],
  threshold = 60,
): Promise<{ refinedMask: string; masks: MaskInfo[] }> {
  if (masks.length <= 1 || !anyTooSimilar(masks, threshold)) {
    return { refinedMask: refinedMaskBase64, masks }
  }

  const newColors: [number, number, number][] = masks.map((_, i) =>
    i < PALETTE.length ? PALETTE[i] : extraColor(i)
  )

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
        if (r === 0 && g === 0 && b === 0) continue   // black = unassigned

        // Nearest original mask color → assign new palette color
        let bestDist = Infinity, bestMi = -1
        for (let mi = 0; mi < masks.length; mi++) {
          const [mr, mg, mb] = masks[mi].color
          const dist = (r - mr) ** 2 + (g - mg) ** 2 + (b - mb) ** 2
          if (dist < bestDist) { bestDist = dist; bestMi = mi }
        }
        if (bestMi === -1) continue

        const [nr, ng, nb] = newColors[bestMi]
        d[i] = nr; d[i + 1] = ng; d[i + 2] = nb
      }

      ctx.putImageData(imageData, 0, 0)

      const newRefinedMask = canvas.toDataURL('image/png').split(',')[1]
      const newMasks = masks.map((m, i) => ({ ...m, color: newColors[i] }))
      resolve({ refinedMask: newRefinedMask, masks: newMasks })
    }
    img.onerror = reject
    img.src = `data:image/png;base64,${refinedMaskBase64}`
  })
}
