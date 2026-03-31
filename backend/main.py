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
import fal_client
import httpx

load_dotenv()

# ── SAM3 import ──────────────────────────────────────────────────────────────
sam3d_path = os.getenv("SAM3D_PATH", "C:/Users/Tintt/Documents/SAM3D")
sys.path.insert(0, sam3d_path)
from app import init_model, segment_image   # noqa: E402

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
_model_loaded = False

@app.on_event("startup")
async def startup_event():
    global _model_loaded
    try:
        init_model()
        _model_loaded = True
        print("SAM3 model loaded successfully")
    except Exception as e:
        print(f"Warning: SAM3 model failed to load: {e}")
        _model_loaded = False


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


def download_url(url: str) -> bytes:
    with httpx.Client(timeout=120) as client:
        r = client.get(url)
        r.raise_for_status()
        return r.content



def call_flux(prompt: str, image_uris: list[str]) -> Image.Image:
    """
    Call Flux Klein 9B and return a PIL Image.
    fal_client reads FAL_KEY from the environment automatically.
    No image_size passed — fal auto-uses input image dimensions.
    """
    print(f"[flux] calling fal API  prompt='{prompt[:60]}...'")
    result = fal_client.subscribe(
        "fal-ai/flux-2/klein/9b/edit/lora",
        arguments={
            "prompt": prompt,
            "image_urls": image_uris,
            "num_images": 1,
            "output_format": "png",
        },
    )
    image_url = result["images"][0]["url"]
    raw = download_url(image_url)
    img = Image.open(io.BytesIO(raw))
    print(f"[flux] received {img.size} mode={img.mode}")
    return img


def call_seedream(prompt: str, image_uris: list[str]) -> Image.Image:
    """
    Call Seedream v5 lite and return a PIL Image.
    fal_client reads FAL_KEY from the environment automatically.
    """
    print(f"[seedream] calling fal API  prompt='{prompt[:60]}...'")
    result = fal_client.subscribe(
        "fal-ai/bytedance/seedream/v5/lite/edit",
        arguments={
            "prompt": prompt,
            "image_urls": image_uris,
            "num_images": 1,
        },
    )
    image_url = result["images"][0]["url"]
    raw = download_url(image_url)
    img = Image.open(io.BytesIO(raw))
    print(f"[seedream] received {img.size} mode={img.mode}")
    return img


def pil_to_data_uri(img: Image.Image, fmt: str = "JPEG") -> str:
    mime = "image/png" if fmt == "PNG" else "image/jpeg"
    return f"data:{mime};base64,{image_to_base64(img, fmt)}"


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


@app.get("/materials")
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
    enhanced = call_flux(req.promptEnhance, [pil_to_data_uri(blurred)])
    enhanced.save(DEBUG_DIR / "enhanced.png")
    print(f"[enhance] done size={enhanced.size}")

    return {"enhancedImage": image_to_base64(enhanced, "JPEG")}


@app.post("/process-masks")
def process_masks(req: ProcessMasksRequest):
    """Steps 2-4: Flux clean → SAM3 → blur mask → Flux refine → returns masks."""
    enhanced = base64_to_image(req.enhancedImage)
    print(f"[process-masks] input size={enhanced.size}")

    # Step 2: Seedream clean
    cleaned = call_seedream(req.promptClean, [pil_to_data_uri(enhanced)])
    cleaned.save(DEBUG_DIR / "cleaned.png")
    print(f"[process-masks] cleaned size={cleaned.size}")

    # Step 3: SAM3 segmentation
    if not _model_loaded:
        raise HTTPException(503, detail="SAM3 model not yet loaded")

    seg = segment_image(
        image=cleaned,
        confidence_threshold=0.3,
        prompts=["wall", "floor", "ceiling", "window", "door"],
    )
    print(f"[process-masks] SAM3 found {len(seg['masks'])} masks")
    masks = [{"id": m["id"], "label": m["label"], "color": m["color"]} for m in seg["masks"]]

    mask_img = base64_to_image(seg["mask_only_b64"])
    mask_img.save(DEBUG_DIR / "mask_raw.png")

    # Step 4: Seedream refine — send as PNG (lossless) to avoid JPEG noise at input
    refined = call_seedream(req.promptRefine, [pil_to_data_uri(mask_img, "PNG")])
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


@app.post("/apply-material")
def apply_material(req: ApplyMaterialRequest):
    original = base64_to_image(req.originalImage)

    material_path = MATERIALS_DIR / req.materialFilename
    if not material_path.exists():
        raise HTTPException(404, detail=f"Material not found: {req.materialFilename}")

    material = Image.open(material_path)

    result_img = call_flux(
        req.promptApplyMaterial,
        [pil_to_data_uri(original), pil_to_data_uri(material)],
    )

    result_img.save(DEBUG_DIR / "apply_material_result.png")

    return {"resultImage": image_to_base64(result_img, "PNG")}


@app.post("/finalize")
def finalize(req: FinalizeRequest):
    composite = base64_to_image(req.compositeImage)
    blurred = composite.filter(ImageFilter.GaussianBlur(radius=1))

    final_img = call_flux(req.promptFinalize, [pil_to_data_uri(blurred)])

    return {"finalImage": image_to_base64(final_img, "PNG")}
