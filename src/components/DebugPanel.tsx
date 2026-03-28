import { useState } from 'react'
import type { DebugPrompts } from '../types'
import { DEFAULT_PROMPTS } from '../types'

export interface DebugFlags {
  showClean: boolean
  showRawMask: boolean
  showRefinedMask: boolean
  hoverHighlight: boolean
  hoverFill: boolean
}

interface DebugPanelProps {
  flags: DebugFlags
  onChange: (flags: DebugFlags) => void
  prompts: DebugPrompts
  onPromptsChange: (prompts: DebugPrompts) => void
}

const FLAG_OPTIONS: { key: keyof DebugFlags; label: string }[] = [
  { key: 'showClean',       label: 'show clean' },
  { key: 'showRawMask',     label: 'show raw mask' },
  { key: 'showRefinedMask', label: 'show refined mask' },
  { key: 'hoverHighlight',  label: 'hover highlight' },
  { key: 'hoverFill',       label: 'hover fill' },
]

const PROMPT_FIELDS: { key: keyof DebugPrompts; label: string }[] = [
  { key: 'enhance',       label: '增强原图' },
  { key: 'clean',         label: '清理场景' },
  { key: 'refine',        label: '精炼蒙版' },
  { key: 'applyMaterial', label: '应用材质' },
  { key: 'finalize',      label: '最终渲染' },
]

export function DebugPanel({ flags, onChange, prompts, onPromptsChange }: DebugPanelProps) {
  const [promptsOpen, setPromptsOpen] = useState(false)

  return (
    <div className="absolute top-3 left-3 z-50 bg-black/80 backdrop-blur-sm rounded-xl px-3 py-2.5 font-mono pointer-events-auto select-none max-w-[260px]">
      <p className="text-[9px] tracking-widest text-gray-500 uppercase mb-1.5">debug</p>

      {/* Overlay toggles */}
      <div className="flex flex-col gap-1 mb-2">
        {FLAG_OPTIONS.map(({ key, label }) => (
          <label key={key} className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={flags[key]}
              onChange={(e) => onChange({ ...flags, [key]: e.target.checked })}
              className="accent-cyan-400 w-3 h-3"
            />
            <span className="text-[11px] text-gray-300">{label}</span>
          </label>
        ))}
      </div>

      {/* Prompts section */}
      <button
        onClick={() => setPromptsOpen(v => !v)}
        className="flex items-center gap-1 text-[10px] text-gray-400 hover:text-gray-200 w-full text-left mb-1"
      >
        <span>{promptsOpen ? '▼' : '▶'}</span>
        <span className="tracking-widest uppercase">prompts</span>
      </button>

      {promptsOpen && (
        <div className="flex flex-col gap-2 pt-1 border-t border-gray-700/50">
          {PROMPT_FIELDS.map(({ key, label }) => (
            <div key={key} className="flex flex-col gap-0.5">
              <span className="text-[9px] text-gray-500 uppercase tracking-wider">{label}</span>
              <textarea
                value={prompts[key]}
                onChange={(e) => onPromptsChange({ ...prompts, [key]: e.target.value })}
                rows={2}
                className="w-full bg-gray-900 border border-gray-700 rounded px-1.5 py-1 text-[10px] text-gray-200 resize-none focus:outline-none focus:border-cyan-600"
              />
            </div>
          ))}
          <button
            onClick={() => onPromptsChange({ ...DEFAULT_PROMPTS })}
            className="text-[9px] text-gray-600 hover:text-red-400 text-left mt-0.5"
          >
            reset to defaults
          </button>
        </div>
      )}
    </div>
  )
}
