# WallChanger — Design Spec
**Date:** 2026-03-27
**Status:** Approved

---

## 1. Overview

A local-first mobile webapp that lets users upload an interior photo, drag materials from a library onto wall regions, and receive an AI-rendered result. Runs entirely on the user's PC; phone connects via local WiFi.

**Key integrations:**
- **SAM3** — local GPU model for semantic segmentation (imported directly via Python)
- **Flux Klein 4B** (`fal-ai/flux-2/klein/4b/edit/lora`) — cloud AI for image editing via `fal-client`
- No cloud deployment; no Vercel

---

## 2. Architecture

Two processes, launched via `start.bat`:

```
WallChanger/
├── backend/               # Python FastAPI — port 8100
│   ├── main.py
│   ├── requirements.txt
│   └── start.bat
├── src/                   # Vite + React + TypeScript + Tailwind
├── public/
│   └── materials/         # User-supplied 512×512 material images (jpg/png/webp)
├── index.html
├── package.json
├── vite.config.ts
└── start.bat              # Launches both processes
```

**Backend** (`0.0.0.0:8100`):
- Imports SAM3 directly: `sys.path.insert(0, "C:/Users/Tintt/Documents/SAM3D")` → `from app import init_model, segment_image`
- Proxies Flux API (FAL_KEY in `.env`, never exposed to browser)
- Applies Gaussian blur via PIL
- CORS open (`*`) for local network access

**Frontend** (`:5173` in dev):
- Configurable backend URL stored in `localStorage` (default `http://localhost:8100`)
- Settings screen (gear icon) to change PC's local IP for phone access
- All images transferred as base64 strings

---

## 3. Processing Pipeline

### Step 1 — Background (triggered on upload)

| Sub-step | Action |
|---|---|
| 1-1 | Flux: `"remove all object, keep only hard finishes, keep structure unchanged."` — input: original image |
| 1-2 | SAM3: `segment_image()` on 1-1 result — prompts: `["wall", "floor", "ceiling", "window", "door"]`, confidence: `0.3` |
| 1-3 | PIL Gaussian blur on SAM3 mask — `radius=3` |
| 1-4 | Flux: `"refine the mask, the connection between different color should have no gap"` — input: blurred mask |

All image sizes passed as `{ width, height }` to Flux to preserve original dimensions.
Returns: `{ refinedMask: base64 (PNG format), masks: MaskInfo[], originalDimensions }` to frontend.

**Note:** Refined mask must be PNG to preserve exact RGB values for compositing.

### Step 2 — Per region (triggered on material drop)

1. Frontend sends: original image base64 + material filename + target mask color
2. Backend reads material from `public/materials/{filename}`, uploads both to `fal.storage`, calls Flux:
   prompt: `"based on image 2, change all wall material in image 1."`,
   `image_urls: [original_url, material_url]`
3. Returns: result image base64
4. Frontend composites result onto running canvas using mask color matching

### Step 3 — Finalize (triggered by "一键焕色" button)

1. Frontend sends current composite image (canvas export) to backend
2. Backend: PIL Gaussian blur (`radius=3`)
3. Backend: Flux `"realistic render"` on blurred composite
4. Returns: final image base64
5. Frontend shows result in bottom sheet with save option

---

## 4. Backend Endpoints

| Method | Path | Input | Output |
|---|---|---|---|
| `GET` | `/api/health` | — | `{ status, model_loaded }` |
| `GET` | `/api/materials` | — | `[{ name, url, filename }]` |
| `POST` | `/api/process-upload` | `{ image: base64, width, height }` | `{ refinedMask: base64, masks: MaskInfo[], width, height }` |
| `POST` | `/api/apply-material` | `{ originalImage: base64, materialFilename: string, width, height }` | `{ resultImage: base64 }` |
| `POST` | `/api/finalize` | `{ compositeImage: base64, width, height }` | `{ finalImage: base64 }` |

**MaskInfo:** `{ id: int, label: str, color: [r, g, b] }`

---

## 5. Frontend Screens

### 5.1 Upload Screen
- Full-screen drop zone with camera/gallery upload button
- Shows app title and brief instruction
- Gear icon top-right → Settings drawer (backend URL input)

### 5.2 Processing Screen
- Displays original image (dimmed)
- Step progress indicator: 4 steps with labels and spinners
- Cannot interact until complete

### 5.3 Editor Screen (main)
- Full-screen image display with canvas overlay
- **Bottom drawer handle** → tap to expand material grid (2-column, scrollable)
- **"一键焕色" FAB** — bottom-right corner, disabled while any region is processing
- Region highlight: colored border + semi-transparent fill matching mask color, shown when drag hovers
- Shimmer skeleton (CSS animation) over processing regions

### 5.4 Finalizing Screen
- Screen dims to 70% opacity, non-interactive
- Centered ring spinner + "正在魔法渲染..." label
- Brief particle/sparkle CSS animation on entry

### 5.5 Result Sheet
- Bottom sheet slides up with final image
- "保存图片" button — uses Canvas `toBlob()` + `<a download>` trick
- "继续编辑" button — closes sheet, returns to Editor

---

## 6. Drag Interaction

1. **Long-press** (~300ms) on material tile → tile scales up ("lifted"), floating preview appears under finger
2. Finger dragged toward image → floating preview follows
3. **On image hover**: offscreen canvas samples refined mask pixel at mapped image coordinates → find matching MaskInfo by RGB → draw highlight overlay
4. **On release over image**: trigger `POST /api/apply-material`, show shimmer on that region
5. **On release outside image**: cancel drag, no API call
6. If region already has a result, it is overwritten

**Coordinate mapping:**
```
imageX = touchX / displayedImageWidth  * originalWidth
imageY = touchY / displayedImageHeight * originalHeight
```

---

## 7. Compositing (Frontend Canvas)

After each `apply-material` result arrives:

```
for each pixel (x, y):
  maskColor = sampleMask(refinedMask, x, y)        // offscreen canvas
  if maskColor == targetRegionColor:
    composite[x,y] = resultImage[x,y]
  else:
    composite[x,y] = previousComposite[x,y]        // or original on first apply
```

Done via `getImageData()` / `putImageData()` on hidden `<canvas>`.
The running composite is what gets sent to `/api/finalize`.

---

## 8. State (Zustand)

```typescript
interface AppState {
  phase: 'upload' | 'processing' | 'editing' | 'finalizing' | 'done'

  // Images
  originalImage: string | null        // base64
  dimensions: { width: number; height: number }
  refinedMask: string | null          // base64 — refined colored mask
  masks: MaskInfo[]                   // from SAM3
  compositeImage: string | null       // running canvas composite
  finalImage: string | null

  // Processing
  processingStep: 0 | 1 | 2 | 3 | 4  // for step 1 progress display
  processingRegions: Set<number>       // mask IDs currently loading
  appliedRegions: Map<number, string>  // maskId → result image base64

  // Drag state
  draggingMaterial: Material | null
  hoveredMaskId: number | null

  // Config
  backendUrl: string                  // from localStorage
}
```

---

## 9. Material Library

- Folder: `public/materials/`
- User places 512×512 images here (jpg/png/webp)
- Backend `/api/materials` reads the folder and returns file list
- Frontend displays as a 2-column grid in the drawer
- Material object: `{ name: string (filename without ext), filename: string, url: string }`

---

## 10. Error Handling

- **SAM3 not loaded**: `/api/health` returns `model_loaded: false` → frontend shows "SAM3 正在加载，请稍候" banner
- **Flux API error**: backend returns `{ error: string }` → frontend shows toast notification, region returns to previous state
- **Upload too large**: backend rejects images over 20MB with 413 response
- **No mask found at drop point**: if mask pixel is black (no region), show brief "未识别到区域" toast, cancel drop

---

## 11. Tech Stack

| Layer | Choice |
|---|---|
| Frontend framework | Vite + React 18 + TypeScript |
| Styling | Tailwind CSS v3 |
| State | Zustand |
| Backend | Python FastAPI + uvicorn |
| Image processing | PIL (Pillow) |
| Flux client | `fal-client` (Python) |
| SAM3 | Direct Python import from `C:/Users/Tintt/Documents/SAM3D/app.py` |

---

## 12. Development Setup

```
# Terminal 1 — backend
cd backend
pip install -r requirements.txt
python main.py

# Terminal 2 — frontend
npm install
npm run dev
```

Or double-click `start.bat` to launch both.

Phone access: open Settings in app → enter PC's local IP (e.g. `http://192.168.1.x:8100`).
