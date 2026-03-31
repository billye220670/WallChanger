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
  refine:        'Image Editing Prompt\nTask: Remove black outlines and recolor\n\nREMOVE\nAll black outlines\nAll black boundary lines between color regions\nAll black borders, gaps, and separation lines\nFILL\nEvery color region fills completely to its edges\nNo black gaps between regions\nColors meet directly at sharp, clean edges\nCOLOR RULE ⚠️\nEach region = one flat solid color only\nNo gradients\nNo shading\nNo textures\nNo color blending\nLIGHTING\nUnlit scene\nNo highlights\nNo shadows\nNo light effects\nBOUNDARIES\nColor-to-color contact only\nHard edges between regions\nNo anti-aliasing bleed\nNo feathering',
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
