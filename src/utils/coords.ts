/**
 * Maps a touch/click position on the displayed image to
 * the actual pixel coordinates in the original image.
 */
export function touchToImageCoords(
  touchX: number,
  touchY: number,
  imageElement: HTMLElement,
  originalWidth: number,
  originalHeight: number
): { x: number; y: number } {
  const rect = imageElement.getBoundingClientRect()
  const displayedWidth = rect.width
  const displayedHeight = rect.height

  const relX = touchX - rect.left
  const relY = touchY - rect.top

  const imageX = (relX / displayedWidth) * originalWidth
  const imageY = (relY / displayedHeight) * originalHeight

  return { x: Math.max(0, Math.min(originalWidth, imageX)), y: Math.max(0, Math.min(originalHeight, imageY)) }
}
