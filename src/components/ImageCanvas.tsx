import { useEffect, useRef, forwardRef, useImperativeHandle } from 'react'
import { useStore } from '../store'
import { initOffscreenCanvas, loadMaskIntoOffscreen } from '../utils/canvas'

export interface ImageCanvasHandle {
  getCanvas: () => HTMLCanvasElement | null
  exportBase64: () => string | null
}

interface ImageCanvasProps {
  onReady: () => void
}

export const ImageCanvas = forwardRef<ImageCanvasHandle, ImageCanvasProps>(
  function ImageCanvas({ onReady }, ref) {
    const canvasRef = useRef<HTMLCanvasElement>(null)
    const { originalImage, rawMask, compositeImage, dimensions } = useStore()

    // Keep a ref to compositeImage so Effect 1 can read the latest value
    // without needing it in the dependency array (avoids re-running mask init)
    const compositeImageRef = useRef(compositeImage)
    useEffect(() => { compositeImageRef.current = compositeImage }, [compositeImage])

    useImperativeHandle(ref, () => ({
      getCanvas: () => canvasRef.current,
      exportBase64: () => {
        if (!canvasRef.current) return null
        return canvasRef.current.toDataURL('image/png').split(',')[1]
      }
    }))

    useEffect(() => {
      if (!originalImage || !canvasRef.current) return

      const canvas = canvasRef.current
      const ctx = canvas.getContext('2d')!
      const { width, height } = dimensions

      canvas.width = width
      canvas.height = height

      const img = new Image()
      img.onload = async () => {
        ctx.drawImage(img, 0, 0, width, height)
        initOffscreenCanvas(width, height)
        if (rawMask) {
          await loadMaskIntoOffscreen(rawMask)
        }
        // If a composite already exists (e.g. Effect 1 re-ran after compositing),
        // restore it on top so the enhanced image doesn't cover the applied material.
        const existing = compositeImageRef.current
        if (existing) {
          await new Promise<void>(resolve => {
            const compImg = new Image()
            compImg.onload = () => { ctx.drawImage(compImg, 0, 0, width, height); resolve() }
            compImg.onerror = () => resolve()
            compImg.src = `data:image/png;base64,${existing}`
          })
        }
        onReady()
      }
      img.src = `data:image/jpeg;base64,${originalImage}`
    }, [originalImage, rawMask])

    useEffect(() => {
      if (!compositeImage || !canvasRef.current) return
      const canvas = canvasRef.current
      const ctx = canvas.getContext('2d')!
      const img = new Image()
      img.onload = () => ctx.drawImage(img, 0, 0, dimensions.width, dimensions.height)
      img.src = `data:image/png;base64,${compositeImage}`
    }, [compositeImage])

    return (
      <canvas
        ref={canvasRef}
        className="w-full h-full object-contain"
        style={{ imageRendering: 'auto' }}
      />
    )
  }
)
