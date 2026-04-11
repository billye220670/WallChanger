import type { MaskInfo, Material } from '../types'

let backendUrl = 'http://localhost:8100'

export function setBackendUrl(url: string) {
  backendUrl = url
}

export async function checkHealth(): Promise<{ status: string; model_loaded: boolean }> {
  const resp = await fetch(`${backendUrl}/health`)
  if (!resp.ok) throw new Error(`Health check failed: ${resp.status}`)
  return resp.json()
}

export async function getMaterials(): Promise<Material[]> {
  const resp = await fetch(`${backendUrl}/api/materials`)
  if (!resp.ok) throw new Error(`Failed to fetch materials: ${resp.status}`)
  return resp.json()
}

export async function preprocessImage(
  image: string,
): Promise<{ enforcedResult: string; masks: string[] }> {
  const resp = await fetch(`${backendUrl}/api/v2/preprocess`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image }),
  })
  if (!resp.ok) {
    const text = await resp.text()
    console.error('[preprocess] error response:', resp.status, text)
    throw new Error(`Preprocess failed: ${resp.status} — ${text}`)
  }
  const data = await resp.json()
  console.log('[preprocess] success: masks count =', data.masks?.length)
  return data
}

export async function enhanceImage(
  image: string,
  width: number,
  height: number,
  promptEnhance?: string
): Promise<{ enhancedImage: string }> {
  const resp = await fetch(`${backendUrl}/enhance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image, width, height, promptEnhance }),
  })
  if (!resp.ok) throw new Error(`Enhance failed: ${resp.status}`)
  return resp.json()
}

export async function processMasks(
  enhancedImage: string,
  promptClean?: string,
  promptRefine?: string,
): Promise<{ refinedMask: string; rawMask: string; masks: MaskInfo[] }> {
  const resp = await fetch(`${backendUrl}/process-masks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enhancedImage, promptClean, promptRefine }),
  })
  if (!resp.ok) {
    const text = await resp.text()
    console.error('[process-masks] error response:', resp.status, text)
    throw new Error(`Process masks failed: ${resp.status} — ${text}`)
  }
  const data = await resp.json()
  console.log('[process-masks] success:', { masksCount: data.masks?.length, masks: data.masks })
  return data
}

export async function processUpload(
  image: string,
  width: number,
  height: number
): Promise<{ enhancedImage: string; refinedMask: string; masks: MaskInfo[]; width: number; height: number }> {
  const resp = await fetch(`${backendUrl}/process-upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image, width, height }),
  })
  if (!resp.ok) throw new Error(`Process upload failed: ${resp.status}`)
  return resp.json()
}

export async function debugSegment(
  image: string,
): Promise<{ refinedMask: string; rawMask: string; masks: MaskInfo[] }> {
  const resp = await fetch(`${backendUrl}/debug-segment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image }),
  })
  if (!resp.ok) {
    const text = await resp.text()
    console.error('[debug-segment] error response:', resp.status, text)
    throw new Error(`Debug segment failed: ${resp.status} — ${text}`)
  }
  const data = await resp.json()
  console.log('[debug-segment] success:', { masksCount: data.masks?.length, masks: data.masks })
  return data
}

export async function renderAll(
  enforcedImage: string,
  masks: string[],
  items: Array<{ x: number; y: number; materialImage: string; prompt?: string }>
): Promise<{ finalImage: string }> {
  const resp = await fetch(`${backendUrl}/api/v2/render-all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enforcedImage, masks, items }),
  })
  if (!resp.ok) {
    const text = await resp.text()
    console.error('[render-all] error response:', resp.status, text)
    throw new Error(`Render-all failed: ${resp.status} — ${text}`)
  }
  return resp.json()
}

export async function renderRegion(
  enforcedImage: string,
  maskImage: string,
  materialImage: string,
): Promise<{ resultImage: string }> {
  const resp = await fetch(`${backendUrl}/api/v2/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enforcedImage, maskImage, materialImage }),
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Apply material failed: ${resp.status} — ${text}`)
  }
  return resp.json()
}

export async function finalizeV2(
  compositeImage: string,
): Promise<{ finalImage: string }> {
  const resp = await fetch(`${backendUrl}/api/v2/finalize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ compositeImage }),
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(`Finalize failed: ${resp.status} — ${text}`)
  }
  return resp.json()
}

export async function applyMaterial(
  originalImage: string,
  materialFilename: string,
  promptApplyMaterial?: string,
): Promise<{ resultImage: string }> {
  const resp = await fetch(`${backendUrl}/apply-material`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ originalImage, materialFilename, promptApplyMaterial }),
  })
  if (!resp.ok) throw new Error(`Apply material failed: ${resp.status}`)
  return resp.json()
}

export async function finalize(
  compositeImage: string,
  promptFinalize?: string,
): Promise<{ finalImage: string }> {
  const resp = await fetch(`${backendUrl}/finalize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ compositeImage, promptFinalize }),
  })
  if (!resp.ok) throw new Error(`Finalize failed: ${resp.status}`)
  return resp.json()
}
