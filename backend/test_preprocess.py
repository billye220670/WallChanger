"""
快速诊断脚本 - 直接测试 /api/v2/preprocess 接口
用法: python test_preprocess.py [图片路径]
如果不传图片路径，会使用一个默认的纯色测试图

诊断结果会打印在控制台，中间图片保存在 backend/debug/ 目录
"""
import sys
import base64
import json
import time
import httpx
from pathlib import Path
from PIL import Image
import io

BACKEND_URL = "http://127.0.0.1:8100"
DEBUG_DIR = Path(__file__).parent / "debug"
DEBUG_DIR.mkdir(exist_ok=True)


def image_to_base64(img_path: str) -> str:
    with open(img_path, "rb") as f:
        return base64.b64encode(f.read()).decode()


def b64_to_image(b64: str) -> Image.Image:
    return Image.open(io.BytesIO(base64.b64decode(b64)))


def main():
    if len(sys.argv) > 1:
        img_path = sys.argv[1]
        print(f"📷 使用测试图片: {img_path}")
        img = Image.open(img_path)
        print(f"   尺寸: {img.size}, 模式: {img.mode}")
        b64 = image_to_base64(img_path)
    else:
        # 找 debug 目录下有没有之前的 original_input.png
        test_candidates = [
            DEBUG_DIR / "original_input.png",
            Path(__file__).parent.parent / "public" / "examples" / "example1" / "input.jpg",
        ]
        found = None
        for p in test_candidates:
            if p.exists():
                found = str(p)
                break
        if found:
            print(f"📷 自动找到测试图片: {found}")
            img = Image.open(found)
            print(f"   尺寸: {img.size}, 模式: {img.mode}")
            b64 = image_to_base64(found)
        else:
            print("❌ 没有找到测试图片，请传入图片路径:")
            print(f"   python {sys.argv[0]} <图片路径>")
            return

    print(f"\n🔧 base64长度: {len(b64)} 字符")
    print(f"🌐 请求 {BACKEND_URL}/api/v2/preprocess ...")
    print(f"⏱️  开始时间: {time.strftime('%H:%M:%S')}")

    try:
        resp = httpx.post(
            f"{BACKEND_URL}/api/v2/preprocess",
            json={"image": b64},
            timeout=600,
        )
    except httpx.ConnectError:
        print(f"\n❌ 无法连接到后端 {BACKEND_URL}")
        print("   请先启动后端: cd backend && python main.py")
        return
    except Exception as e:
        print(f"\n❌ 请求异常: {e}")
        return

    print(f"⏱️  结束时间: {time.strftime('%H:%M:%S')}")
    print(f"📊 HTTP状态码: {resp.status_code}")

    if resp.status_code != 200:
        print(f"\n❌ 请求失败!")
        print(f"   响应: {resp.text[:500]}")
        return

    data = resp.json()
    print(f"\n✅ 请求成功!")
    print(f"   响应字段: {list(data.keys())}")

    # 检查 enforcedResult
    er = data.get("enforcedResult", "")
    if er:
        er_img = b64_to_image(er)
        er_path = DEBUG_DIR / "test_enforcedResult.png"
        er_img.save(str(er_path))
        print(f"   enforcedResult: ✅ 存在, 尺寸={er_img.size}, 已保存 → {er_path}")
    else:
        print(f"   enforcedResult: ❌ 不存在!")

    # 检查 masks
    masks = data.get("masks", [])
    print(f"   masks数量: {len(masks)}")

    import numpy as np
    all_black = True
    for i, m_b64 in enumerate(masks):
        m_img = b64_to_image(m_b64)
        m_arr = np.array(m_img)
        max_val = m_arr.max()
        mean_val = m_arr.mean()
        m_path = DEBUG_DIR / f"test_mask_{i}.png"
        m_img.save(str(m_path))

        status = "✅ 有内容" if max_val > 0 else "⚠️ 全黑!"
        print(f"   mask[{i}]: {status}  size={m_img.size} mode={m_img.mode} max={max_val} mean={mean_val:.2f}  → {m_path}")
        if max_val > 0:
            all_black = False

    print(f"\n{'='*60}")
    if not masks:
        print("🔴 结论: API返回了错误，没有任何mask")
    elif all_black:
        print("🔴 结论: 所有mask全黑！SAM3未识别到任何墙体/天花")
        print("   请检查 backend/debug/ 目录下的:")
        print("   - debug_sam3_input.png  (SAM3实际接收到的图)")
        print("   - debug_flux2_pass2.png (Flux2中间输出)")
        print("   对比你在ComfyUI中直接运行时SAM3接收到的图是否一样")
    else:
        print("🟢 结论: 识别正常！至少有mask包含内容")
        print("   如果前端仍显示无墙体，问题在前端解析而非后端识别")


if __name__ == "__main__":
    main()
