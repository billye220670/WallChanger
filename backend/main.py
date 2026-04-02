import os
import sys
import base64
import io
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


def call_flux2(prompt: str, images: list[Image.Image]) -> Image.Image:
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

    with httpx.Client(timeout=180, verify=False) as client:
        resp = client.post(FLUX2_API, files=files, data=data)
        resp.raise_for_status()

    img = Image.open(io.BytesIO(resp.content))
    print(f"[flux2] received {img.size} mode={img.mode}")
    return img


def call_sam3_remote(image: Image.Image, prompts: list[str], confidence: float = 0.3) -> dict:
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

    with httpx.Client(timeout=120, verify=False) as client:
        resp = client.post(SAM3_API, files=files, data=data)
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
def enhance(req: ProcessUploadRequest):
    """Step 1: Light blur + Flux 'Realistic render' → returns enhanced image for display."""
    original = base64_to_image(req.image)
    original = ImageOps.exif_transpose(original)
    if original.size != (req.width, req.height):
        print(f"[enhance] resizing {original.size} → {req.width}x{req.height}")
        original = original.resize((req.width, req.height), Image.LANCZOS)
    print(f"[enhance] input size={original.size} mode={original.mode}")

    blurred = original.filter(ImageFilter.GaussianBlur(radius=0.5))
    enhanced = call_flux2(req.promptEnhance, [blurred])
    enhanced.save(DEBUG_DIR / "enhanced.png")
    print(f"[enhance] done size={enhanced.size}")

    return {"enhancedImage": image_to_base64(enhanced, "JPEG")}


@app.post("/process-masks")
def process_masks(req: ProcessMasksRequest):
    """Steps 2-4: Flux2 clean → remote SAM3 → Flux2 refine → returns masks."""
    enhanced = base64_to_image(req.enhancedImage)
    print(f"[process-masks] input size={enhanced.size}")

    # Step 2: Flux2 clean
    cleaned = call_flux2(req.promptClean, [enhanced])
    cleaned.save(DEBUG_DIR / "cleaned.png")
    print(f"[process-masks] cleaned size={cleaned.size}")

    # Step 3: Remote SAM3 segmentation
    seg = call_sam3_remote(
        image=cleaned,
        prompts=["wall"],
        confidence=0.3,
    )
    print(f"[process-masks] SAM3 found {len(seg['masks'])} masks")
    masks = seg["masks"]

    mask_img = base64_to_image(seg["mask_only_b64"])
    mask_img.save(DEBUG_DIR / "mask_raw.png")

    # Step 4: Flux2 refine mask
    refined = call_flux2(req.promptRefine, [mask_img])
    refined.save(DEBUG_DIR / "mask_refined.png")

    return {
        "refinedMask": image_to_base64(refined, "PNG"),
        "rawMask": image_to_base64(mask_img, "PNG"),
        "masks": masks,
    }


@app.post("/process-upload")
def process_upload(req: ProcessUploadRequest):
    """Legacy single-call endpoint — calls enhance + process_masks internally."""
    enh = enhance(req)
    masks_req = ProcessMasksRequest(enhancedImage=enh["enhancedImage"])
    result = process_masks(masks_req)
    return {**enh, **result, "width": req.width, "height": req.height}


@app.post("/debug-segment")
def debug_segment(req: DebugSegmentRequest):
    """Debug mode: skip enhance/clean/refine, just run SAM3 on original image."""
    original = base64_to_image(req.image)
    original = ImageOps.exif_transpose(original)
    print(f"[debug-segment] input size={original.size}")

    seg = call_sam3_remote(
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
def apply_material(req: ApplyMaterialRequest):
    original = base64_to_image(req.originalImage)

    material_path = MATERIALS_DIR / req.materialFilename
    if not material_path.exists():
        raise HTTPException(404, detail=f"Material not found: {req.materialFilename}")

    material = Image.open(material_path)

    result_img = call_flux2(
        req.promptApplyMaterial,
        [original, material],
    )

    result_img.save(DEBUG_DIR / "apply_material_result.png")

    return {"resultImage": image_to_base64(result_img, "PNG")}


@app.post("/finalize")
def finalize(req: FinalizeRequest):
    composite = base64_to_image(req.compositeImage)
    blurred = composite.filter(ImageFilter.GaussianBlur(radius=1))

    final_img = call_flux2(req.promptFinalize, [blurred])

    return {"finalImage": image_to_base64(final_img, "PNG")}
