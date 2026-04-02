import os
import sys
import asyncio
import base64
import io
import numpy as np
from pathlib import Path
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
from PIL import Image, ImageFilter, ImageOps
from dotenv import load_dotenv
import httpx

load_dotenv()

# ── SAM3 remote API ──────────────────────────────────────────────────────────
SAM3_API = os.getenv("SAM3_API", "https://sh-llm-api.tinttex.cn:8443/sam3/segment")

# ── Flux2 Klein API ──────────────────────────────────────────────────────────
FLUX2_API = os.getenv("FLUX2_API", "https://sh-llm-api.tinttex.cn:8443/flux2-klein/edit-multi")

# ── Materials path ───────────────────────────────────────────────────────────
# Relative to this file's directory (backend/) → ../public/materials
_materials_rel = os.getenv("MATERIALS_PATH", "../public/materials")
MATERIALS_DIR = (Path(__file__).parent / _materials_rel).resolve()
MATERIALS_DIR.mkdir(parents=True, exist_ok=True)

# ── App ───────────────────────────────────────────────────────────────────────
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve material images so the frontend can show thumbnails
app.mount("/materials", StaticFiles(directory=str(MATERIALS_DIR)), name="materials")

# ── Debug images path ─────────────────────────────────────────────────────────
# Exposes backend/debug/ as /debug-imgs so the frontend debug panel can load them
DEBUG_DIR = (Path(__file__).parent / "debug").resolve()
DEBUG_DIR.mkdir(parents=True, exist_ok=True)
app.mount("/debug-imgs", StaticFiles(directory=str(DEBUG_DIR)), name="debug_imgs")

# ── Model loading ─────────────────────────────────────────────────────────────
_model_loaded = True  # Remote API, always ready


# ── Helpers ───────────────────────────────────────────────────────────────────

def base64_to_image(b64: str) -> Image.Image:
    """Accept raw base64 or data URI."""
    if "," in b64:
        b64 = b64.split(",", 1)[1]
    return Image.open(io.BytesIO(base64.b64decode(b64)))


def image_to_base64(img: Image.Image, fmt: str = "PNG") -> str:
    buf = io.BytesIO()
    if fmt.upper() == "JPEG" and img.mode == "RGBA":
        img = img.convert("RGB")
    img.save(buf, format=fmt)
    return base64.b64encode(buf.getvalue()).decode()


def snap_to_64(w: int, h: int, target: int = 1024) -> tuple[int, int]:
    """Scale (w, h) so the longer side ≈ target, both sides multiples of 64."""
    scale = target / max(w, h)
    nw = round(w * scale / 64) * 64
    nh = round(h * scale / 64) * 64
    return max(nw, 64), max(nh, 64)


async def call_flux2(prompt: str, images: list[Image.Image]) -> Image.Image:
    """
    Call self-hosted Flux2 Klein /edit-multi endpoint.
    Sends images as multipart files, returns a PIL Image (PNG).
    Width/height are auto-calculated from the first image (aspect-preserving,
    long side ≈ 1024, both sides aligned to 64).
    """
    ref = images[0]
    w, h = snap_to_64(ref.width, ref.height)
    print(f"[flux2] calling API  prompt='{prompt[:60]}...'  images={len(images)}  size={w}x{h}")

    files = []
    for i, img in enumerate(images):
        buf = io.BytesIO()
        img.save(buf, format="PNG")
        buf.seek(0)
        files.append(("images", (f"image_{i}.png", buf, "image/png")))

    data = {"prompts": prompt, "width": str(w), "height": str(h)}

    async with httpx.AsyncClient(timeout=180, verify=False) as client:
        resp = await client.post(FLUX2_API, files=files, data=data)
        resp.raise_for_status()

    img = Image.open(io.BytesIO(resp.content))
    print(f"[flux2] received {img.size} mode={img.mode}")
    return img


async def call_sam3_remote(image: Image.Image, prompts: list[str], confidence: float = 0.3) -> dict:
    """Call remote SAM3 API and return masks + mask image."""
    print(f"[sam3-remote] calling API with prompts={prompts}, confidence={confidence}")

    # Convert PIL to bytes
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    buf.seek(0)

    # Build multipart form
    files = {"image": ("image.png", buf, "image/png")}
    data = {
        "prompts": ",".join(prompts),
        "confidence": str(confidence),
    }

    async with httpx.AsyncClient(timeout=120, verify=False) as client:
        resp = await client.post(SAM3_API, files=files, data=data)
        resp.raise_for_status()
        result = resp.json()

    # Convert hex string to base64 PNG
    hex_str = result["mask_base64"]
    if not hex_str:
        raise HTTPException(500, detail="SAM3 returned empty mask - no segments detected")

    png_bytes = bytes.fromhex(hex_str)
    mask_b64 = base64.b64encode(png_bytes).decode()

    # Map response format to local format
    segments = result["label_map"]["segments"]
    masks = [{"id": s["id"], "label": s["label"], "color": s["color_rgb"]} for s in segments]

    print(f"[sam3-remote] received {len(masks)} masks")
    return {"masks": masks, "mask_only_b64": mask_b64}


def composite_regions(
    base: Image.Image,
    mask: Image.Image,
    region_colors: list[list[int]],
    region_results: list[Image.Image],
    feather_radius: int = 3,
) -> Image.Image:
    """
    Composite multiple region results onto base using mask colours.
    For each pixel whose mask colour matches a region, copy from that region's
    result image. Feather edges with a Gaussian blur on per-region alpha masks.
    """
    w, h = base.size
    mask_resized = mask.resize((w, h), Image.NEAREST) if mask.size != (w, h) else mask
    mask_arr = np.array(mask_resized.convert("RGB"))  # (H, W, 3)
    out = np.array(base.convert("RGBA"))

    tolerance = 15

    for colors, result_img in zip(region_colors, region_results):
        result_resized = result_img.resize((w, h), Image.LANCZOS) if result_img.size != (w, h) else result_img
        result_arr = np.array(result_resized.convert("RGBA"))

        # Build binary mask for this region
        tc = np.array(colors, dtype=np.int16)
        diff = np.abs(mask_arr.astype(np.int16) - tc)
        region_mask = np.all(diff <= tolerance, axis=2)  # (H, W) bool

        # Feather edges: convert bool mask to float alpha, blur, then blend
        alpha = region_mask.astype(np.float32)
        if feather_radius > 0:
            alpha_img = Image.fromarray((alpha * 255).astype(np.uint8), mode="L")
            alpha_img = alpha_img.filter(ImageFilter.GaussianBlur(radius=feather_radius))
            alpha = np.array(alpha_img).astype(np.float32) / 255.0

        # Blend: out = result * alpha + out * (1 - alpha)
        a3 = alpha[:, :, np.newaxis]
        out = (result_arr * a3 + out * (1 - a3)).astype(np.uint8)

    return Image.fromarray(out)


def generate_unique_color(
    existing: list[list[int]],
    min_dist: int = 80,
    lo: int = 28,
    hi: int = 228,
    max_tries: int = 300,
) -> list[int]:
    """
    Generate a random RGB colour that is at least `min_dist` (Euclidean, RGB space)
    away from every colour in `existing`. Values are drawn from [lo, hi).
    Falls back to [255, 128, 0] (orange) if no candidate is found within `max_tries`.
    """
    import random
    for _ in range(max_tries):
        c = [random.randint(lo, hi - 1) for _ in range(3)]
        if all(
            sum((c[i] - e[i]) ** 2 for i in range(3)) ** 0.5 >= min_dist
            for e in existing
        ):
            return c
    return [255, 128, 0]


def split_mask_by_line(
    mask_arr: np.ndarray,
    target_color: list[int],
    x1: int, y1: int,
    x2: int, y2: int,
    existing_colors: list[list[int]],
    tolerance: int = 15,
) -> tuple[np.ndarray, list[int]] | None:
    """
    Split pixels matching `target_color` in `mask_arr` (H×W×3 uint8) using a
    half-plane defined by the directed line (x1,y1)→(x2,y2).

    Cross product  dx*(py-y1) - dy*(px-x1):
      >= 0  → side A: keep target_color
      <  0  → side B: recolor to new_color

    Returns (updated_arr, new_color) or None if the line doesn't split the region
    (all pixels fall on the same side).
    """
    tc = np.array(target_color, dtype=np.int16)
    diff = np.abs(mask_arr.astype(np.int16) - tc)
    region_mask = np.all(diff <= tolerance, axis=2)   # (H, W) bool

    if not region_mask.any():
        return None

    h, w = mask_arr.shape[:2]
    ys, xs = np.where(region_mask)

    dx = x2 - x1
    dy = y2 - y1
    cross = dx * (ys.astype(np.int64) - y1) - dy * (xs.astype(np.int64) - x1)

    side_b = cross < 0
    if not side_b.any() or side_b.all():
        return None   # degenerate — line doesn't split the region

    new_color = generate_unique_color(existing_colors)

    result = mask_arr.copy()
    b_ys = ys[side_b]
    b_xs = xs[side_b]
    result[b_ys, b_xs] = new_color

    return result, new_color


# ── Request / Response models ─────────────────────────────────────────────────


class ProcessUploadRequest(BaseModel):
    image: str      # raw base64 (no data URI prefix)
    width: int
    height: int
    promptEnhance: str = "Realistic render"

class ProcessMasksRequest(BaseModel):
    enhancedImage: str  # raw base64 JPEG returned by /enhance
    promptClean: str = "empty room"
    promptRefine: str = "Remove all black outlines and black boundary lines between color regions. Make each colored area fill seamlessly to their edges without any black gaps, borders, or outlines. The result should have clean, sharp color boundaries where colors meet directly with no black separation lines."

class DebugSegmentRequest(BaseModel):
    image: str  # raw base64 (original image, no preprocessing)

class MaskInfo(BaseModel):
    id: int
    label: str
    color: list[int]

class ApplyMaterialRequest(BaseModel):
    originalImage: str      # raw base64
    materialFilename: str
    promptApplyMaterial: str = "based on image 2, change all wall material in image 1."

class FinalizeRequest(BaseModel):
    compositeImage: str     # raw base64
    promptFinalize: str = "realistic render"


# ── V2 models ────────────────────────────────────────────────────────────────

DEFAULT_PROMPT_REFINE = "Remove all black outlines and black boundary lines between color regions. Make each colored area fill seamlessly to their edges without any black gaps, borders, or outlines. The result should have clean, sharp color boundaries where colors meet directly with no black separation lines."

class SegmentRequest(BaseModel):
    image: str                          # raw base64
    promptEnhance: str = "Realistic render"
    promptClean: str = "empty room"
    promptRefine: str = DEFAULT_PROMPT_REFINE

class RegionItem(BaseModel):
    maskColor: list[int]                # [R, G, B] matching mask colour
    materialImage: str                  # raw base64 of material texture
    prompt: str = "based on image 2, change all wall material in image 1."

class CoordRegionItem(BaseModel):
    x: int                              # pixel X on original image
    y: int                              # pixel Y on original image
    referenceImage: str                 # raw base64 of material texture
    prompt: str = "based on image 2, change all wall material in image 1."

class RenderRequest(BaseModel):
    image: str                          # raw base64 (original / enhanced)
    refinedMask: str                    # raw base64 PNG from /api/v2/segment
    items: list[CoordRegionItem]        # click point + reference image + prompt
    promptFinalize: str = "realistic render"

class SplitMaskRequest(BaseModel):
    maskImage: str                      # raw base64 PNG — current refined mask
    targetColor: list[int]             # [R, G, B] — which region to split
    x1: int                            # line start X (mask image pixel coords)
    y1: int                            # line start Y
    x2: int                            # line end X
    y2: int                            # line end Y
    existingColors: list[list[int]] = []  # all current mask colours (for collision avoidance)


# ── Endpoints ─────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "model_loaded": _model_loaded}


@app.get("/api/materials")
def get_materials():
    items = []
    for f in sorted(MATERIALS_DIR.iterdir()):
        if f.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}:
            items.append({
                "name": f.stem,
                "filename": f.name,
                "url": f"/materials/{f.name}",
            })
    return items


@app.post("/enhance")
async def enhance(req: ProcessUploadRequest):
    """Step 1: Light blur + Flux 'Realistic render' → returns enhanced image for display."""
    original = base64_to_image(req.image)
    original = ImageOps.exif_transpose(original)
    if original.size != (req.width, req.height):
        print(f"[enhance] resizing {original.size} → {req.width}x{req.height}")
        original = original.resize((req.width, req.height), Image.LANCZOS)
    print(f"[enhance] input size={original.size} mode={original.mode}")

    blurred = original.filter(ImageFilter.GaussianBlur(radius=0.5))
    enhanced = await call_flux2(req.promptEnhance, [blurred])
    enhanced.save(DEBUG_DIR / "enhanced.png")
    print(f"[enhance] done size={enhanced.size}")

    return {"enhancedImage": image_to_base64(enhanced, "JPEG")}


@app.post("/process-masks")
async def process_masks(req: ProcessMasksRequest):
    """Steps 2-4: Flux2 clean → remote SAM3 → Flux2 refine → returns masks."""
    enhanced = base64_to_image(req.enhancedImage)
    print(f"[process-masks] input size={enhanced.size}")

    # Step 2: Flux2 clean
    cleaned = await call_flux2(req.promptClean, [enhanced])
    cleaned.save(DEBUG_DIR / "cleaned.png")
    print(f"[process-masks] cleaned size={cleaned.size}")

    # Step 3: Remote SAM3 segmentation
    seg = await call_sam3_remote(
        image=cleaned,
        prompts=["wall"],
        confidence=0.3,
    )
    print(f"[process-masks] SAM3 found {len(seg['masks'])} masks")
    masks = seg["masks"]

    mask_img = base64_to_image(seg["mask_only_b64"])
    mask_img.save(DEBUG_DIR / "mask_raw.png")

    # Step 4: Flux2 refine mask
    refined = await call_flux2(req.promptRefine, [mask_img])
    refined.save(DEBUG_DIR / "mask_refined.png")

    return {
        "refinedMask": image_to_base64(refined, "PNG"),
        "rawMask": image_to_base64(mask_img, "PNG"),
        "masks": masks,
    }


@app.post("/process-upload")
async def process_upload(req: ProcessUploadRequest):
    """Legacy single-call endpoint — calls enhance + process_masks internally."""
    enh = await enhance(req)
    masks_req = ProcessMasksRequest(enhancedImage=enh["enhancedImage"])
    result = await process_masks(masks_req)
    return {**enh, **result, "width": req.width, "height": req.height}


@app.post("/debug-segment")
async def debug_segment(req: DebugSegmentRequest):
    """Debug mode: skip enhance/clean/refine, just run SAM3 on original image."""
    original = base64_to_image(req.image)
    original = ImageOps.exif_transpose(original)
    print(f"[debug-segment] input size={original.size}")

    seg = await call_sam3_remote(
        image=original,
        prompts=["wall"],
        confidence=0.3,
    )
    print(f"[debug-segment] SAM3 found {len(seg['masks'])} masks")
    masks = seg["masks"]

    mask_img = base64_to_image(seg["mask_only_b64"])
    mask_img.save(DEBUG_DIR / "mask_raw.png")

    mask_b64 = image_to_base64(mask_img, "PNG")
    return {
        "refinedMask": mask_b64,
        "rawMask": mask_b64,
        "masks": masks,
    }


@app.post("/apply-material")
async def apply_material(req: ApplyMaterialRequest):
    original = base64_to_image(req.originalImage)

    material_path = MATERIALS_DIR / req.materialFilename
    if not material_path.exists():
        raise HTTPException(404, detail=f"Material not found: {req.materialFilename}")

    material = Image.open(material_path)

    result_img = await call_flux2(
        req.promptApplyMaterial,
        [original, material],
    )

    result_img.save(DEBUG_DIR / "apply_material_result.png")

    return {"resultImage": image_to_base64(result_img, "PNG")}


@app.post("/finalize")
async def finalize(req: FinalizeRequest):
    composite = base64_to_image(req.compositeImage)
    blurred = composite.filter(ImageFilter.GaussianBlur(radius=1))

    final_img = await call_flux2(req.promptFinalize, [blurred])

    return {"finalImage": image_to_base64(final_img, "PNG")}


# ── V2 Endpoints (headless pipeline) ────────────────────────────────────────

@app.post("/api/v2/segment")
async def v2_segment(req: SegmentRequest):
    """
    Headless pipeline step 1:
    Upload image → enhance → clean → SAM3 → refine → return masks.
    """
    # Decode & normalise
    original = base64_to_image(req.image)
    original = ImageOps.exif_transpose(original)
    print(f"[v2/segment] input size={original.size}")

    # Enhance
    blurred = original.filter(ImageFilter.GaussianBlur(radius=0.5))
    enhanced = await call_flux2(req.promptEnhance, [blurred])
    enhanced.save(DEBUG_DIR / "enhanced.png")

    # Clean
    cleaned = await call_flux2(req.promptClean, [enhanced])
    cleaned.save(DEBUG_DIR / "cleaned.png")

    # SAM3 segment
    seg = await call_sam3_remote(image=cleaned, prompts=["wall"], confidence=0.3)
    masks = seg["masks"]
    mask_img = base64_to_image(seg["mask_only_b64"])
    mask_img.save(DEBUG_DIR / "mask_raw.png")

    # Refine mask
    refined = await call_flux2(req.promptRefine, [mask_img])
    refined.save(DEBUG_DIR / "mask_refined.png")

    return {
        "enhancedImage": image_to_base64(enhanced, "JPEG"),
        "refinedMask": image_to_base64(refined, "PNG"),
        "rawMask": image_to_base64(mask_img, "PNG"),
        "masks": masks,
    }


@app.post("/api/v2/render")
async def v2_render(req: RenderRequest):
    """
    Headless pipeline step 2:
    Upload image + list of {x, y, referenceImage, prompt} →
    resolve each (x,y) to a mask colour → parallel apply materials →
    composite → finalize → return final image.
    """
    base_img = base64_to_image(req.image)
    mask_img = base64_to_image(req.refinedMask)
    print(f"[v2/render] base={base_img.size}  items={len(req.items)}")

    # Resolve each click point to the mask colour at that pixel
    mask_rgb = mask_img.convert("RGB")
    mask_w, mask_h = mask_rgb.size
    base_w, base_h = base_img.size

    def sample_mask_color(x: int, y: int) -> list[int]:
        # Scale coordinate from base image space to mask image space
        mx = round(x * mask_w / base_w)
        my = round(y * mask_h / base_h)
        mx = max(0, min(mx, mask_w - 1))
        my = max(0, min(my, mask_h - 1))
        r, g, b = mask_rgb.getpixel((mx, my))
        return [r, g, b]

    # Deduplicate: multiple points on the same colour only generate one call
    # Use the last item's prompt/referenceImage for a given colour
    color_key: dict[tuple, CoordRegionItem] = {}
    for item in req.items:
        color = tuple(sample_mask_color(item.x, item.y))
        color_key[color] = item
        print(f"[v2/render] ({item.x},{item.y}) → mask colour {color}")

    # Parallel apply-material for each unique region
    async def apply_one(color: tuple, item: CoordRegionItem) -> tuple[list[int], Image.Image]:
        mat = base64_to_image(item.referenceImage)
        result = await call_flux2(item.prompt, [base_img, mat])
        return list(color), result

    tasks = [apply_one(c, it) for c, it in color_key.items()]
    results = await asyncio.gather(*tasks)

    region_colors = [r[0] for r in results]
    region_results = [r[1] for r in results]

    # Composite all regions onto base
    composited = composite_regions(base_img, mask_img, region_colors, region_results)
    composited.save(DEBUG_DIR / "v2_composite.png")

    # Finalize
    blurred = composited.filter(ImageFilter.GaussianBlur(radius=1))
    final_img = await call_flux2(req.promptFinalize, [blurred])
    final_img.save(DEBUG_DIR / "v2_final.png")

    return {"finalImage": image_to_base64(final_img, "PNG")}


@app.post("/api/v2/split-mask")
def v2_split_mask(req: SplitMaskRequest):
    """
    Split one mask region into two sub-regions using a directed line.

    The line (x1,y1)→(x2,y2) divides the target region via half-plane
    classification (cross product). Side A keeps targetColor; side B gets a
    newly generated colour that avoids collision with existingColors.

    Returns the updated mask image and the new colour assigned to side B.
    Returns 422 if the line doesn't actually split the region.
    """
    mask_img = base64_to_image(req.maskImage).convert("RGB")
    mask_arr = np.array(mask_img)

    all_colors = list(req.existingColors) or [req.targetColor]
    result = split_mask_by_line(
        mask_arr,
        req.targetColor,
        req.x1, req.y1,
        req.x2, req.y2,
        all_colors,
    )

    if result is None:
        raise HTTPException(
            422,
            detail="Line does not split the target region — all pixels fall on the same side, or target colour not found in mask.",
        )

    updated_arr, new_color = result
    updated_img = Image.fromarray(updated_arr.astype(np.uint8))
    updated_img.save(DEBUG_DIR / "v2_split_mask.png")

    print(f"[v2/split-mask] target={req.targetColor} → new={new_color}")
    return {
        "maskImage": image_to_base64(updated_img, "PNG"),
        "newColor": new_color,
    }
