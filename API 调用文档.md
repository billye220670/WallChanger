
# FLUX.2 [klein] 4B LoRA — Image-to-Image API 调用文档

> **模型 ID**：`fal-ai/flux-2/klein/4b/edit/lora`  
> **能力**：基于自然语言描述对图像进行精准编辑，支持加载自定义 LoRA 权重，4步推理快速出图。

---

## 1. 安装客户端

```bash
npm install --save @fal-ai/client
```

> ⚠️ `@fal-ai/serverless-client` 已弃用，请统一使用 `@fal-ai/client`。

---

## 2. 认证配置

### 方式 A：环境变量（推荐服务端）

```bash
export FAL_KEY="YOUR_API_KEY"
```

### 方式 B：代码内配置

```js
import { fal } from "@fal-ai/client";

fal.config({
  credentials: "YOUR_FAL_KEY"
});
```

> 🔒 **安全提示**：在浏览器、移动端等客户端环境中，禁止直接暴露 `FAL_KEY`，应通过**服务端代理**转发请求。

---

## 3. 发起请求

### 方式 A：直接调用（同步等待结果）

```js
import { fal } from "@fal-ai/client";

const result = await fal.subscribe("fal-ai/flux-2/klein/4b/edit/lora", {
  input: {
    prompt: "Turn this into a realistic image",
    image_urls: [
      "https://v3b.fal.media/files/b/0a8a69d5/kkXxFfj1QeVtw35kxy5Py_1a7e3511-bd2c-46be-923a-8e6be2496f12.png"
    ]
  }
});

console.log(result.data);
```

### 方式 B：队列模式（推荐长耗时任务）

#### ① 提交任务

```js
import { fal } from "@fal-ai/client";

const { request_id } = await fal.queue.submit("fal-ai/flux-2/klein/4b/edit/lora", {
  input: {
    prompt: "Turn this into a realistic image",
    image_urls: [
      "https://v3b.fal.media/files/b/0a8a69d5/kkXxFfj1QeVtw35kxy5Py_1a7e3511-bd2c-46be-923a-8e6be2496f12.png"
    ]
  },
  webhookUrl: "https://optional.webhook.url/for/results", // 可选
});
```

#### ② 查询任务状态

```js
import { fal } from "@fal-ai/client";

const status = await fal.queue.status("fal-ai/flux-2/klein/4b/edit/lora", {
  requestId: "764cabcf-b745-4b3e-ae38-1200304cf45b",
  logs: true, // 是否返回日志
});
```

#### ③ 获取结果

```js
import { fal } from "@fal-ai/client";

const result = await fal.queue.result("fal-ai/flux-2/klein/4b/edit/lora", {
  requestId: "764cabcf-b745-4b3e-ae38-1200304cf45b"
});

console.log(result.data);       // 结果数据（含图像 URL）
console.log(result.requestId);  // 请求 ID
```

---

## 4. 文件传入方式

| 方式 | 说明 |
|---|---|
| **公开 URL** | 直接传入可公开访问的图像 URL |
| **Base64 Data URI** | 传入 `data:image/png;base64,...` 格式，适合小文件，大文件会影响性能 |
| **二进制上传** | 传入 `File` / `Blob` 对象，客户端自动上传并返回 URL |

```js
// 上传本地文件并获取 URL
import { fal } from "@fal-ai/client";

const file = new File([binaryData], "image.png", { type: "image/png" });
const url = await fal.storage.upload(file);
// 然后将 url 传入 image_urls
```

---

## 5. 输入参数（Input Schema）

| 参数 | 类型 | 必填 | 默认值 | 说明 |
|---|---|:---:|---|---|
| `prompt` | `string` | ✅ | — | 描述如何编辑图像的文本提示词 |
| `image_urls` | `string[]` | ✅ | — | 待编辑的图像 URL 列表，**最多 4 张** |
| `image_size` | `string \| object` | ❌ | 原图尺寸 | 输出图像尺寸（见下方枚举值） |
| `num_images` | `integer` | ❌ | `1` | 生成图像数量 |
| `num_inference_steps` | `integer` | ❌ | `4` | 推理步数 |
| `output_format` | `string` | ❌ | `"png"` | 输出格式：`jpeg` / `png` / `webp` |
| `seed` | `integer` | ❌ | 随机 | 随机种子，固定可复现结果 |
| `sync_mode` | `boolean` | ❌ | `false` | `true` 时直接返回 Data URI，**结果不会被存储** |
| `enable_safety_checker` | `boolean` | ❌ | `true` | 是否启用安全内容检测 |
| `loras` | `LoRAInput[]` | ❌ | `[]` | LoRA 权重列表，**最多 3 个** |

### `image_size` 枚举值

```
square_hd | square | portrait_4_3 | portrait_16_9 | landscape_4_3 | landscape_16_9
```

或传入自定义尺寸对象：

```json
"image_size": {
  "width": 1280,
  "height": 720
}
```

### 完整请求体示例

```json
{
  "prompt": "Turn this into a realistic image",
  "image_urls": [
    "https://v3b.fal.media/files/b/0a8a69d5/kkXxFfj1QeVtw35kxy5Py_1a7e3511-bd2c-46be-923a-8e6be2496f12.png"
  ],
  "image_size": {
    "width": 2016,
    "height": 1152
  },
  "num_images": 1,
  "num_inference_steps": 4,
  "output_format": "png",
  "enable_safety_checker": true,
  "seed": 42,
  "loras": []
}
```

---

## 6. 输出结果（Output Schema）

| 字段 | 类型 | 必填 | 说明 |
|---|---|:---:|---|
| `images` | `ImageFile[]` | ✅ | 编辑后的图像列表 |
| `prompt` | `string` | ✅ | 实际使用的提示词 |
| `seed` | `integer` | ✅ | 实际使用的随机种子 |
| `timings` | `object` | ✅ | 各阶段耗时数据 |
| `has_nsfw_concepts` | `boolean[]` | ✅ | 每张图是否含有 NSFW 内容 |

### `ImageFile` 结构

| 字段 | 类型 | 必填 | 说明 |
|---|---|:---:|---|
| `url` | `string` | ✅ | 图像下载 URL |
| `content_type` | `string` | ❌ | MIME 类型，如 `image/png` |
| `file_name` | `string` | ❌ | 文件名（未提供时自动生成）|
| `file_size` | `integer` | ❌ | 文件大小（字节） |
| `width` | `integer` | ❌ | 图像宽度（像素） |
| `height` | `integer` | ❌ | 图像高度（像素） |

### 输出示例

```json
{
  "images": [
    {
      "url": "https://v3b.fal.media/files/b/0a8a69d6/M73KvDgfEgIM77t4mFsS2.png",
      "content_type": "image/png",
      "file_size": 204800,
      "width": 1024,
      "height": 1024
    }
  ],
  "prompt": "Turn this into a realistic image",
  "seed": 42,
  "timings": {},
  "has_nsfw_concepts": [false]
}
```

---

## 7. 读取结果图像 URL

```js
// 获取第一张图的 URL
const imageUrl = result.data.images[0].url;

// 遍历所有图像
result.data.images.forEach((img, idx) => {
  console.log(`图像 ${idx + 1}: ${img.url} (${img.width}x${img.height})`);
});

// 检查 NSFW
if (result.data.has_nsfw_concepts[0]) {
  console.warn("该图像包含 NSFW 内容");
}
```
