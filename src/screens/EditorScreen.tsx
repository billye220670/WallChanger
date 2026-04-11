import { useRef, useState, useCallback, useEffect } from 'react'
import { useStore } from '../store'
import type { Material } from '../types'
import { ImageCanvas, type ImageCanvasHandle } from '../components/ImageCanvas'
import { MaterialDrawer } from '../components/MaterialDrawer'
import { DragPreview } from '../components/DragPreview'
import { DebugPanel, type DebugFlags } from '../components/DebugPanel'
import { renderRegion, setBackendUrl } from '../utils/api'
import type { BatchItem } from '../types'
import { getMaskAtPixel, compositeRegion, precomputeMaskOutlines, drawMaskOutline, drawMaskShimmer, drawProcessingShimmer, drawMaskDim, splitMaskByLine, loadBWMasksIntoOffscreen } from '../utils/canvas'
import { touchToImageCoords } from '../utils/coords'

// ── Line editor types ─────────────────────────────────────────────────────────
interface Point { x: number; y: number }

type DragTarget =
  | { kind: 'start' }
  | { kind: 'end' }
  | { kind: 'line'; startBase: Point; endBase: Point; pointerStart: Point }

export function EditorScreen() {
  const {
    masks,
    maskImages,
    dimensions,
    processingRegions,
    hoveredMaskId,
    draggingMaterial,
    backendUrl,
    originalImage,
    refinedMask,
    rawMask,
    isApplying,
    debugPrompts,
    batchMode,
    batchItems,
    setDraggingMaterial,
    setHoveredMaskId,
    addProcessingRegion,
    removeProcessingRegion,
    setAppliedRegion,
    setCompositeImage,
    setPhase,
    setDebugPrompts,
    setMaskImages,
    setIsApplying,
    setBatchMode,
    addBatchItem,
    removeBatchItem,
    clearBatchItems,
  } = useStore()

  const canvasRef           = useRef<ImageCanvasHandle>(null)
  const outerRef            = useRef<HTMLDivElement>(null)
  const imageContainerRef   = useRef<HTMLDivElement>(null)
  const overlayCanvasRef    = useRef<HTMLCanvasElement>(null)
  const processingCanvasRef = useRef<HTMLCanvasElement>(null)
  const dimCanvasRef        = useRef<HTMLCanvasElement>(null)
  const lineCanvasRef       = useRef<HTMLCanvasElement>(null)

  const [drawerOpen, setDrawerOpen]     = useState(false)
  const [dragPos, setDragPos]           = useState({ x: 0, y: 0 })
  const [canvasReady, setCanvasReady]   = useState(false)
  const [debugFlags, setDebugFlags]     = useState<DebugFlags>({
    showClean: false, showRawMask: false, showRefinedMask: false, hoverHighlight: false, hoverFill: false,
  })
  const [selectedMaskId, setSelectedMaskId] = useState<number | null>(null)

  // editing mode
  const [editing, setEditing]   = useState(false)
  // line state in display pixels (relative to imageContainerRef)
  const [lineStart, setLineStart] = useState<Point | null>(null)
  const [lineEnd, setLineEnd]     = useState<Point | null>(null)
  const lineDragRef = useRef<DragTarget | null>(null)

  // Snapshot of original maskImages + masks (before any splits), for full reset
  const originalSnapshotRef = useRef<{ maskImages: string[]; masks: typeof masks } | null>(null)
  const [hasSplit, setHasSplit] = useState(false)

  // ── Contain-box sizing ────────────────────────────────────────────────────
  const [imgBox, setImgBox] = useState({ x: 0, y: 0, w: 0, h: 0 })

  useEffect(() => {
    const outer = outerRef.current
    if (!outer || !dimensions.width || !dimensions.height) return
    const compute = () => {
      const { width: cw, height: ch } = outer.getBoundingClientRect()
      if (!cw || !ch) return
      const iAR = dimensions.width / dimensions.height
      const cAR = cw / ch
      const w = iAR > cAR ? cw : ch * iAR
      const h = iAR > cAR ? cw / iAR : ch
      setImgBox({ x: (cw - w) / 2, y: (ch - h) / 2, w, h })
    }
    compute()
    const ro = new ResizeObserver(compute)
    ro.observe(outer)
    return () => ro.disconnect()
  }, [dimensions.width, dimensions.height])

  // ── Pre-compute outline borders once mask is loaded ───────────────────────
  useEffect(() => {
    if (canvasReady && masks.length > 0) precomputeMaskOutlines(masks)
  }, [canvasReady, masks])

  // ── Clear selection when material drawer opens ────────────────────────────
  useEffect(() => {
    if (drawerOpen) { setSelectedMaskId(null); setEditing(false) }
  }, [drawerOpen])

  // ── Exit editing when selection cleared ──────────────────────────────────
  useEffect(() => {
    if (selectedMaskId === null) setEditing(false)
  }, [selectedMaskId])

  // ── Draw / clear outline overlay on selection change ─────────────────────
  useEffect(() => {
    const overlay   = overlayCanvasRef.current
    const container = imageContainerRef.current
    if (!overlay || !container) return
    if (debugFlags.hoverFill) return
    const { width: w, height: h } = container.getBoundingClientRect()
    overlay.width  = Math.round(w)
    overlay.height = Math.round(h)
    if (selectedMaskId === null) { drawMaskOutline(null, overlay); return }
    drawMaskOutline(selectedMaskId, overlay)
  }, [selectedMaskId, debugFlags.hoverFill, canvasReady])

  // ── Hover fill shimmer ────────────────────────────────────────────────────
  useEffect(() => {
    if (!debugFlags.hoverFill || selectedMaskId === null) return
    const selectedMask = masks.find(m => m.id === selectedMaskId)
    if (!selectedMask) return
    let animId: number
    const animate = (timestamp: number) => {
      const overlay   = overlayCanvasRef.current
      const container = imageContainerRef.current
      if (!overlay || !container) return
      const { width: w, height: h } = container.getBoundingClientRect()
      if (overlay.width !== Math.round(w) || overlay.height !== Math.round(h)) {
        overlay.width  = Math.round(w)
        overlay.height = Math.round(h)
      }
      drawMaskShimmer(selectedMaskId, overlay, timestamp, selectedMask.color)
      animId = requestAnimationFrame(animate)
    }
    animId = requestAnimationFrame(animate)
    return () => {
      cancelAnimationFrame(animId)
      const overlay = overlayCanvasRef.current
      overlay?.getContext('2d')?.clearRect(0, 0, overlay.width, overlay.height)
    }
  }, [debugFlags.hoverFill, selectedMaskId, masks])

  // ── Dim overlay (editing mode) ────────────────────────────────────────────
  useEffect(() => {
    const dim       = dimCanvasRef.current
    const container = imageContainerRef.current
    if (!dim || !container) return
    const { width: w, height: h } = container.getBoundingClientRect()
    dim.width  = Math.round(w)
    dim.height = Math.round(h)
    if (editing && selectedMaskId !== null) {
      drawMaskDim(selectedMaskId, dim)
    } else {
      dim.getContext('2d')?.clearRect(0, 0, dim.width, dim.height)
    }
  }, [editing, selectedMaskId, canvasReady])

  // ── Draw dashed line + control points ────────────────────────────────────
  useEffect(() => {
    const lc        = lineCanvasRef.current
    const container = imageContainerRef.current
    if (!lc || !container) return
    const { width: w, height: h } = container.getBoundingClientRect()
    lc.width  = Math.round(w)
    lc.height = Math.round(h)
    const ctx = lc.getContext('2d')!
    ctx.clearRect(0, 0, lc.width, lc.height)

    if (!editing || !lineStart || !lineEnd) return

    // Dashed line
    ctx.save()
    ctx.strokeStyle = 'white'
    ctx.lineWidth   = 2
    ctx.setLineDash([8, 5])
    ctx.lineDashOffset = 0
    ctx.beginPath()
    ctx.moveTo(lineStart.x, lineStart.y)
    ctx.lineTo(lineEnd.x, lineEnd.y)
    ctx.stroke()
    ctx.restore()

    // Control point circles
    for (const pt of [lineStart, lineEnd]) {
      ctx.save()
      ctx.beginPath()
      ctx.arc(pt.x, pt.y, 10, 0, Math.PI * 2)
      ctx.fillStyle = 'white'
      ctx.fill()
      ctx.strokeStyle = 'rgba(0,0,0,0.4)'
      ctx.lineWidth = 1.5
      ctx.stroke()
      ctx.restore()
    }
  }, [editing, lineStart, lineEnd])

  // ── Always-on hover tracking ───────────────────────────────────────────────
  useEffect(() => {
    const container = imageContainerRef.current
    if (!container) return
    const handleMouseMove = (e: MouseEvent) => {
      if (!dimensions.width) return
      const { x: imgX, y: imgY } = touchToImageCoords(e.clientX, e.clientY, container, dimensions.width, dimensions.height)
      const mask = getMaskAtPixel(imgX, imgY)
      setHoveredMaskId(mask?.id ?? null)
    }
    const handleMouseLeave = () => setHoveredMaskId(null)
    container.addEventListener('mousemove', handleMouseMove)
    container.addEventListener('mouseleave', handleMouseLeave)
    return () => {
      container.removeEventListener('mousemove', handleMouseMove)
      container.removeEventListener('mouseleave', handleMouseLeave)
    }
  }, [dimensions, masks])

  // ── Processing shimmer ────────────────────────────────────────────────────
  useEffect(() => {
    const ids = Array.from(processingRegions)
    if (ids.length === 0) {
      const pc = processingCanvasRef.current
      pc?.getContext('2d')?.clearRect(0, 0, pc.width, pc.height)
      return
    }
    let animId: number
    const animate = (timestamp: number) => {
      const pc        = processingCanvasRef.current
      const container = imageContainerRef.current
      if (!pc || !container) return
      const { width: w, height: h } = container.getBoundingClientRect()
      if (pc.width !== Math.round(w) || pc.height !== Math.round(h)) {
        pc.width  = Math.round(w)
        pc.height = Math.round(h)
      }
      drawProcessingShimmer(ids, pc, timestamp)
      animId = requestAnimationFrame(animate)
    }
    animId = requestAnimationFrame(animate)
    return () => {
      cancelAnimationFrame(animId)
      const pc = processingCanvasRef.current
      pc?.getContext('2d')?.clearRect(0, 0, pc.width, pc.height)
    }
  }, [processingRegions])

  // ── Material drag handlers ────────────────────────────────────────────────
  const handleDragStart = useCallback((material: Material, x: number, y: number) => {
    setBackendUrl(backendUrl)
    setDraggingMaterial(material)
    setDragPos({ x, y })
  }, [backendUrl])

  const handleDragMove = useCallback((x: number, y: number) => {
    setDragPos({ x, y })
    if (!imageContainerRef.current || !dimensions.width) return
    const rect = imageContainerRef.current.getBoundingClientRect()
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      setHoveredMaskId(null); return
    }
    const { x: imgX, y: imgY } = touchToImageCoords(x, y, imageContainerRef.current, dimensions.width, dimensions.height)
    const mask = getMaskAtPixel(imgX, imgY)
    setHoveredMaskId(mask?.id ?? null)
  }, [dimensions, masks])

  const handleDragEnd = useCallback(async (x: number, y: number): Promise<boolean> => {
    if (!draggingMaterial) { setDraggingMaterial(null); setHoveredMaskId(null); return false }
    const material = draggingMaterial
    setDraggingMaterial(null)
    if (!imageContainerRef.current || !dimensions.width) { setHoveredMaskId(null); return false }
    const rect = imageContainerRef.current.getBoundingClientRect()
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      setHoveredMaskId(null); return false
    }
    const { x: imgX, y: imgY } = touchToImageCoords(x, y, imageContainerRef.current, dimensions.width, dimensions.height)
    const mask = getMaskAtPixel(imgX, imgY)
    if (!mask) { setHoveredMaskId(null); return false }

    setHoveredMaskId(null)

    // ── Batch mode: collect data, don't render ──
    if (batchMode) {
      try {
        const matResp = await fetch(`${backendUrl}/materials/${material.filename}`)
        const matBlob = await matResp.blob()
        const materialB64 = await new Promise<string>((resolve) => {
          const reader = new FileReader()
          reader.onload = (e) => resolve((e.target!.result as string).split(',')[1])
          reader.readAsDataURL(matBlob)
        })
        addBatchItem({ imgX: Math.round(imgX), imgY: Math.round(imgY), material, materialB64 })
      } catch (err) {
        console.error('Failed to load material:', err)
      }
      return true
    }

    // ── Original render logic ──
    // Synchronous lock — ComfyUI can only handle one job at a time
    if (isApplying) { return false }

    setIsApplying(true)
    addProcessingRegion(mask.id)

    try {
      // Find the B&W mask image for this region
      const maskIndex = masks.findIndex(m => m.id === mask.id)
      const maskImageB64 = maskImages[maskIndex] ?? null
      if (!maskImageB64 || !originalImage) throw new Error('Missing mask or image data')

      // Load material as base64
      const matResp = await fetch(`${backendUrl}/materials/${material.filename}`)
      const matBlob = await matResp.blob()
      const materialB64 = await new Promise<string>((resolve) => {
        const reader = new FileReader()
        reader.onload = (e) => resolve((e.target!.result as string).split(',')[1])
        reader.readAsDataURL(matBlob)
      })

      const result = await renderRegion(originalImage, maskImageB64, materialB64)
      setAppliedRegion(mask.id, result.resultImage)

      // Composite: draw the RGBA result (with alpha) directly onto the canvas
      const canvas = canvasRef.current?.getCanvas()
      if (canvas) {
        await new Promise<void>((resolve) => {
          const img = new Image()
          img.onload = () => {
            const ctx = canvas.getContext('2d')!
            ctx.drawImage(img, 0, 0, dimensions.width, dimensions.height)
            resolve()
          }
          img.src = `data:image/png;base64,${result.resultImage}`
        })
        setCompositeImage(canvas.toDataURL('image/png').split(',')[1])
      }
    } catch (err) {
      console.error('Apply material failed:', err)
    } finally {
      removeProcessingRegion(mask.id)
      setIsApplying(false)
    }
    return true
  }, [draggingMaterial, dimensions, masks, maskImages, originalImage, backendUrl, isApplying, batchMode, addBatchItem])

  // ── Click-to-select (normal mode) ────────────────────────────────────────
  const handleImageClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (editing) return
    if (!imageContainerRef.current || !dimensions.width) return
    const { x: imgX, y: imgY } = touchToImageCoords(e.clientX, e.clientY, imageContainerRef.current, dimensions.width, dimensions.height)
    const mask = getMaskAtPixel(imgX, imgY)
    setSelectedMaskId(mask?.id ?? null)
  }, [editing, dimensions])

  const handleOuterClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (editing) return
    if (!imageContainerRef.current?.contains(e.target as Node)) {
      setSelectedMaskId(null)
    }
  }, [editing])

  // ── Line editor pointer handlers ──────────────────────────────────────────
  // Helpers to convert clientXY → coords relative to imageContainerRef
  const clientToContainer = useCallback((cx: number, cy: number): Point => {
    const rect = imageContainerRef.current!.getBoundingClientRect()
    return { x: cx - rect.left, y: cy - rect.top }
  }, [])

  const HANDLE_RADIUS = 18 // px hit area for control points

  const handleLinePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!editing) return
    e.currentTarget.setPointerCapture(e.pointerId)
    const pt = clientToContainer(e.clientX, e.clientY)

    // Check control points first
    if (lineStart && lineEnd) {
      const distSq = (a: Point, b: Point) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2
      if (distSq(pt, lineStart) <= HANDLE_RADIUS ** 2) {
        lineDragRef.current = { kind: 'start' }
        return
      }
      if (distSq(pt, lineEnd) <= HANDLE_RADIUS ** 2) {
        lineDragRef.current = { kind: 'end' }
        return
      }

      // Check proximity to the line segment (within 16px)
      const dx = lineEnd.x - lineStart.x
      const dy = lineEnd.y - lineStart.y
      const len2 = dx * dx + dy * dy
      if (len2 > 0) {
        const t = Math.max(0, Math.min(1, ((pt.x - lineStart.x) * dx + (pt.y - lineStart.y) * dy) / len2))
        const closestX = lineStart.x + t * dx
        const closestY = lineStart.y + t * dy
        const dist2 = (pt.x - closestX) ** 2 + (pt.y - closestY) ** 2
        if (dist2 <= 16 ** 2) {
          lineDragRef.current = { kind: 'line', startBase: { ...lineStart }, endBase: { ...lineEnd }, pointerStart: pt }
          return
        }
      }
    }

    // Start a new line
    setLineStart(pt)
    setLineEnd(pt)
    lineDragRef.current = { kind: 'end' }
  }, [editing, lineStart, lineEnd, clientToContainer])

  const handleLinePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!editing || !lineDragRef.current) return
    const pt = clientToContainer(e.clientX, e.clientY)
    const target = lineDragRef.current

    if (target.kind === 'start') {
      setLineStart(pt)
    } else if (target.kind === 'end') {
      setLineEnd(pt)
    } else {
      const dx = pt.x - target.pointerStart.x
      const dy = pt.y - target.pointerStart.y
      setLineStart({ x: target.startBase.x + dx, y: target.startBase.y + dy })
      setLineEnd({ x: target.endBase.x + dx, y: target.endBase.y + dy })
    }
  }, [editing, clientToContainer])

  const handleLinePointerUp = useCallback(() => {
    lineDragRef.current = null
  }, [])

  const handleApply = useCallback(() => {
    if (!lineStart || !lineEnd || selectedMaskId === null) return
    const container = imageContainerRef.current
    if (!container) return

    // Convert display coords (px relative to container) → mask image coords
    const { width: dispW, height: dispH } = container.getBoundingClientRect()
    const scaleX = dimensions.width  / dispW
    const scaleY = dimensions.height / dispH

    const x1 = lineStart.x * scaleX
    const y1 = lineStart.y * scaleY
    const x2 = lineEnd.x   * scaleX
    const y2 = lineEnd.y   * scaleY

    const result = splitMaskByLine(selectedMaskId, x1, y1, x2, y2, masks)
    if (!result) {
      // Line didn't split the region — silently ignore
      return
    }

    // Save snapshot before the very first split
    if (!originalSnapshotRef.current) {
      originalSnapshotRef.current = { maskImages: [...maskImages], masks: [...masks] }
    }

    const { updatedMaskBase64, newMaskBase64, newMask } = result
    const updatedMasks = [...masks, newMask]

    if (maskImages.length > 0) {
      // B&W mask mode: update maskImages array
      const mi = masks.findIndex(m => m.id === selectedMaskId)
      const updatedMaskImages = [...maskImages]
      if (mi >= 0) updatedMaskImages[mi] = updatedMaskBase64
      updatedMaskImages.push(newMaskBase64)
      setMaskImages(updatedMaskImages, updatedMasks)
    } else {
      // Legacy color mask mode: just update masks list
      setMaskImages([], updatedMasks)
    }
    precomputeMaskOutlines(updatedMasks)

    // Exit editing mode, deselect
    setHasSplit(true)
    setEditing(false)
    setSelectedMaskId(null)
    setLineStart(null)
    setLineEnd(null)
  }, [lineStart, lineEnd, selectedMaskId, dimensions, masks, maskImages, setMaskImages])

  const isProcessing = processingRegions.size > 0

  return (
    <div className="fixed inset-0 bg-black flex flex-col">

      {/* ── Outer image area ─────────────────────────────────────────────── */}
      <div ref={outerRef} className="flex-1 relative overflow-hidden" onClick={handleOuterClick}>

        {!canvasReady && (
          <div className="absolute inset-0 bg-black flex items-center justify-center" style={{ zIndex: 50 }}>
            <div className="w-8 h-8 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
          </div>
        )}

        {/* Image box */}
        <div
          ref={imageContainerRef}
          className="absolute overflow-hidden"
          style={{
            left: imgBox.x, top: imgBox.y, width: imgBox.w, height: imgBox.h,
            cursor: editing ? 'crosshair' : (hoveredMaskId !== null ? 'pointer' : 'default'),
          }}
          onClick={handleImageClick}
        >
          <ImageCanvas ref={canvasRef} onReady={() => setCanvasReady(true)} />

          {/* Outline glow (selection) */}
          <canvas
            ref={overlayCanvasRef}
            className="absolute inset-0 w-full h-full pointer-events-none"
            style={{ zIndex: 10 }}
          />

          {/* Dim overlay (editing mode) */}
          <canvas
            ref={dimCanvasRef}
            className="absolute inset-0 w-full h-full pointer-events-none"
            style={{ zIndex: 15 }}
          />

          {/* Line editor canvas (editing mode, captures pointer events) */}
          {editing && (
            <canvas
              ref={lineCanvasRef}
              className="absolute inset-0 w-full h-full"
              style={{ zIndex: 25 }}
              onPointerDown={handleLinePointerDown}
              onPointerMove={handleLinePointerMove}
              onPointerUp={handleLinePointerUp}
              onPointerCancel={handleLinePointerUp}
            />
          )}
          {/* Line canvas kept in DOM but pointer-events off when not editing */}
          {!editing && (
            <canvas
              ref={lineCanvasRef}
              className="absolute inset-0 w-full h-full pointer-events-none"
              style={{ zIndex: 25 }}
            />
          )}

          {/* Debug overlays */}
          {debugFlags.showClean && (
            <img src={`${backendUrl}/debug-imgs/cleaned.png`}
              className="absolute inset-0 w-full h-full pointer-events-none"
              style={{ zIndex: 30, opacity: 0.55, objectFit: 'fill' }}
              crossOrigin="anonymous" alt="clean" />
          )}
          {debugFlags.showRawMask && (
            <img src={`${backendUrl}/debug-imgs/mask_raw.png`}
              className="absolute inset-0 w-full h-full pointer-events-none"
              style={{ zIndex: 30, opacity: 0.65, objectFit: 'fill' }}
              crossOrigin="anonymous" alt="raw mask" />
          )}
          {debugFlags.showRefinedMask && refinedMask && (
            <img src={`data:image/png;base64,${refinedMask}`}
              className="absolute inset-0 w-full h-full pointer-events-none"
              style={{ zIndex: 30, opacity: 0.65, objectFit: 'fill' }}
              alt="refined mask" />
          )}

          {/* Processing shimmer */}
          <canvas
            ref={processingCanvasRef}
            className="absolute inset-0 w-full h-full pointer-events-none"
            style={{ zIndex: 20 }}
          />

          {/* Batch mode material pins */}
          {batchMode && batchItems.map((item) => {
            const displayX = (item.imgX / dimensions.width) * imgBox.w
            const displayY = (item.imgY / dimensions.height) * imgBox.h
            return (
              <div
                key={item.id}
                className="absolute z-30 group"
                style={{
                  left: displayX - 20,
                  top: displayY - 20,
                  width: 40,
                  height: 40,
                }}
              >
                <img
                  src={`${backendUrl}/materials/${item.material.filename}`}
                  alt={item.material.name}
                  className="w-full h-full rounded-full object-cover border-2 border-white shadow-lg"
                  crossOrigin="anonymous"
                />
                <button
                  onClick={(e) => { e.stopPropagation(); removeBatchItem(item.id) }}
                  className="absolute -top-1 -right-1 w-4 h-4 rounded-full bg-red-500 text-white text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity"
                >
                  ×
                </button>
              </div>
            )
          })}
        </div>

        {/* Debug panel */}
        {false && <DebugPanel
          flags={debugFlags}
          onChange={setDebugFlags}
          prompts={debugPrompts}
          onPromptsChange={setDebugPrompts}
        />}

        {/* Hover debug HUD */}
        {debugFlags.hoverHighlight && (() => {
          const hm = hoveredMaskId !== null ? masks.find(m => m.id === hoveredMaskId) : null
          return (
            <div className="absolute top-3 right-3 z-50 bg-black/80 backdrop-blur-sm rounded-xl px-3 py-2 font-mono text-[11px] pointer-events-none min-w-[160px]">
              <p className="text-[9px] tracking-widest text-gray-500 uppercase mb-1.5">hover mask</p>
              {hm ? (
                <>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="w-3.5 h-3.5 rounded-sm flex-shrink-0 border border-white/20"
                      style={{ background: `rgb(${hm.color[0]},${hm.color[1]},${hm.color[2]})` }} />
                    <span className="text-white font-semibold">{hm.label}</span>
                  </div>
                  <p className="text-gray-400">id: {hm.id}</p>
                  <p className="text-gray-400">rgb({hm.color[0]}, {hm.color[1]}, {hm.color[2]})</p>
                </>
              ) : (
                <p className="text-gray-600">—</p>
              )}
            </div>
          )
        })()}

        {/* ── Normal mode buttons ──────────────────────────────────────── */}
        {!editing && (
          <>
            {/* Batch mode toggle (top-left) */}
            <div className="absolute top-4 left-4 z-40 flex items-center gap-2 bg-black/60 backdrop-blur-sm rounded-full px-3 py-1.5 border border-white/10">
              <span className="text-white text-xs">后端测试</span>
              <button
                onClick={() => setBatchMode(!batchMode)}
                className={`relative w-10 h-5 rounded-full transition-colors ${
                  batchMode ? 'bg-green-500' : 'bg-gray-600'
                }`}
              >
                <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                  batchMode ? 'translate-x-5' : ''
                }`} />
              </button>
            </div>

            {/* FAB 一键焕色 */}
            <button
              onClick={() => {
                if (batchMode && batchItems.length > 0) {
                  setPhase('finalizing')
                } else if (!batchMode) {
                  setPhase('finalizing')
                }
              }}
              disabled={isProcessing || (batchMode && batchItems.length === 0)}
              className={`absolute bottom-20 right-4 z-40 px-4 py-3 rounded-full font-bold text-white shadow-2xl transition-all ${
                isProcessing || (batchMode && batchItems.length === 0)
                  ? 'bg-gray-700 opacity-60 cursor-not-allowed'
                  : 'bg-gradient-to-r from-purple-600 to-blue-600 hover:scale-105 active:scale-95'
              }`}
            >
              一键焕色 {batchMode && batchItems.length > 0 ? `(${batchItems.length})` : ''}
            </button>

            {/* Edit button */}
            {selectedMaskId !== null && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  setEditing(true)
                  setLineStart(null)
                  setLineEnd(null)
                }}
                className="absolute bottom-20 left-4 z-40 flex items-center gap-2 px-4 py-3 rounded-full font-bold text-white shadow-2xl bg-white/15 backdrop-blur-sm border border-white/20 hover:bg-white/25 active:scale-95 transition-all"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                </svg>
                编辑
              </button>
            )}

            {/* Reset splits button — only shown after at least one split */}
            {hasSplit && (
              <button
                onClick={async (e) => {
                  e.stopPropagation()
                  const snap = originalSnapshotRef.current
                  if (!snap) return
                  await loadBWMasksIntoOffscreen(snap.maskImages, dimensions.width, dimensions.height)
                  setMaskImages(snap.maskImages, snap.masks)
                  precomputeMaskOutlines(snap.masks)
                  setHasSplit(false)
                  setSelectedMaskId(null)
                }}
                className={`absolute bottom-20 z-40 flex items-center gap-2 px-4 py-3 rounded-full font-bold text-white shadow-2xl bg-white/15 backdrop-blur-sm border border-white/20 hover:bg-white/25 active:scale-95 transition-all ${
                  selectedMaskId !== null ? 'left-36' : 'left-4'
                }`}
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
                恢复区域
              </button>
            )}
          </>
        )}

        {/* ── Editing mode: exit (top-left) ────────────────────────────── */}
        {editing && (
          <button
            onClick={(e) => { e.stopPropagation(); setEditing(false) }}
            className="absolute top-4 left-4 z-50 flex items-center gap-1.5 px-3 py-2 rounded-full text-sm text-white bg-black/50 backdrop-blur-sm border border-white/15 hover:bg-black/70 active:scale-95 transition-all"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            退出编辑
          </button>
        )}
      </div>

      {/* ── Editing mode bottom bar ───────────────────────────────────────── */}
      {editing ? (
        <div className="flex-none flex items-center justify-center gap-3 px-6 py-4 bg-gray-900/80 backdrop-blur-sm border-t border-white/[0.06]">
          <button
            onClick={handleApply}
            disabled={!lineStart || !lineEnd}
            className={`px-10 py-3 rounded-full font-bold text-white shadow-xl transition-all ${
              lineStart && lineEnd
                ? 'bg-gradient-to-r from-blue-500 to-cyan-500 hover:scale-105 active:scale-95'
                : 'bg-gray-700 opacity-50 cursor-not-allowed'
            }`}
          >
            应用
          </button>
        </div>
      ) : (
        /* ── Normal mode: material drawer ─────────────────────────────── */
        <MaterialDrawer
          open={drawerOpen}
          onToggle={() => setDrawerOpen(v => !v)}
          onDragStart={handleDragStart}
          onDragMove={handleDragMove}
          onDragEnd={handleDragEnd}
        />
      )}

      {draggingMaterial && <DragPreview x={dragPos.x} y={dragPos.y} />}
    </div>
  )
}
