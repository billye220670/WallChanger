import { create } from 'zustand'
import type { AppState, MaskInfo, Material, Phase, DebugPrompts } from './types'
import { DEFAULT_PROMPTS } from './types'

interface AppStore extends AppState {
  setPhase: (phase: Phase) => void
  setOriginalImage: (image: string, width: number, height: number) => void
  setMasks: (enforcedResult: string, maskImages: string[], masks: MaskInfo[]) => void
  setMaskImages: (maskImages: string[], masks: MaskInfo[]) => void
  setProcessingStep: (step: 0 | 1 | 2 | 3 | 4) => void
  addProcessingRegion: (maskId: number) => void
  removeProcessingRegion: (maskId: number) => void
  setAppliedRegion: (maskId: number, image: string) => void
  setCompositeImage: (image: string) => void
  setFinalImage: (image: string) => void
  setDraggingMaterial: (material: Material | null) => void
  setHoveredMaskId: (id: number | null) => void
  setBackendUrl: (url: string) => void
  setDebugPrompts: (prompts: DebugPrompts) => void
  setDebugMode: (enabled: boolean) => void
  loadExample: (originalImage: string, width: number, height: number, refinedMask: string, rawMask: string, masks: MaskInfo[]) => void
  reset: () => void
}

const savedBackendUrl = localStorage.getItem('backendUrl') || 'http://localhost:8100'

function loadSavedPrompts(): DebugPrompts {
  try {
    const saved = localStorage.getItem('debugPrompts')
    if (saved) return { ...DEFAULT_PROMPTS, ...JSON.parse(saved) }
  } catch {}
  return { ...DEFAULT_PROMPTS }
}

const initialState: AppState = {
  phase: 'upload',
  originalImage: null,
  dimensions: { width: 0, height: 0 },
  refinedMask: null,
  rawMask: null,
  maskImages: [],
  masks: [],
  compositeImage: null,
  finalImage: null,
  processingStep: 0,
  processingRegions: new Set<number>(),
  appliedRegions: new Map<number, string>(),
  draggingMaterial: null,
  hoveredMaskId: null,
  backendUrl: savedBackendUrl,
  debugPrompts: loadSavedPrompts(),
  debugMode: localStorage.getItem('debugMode') === 'true',
}

export const useStore = create<AppStore>((set, get) => ({
  ...initialState,

  setPhase: (phase) => set({ phase }),

  setOriginalImage: (image, width, height) => set({
    originalImage: image,
    dimensions: { width, height },
    // Clear composite/final when a new image is set so stale results
    // don't cover the fresh canvas in ImageCanvas Effect 1.
    compositeImage: null,
    finalImage: null,
    appliedRegions: new Map<number, string>(),
  }),

  setMasks: (enforcedResult, maskImages, masks) => set((state) => ({
    originalImage: enforcedResult,
    maskImages,
    masks,
    refinedMask: null,
    rawMask: null,
    // Clear composite/final when masks are reset
    compositeImage: null,
    finalImage: null,
    appliedRegions: new Map<number, string>(),
    dimensions: state.dimensions,
  })),

  setMaskImages: (maskImages, masks) => set({ maskImages, masks }),

  setProcessingStep: (processingStep) => set({ processingStep }),

  addProcessingRegion: (maskId) => set((state) => {
    const updated = new Set(state.processingRegions)
    updated.add(maskId)
    return { processingRegions: updated }
  }),

  removeProcessingRegion: (maskId) => set((state) => {
    const updated = new Set(state.processingRegions)
    updated.delete(maskId)
    return { processingRegions: updated }
  }),

  setAppliedRegion: (maskId, image) => set((state) => {
    const updated = new Map(state.appliedRegions)
    updated.set(maskId, image)
    return { appliedRegions: updated }
  }),

  setCompositeImage: (compositeImage) => set({ compositeImage }),

  setFinalImage: (finalImage) => set({ finalImage }),

  setDraggingMaterial: (draggingMaterial) => set({ draggingMaterial }),

  setHoveredMaskId: (hoveredMaskId) => set({ hoveredMaskId }),

  setBackendUrl: (backendUrl) => {
    localStorage.setItem('backendUrl', backendUrl)
    set({ backendUrl })
  },

  setDebugPrompts: (debugPrompts) => {
    localStorage.setItem('debugPrompts', JSON.stringify(debugPrompts))
    set({ debugPrompts })
  },

  setDebugMode: (debugMode) => {
    localStorage.setItem('debugMode', String(debugMode))
    set({ debugMode })
  },

  loadExample: (originalImage, width, height, refinedMask, rawMask, masks) => set({
    originalImage,
    dimensions: { width, height },
    refinedMask,
    rawMask,
    maskImages: [],
    masks,
    compositeImage: null,
    finalImage: null,
    appliedRegions: new Map<number, string>(),
    processingRegions: new Set<number>(),
    processingStep: 4,
    phase: 'editing',
  }),

  reset: () => set({
    ...initialState,
    backendUrl: get().backendUrl,
    debugPrompts: get().debugPrompts,
    processingRegions: new Set<number>(),
    appliedRegions: new Map<number, string>(),
  }),
}))
