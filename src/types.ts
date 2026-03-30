export interface MaskInfo {
  id: number
  label: string
  color: [number, number, number]
}

export interface Material {
  name: string
  filename: string
  url: string
}

export type Phase = 'upload' | 'processing' | 'editing' | 'finalizing' | 'done'

export interface DebugPrompts {
  enhance: string
  clean: string
  refine: string
  applyMaterial: string
  finalize: string
}

export const DEFAULT_PROMPTS: DebugPrompts = {
  enhance:       'Realistic render',
  clean:         'empty room',
  refine:        'Remove all black outlines and black boundary lines between color regions. Make each colored area fill seamlessly to their edges without any black gaps, borders, or outlines. The result should have clean, sharp color boundaries where colors meet directly with no black separation lines.',
  applyMaterial: 'based on image 2, change all wall material in image 1.',
  finalize:      'realistic render',
}

export interface AppState {
  phase: Phase

  // Images
  originalImage: string | null
  dimensions: { width: number; height: number }
  refinedMask: string | null
  rawMask: string | null
  masks: MaskInfo[]
  compositeImage: string | null
  finalImage: string | null

  // Processing
  processingStep: 0 | 1 | 2 | 3 | 4
  processingRegions: Set<number>
  appliedRegions: Map<number, string>

  // Drag state
  draggingMaterial: Material | null
  hoveredMaskId: number | null

  // Config
  backendUrl: string
  debugPrompts: DebugPrompts
}
