import type { MaskInfo } from '../types'

let offscreenCanvas: HTMLCanvasElement | null = null
let offscreenCtx: CanvasRenderingContext2D | null = null

// ── B&W mask canvases (one per wall region from ComfyUI) ─────────────────────
let bwMaskCanvases: HTMLCanvasElement[] = []
let bwMaskWidth  = 0
let bwMaskHeight = 0

// ── Pre-computed edge SDF per mask (keyed by mask ID) ───────────────────────
// sdf        = outward distance from smoothed edge (for glow); 0=edge, 255=deep interior
// smoothMask = box-blurred 0..255; used as anti-aliased fill alpha in shimmers
// edgeAlpha  = inward feather 0..255 for compositing; 0=boundary, 255=deep interior
interface SDFData {
  sdf: Uint8Array
  smoothMask: Uint8Array
  edgeAlpha: Uint8Array
  w: number
  h: number
}
const maskSDFs = new Map<number, SDFData>()

const MAX_GLOW_DIST = 20   // glow radius in mask-resolution pixels
const BLUR_RADIUS   = 2    // box-blur radius applied to binary mask before SDF build
const FEATHER_W     = 3    // compositing feather width in pixels

// ── Separable box-blur on a binary Uint8Array ────────────────────────────────
// Produces Uint8Array 0..255: edge pixels land at fractional values between the
// two neighbours, giving anti-aliased fill boundaries regardless of display scale.
function boxBlur(src: Uint8Array, W: number, H: number, R: number): Uint8Array {
  const tmp = new Float32Array(W * H)

  // Horizontal sliding-window pass (stores 0..1 intermediate)
  for (let y = 0; y < H; y++) {
    let sum = 0, cnt = 0
    for (let k = 0; k <= R && k < W; k++) { sum += src[y * W + k]; cnt++ }
    for (let x = 0; x < W; x++) {
      tmp[y * W + x] = cnt > 0 ? sum / cnt : 0
      if (x + R + 1 < W) { sum += src[y * W + x + R + 1]; cnt++ }
      if (x - R     >= 0) { sum -= src[y * W + x - R    ]; cnt-- }
    }
  }

  // Vertical sliding-window pass (scales to 0..255)
  const out = new Uint8Array(W * H)
  for (let x = 0; x < W; x++) {
    let sum = 0, cnt = 0
    for (let k = 0; k <= R && k < H; k++) { sum += tmp[k * W + x]; cnt++ }
    for (let y = 0; y < H; y++) {
      out[y * W + x] = cnt > 0 ? Math.round((sum / cnt) * 255) : 0
      if (y + R + 1 < H) { sum += tmp[(y + R + 1) * W + x]; cnt++ }
      if (y - R     >= 0) { sum -= tmp[(y - R    ) * W + x]; cnt-- }
    }
  }

  return out
}

// ── Bilinear sampler ──────────────────────────────────────────────────────────
function sampleBilinear(
  data: Float32Array | Uint8Array,
  w: number, h: number,
  fx: number, fy: number
): number {
  const x0 = Math.max(0, Math.floor(fx))
  const y0 = Math.max(0, Math.floor(fy))
  const x1 = Math.min(x0 + 1, w - 1)
  const y1 = Math.min(y0 + 1, h - 1)
  const tx = fx - x0
  const ty = fy - y0
  return (
    data[y0 * w + x0] * (1 - tx) * (1 - ty) +
    data[y0 * w + x1] * tx       * (1 - ty) +
    data[y1 * w + x0] * (1 - tx) * ty       +
    data[y1 * w + x1] * tx       * ty
  )
}

// ── BFS outward from edge pixels → distance field for outer glow ─────────────
function buildEdgeSDF(binary: Uint8Array, W: number, H: number, maxDist: number): Uint8Array {
  const total = W * H
  const sdf = new Uint8Array(total).fill(255)
  const queue = new Int32Array(total)
  let head = 0, tail = 0

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (!binary[i]) continue
      let isEdge = false
      outer: for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const nx = x + dx, ny = y + dy
          if (nx < 0 || nx >= W || ny < 0 || ny >= H || !binary[ny * W + nx]) {
            isEdge = true; break outer
          }
        }
      }
      if (isEdge) { sdf[i] = 0; queue[tail++] = i }
    }
  }

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
      if (ni < 0 || binary[ni] || sdf[ni] <= nd) continue
      sdf[ni] = nd
      queue[tail++] = ni
    }
  }

  return sdf
}

// ── BFS inward from edge pixels → distance field for compositing feather ─────
function buildInnerSDF(binary: Uint8Array, W: number, H: number, maxDist: number): Uint8Array {
  const total = W * H
  const sdf = new Uint8Array(total).fill(255)
  const queue = new Int32Array(total)
  let head = 0, tail = 0

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x
      if (!binary[i]) continue
      let isEdge = false
      outer: for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const nx = x + dx, ny = y + dy
          if (nx < 0 || nx >= W || ny < 0 || ny >= H || !binary[ny * W + nx]) {
            isEdge = true; break outer
          }
        }
      }
      if (isEdge) { sdf[i] = 0; queue[tail++] = i }
    }
  }

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
      if (ni < 0 || !binary[ni] || sdf[ni] <= nd) continue
      sdf[ni] = nd
      queue[tail++] = ni
    }
  }

  return sdf
}

// ── Pre-computed assignment for pixel-perfect hit-testing ─────────────────────
let hitAssignment: Int16Array | null = null
let hitW = 0
let hitH = 0
let hitMasks: MaskInfo[] = []

/**
 * Call once after loadMaskIntoOffscreen() + masks are known.
 * Supports two modes:
 *   - B&W mode (bwMaskCanvases populated): each canvas is a binary mask for one region
 *   - Legacy color mode (offscreenCanvas populated): nearest-neighbour color assignment
 */
export function precomputeMaskOutlines(masks: MaskInfo[]): void {
  if (masks.length === 0) return

  const useBW = bwMaskCanvases.length > 0

  if (useBW) {
    _precomputeFromBWMasks(masks)
  } else if (offscreenCtx && offscreenCanvas) {
    _precomputeFromColorMask(masks)
  }
}

function _precomputeFromBWMasks(masks: MaskInfo[]): void {
  maskSDFs.clear()
  const W = bwMaskWidth
  const H = bwMaskHeight
  if (!W || !H) return
  const total = W * H

  // Build hitAssignment from B&W canvases
  // For each pixel, find which mask canvas has white (>128) at that position.
  // If multiple masks overlap (shouldn't happen), last one wins.
  const assignment = new Int16Array(total).fill(-1)

  for (let mi = 0; mi < Math.min(masks.length, bwMaskCanvases.length); mi++) {
    const bwCanvas = bwMaskCanvases[mi]
    const bwCtx = bwCanvas.getContext('2d', { willReadFrequently: true })!
    const pixels = bwCtx.getImageData(0, 0, W, H).data
    for (let i = 0; i < total; i++) {
      // B&W mask: white region = this wall. Use red channel as brightness.
      if (pixels[i * 4] > 128) {
        assignment[i] = mi
      }
    }
  }

  _buildSDFs(masks, assignment, W, H, total)
}

function _precomputeFromColorMask(masks: MaskInfo[]): void {
  maskSDFs.clear()
  const W = offscreenCanvas!.width
  const H = offscreenCanvas!.height
  const pixels = offscreenCtx!.getImageData(0, 0, W, H).data
  const total = W * H

  const assignment = new Int16Array(total).fill(-1)
  for (let i = 0; i < total; i++) {
    const r = pixels[i * 4], g = pixels[i * 4 + 1], b = pixels[i * 4 + 2]
    if (r === 0 && g === 0 && b === 0) continue
    let bestDist = 50000, bestMi = -1
    for (let mi = 0; mi < masks.length; mi++) {
      const [mr, mg, mb] = masks[mi].color
      const d = (r - mr) ** 2 + (g - mg) ** 2 + (b - mb) ** 2
      if (d < bestDist) { bestDist = d; bestMi = mi }
    }
    assignment[i] = bestMi
  }

  _buildSDFs(masks, assignment, W, H, total)
}

function _buildSDFs(masks: MaskInfo[], assignment: Int16Array, W: number, H: number, total: number): void {
  const bfsQueue  = new Int32Array(total)
  const visited   = new Uint8Array(total)
  const inLargest = new Uint8Array(total)

  for (let mi = 0; mi < masks.length; mi++) {
    // ── 2a: Find largest 4-connected component ──────────────────────────────
    visited.fill(0)
    let largestSeed = -1, largestSize = 0

    for (let seed = 0; seed < total; seed++) {
      if (assignment[seed] !== mi || visited[seed]) continue
      let head = 0, tail = 0
      bfsQueue[tail++] = seed
      visited[seed] = 1
      let size = 0
      while (head < tail) {
        const curr = bfsQueue[head++]; size++
        const cy = (curr / W) | 0, cx = curr - cy * W
        if (cy > 0   && assignment[curr - W] === mi && !visited[curr - W]) { visited[curr - W] = 1; bfsQueue[tail++] = curr - W }
        if (cy < H-1 && assignment[curr + W] === mi && !visited[curr + W]) { visited[curr + W] = 1; bfsQueue[tail++] = curr + W }
        if (cx > 0   && assignment[curr - 1] === mi && !visited[curr - 1]) { visited[curr - 1] = 1; bfsQueue[tail++] = curr - 1 }
        if (cx < W-1 && assignment[curr + 1] === mi && !visited[curr + 1]) { visited[curr + 1] = 1; bfsQueue[tail++] = curr + 1 }
      }
      if (size > largestSize) { largestSize = size; largestSeed = seed }
    }

    // ── 2b: Mark the largest component ──────────────────────────────────────
    inLargest.fill(0)
    if (largestSeed >= 0) {
      let head = 0, tail = 0
      bfsQueue[tail++] = largestSeed
      inLargest[largestSeed] = 1
      while (head < tail) {
        const curr = bfsQueue[head++]
        const cy = (curr / W) | 0, cx = curr - cy * W
        if (cy > 0   && assignment[curr - W] === mi && !inLargest[curr - W]) { inLargest[curr - W] = 1; bfsQueue[tail++] = curr - W }
        if (cy < H-1 && assignment[curr + W] === mi && !inLargest[curr + W]) { inLargest[curr + W] = 1; bfsQueue[tail++] = curr + W }
        if (cx > 0   && assignment[curr - 1] === mi && !inLargest[curr - 1]) { inLargest[curr - 1] = 1; bfsQueue[tail++] = curr - 1 }
        if (cx < W-1 && assignment[curr + 1] === mi && !inLargest[curr + 1]) { inLargest[curr + 1] = 1; bfsQueue[tail++] = curr + 1 }
      }
    }

    // ── 3: Box-blur inLargest → smoothMask 0..255 ───────────────────────────
    const smoothMask = boxBlur(inLargest, W, H, BLUR_RADIUS)

    // ── 4: Threshold smoothMask at 50% → smoothBinary ───────────────────────
    const smoothBinary = new Uint8Array(total)
    for (let i = 0; i < total; i++) smoothBinary[i] = smoothMask[i] >= 128 ? 1 : 0

    // ── 5: Outward SDF for glow ─────────────────────────────────────────────
    const sdf = buildEdgeSDF(smoothBinary, W, H, MAX_GLOW_DIST)

    // ── 6: Inward SDF → smoothstep edgeAlpha for compositing feather ─────────
    const innerSDF  = buildInnerSDF(smoothBinary, W, H, FEATHER_W)
    const edgeAlpha = new Uint8Array(total)
    for (let i = 0; i < total; i++) {
      if (!smoothBinary[i]) { edgeAlpha[i] = 0; continue }
      const d = innerSDF[i]
      if (d >= FEATHER_W || d === 255) {
        edgeAlpha[i] = 255
      } else {
        const t = d / FEATHER_W
        edgeAlpha[i] = Math.round(t * t * (3 - 2 * t) * 255)   // smoothstep
      }
    }

    maskSDFs.set(masks[mi].id, { sdf, smoothMask, edgeAlpha, w: W, h: H })
  }

  hitAssignment = assignment
  hitW = bwMaskCanvases.length > 0 ? bwMaskWidth : offscreenCanvas!.width
  hitH = bwMaskCanvases.length > 0 ? bwMaskHeight : offscreenCanvas!.height
  hitMasks = masks
}

/**
 * Returns the mask that owns pixel (imageX, imageY) using the nearest-neighbour
 * assignment from precomputeMaskOutlines. Hit-testing stays on the original raw
 * colour assignment (not the blurred boundary) for accurate click targeting.
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
 * Render the selection glow using a pre-computed SDF.
 * The SDF is built from the box-blurred boundary so the glow core traces a
 * smooth contour rather than the original pixel staircase.
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

  const SPREAD = MAX_GLOW_DIST
  const CORE_W = 1.5

  const outData = ctx.createImageData(dW, dH)
  const od = outData.data

  for (let dy = 0; dy < dH; dy++) {
    for (let dx = 0; dx < dW; dx++) {
      // Bilinear SDF sampling for smooth glow at all display scales
      const d = sampleBilinear(sdf, sW, sH, dx * scaleX, dy * scaleY)
      if (d === 255 || d > SPREAD) continue

      const t    = d / SPREAD
      const glow = Math.exp(-3.5 * t)
      if (glow < 0.004) continue

      const whiteness = d < CORE_W ? (1 - d / CORE_W) ** 2 : 0
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
 * Sweeping shimmer clipped to the mask region.
 * Uses bilinear sample of smoothMask (0..255) as the fill alpha — the box-blurred
 * boundary gives a natural anti-aliased edge at any display scale.
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

  const { smoothMask, w: sW, h: sH } = data
  const dW = shimmerCanvas.width
  const dH = shimmerCanvas.height
  if (!dW || !dH) return

  const scaleX = sW / dW
  const scaleY = sH / dH
  const t = (timestamp / 2500) * Math.PI * 2
  const [cr, cg, cb] = color

  const outData = ctx.createImageData(dW, dH)
  const od = outData.data

  for (let dy = 0; dy < dH; dy++) {
    for (let dx = 0; dx < dW; dx++) {
      const maskAlpha = sampleBilinear(smoothMask, sW, sH, dx * scaleX, dy * scaleY) / 255
      if (maskAlpha < 0.01) continue

      const wave1   = Math.sin(dx * 0.018 + dy * 0.004 + t)
      const wave2   = Math.sin(dx * 0.011 - dy * 0.006 + t * 0.71 + 1.0)
      const shimmer = (wave1 + wave2) * 0.25 + 0.5   // 0..1 gentle ripple

      const alpha = maskAlpha * (0.60 + shimmer * 0.40)
      const blend = shimmer * 0.70

      const di = (dy * dW + dx) * 4
      od[di]     = Math.round(cr * (1 - blend) + 255 * blend)
      od[di + 1] = Math.round(cg * (1 - blend) + 255 * blend)
      od[di + 2] = Math.round(cb * (1 - blend) + 255 * blend)
      od[di + 3] = Math.round(alpha * 255)
    }
  }

  ctx.putImageData(outData, 0, 0)
}

/**
 * Grayscale shimmer for all currently-processing mask regions.
 * Uses bilinear smoothMask for anti-aliased edges.
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

  const t = (timestamp / 2500) * Math.PI * 2

  const outData = ctx.createImageData(dW, dH)
  const od = outData.data

  for (const maskId of maskIds) {
    const data = maskSDFs.get(maskId)
    if (!data) continue

    const { smoothMask, w: sW, h: sH } = data
    const scaleX = sW / dW
    const scaleY = sH / dH

    for (let dy = 0; dy < dH; dy++) {
      for (let dx = 0; dx < dW; dx++) {
        const maskAlpha = sampleBilinear(smoothMask, sW, sH, dx * scaleX, dy * scaleY) / 255
        if (maskAlpha < 0.01) continue

        const wave1   = Math.sin(dx * 0.018 + dy * 0.004 + t)
        const wave2   = Math.sin(dx * 0.011 - dy * 0.006 + t * 0.71 + 1.0)
        const shimmer = (wave1 + wave2) * 0.25 + 0.5   // 0..1 gentle ripple

        const alpha      = maskAlpha * (0.55 + shimmer * 0.45)
        const brightness = Math.round(120 + shimmer * 135)   // 120..255
        const di = (dy * dW + dx) * 4
        od[di]     = brightness
        od[di + 1] = brightness
        od[di + 2] = brightness
        od[di + 3] = Math.round(alpha * 255)
      }
    }
  }

  ctx.putImageData(outData, 0, 0)
}

/**
 * Generate a random RGB color that doesn't collide with any existing mask color.
 * Minimum Euclidean distance in RGB space: 80 units.
 * Avoids near-black (< 28) and near-white (> 228) to stay clearly visible on the mask.
 */
function generateUniqueColor(
  existingColors: [number, number, number][]
): [number, number, number] {
  const MIN_DIST_SQ = 80 * 80
  for (let attempt = 0; attempt < 300; attempt++) {
    const r = Math.floor(Math.random() * 200) + 28
    const g = Math.floor(Math.random() * 200) + 28
    const b = Math.floor(Math.random() * 200) + 28
    let ok = true
    for (const [er, eg, eb] of existingColors) {
      if ((r - er) ** 2 + (g - eg) ** 2 + (b - eb) ** 2 < MIN_DIST_SQ) {
        ok = false; break
      }
    }
    if (ok) return [r, g, b]
  }
  // Extremely unlikely fallback
  return [255, 128, 0]
}

/**
 * Split a mask region in two using an infinite line (half-plane classification).
 *
 * Works in B&W mask mode: finds the bwMaskCanvas for maskId, splits its white
 * pixels into side-A (kept) and side-B (new canvas).
 *
 * Falls back to legacy color-mask mode if bwMaskCanvases is empty.
 *
 * Returns null if the line doesn't split the region.
 */
export function splitMaskByLine(
  maskId: number,
  x1: number, y1: number,
  x2: number, y2: number,
  existingMasks: MaskInfo[]
): { updatedMaskBase64: string; newMaskBase64: string; newMask: MaskInfo } | null {
  const mi = hitMasks.findIndex(m => m.id === maskId)
  if (mi === -1) return null

  const useBW = bwMaskCanvases.length > 0

  if (useBW) {
    return _splitBWMask(mi, maskId, x1, y1, x2, y2, existingMasks)
  } else {
    return _splitColorMask(mi, maskId, x1, y1, x2, y2, existingMasks)
  }
}

function _splitBWMask(
  mi: number,
  maskId: number,
  x1: number, y1: number,
  x2: number, y2: number,
  existingMasks: MaskInfo[]
): { updatedMaskBase64: string; newMaskBase64: string; newMask: MaskInfo } | null {
  const bwCanvas = bwMaskCanvases[mi]
  if (!bwCanvas) return null

  const W  = bwCanvas.width
  const H  = bwCanvas.height
  const dx = x2 - x1
  const dy = y2 - y1

  const bwCtx = bwCanvas.getContext('2d', { willReadFrequently: true })!
  const imgData = bwCtx.getImageData(0, 0, W, H)
  const d = imgData.data

  // Count pixels on each side
  let sideACount = 0, sideBCount = 0
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const i = py * W + px
      if (d[i * 4] <= 128) continue  // black pixel, skip
      const cross = dx * (py - y1) - dy * (px - x1)
      if (cross >= 0) sideACount++
      else sideBCount++
    }
  }
  if (sideACount === 0 || sideBCount === 0) return null

  // Create new canvas for side-B
  const newCanvas = document.createElement('canvas')
  newCanvas.width = W
  newCanvas.height = H
  const newCtx = newCanvas.getContext('2d', { willReadFrequently: true })!
  const newData = newCtx.createImageData(W, H)
  const nd = newData.data

  // Split: side-B pixels → new canvas (white), cleared from original
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const i = py * W + px
      if (d[i * 4] <= 128) continue
      const cross = dx * (py - y1) - dy * (px - x1)
      if (cross < 0) {
        // Side B: move to new canvas
        d[i * 4] = 0; d[i * 4 + 1] = 0; d[i * 4 + 2] = 0; d[i * 4 + 3] = 255
        nd[i * 4] = 255; nd[i * 4 + 1] = 255; nd[i * 4 + 2] = 255; nd[i * 4 + 3] = 255
      }
    }
  }

  bwCtx.putImageData(imgData, 0, 0)
  newCtx.putImageData(newData, 0, 0)

  // Register new canvas
  const newColor = generateUniqueColor(existingMasks.map(m => m.color))
  const newId    = Math.max(...existingMasks.map(m => m.id)) + 1
  bwMaskCanvases.push(newCanvas)

  const updatedMaskBase64 = bwCanvas.toDataURL('image/png').split(',')[1]
  const newMaskBase64     = newCanvas.toDataURL('image/png').split(',')[1]
  const newMask: MaskInfo = {
    id:    newId,
    label: `${hitMasks[mi].label} B`,
    color: newColor,
  }

  return { updatedMaskBase64, newMaskBase64, newMask }
}

function _splitColorMask(
  mi: number,
  maskId: number,
  x1: number, y1: number,
  x2: number, y2: number,
  existingMasks: MaskInfo[]
): { updatedMaskBase64: string; newMaskBase64: string; newMask: MaskInfo } | null {
  if (!offscreenCtx || !offscreenCanvas || !hitAssignment) return null

  const W  = offscreenCanvas.width
  const H  = offscreenCanvas.height
  const dx = x2 - x1
  const dy = y2 - y1

  const imgData = offscreenCtx.getImageData(0, 0, W, H)
  const d       = imgData.data

  let side2Count = 0, totalCount = 0
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      if (hitAssignment[py * W + px] !== mi) continue
      totalCount++
      if (dx * (py - y1) - dy * (px - x1) < 0) side2Count++
    }
  }
  if (side2Count === 0 || side2Count === totalCount) return null

  const newColor = generateUniqueColor(existingMasks.map(m => m.color))
  const [nr, ng, nb] = newColor

  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      const i = py * W + px
      if (hitAssignment[i] !== mi) continue
      if (dx * (py - y1) - dy * (px - x1) < 0) {
        d[i * 4]     = nr
        d[i * 4 + 1] = ng
        d[i * 4 + 2] = nb
        d[i * 4 + 3] = 255
      }
    }
  }

  offscreenCtx.putImageData(imgData, 0, 0)

  const updatedMaskBase64 = offscreenCanvas.toDataURL('image/png').split(',')[1]
  const newId = Math.max(...existingMasks.map(m => m.id)) + 1
  const newMask: MaskInfo = {
    id:    newId,
    label: `${hitMasks[mi].label} B`,
    color: newColor,
  }

  return { updatedMaskBase64, newMaskBase64: updatedMaskBase64, newMask }
}

/**
 * Fills the canvas with a dark overlay, with the selected mask region kept
 * transparent (smooth edge via bilinear-sampled smoothMask).
 * Used to dim everything except the currently-selected wall in editing mode.
 */
export function drawMaskDim(maskId: number, canvas: HTMLCanvasElement): void {
  const ctx = canvas.getContext('2d')!
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  const data = maskSDFs.get(maskId)
  if (!data) return

  const { smoothMask, w: sW, h: sH } = data
  const dW = canvas.width
  const dH = canvas.height
  if (!dW || !dH) return
  const scaleX = sW / dW
  const scaleY = sH / dH

  const outData = ctx.createImageData(dW, dH)
  const od = outData.data

  for (let dy = 0; dy < dH; dy++) {
    for (let dx = 0; dx < dW; dx++) {
      const maskAlpha = sampleBilinear(smoothMask, sW, sH, dx * scaleX, dy * scaleY) / 255
      const dimAlpha = Math.round((1 - maskAlpha) * 0.65 * 255)
      if (dimAlpha === 0) continue
      const di = (dy * dW + dx) * 4
      // rgb stays 0 (black); only set alpha
      od[di + 3] = dimAlpha
    }
  }

  ctx.putImageData(outData, 0, 0)
}

export function initOffscreenCanvas(width: number, height: number) {
  offscreenCanvas = document.createElement('canvas')
  offscreenCanvas.width = width
  offscreenCanvas.height = height
  offscreenCtx = offscreenCanvas.getContext('2d', { willReadFrequently: true })!
  // Reset B&W canvases when a new image is loaded
  bwMaskCanvases = []
  bwMaskWidth  = 0
  bwMaskHeight = 0
}

export function loadMaskIntoOffscreen(maskBase64: string): Promise<void> {
  return new Promise((resolve) => {
    if (!offscreenCtx || !offscreenCanvas) { resolve(); return }
    const img = new Image()
    img.onload = () => {
      offscreenCtx!.drawImage(img, 0, 0, offscreenCanvas!.width, offscreenCanvas!.height)
      resolve()
    }
    img.crossOrigin = 'anonymous'
    img.src = _toImgSrc(maskBase64)
  })
}

/** URL / base64 自适应转换 */
function _toImgSrc(value: string): string {
  if (
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    value.startsWith('/') ||
    value.startsWith('data:')
  ) return value
  return `data:image/png;base64,${value}`
}

/**
 * Load multiple B&W mask images (one per wall region) into separate offscreen canvases.
 * Each canvas stores a binary mask: white = this wall region, black = background.
 * Call this instead of loadMaskIntoOffscreen when using the ComfyUI B&W mask pipeline.
 */
export function loadBWMasksIntoOffscreen(
  maskBase64List: string[],
  width: number,
  height: number,
): Promise<void> {
  bwMaskCanvases = []
  bwMaskWidth  = width
  bwMaskHeight = height

  const promises = maskBase64List.map((b64) => {
    return new Promise<HTMLCanvasElement>((resolve) => {
      const canvas = document.createElement('canvas')
      canvas.width  = width
      canvas.height = height
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!
      const img = new Image()
      img.onload = () => {
        ctx.drawImage(img, 0, 0, width, height)
        resolve(canvas)
      }
      img.onerror = () => resolve(canvas)  // empty canvas on error
      img.crossOrigin = 'anonymous'
      img.src = _toImgSrc(b64)
    })
  })

  return Promise.all(promises).then((canvases) => {
    bwMaskCanvases = canvases
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
    const resultImg = new Image()
    resultImg.onload = () => {
      const tempCanvas = document.createElement('canvas')
      tempCanvas.width = width
      tempCanvas.height = height
      const tempCtx = tempCanvas.getContext('2d', { willReadFrequently: true })!
      tempCtx.drawImage(resultImg, 0, 0, width, height)

      const baseCtx   = baseCanvas.getContext('2d', { willReadFrequently: true })!
      const baseData   = baseCtx.getImageData(0, 0, width, height)
      const resultData = tempCtx.getImageData(0, 0, width, height)

      const sdfData = maskId !== undefined ? maskSDFs.get(maskId) : undefined

      if (sdfData) {
        const { edgeAlpha, w: sW, h: sH } = sdfData
        for (let py = 0; py < height; py++) {
          for (let px = 0; px < width; px++) {
            const sx = Math.min(Math.round(px * sW / width), sW - 1)
            const sy = Math.min(Math.round(py * sH / height), sH - 1)
            const a = edgeAlpha[sy * sW + sx]
            if (a === 0) continue
            const i = (py * width + px) * 4
            if (a >= 255) {
              baseData.data[i]     = resultData.data[i]
              baseData.data[i + 1] = resultData.data[i + 1]
              baseData.data[i + 2] = resultData.data[i + 2]
              baseData.data[i + 3] = resultData.data[i + 3]
            } else {
              const af = a / 255, bf = 1 - af
              baseData.data[i]     = Math.round(resultData.data[i]     * af + baseData.data[i]     * bf)
              baseData.data[i + 1] = Math.round(resultData.data[i + 1] * af + baseData.data[i + 1] * bf)
              baseData.data[i + 2] = Math.round(resultData.data[i + 2] * af + baseData.data[i + 2] * bf)
              baseData.data[i + 3] = Math.round(resultData.data[i + 3] * af + baseData.data[i + 3] * bf)
            }
          }
        }
      } else if (offscreenCtx) {
        // Fallback: colour-match against the raw mask image
        const maskData = offscreenCtx.getImageData(0, 0, width, height)
        const [tr, tg, tb] = targetColor
        const tolerance = 10
        for (let i = 0; i < maskData.data.length; i += 4) {
          const mr = maskData.data[i], mg = maskData.data[i + 1], mb = maskData.data[i + 2]
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
