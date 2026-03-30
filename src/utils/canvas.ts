import type { MaskInfo } from '../types'

let offscreenCanvas: HTMLCanvasElement | null = null
let offscreenCtx: CanvasRenderingContext2D | null = null

// ── Pre-computed edge SDF per mask (keyed by mask ID) ───────────────────────
// sdf[i] = distance (in mask-resolution pixels) from pixel i to nearest edge;
// 255 = "far" sentinel (no glow rendered).
interface SDFData { sdf: Uint8Array; inLargest: Uint8Array; w: number; h: number }
const maskSDFs = new Map<number, SDFData>()

const MAX_GLOW_DIST = 20   // glow radius in mask-resolution pixels

// ── Pre-computed assignment for pixel-perfect hit-testing ──────────────────
let hitAssignment: Int16Array | null = null
let hitW = 0
let hitH = 0
let hitMasks: MaskInfo[] = []

/**
 * BFS outward from edge pixels to build a distance field.
 * sdf[i] = distance to nearest edge (0 = edge pixel, 255 = far / inside).
 * Only non-mask pixels receive finite distances; deep mask interior = 255.
 */
function buildEdgeSDF(inLargest: Uint8Array, W: number, H: number, maxDist: number): Uint8Array {
  const total = W * H
  const sdf = new Uint8Array(total).fill(255)
  const queue = new Int32Array(total)
  let head = 0, tail = 0

  // Seed: in-mask pixels that have at least one non-mask 8-neighbour
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (!inLargest[i]) continue
      let isEdge = false
      outer: for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const nx = x + dx, ny = y + dy
          if (nx < 0 || nx >= W || ny < 0 || ny >= H || !inLargest[ny * W + nx]) {
            isEdge = true; break outer
          }
        }
      }
      if (isEdge) { sdf[i] = 0; queue[tail++] = i }
    }
  }

  // BFS outward — only spread to non-mask pixels (4-connected)
  while (head < tail) {
    const curr = queue[head++]
    const d = sdf[curr]
    if (d >= maxDist) continue
    const nd = d + 1
    const cy = (curr / W) | 0
    const cx = curr - cy * W
    const ns = [
      cy > 0   ? curr - W : -1,
      cy < H-1 ? curr + W : -1,
      cx > 0   ? curr - 1 : -1,
      cx < W-1 ? curr + 1 : -1,
    ]
    for (const ni of ns) {
      if (ni < 0 || inLargest[ni] || sdf[ni] <= nd) continue
      sdf[ni] = nd
      queue[tail++] = ni
    }
  }

  return sdf
}

/**
 * Call once after loadMaskIntoOffscreen() + masks are known.
 * Uses nearest-neighbour assignment so blurry Flux boundaries are handled
 * cleanly — every pixel is deterministically assigned to the closest mask
 * colour before edge detection runs.
 */
export function precomputeMaskOutlines(masks: MaskInfo[]): void {
  if (!offscreenCtx || !offscreenCanvas || masks.length === 0) return
  maskSDFs.clear()
  const W = offscreenCanvas.width
  const H = offscreenCanvas.height
  const pixels = offscreenCtx.getImageData(0, 0, W, H).data
  const total = W * H

  // Step 1 — nearest-neighbour colour assignment
  const assignment = new Int16Array(total).fill(-1)
  for (let i = 0; i < total; i++) {
    const r = pixels[i * 4], g = pixels[i * 4 + 1], b = pixels[i * 4 + 2]
    if (r === 0 && g === 0 && b === 0) continue   // pure black = no region
    let bestDist = 50000, bestMi = -1
    for (let mi = 0; mi < masks.length; mi++) {
      const [mr, mg, mb] = masks[mi].color
      const d = (r - mr) ** 2 + (g - mg) ** 2 + (b - mb) ** 2
      if (d < bestDist) { bestDist = d; bestMi = mi }
    }
    assignment[i] = bestMi
  }

  // Step 2 — build outline + filled canvases per mask
  // Shared typed arrays reused across masks to avoid GC pressure
  const bfsQueue  = new Int32Array(total)
  const visited   = new Uint8Array(total)
  const inLargest = new Uint8Array(total)

  for (let mi = 0; mi < masks.length; mi++) {
    // ── 2a: Find seed of the largest 4-connected component ──────────────────
    visited.fill(0)
    let largestSeed = -1
    let largestSize = 0

    for (let seed = 0; seed < total; seed++) {
      if (assignment[seed] !== mi || visited[seed]) continue

      let head = 0, tail = 0
      bfsQueue[tail++] = seed
      visited[seed] = 1
      let size = 0

      while (head < tail) {
        const curr = bfsQueue[head++]
        size++
        const cy = (curr / W) | 0
        const cx = curr - cy * W
        if (cy > 0   && assignment[curr - W] === mi && !visited[curr - W]) { visited[curr - W] = 1; bfsQueue[tail++] = curr - W }
        if (cy < H-1 && assignment[curr + W] === mi && !visited[curr + W]) { visited[curr + W] = 1; bfsQueue[tail++] = curr + W }
        if (cx > 0   && assignment[curr - 1] === mi && !visited[curr - 1]) { visited[curr - 1] = 1; bfsQueue[tail++] = curr - 1 }
        if (cx < W-1 && assignment[curr + 1] === mi && !visited[curr + 1]) { visited[curr + 1] = 1; bfsQueue[tail++] = curr + 1 }
      }

      if (size > largestSize) { largestSize = size; largestSeed = seed }
    }

    // ── 2b: BFS again from winning seed to mark the largest component ────────
    inLargest.fill(0)
    if (largestSeed >= 0) {
      let head = 0, tail = 0
      bfsQueue[tail++] = largestSeed
      inLargest[largestSeed] = 1

      while (head < tail) {
        const curr = bfsQueue[head++]
        const cy = (curr / W) | 0
        const cx = curr - cy * W
        if (cy > 0   && assignment[curr - W] === mi && !inLargest[curr - W]) { inLargest[curr - W] = 1; bfsQueue[tail++] = curr - W }
        if (cy < H-1 && assignment[curr + W] === mi && !inLargest[curr + W]) { inLargest[curr + W] = 1; bfsQueue[tail++] = curr + W }
        if (cx > 0   && assignment[curr - 1] === mi && !inLargest[curr - 1]) { inLargest[curr - 1] = 1; bfsQueue[tail++] = curr - 1 }
        if (cx < W-1 && assignment[curr + 1] === mi && !inLargest[curr + 1]) { inLargest[curr + 1] = 1; bfsQueue[tail++] = curr + 1 }
      }
    }

    // ── 2c: Build edge SDF from the largest component ───────────────────────
    const sdf = buildEdgeSDF(inLargest, W, H, MAX_GLOW_DIST)
    maskSDFs.set(masks[mi].id, { sdf, inLargest: inLargest.slice(), w: W, h: H })
  }

  // Save assignment for pixel-perfect hit-testing (same data, zero extra cost)
  hitAssignment = assignment
  hitW = W
  hitH = H
  hitMasks = masks
}

/**
 * Returns the mask that owns pixel (imageX, imageY) using the same
 * nearest-neighbour assignment computed by precomputeMaskOutlines.
 * Guaranteed to agree with what the outline renderer draws.
 */
export function getMaskAtPixel(imageX: number, imageY: number): MaskInfo | null {
  if (!hitAssignment || !hitW || !hitH) return null
  const x = Math.floor(imageX)
  const y = Math.floor(imageY)
  if (x < 0 || x >= hitW || y < 0 || y >= hitH) return null
  const mi = hitAssignment[y * hitW + x]
  if (mi === -1) return null
  return hitMasks[mi] ?? null
}

/**
 * Render the selection glow on an overlay canvas using a pre-computed SDF.
 * Each pixel's brightness is driven by its distance to the mask edge —
 * no canvas shadowBlur, so the glow never bleeds into adjacent regions.
 *
 * Visual style (inspired by the reference SDF renderer):
 *   • Exponential falloff from the edge outward (soft outer glow)
 *   • Bright white core right at the edge pixels (d = 0)
 *   • White-blue tint for the glow body
 */
export function drawMaskOutline(
  maskId: number | null,
  overlayCanvas: HTMLCanvasElement
): void {
  const ctx = overlayCanvas.getContext('2d')!
  ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height)
  if (maskId === null) return

  const data = maskSDFs.get(maskId)
  if (!data) return

  const { sdf, w: sW, h: sH } = data
  const dW = overlayCanvas.width
  const dH = overlayCanvas.height
  const scaleX = sW / dW
  const scaleY = sH / dH

  const SPREAD   = MAX_GLOW_DIST
  const CORE_W   = 1.5   // pixels at mask-res; inner lamp-tube width

  const outData = ctx.createImageData(dW, dH)
  const od = outData.data

  for (let dy = 0; dy < dH; dy++) {
    for (let dx = 0; dx < dW; dx++) {
      const sx = Math.min(Math.round(dx * scaleX), sW - 1)
      const sy = Math.min(Math.round(dy * scaleY), sH - 1)
      const d  = sdf[sy * sW + sx]

      if (d === 255 || d > SPREAD) continue   // deep interior or too far out

      const t    = d / SPREAD
      const glow = Math.exp(-3.5 * t)         // exponential falloff
      if (glow < 0.004) continue

      // White core: pixels right at the edge boundary flash bright white
      const whiteness = d < CORE_W ? (1 - d / CORE_W) ** 2 : 0

      // Base colour: cool white-blue glow
      const r = Math.min(210 + (255 - 210) * whiteness, 255)
      const g = Math.min(230 + (255 - 230) * whiteness, 255)
      const b = 255

      const di = (dy * dW + dx) * 4
      od[di]     = r
      od[di + 1] = g
      od[di + 2] = b
      od[di + 3] = Math.round(glow * 255)
    }
  }

  ctx.putImageData(outData, 0, 0)
}

/**
 * Draws a sweeping shimmer effect clipped to the mask region pixels.
 * Designed to simulate a "loading" state when a material is being applied.
 * Call repeatedly in a requestAnimationFrame loop.
 */
export function drawMaskShimmer(
  maskId: number | null,
  shimmerCanvas: HTMLCanvasElement,
  timestamp: number,
  color: [number, number, number]
): void {
  const ctx = shimmerCanvas.getContext('2d')!
  ctx.clearRect(0, 0, shimmerCanvas.width, shimmerCanvas.height)
  if (maskId === null) return

  const data = maskSDFs.get(maskId)
  if (!data) return

  const { inLargest, w: sW, h: sH } = data
  const dW = shimmerCanvas.width
  const dH = shimmerCanvas.height
  if (!dW || !dH) return

  const scaleX = sW / dW
  const scaleY = sH / dH

  const PERIOD = 1500
  const phase  = (timestamp % PERIOD) / PERIOD
  // Sweep enters from left (-30%) and exits right (130%) so edges animate smoothly
  const sweepX = (phase * 1.6 - 0.3) * dW
  const BAND   = dW * 0.15    // half-width of the highlight band

  const [cr, cg, cb] = color

  const outData = ctx.createImageData(dW, dH)
  const od = outData.data

  for (let dy = 0; dy < dH; dy++) {
    for (let dx = 0; dx < dW; dx++) {
      const sx = Math.min(Math.round(dx * scaleX), sW - 1)
      const sy = Math.min(Math.round(dy * scaleY), sH - 1)
      if (!inLargest[sy * sW + sx]) continue   // pixel not in this mask region

      const di = (dy * dW + dx) * 4
      const t  = Math.max(0, 1 - Math.abs(dx - sweepX) / BAND)
      const shimmer = t * t    // quadratic falloff

      // Base: mask color at ~35% opacity; peak: blends toward white
      const alpha = 0.35 + shimmer * 0.5
      const blend = shimmer * 0.75
      od[di]     = Math.round(cr * (1 - blend) + 255 * blend)
      od[di + 1] = Math.round(cg * (1 - blend) + 255 * blend)
      od[di + 2] = Math.round(cb * (1 - blend) + 255 * blend)
      od[di + 3] = Math.round(alpha * 255)
    }
  }

  ctx.putImageData(outData, 0, 0)
}

/**
 * Draws a grayscale shimmer for all currently-processing mask regions.
 * Pass all active maskIds so they are composited in a single putImageData pass.
 * Call repeatedly in a requestAnimationFrame loop while processingRegions is non-empty.
 */
export function drawProcessingShimmer(
  maskIds: number[],
  shimmerCanvas: HTMLCanvasElement,
  timestamp: number,
): void {
  const ctx = shimmerCanvas.getContext('2d')!
  ctx.clearRect(0, 0, shimmerCanvas.width, shimmerCanvas.height)

  const dW = shimmerCanvas.width
  const dH = shimmerCanvas.height
  if (!dW || !dH || maskIds.length === 0) return

  const PERIOD = 1500
  const phase  = (timestamp % PERIOD) / PERIOD
  const sweepX = (phase * 1.6 - 0.3) * dW
  const BAND   = dW * 0.15

  const outData = ctx.createImageData(dW, dH)
  const od = outData.data

  for (const maskId of maskIds) {
    const data = maskSDFs.get(maskId)
    if (!data) continue

    const { inLargest, w: sW, h: sH } = data
    const scaleX = sW / dW
    const scaleY = sH / dH

    for (let dy = 0; dy < dH; dy++) {
      for (let dx = 0; dx < dW; dx++) {
        const sx = Math.min(Math.round(dx * scaleX), sW - 1)
        const sy = Math.min(Math.round(dy * scaleY), sH - 1)
        if (!inLargest[sy * sW + sx]) continue

        const di = (dy * dW + dx) * 4
        const t  = Math.max(0, 1 - Math.abs(dx - sweepX) / BAND)
        const shimmer = t * t    // quadratic falloff

        // Grayscale: mid-gray base, sweeps toward white
        const brightness = Math.round(130 + shimmer * 125)  // 130 → 255
        const alpha      = 0.4 + shimmer * 0.45

        od[di]     = brightness
        od[di + 1] = brightness
        od[di + 2] = brightness
        od[di + 3] = Math.round(alpha * 255)
      }
    }
  }

  ctx.putImageData(outData, 0, 0)
}

export function initOffscreenCanvas(width: number, height: number) {
  offscreenCanvas = document.createElement('canvas')
  offscreenCanvas.width = width
  offscreenCanvas.height = height
  offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true })!
}

export function loadMaskIntoOffscreen(maskBase64: string): Promise<void> {
  return new Promise((resolve) => {
    if (!offscreenCtx || !offscreenCanvas) {
      resolve()
      return
    }
    const img = new Image()
    img.onload = () => {
      offscreenCtx!.drawImage(img, 0, 0, offscreenCanvas!.width, offscreenCanvas!.height)
      resolve()
    }
    img.src = `data:image/png;base64,${maskBase64}`
  })
}

export function sampleMaskAt(imageX: number, imageY: number): [number, number, number] | null {
  if (!offscreenCtx || !offscreenCanvas) return null
  const x = Math.floor(imageX)
  const y = Math.floor(imageY)
  const pixel = offscreenCtx.getImageData(x, y, 1, 1).data
  if (pixel[0] === 0 && pixel[1] === 0 && pixel[2] === 0) return null
  return [pixel[0], pixel[1], pixel[2]]
}

export function findMaskByColor(
  color: [number, number, number],
  masks: MaskInfo[],
  tolerance = 10
): MaskInfo | null {
  for (const mask of masks) {
    const [r, g, b] = mask.color
    if (
      Math.abs(r - color[0]) <= tolerance &&
      Math.abs(g - color[1]) <= tolerance &&
      Math.abs(b - color[2]) <= tolerance
    ) {
      return mask
    }
  }
  return null
}

/**
 * Nearest-neighbour mask lookup — always returns the closest mask colour.
 * Use for hover/drag hit-testing where the refined mask has blurry edges.
 * Returns null only for pure-black (unassigned) pixels.
 */
export function findNearestMask(
  color: [number, number, number],
  masks: MaskInfo[],
): MaskInfo | null {
  if (masks.length === 0) return null
  let bestDist = Infinity
  let bestMask: MaskInfo | null = null
  for (const mask of masks) {
    const [r, g, b] = mask.color
    const d = (r - color[0]) ** 2 + (g - color[1]) ** 2 + (b - color[2]) ** 2
    if (d < bestDist) { bestDist = d; bestMask = mask }
  }
  return bestMask
}

export function compositeRegion(
  baseCanvas: HTMLCanvasElement,
  resultBase64: string,
  targetColor: [number, number, number],
  width: number,
  height: number,
  maskId?: number
): Promise<void> {
  return new Promise((resolve) => {
    if (!offscreenCtx) {
      resolve()
      return
    }

    const resultImg = new Image()
    resultImg.onload = () => {
      const tempCanvas = document.createElement('canvas')
      tempCanvas.width = width
      tempCanvas.height = height
      const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true })!
      tempCtx.drawImage(resultImg, 0, 0, width, height)

      const baseCtx = baseCanvas.getContext('2d', { willReadFrequently: true })!
      const baseData = baseCtx.getImageData(0, 0, width, height)
      const resultData = tempCtx.getImageData(0, 0, width, height)

      // Prefer the pre-computed inLargest bitmap (gap-free largest connected
      // component) over raw colour matching. Fall back to colour matching only
      // when maskId is not supplied or the SDF entry is missing.
      const sdfData = maskId !== undefined ? maskSDFs.get(maskId) : undefined

      if (sdfData) {
        const { inLargest, w: sW, h: sH } = sdfData
        // inLargest is at mask/SDF resolution (sW × sH); base canvas is at
        // (width × height). They should be identical because initOffscreenCanvas
        // is called with the original image dimensions, but guard with scaling
        // in case they ever differ.
        for (let py = 0; py < height; py++) {
          for (let px = 0; px < width; px++) {
            const sx = Math.min(Math.round(px * sW / width), sW - 1)
            const sy = Math.min(Math.round(py * sH / height), sH - 1)
            if (!inLargest[sy * sW + sx]) continue
            const i = (py * width + px) * 4
            baseData.data[i]     = resultData.data[i]
            baseData.data[i + 1] = resultData.data[i + 1]
            baseData.data[i + 2] = resultData.data[i + 2]
            baseData.data[i + 3] = resultData.data[i + 3]
          }
        }
      } else {
        // Fallback: colour-match against the raw mask image
        const maskData = offscreenCtx!.getImageData(0, 0, width, height)
        const [tr, tg, tb] = targetColor
        const tolerance = 10
        for (let i = 0; i < maskData.data.length; i += 4) {
          const mr = maskData.data[i]
          const mg = maskData.data[i + 1]
          const mb = maskData.data[i + 2]
          if (
            Math.abs(mr - tr) <= tolerance &&
            Math.abs(mg - tg) <= tolerance &&
            Math.abs(mb - tb) <= tolerance
          ) {
            baseData.data[i]     = resultData.data[i]
            baseData.data[i + 1] = resultData.data[i + 1]
            baseData.data[i + 2] = resultData.data[i + 2]
            baseData.data[i + 3] = resultData.data[i + 3]
          }
        }
      }

      baseCtx.putImageData(baseData, 0, 0)
      resolve()
    }
    resultImg.src = `data:image/png;base64,${resultBase64}`
  })
}
