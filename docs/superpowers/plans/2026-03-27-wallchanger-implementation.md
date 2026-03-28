# WallChanger — Implementation Plan
**Date:** 2026-03-27
**Spec:** `docs/superpowers/specs/2026-03-27-wallchanger-design.md`

---

## File Structure

```
WallChanger/
├── backend/
│   ├── main.py              # FastAPI server, all endpoints
│   ├── requirements.txt     # Python dependencies
│   ├── .env.example         # FAL_KEY template
│   └── start.bat            # Launch backend
├── src/
│   ├── main.tsx             # React entry point
│   ├── App.tsx              # Root component, phase router
│   ├── store.ts             # Zustand state
│   ├── screens/
│   │   ├── UploadScreen.tsx
│   │   ├── ProcessingScreen.tsx
│   │   ├── EditorScreen.tsx
│   │   ├── FinalizingScreen.tsx
│   │   └── ResultSheet.tsx
│   ├── components/
│   │   ├── MaterialDrawer.tsx
│   │   ├── MaterialTile.tsx
│   │   ├── DragPreview.tsx
│   │   ├── RegionHighlight.tsx
│   │   ├── SettingsDrawer.tsx
│   │   └── ImageCanvas.tsx
│   ├── utils/
│   │   ├── api.ts           # Backend API calls
│   │   ├── canvas.ts        # Compositing logic
│   │   └── coords.ts        # Touch → image coordinate mapping
│   └── types.ts             # TypeScript interfaces
├── public/
│   └── materials/           # User material images (empty initially)
├── index.html
├── package.json
├── vite.config.ts
├── tailwind.config.js
├── tsconfig.json
├── start.bat                # Launch both processes
└── README.md
```

---

## Implementation Order

### Phase 1: Backend Foundation
1. Backend scaffolding + health endpoint
2. SAM3 integration + /api/process-upload
3. Flux proxy + /api/apply-material
4. /api/finalize endpoint
5. /api/materials endpoint

### Phase 2: Frontend Foundation
6. Vite + React + Tailwind setup
7. Zustand store
8. API client utilities
9. Upload screen
10. Settings drawer

### Phase 3: Processing Pipeline
11. Processing screen with progress
12. Backend Step 1 pipeline integration

### Phase 4: Editor Core
13. Editor screen layout
14. Image canvas component
15. Material drawer + tiles
16. Drag interaction (long-press → preview → hover → drop)
17. Region highlighting
18. Compositing logic

### Phase 5: Finalization
19. Shimmer skeleton for processing regions
20. "一键焕色" button + finalizing screen
21. Result sheet with save

### Phase 6: Polish
22. Error handling + toasts
23. Loading states
24. start.bat launcher
25. README with setup instructions

---

## Task Breakdown

### Task 1: Backend scaffolding + health endpoint

**Files:**
- `backend/main.py`
- `backend/requirements.txt`
- `backend/.env.example`
- `backend/start.bat`

**Steps:**
1. Create `requirements.txt` with fastapi, uvicorn, python-dotenv, pillow, fal-client, scipy
2. Create `.env.example` with FAL_KEY, SAM3D_PATH, MATERIALS_PATH
3. Create `main.py` with FastAPI app, CORS middleware, health endpoint
4. Create `start.bat` to launch uvicorn

**Verification:** `curl http://localhost:8100/api/health` returns `{"status":"ok","model_loaded":false}`

---

### Task 2: SAM3 integration + model loading

**Files:**
- `backend/main.py` (add SAM3 imports and startup event)

**Steps:**
1. Add `sys.path.insert()` for SAM3D directory
2. Import `init_model, segment_image` from app
3. Add `@app.on_event("startup")` to call `init_model()`
4. Set `_model_loaded = True` on success

**Verification:** Health endpoint returns `model_loaded: true` after startup

---

### Task 3: Process upload endpoint (Step 1-1: Flux clean)

**Files:**
- `backend/main.py` (add Pydantic models, base64 helpers, Flux call)

**Steps:**
1. Add Pydantic request/response models
2. Add `base64_to_image()` and `image_to_base64()` helpers
3. Configure `fal_client` with API key from env
4. Implement `/api/process-upload` with Flux call: "remove all object, keep only hard finishes, keep structure unchanged."
5. Return cleaned image as base64 (temporary response, full pipeline in next tasks)

**Verification:** Upload image, receive cleaned version

---

### Task 4: Process upload Step 1-2 (SAM3 segmentation)

**Files:**
- `backend/main.py` (extend `/api/process-upload`)

**Steps:**
1. Call `segment_image()` on cleaned image with prompts `["wall", "floor", "ceiling", "window", "door"]`
2. Extract mask info (id, label, color) from result
3. Save mask image as PNG in memory

**Verification:** Response includes masks array with color info

---

### Task 5: Process upload Steps 1-3 & 1-4 (blur + refine)

**Files:**
- `backend/main.py` (complete pipeline)

**Steps:**
1. Apply Gaussian blur to mask using `PIL.ImageFilter.GaussianBlur(radius=3)`
2. Call Flux with blurred mask: "refine the mask, the connection between different color should have no gap"
3. Encode refined mask as PNG base64
4. Return complete response

**Verification:** Full pipeline produces refined mask + mask info

---

### Task 6: Apply material endpoint

**Files:**
- `backend/main.py` (add endpoint)

**Steps:**
1. Add Pydantic models for request/response
2. Implement `/api/apply-material`: decode original, load material from disk, upload both to fal.storage
3. Call Flux with both images
4. Download result, encode to base64, return

**Verification:** Send original + material filename, receive styled result

---

### Task 7: Finalize endpoint

**Files:**
- `backend/main.py` (add endpoint)

**Steps:**
1. Add Pydantic models
2. Implement `/api/finalize`: decode composite, apply Gaussian blur
3. Call Flux: "realistic render"
4. Return final image as base64

**Verification:** Send composite, receive rendered final image

---

### Task 8: Materials endpoint

**Files:**
- `backend/main.py` (add endpoint)

**Steps:**
1. Implement `/api/materials`: read files from `MATERIALS_PATH`
2. Filter by extensions (.jpg, .png, .webp)
3. Return array of `{name, filename, url}`

**Verification:** GET returns list of available materials

---

### Task 9: Frontend scaffolding

**Files:**
- `package.json`
- `vite.config.ts`
- `tsconfig.json`
- `tailwind.config.js`
- `index.html`
- `src/main.tsx`
- `src/App.tsx`

**Steps:**
1. Run `npm create vite@latest . -- --template react-ts`
2. Install dependencies: `react`, `react-dom`, `zustand`, `tailwindcss`
3. Configure Tailwind
4. Create minimal App.tsx with "WallChanger" text

**Verification:** `npm run dev` shows app at localhost:5173

---

### Task 10: Zustand store

**Files:**
- `src/store.ts`
- `src/types.ts`

**Steps:**
1. Define TypeScript interfaces in `types.ts`
2. Create Zustand store with initial state
3. Add actions: `setPhase`, `setOriginalImage`, `setMasks`, etc.
4. Add localStorage sync for `backendUrl`

**Verification:** Import store in App.tsx, log state

---

### Task 11: API client utilities

**Files:**
- `src/utils/api.ts`

**Steps:**
1. Create functions: `processUpload()`, `applyMaterial()`, `finalize()`, `getMaterials()`, `checkHealth()`
2. Use `fetch()` with store's `backendUrl`
3. Handle JSON serialization

**Verification:** Call `checkHealth()` from console, verify response

---

### Task 12: Upload screen

**Files:**
- `src/screens/UploadScreen.tsx`

**Steps:**
1. Create full-screen drop zone with file input
2. Add camera/gallery button (mobile-friendly)
3. On file select: read as base64, call `setOriginalImage()`, transition to `processing` phase
4. Add gear icon → opens settings drawer

**Verification:** Upload image, state updates, phase changes

---

### Task 13: Settings drawer

**Files:**
- `src/components/SettingsDrawer.tsx`

**Steps:**
1. Create slide-in drawer component
2. Add input for backend URL with localStorage persistence
3. Add "Test Connection" button that calls `/api/health`
4. Show connection status indicator

**Verification:** Change URL, reload page, URL persists

---

### Task 14: Processing screen

**Files:**
- `src/screens/ProcessingScreen.tsx`

**Steps:**
1. Display original image (dimmed with overlay)
2. Show 4-step progress indicator with labels
3. Call `processUpload()` on mount
4. Update `processingStep` state as backend progresses (mock for now, real progress in later task)
5. On completion: store masks, transition to `editing` phase

**Verification:** Upload triggers processing, completes, moves to editor

---

### Task 15: Editor screen layout

**Files:**
- `src/screens/EditorScreen.tsx`

**Steps:**
1. Full-screen layout with image display area
2. Add bottom drawer handle (collapsed by default)
3. Add "一键焕色" FAB button (bottom-right)
4. Render original image initially

**Verification:** Screen shows image with drawer handle and FAB

---

### Task 16: Material drawer + tiles

**Files:**
- `src/components/MaterialDrawer.tsx`
- `src/components/MaterialTile.tsx`

**Steps:**
1. Create drawer that slides up from bottom
2. Fetch materials from `/api/materials` on mount
3. Display as 2-column grid
4. Each tile shows material image thumbnail

**Verification:** Tap handle, drawer opens with material grid

---

### Task 17: Image canvas component

**Files:**
- `src/components/ImageCanvas.tsx`
- `src/utils/canvas.ts`

**Steps:**
1. Create canvas component that renders current composite
2. Add offscreen canvas for mask sampling
3. Implement `sampleMaskAt(x, y)` utility
4. Load refined mask into offscreen canvas

**Verification:** Canvas displays image, can sample mask colors

---

### Task 18: Drag interaction - long-press

**Files:**
- `src/components/MaterialTile.tsx`
- `src/store.ts` (add drag state)

**Steps:**
1. Add `onTouchStart` with 300ms timer
2. On timer complete: set `draggingMaterial` in store, show lift animation
3. Create floating preview that follows touch
4. Add `onTouchEnd` to clear drag state

**Verification:** Long-press tile, preview appears and follows finger

---

### Task 19: Drag interaction - hover highlight

**Files:**
- `src/components/RegionHighlight.tsx`
- `src/utils/coords.ts`

**Steps:**
1. Create coordinate mapping utility
2. On `onTouchMove` over image: map touch to image coords, sample mask
3. Find matching MaskInfo by RGB color
4. Set `hoveredMaskId` in store
5. Render highlight overlay with mask color

**Verification:** Drag over image, regions highlight

---

### Task 20: Drag interaction - drop & apply

**Files:**
- `src/screens/EditorScreen.tsx`

**Steps:**
1. On `onTouchEnd` over image: check if valid region
2. Call `applyMaterial()` with original image + material filename
3. Add mask ID to `processingRegions`
4. On response: store result in `appliedRegions`, remove from processing

**Verification:** Drop material, region processes, result appears

---

### Task 21: Compositing logic

**Files:**
- `src/utils/canvas.ts`

**Steps:**
1. Implement `compositeRegion(original, result, mask, targetColor)`
2. Use `getImageData()` to read pixels
3. For each pixel: if mask matches target color, use result pixel
4. Use `putImageData()` to write composite
5. Update store's `compositeImage`

**Verification:** Multiple regions composite correctly

---

### Task 22: Shimmer skeleton

**Files:**
- `src/components/RegionHighlight.tsx` (add shimmer variant)
- CSS for shimmer animation

**Steps:**
1. Add shimmer CSS animation (gradient sweep)
2. Render shimmer overlay for regions in `processingRegions`
3. Position over region bounds

**Verification:** Processing regions show animated shimmer

---

### Task 23: Finalize button + screen

**Files:**
- `src/screens/EditorScreen.tsx` (FAB handler)
- `src/screens/FinalizingScreen.tsx`

**Steps:**
1. On FAB click: export canvas to base64, call `finalize()`
2. Transition to `finalizing` phase
3. Show dimmed screen with ring spinner + "正在魔法渲染..." text
4. Add particle animation (CSS)
5. On response: store final image, transition to `done` phase

**Verification:** Click FAB, finalizing screen appears, completes

---

### Task 24: Result sheet

**Files:**
- `src/screens/ResultSheet.tsx`

**Steps:**
1. Bottom sheet slides up with final image
2. "保存图片" button: create blob, trigger download
3. "继续编辑" button: transition back to `editing` phase

**Verification:** Sheet shows final image, save downloads file

---

### Task 25: Error handling

**Files:**
- All API calls in `src/utils/api.ts`
- Toast notification component

**Steps:**
1. Wrap API calls in try-catch
2. Create simple toast component
3. Show error messages for failed requests
4. Handle SAM3 not loaded state

**Verification:** Simulate errors, toasts appear

---

### Task 26: Root launcher

**Files:**
- `start.bat` (root)

**Steps:**
1. Create batch file that launches backend and frontend in parallel
2. Use `start` command for separate windows

**Verification:** Double-click starts both processes

---

### Task 27: README

**Files:**
- `README.md`

**Steps:**
1. Document setup: install dependencies, create .env
2. Document usage: start.bat, phone access
3. Document material library setup

**Verification:** Follow README from scratch, app works

---
