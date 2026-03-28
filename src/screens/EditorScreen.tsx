import { useRef, useState, useCallback, useEffect } from 'react'
import { useStore } from '../store'
import type { Material } from '../types'
import { ImageCanvas, type ImageCanvasHandle } from '../components/ImageCanvas'
import { MaterialDrawer } from '../components/MaterialDrawer'
import { DragPreview } from '../components/DragPreview'
import { DebugPanel, type DebugFlags } from '../components/DebugPanel'
import { applyMaterial as apiApplyMaterial, setBackendUrl } from '../utils/api'
import { getMaskAtPixel, compositeRegion, precomputeMaskOutlines, drawMaskOutline } from '../utils/canvas'
import { touchToImageCoords } from '../utils/coords'

export function EditorScreen() {
  const {
    masks,
    dimensions,
    processingRegions,
    hoveredMaskId,
    draggingMaterial,
    backendUrl,
    originalImage,
    refinedMask,
    debugPrompts,
    setDraggingMaterial,
    setHoveredMaskId,
    addProcessingRegion,
    removeProcessingRegion,
    setAppliedRegion,
    setCompositeImage,
    setPhase,
    setDebugPrompts,
  } = useStore()

  const canvasRef        = useRef<ImageCanvasHandle>(null)
  const outerRef         = useRef<HTMLDivElement>(null)   // full image area
  const imageContainerRef = useRef<HTMLDivElement>(null)  // contain-sized box ← all coord math uses this
  const overlayCanvasRef = useRef<HTMLCanvasElement>(null)

  const [drawerOpen, setDrawerOpen] = useState(false)
  const [dragPos, setDragPos]       = useState({ x: 0, y: 0 })
  const [canvasReady, setCanvasReady] = useState(false)
  const [debugFlags, setDebugFlags]  = useState<DebugFlags>({
    showClean: false, showRawMask: false, showRefinedMask: false, hoverHighlight: false,
  })

  // ── Contain-box sizing ────────────────────────────────────────────────────
  // Computes the largest axis-aligned rect that fits the image aspect ratio
  // within the outer container, keeping the canvas/overlays pixel-perfect.
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

  // ── Draw / clear outline overlay on hover change ──────────────────────────
  useEffect(() => {
    const overlay   = overlayCanvasRef.current
    const container = imageContainerRef.current
    if (!overlay || !container) return

    const { width: w, height: h } = container.getBoundingClientRect()
    overlay.width  = Math.round(w)
    overlay.height = Math.round(h)

    if (hoveredMaskId === null || (!draggingMaterial && !debugFlags.hoverHighlight)) {
      drawMaskOutline(null, overlay)
      return
    }
    drawMaskOutline(hoveredMaskId, overlay)
  }, [hoveredMaskId, draggingMaterial, debugFlags.hoverHighlight, canvasReady])

  // ── Hover highlight – mouse tracking when hoverHighlight debug flag is on ──
  useEffect(() => {
    const container = imageContainerRef.current
    if (!container || !debugFlags.hoverHighlight) {
      if (!debugFlags.hoverHighlight) setHoveredMaskId(null)
      return
    }

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
  }, [debugFlags.hoverHighlight, dimensions, masks])

  // ── Drag handlers ─────────────────────────────────────────────────────────
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
      setHoveredMaskId(null)
      return
    }

    const { x: imgX, y: imgY } = touchToImageCoords(x, y, imageContainerRef.current, dimensions.width, dimensions.height)
    const mask = getMaskAtPixel(imgX, imgY)
    setHoveredMaskId(mask?.id ?? null)
  }, [dimensions, masks])

  const handleDragEnd = useCallback(async (x: number, y: number) => {
    if (!draggingMaterial) { setDraggingMaterial(null); setHoveredMaskId(null); return }

    const material = draggingMaterial
    setDraggingMaterial(null)

    if (!imageContainerRef.current || !dimensions.width) { setHoveredMaskId(null); return }

    const rect = imageContainerRef.current.getBoundingClientRect()
    if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
      setHoveredMaskId(null); return
    }

    const { x: imgX, y: imgY } = touchToImageCoords(x, y, imageContainerRef.current, dimensions.width, dimensions.height)
    const mask = getMaskAtPixel(imgX, imgY)
    if (!mask) { setHoveredMaskId(null); return }

    setHoveredMaskId(null)
    console.log('[drag-debug] drop → mask:', mask.id, mask.label, '| mat:', material.name, '| color:', mask.color)
    // API call disabled for drag debugging
    // addProcessingRegion(mask.id)
    // try {
    //   const result = await apiApplyMaterial(originalImage!, material.filename)
    //   setAppliedRegion(mask.id, result.resultImage)
    //   const canvas = canvasRef.current?.getCanvas()
    //   if (canvas) {
    //     await compositeRegion(canvas, result.resultImage, mask.color, dimensions.width, dimensions.height)
    //     setCompositeImage(canvas.toDataURL('image/png').split(',')[1])
    //   }
    // } catch (err) {
    //   console.error('Apply material failed:', err)
    // } finally {
    //   removeProcessingRegion(mask.id)
    // }
  }, [draggingMaterial, dimensions, masks, originalImage])

  const isProcessing = processingRegions.size > 0

  return (
    <div className="fixed inset-0 bg-black flex flex-col">

      {/* ── Outer image area ─────────────────────────────────────────────── */}
      <div ref={outerRef} className="flex-1 relative overflow-hidden">

        {/* Loading overlay – covers outer area until canvas is drawn */}
        {!canvasReady && (
          <div className="absolute inset-0 bg-black flex items-center justify-center" style={{ zIndex: 50 }}>
            <div className="w-8 h-8 rounded-full border-2 border-blue-500 border-t-transparent animate-spin" />
          </div>
        )}

        {/* ── Contain-sized image box ─────────────────────────────────────
            All image layers live here. The box is pixel-perfect "object-contain"
            sized by the ResizeObserver above, so every layer shares the same
            coordinate space as the canvas.                                   */}
        <div
          ref={imageContainerRef}
          className="absolute overflow-hidden"
          style={{ left: imgBox.x, top: imgBox.y, width: imgBox.w, height: imgBox.h }}
        >
          {/* Base image canvas */}
          <ImageCanvas ref={canvasRef} onReady={() => setCanvasReady(true)} />

          {/* Outline highlight (edge glow on hover) */}
          <canvas
            ref={overlayCanvasRef}
            className="absolute inset-0 w-full h-full pointer-events-none"
            style={{ zIndex: 10 }}
          />

          {/* Debug overlays – all objectFit:fill to match canvas stretch */}
          {debugFlags.showClean && (
            <img
              src={`${backendUrl}/debug-imgs/cleaned.png`}
              className="absolute inset-0 w-full h-full pointer-events-none"
              style={{ zIndex: 30, opacity: 0.55, objectFit: 'fill' }}
              crossOrigin="anonymous"
              alt="clean"
            />
          )}
          {debugFlags.showRawMask && (
            <img
              src={`${backendUrl}/debug-imgs/mask_raw.png`}
              className="absolute inset-0 w-full h-full pointer-events-none"
              style={{ zIndex: 30, opacity: 0.65, objectFit: 'fill' }}
              crossOrigin="anonymous"
              alt="raw mask"
            />
          )}
          {debugFlags.showRefinedMask && refinedMask && (
            <img
              src={`data:image/png;base64,${refinedMask}`}
              className="absolute inset-0 w-full h-full pointer-events-none"
              style={{ zIndex: 30, opacity: 0.65, objectFit: 'fill' }}
              alt="refined mask"
            />
          )}

          {/* Shimmer while applying material */}
          {processingRegions.size > 0 && (
            <div className="absolute inset-0 pointer-events-none overflow-hidden" style={{ zIndex: 20 }}>
              <div className="absolute inset-0 shimmer-bg" />
            </div>
          )}
        </div>

        {/* Debug panel – top-left of outer area */}
        <DebugPanel
          flags={debugFlags}
          onChange={setDebugFlags}
          prompts={debugPrompts}
          onPromptsChange={setDebugPrompts}
        />

        {/* Hover debug HUD – top-right, only when hoverHighlight is on */}
        {debugFlags.hoverHighlight && (() => {
          const hm = hoveredMaskId !== null ? masks.find(m => m.id === hoveredMaskId) : null
          return (
            <div className="absolute top-3 right-3 z-50 bg-black/80 backdrop-blur-sm rounded-xl px-3 py-2 font-mono text-[11px] pointer-events-none min-w-[160px]">
              <p className="text-[9px] tracking-widest text-gray-500 uppercase mb-1.5">hover mask</p>
              {hm ? (
                <>
                  <div className="flex items-center gap-2 mb-1">
                    <span
                      className="w-3.5 h-3.5 rounded-sm flex-shrink-0 border border-white/20"
                      style={{ background: `rgb(${hm.color[0]},${hm.color[1]},${hm.color[2]})` }}
                    />
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

        {/* FAB – bottom-right of outer area */}
        <button
          onClick={() => setPhase('finalizing')}
          disabled={isProcessing}
          className={`absolute bottom-20 right-4 z-40 px-4 py-3 rounded-full font-bold text-white shadow-2xl transition-all ${
            isProcessing
              ? 'bg-gray-700 opacity-60 cursor-not-allowed'
              : 'bg-gradient-to-r from-purple-600 to-blue-600 hover:scale-105 active:scale-95'
          }`}
        >
          一键焕色
        </button>
      </div>

      {/* Material drawer */}
      <MaterialDrawer
        open={drawerOpen}
        onToggle={() => setDrawerOpen(v => !v)}
        onDragStart={handleDragStart}
        onDragMove={handleDragMove}
        onDragEnd={handleDragEnd}
      />

      {/* Drag preview – follows finger/cursor */}
      {draggingMaterial && <DragPreview x={dragPos.x} y={dragPos.y} />}
    </div>
  )
}
