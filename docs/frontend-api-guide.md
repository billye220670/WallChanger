# WallChanger 前端 API 对接指南

> 📌 本文档面向前端开发者，详细介绍 WallChanger 后端所有 API 接口的调用方式及完整业务流程。

---

## 目录

1. [概述](#1-概述)
2. [完整业务流程](#2-完整业务流程)
3. [接口详细文档](#3-接口详细文档)
4. [图片编码规范](#4-图片编码规范)
5. [前端数据类型](#5-前端数据类型)
6. [并发控制](#6-并发控制)
7. [完整调用示例](#7-完整调用示例)
8. [性能指标](#8-性能指标)
9. [错误处理](#9-错误处理)
10. [废弃接口](#10-废弃接口)

---

## 1. 概述

### 项目简介

WallChanger 是一款 AI 驱动的室内墙面材质替换工具。用户上传一张室内照片，系统自动识别墙面区域，用户可为每面墙选择不同材质进行替换，最终生成高质量的效果图。

### 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | React 18 + TypeScript + Vite + Tailwind CSS + Zustand |
| 后端 | Python + FastAPI |
| AI 引擎 | ComfyUI (Flux2-Klein 9B) + SAM3 远程分割 API |

### 后端地址配置

后端默认运行在 `http://localhost:8100`。前端通过 Vite 代理或直接请求该地址与后端通信。

```typescript
// 推荐在环境变量或配置文件中定义
const API_BASE = 'http://localhost:8100';
```

---

# 2. 完整业务流程

预处理阶段（方案 A / B 共用）：

```
用户上传图片
    │
    ▼
┌─────────────────────────────────┐
│  POST /api/v2/preprocess        │  ⏱ 约 2-3 分钟
│  发送原图 base64                 │
│  返回: enforcedResult + masks[] │
└─────────────┬───────────────────┘
              │
              ▼
    前端展示增强图 + 高亮墙面区域
    用户为每面墙选择材质
```

### 方案 A：逐个渲染（现有流程）

用户每拖拽一个材质球 → 调用 `/api/v2/render` 单区域渲染 → 前端 canvas 叠加 → 最后调用 `/api/v2/finalize`

```
    用户拖拽材质到某面墙
              │
              ▼
┌─────────────────────────────────────┐
│  POST /api/v2/render                │  ⏱ 约 20-40 秒/面墙
│  逐面墙发送:                         │
│    enforcedImage + maskImage         │
│    + materialImage                   │
│  返回: resultImage (RGBA PNG)        │
│  ⚠ 必须串行调用，一次只能跑一个任务    │
└─────────────┬───────────────────────┘
              │  (每面墙返回后叠加到 canvas)
              ▼
    前端 canvas 合成所有图层
              │
              ▼
┌─────────────────────────────────┐
│  POST /api/v2/finalize          │  ⏱ 约 20-40 秒
│  发送 canvas 导出的合成图        │
│  返回: finalImage (最终效果图)   │
└─────────────┬───────────────────┘
              │
              ▼
    展示最终结果，用户可下载
```

### 方案 B：批量渲染（新增 🆕）

用户选好所有区域的材质 → 一次调用 `/api/v2/render-all` → 后端自动完成所有区域渲染 + 合成 + 洗图 → 返回完整效果图

```
    用户选好所有区域的材质（记录点击坐标 + 材质）
              │
              ▼
┌──────────────────────────────────────────────────┐
│  POST /api/v2/render-all                         │  ⏱ 约 (20-40s × N) + 20-40s
│  一次提交:                                        │
│    enforcedImage + masks[]                       │
│    + items[] (每个含 x, y, materialImage, prompt) │
│  后端自动: 坐标匹配蒙版 → 逐区域换材质              │
│           → 合成 → 最终洗图                        │
│  返回: finalImage (完整效果图)                     │
└─────────────┬────────────────────────────────────┘
              │
              ▼
    展示最终结果，用户可下载
```

> 💡 **方案选择建议**：方案 A 适合用户逐步预览每面墙效果的交互模式；方案 B 适合"一键焕色"场景——用户选好所有区域材质后一次性完成渲染，调用更简单但等待时间更长。

### 数据流转说明

1. **上传阶段** — 用户选择图片 → 前端读取为 raw base64（不含 `data:image/...;base64,` 前缀）
2. **预处理阶段** — 后端对图片进行增强、清理、平坦化、分割，返回增强图和各墙面蒙版
3. **编辑阶段** — 用户在 UI 中为每面墙选择材质
4. **渲染阶段（二选一）**：
   - **方案 A**：前端逐面墙调用 `/api/v2/render`，每次渲染返回的 RGBA 图层叠加到 canvas 上，最后调用 `/api/v2/finalize` 进行最终优化
   - **方案 B**：前端一次调用 `/api/v2/render-all`，后端自动完成全部区域渲染 + 合成 + 最终洗图，直接返回完整效果图
5. **结果展示** — 展示最终效果图，用户可下载

---

## 3. 接口详细文档

### 3.1 🏥 健康检查

**`GET /health`**

用于检测后端服务是否正常运行。

#### 请求参数

无。

#### 请求示例

```typescript
const res = await fetch(`${API_BASE}/health`);
const data = await res.json();
```

#### 响应参数

| 字段 | 类型 | 说明 |
|------|------|------|
| `status` | `string` | 服务状态，正常为 `"ok"` |
| `model_loaded` | `boolean` | AI 模型是否已加载 |

#### 响应示例

```json
{
  "status": "ok",
  "model_loaded": true
}
```

#### 注意事项

- 建议前端在启动时调用此接口，确认后端可用后再允许用户操作。
- `model_loaded` 为 `false` 时，AI 相关接口可能会失败。

---

### 3.2 🎨 获取材质列表

**`GET /api/materials`**

获取服务器上所有可用的材质贴图信息。

#### 请求参数

无。

#### 请求示例

```typescript
const res = await fetch(`${API_BASE}/api/materials`);
const materials: Material[] = await res.json();
```

#### 响应参数

返回数组，每个元素结构如下：

| 字段 | 类型 | 说明 |
|------|------|------|
| `name` | `string` | 材质显示名称 |
| `filename` | `string` | 文件名（含扩展名） |
| `url` | `string` | 材质图片的相对 URL 路径 |

#### 响应示例

```json
[
  {
    "name": "白色大理石",
    "filename": "白色大理石.jpg",
    "url": "/materials/白色大理石.jpg"
  },
  {
    "name": "木纹橡木",
    "filename": "木纹橡木.png",
    "url": "/materials/木纹橡木.png"
  }
]
```

#### 注意事项

- 支持的图片格式：`.jpg`、`.jpeg`、`.png`、`.webp`
- 返回的 `url` 为相对路径，需拼接后端地址使用：`${API_BASE}${material.url}`

---

### 3.3 🖼️ 获取材质图片

**`GET /materials/{filename}`**

静态文件服务接口，直接返回材质图片的二进制数据。

#### 请求参数

| 参数 | 位置 | 类型 | 必须 | 说明 |
|------|------|------|------|------|
| `filename` | URL 路径 | `string` | ✅ | 材质文件名 |

#### 请求示例

```typescript
// 用于 <img> 标签展示缩略图
<img src={`${API_BASE}/materials/${material.filename}`} />

// 用于下载并转 base64（供渲染接口使用）
async function materialToBase64(filename: string): Promise<string> {
  const res = await fetch(`${API_BASE}/materials/${filename}`);
  const blob = await res.blob();
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const dataUrl = reader.result as string;
      resolve(dataUrl.split(',')[1]); // 去掉 data URI 前缀
    };
    reader.readAsDataURL(blob);
  });
}
```

#### 响应

直接返回图片二进制流，`Content-Type` 为对应的图片 MIME 类型。

---

### 3.4 ⚙️ 预处理（核心接口）

**`POST /api/v2/preprocess`**

上传原始图片，后端执行图像增强、清理、平坦化和墙面分割，返回增强图和各墙面蒙版。

#### 请求参数

| 字段 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `image` | `string` | ✅ | 原始图片的 raw base64 编码，**不含** `data:image/...;base64,` 前缀 |

#### 请求示例

```typescript
const res = await fetch(`${API_BASE}/api/v2/preprocess`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ image: rawBase64 }),
});
const data = await res.json();
// data.enforcedResult — 增强后的场景图
// data.masks — 黑白蒙版数组
```

#### 响应参数

| 字段 | 类型 | 说明 |
|------|------|------|
| `enforcedResult` | `string` | 增强后的场景图，base64 PNG。后续所有操作都基于此图 |
| `masks` | `string[]` | 黑白蒙版图数组，每个元素为 base64 PNG。白色区域 = 对应墙面，黑色 = 非该墙面 |

#### 响应示例

```json
{
  "enforcedResult": "iVBORw0KGgo...",
  "masks": [
    "iVBORw0KGgo...",
    "iVBORw0KGgo...",
    "iVBORw0KGgo..."
  ]
}
```

#### 注意事项

- ⏱ **耗时约 2-3 分钟**，前端应展示加载动画
- 内部处理流程：图像模糊 → Flux2 增强 → Flux2 清理(去家具) → Flux2 平坦化 → SAM3 墙面分割 → 生成蒙版
- `enforcedResult` 必须缓存，后续每次调用 `/api/v2/render` 都需要它
- `masks` 数组长度取决于识别出的墙面数量（通常 2-5 面）
- 错误码：`422` 参数错误，`500` AI 处理失败

---

### 3.5 🧱 材质应用

**`POST /api/v2/render`** 或 **`POST /api/v2/apply-material`**

> 两个 URL 功能完全相同，任选其一即可。

将指定材质应用到指定墙面区域，返回带 alpha 通道的结果图层。

#### 请求参数

| 字段 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `enforcedImage` | `string` | ✅ | 预处理返回的 `enforcedResult`，base64 |
| `maskImage` | `string` | ✅ | 对应墙面区域的黑白蒙版，base64 |
| `materialImage` | `string` | ✅ | 材质贴图，base64 |

#### 请求示例

```typescript
const res = await fetch(`${API_BASE}/api/v2/render`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    enforcedImage: preprocessResult.enforcedResult,
    maskImage: preprocessResult.masks[wallIndex],
    materialImage: materialBase64,
  }),
});
const data = await res.json();
// data.resultImage — RGBA PNG，只有目标区域有像素
```

#### 响应参数

| 字段 | 类型 | 说明 |
|------|------|------|
| `resultImage` | `string` | RGBA PNG 的 base64 编码。只有目标墙面区域包含像素（其余区域透明） |

#### 响应示例

```json
{
  "resultImage": "iVBORw0KGgo..."
}
```

#### 前端合成方式

```typescript
// 将返回的 RGBA 图层叠加到 canvas
const img = new Image();
img.onload = () => {
  ctx.drawImage(img, 0, 0); // 直接叠在已有内容上
};
img.src = `data:image/png;base64,${data.resultImage}`;
```

#### 注意事项

- ⏱ **耗时约 20-40 秒**
- ⚠️ **同步接口，同一时刻只能有一个任务在跑**。前端必须使用互斥锁（`isApplying`）控制并发，详见[并发控制](#6-并发控制)章节
- 返回的图像带 alpha 通道，可直接用 `drawImage` 叠加合成
- 错误码：`500` AI 处理失败，`504` 超时（默认 10 分钟）

---

### 3.6 ✨ 最终渲染

**`POST /api/v2/finalize`**

将 canvas 上合成好的效果图发送到后端进行最终优化渲染。

#### 请求参数

| 字段 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `compositeImage` | `string` | ✅ | canvas 导出的 PNG 合成图，base64 |

#### 请求示例

```typescript
// 从 canvas 导出 base64
const compositeBase64 = canvas.toDataURL('image/png').split(',')[1];

const res = await fetch(`${API_BASE}/api/v2/finalize`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ compositeImage: compositeBase64 }),
});
const data = await res.json();
// data.finalImage — 最终效果图
```

#### 响应参数

| 字段 | 类型 | 说明 |
|------|------|------|
| `finalImage` | `string` | 最终优化后的 PNG 图片，base64 |

#### 响应示例

```json
{
  "finalImage": "iVBORw0KGgo..."
}
```

#### 注意事项

- ⏱ **耗时约 20-40 秒**
- 确保 canvas 合成完整后再调用（所有墙面材质都已叠加）
- 导出时使用 `canvas.toDataURL('image/png')`，并通过 `.split(',')[1]` 去掉 data URI 前缀

---

## 3.7 🚀 批量渲染（一键焕色）

**`POST /api/v2/render-all`**

批量渲染——一次提交所有需要替换材质的区域，后端自动完成全部区域换材质 + 合成 + 最终洗图，返回一张完整的效果图。

#### 请求参数

| 字段 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `enforcedImage` | `string` | ✅ | preprocess 返回的 `enforcedResult`，URL 字符串 |
| `masks` | `string[]` | ✅ | preprocess 返回的 `masks[]` 黑白蒙版数组，每个元素为 URL 字符串 |
| `items` | `array` | ✅ | 要替换的区域列表，不能为空 |
| `items[].x` | `number` | ✅ | 用户点击位置 X 坐标（相对于 enforcedImage 的像素坐标） |
| `items[].y` | `number` | ✅ | 用户点击位置 Y 坐标 |
| `items[].materialImage` | `string` | ✅ | 材质参考图，URL 字符串（如 `/materials/mat (1).png`） |
| `items[].prompt` | `string` | 否 | 该区域的替换提示词（预留字段），默认 `"based on image 2, change all wall material in image 1."` |

#### 请求示例

```typescript
const res = await fetch(`${API_BASE}/api/v2/render-all`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    enforcedImage: preprocessResult.enforcedResult,
    masks: preprocessResult.masks,
    items: [
      {
        x: 320,
        y: 240,
        materialImage: '/materials/mat (1).png',
      },
      {
        x: 800,
        y: 150,
        materialImage: '/materials/mat (2).png',
      },
    ],
  }),
});
const data = await res.json();
// data.finalImage — 完整效果图
```

#### 请求模型

```json
{
  "enforcedImage": "<preprocess返回的enforcedResult, URL 字符串>",
  "masks": [
    "<第1面墙的B&W蒙版 URL>",
    "<第2面墙的B&W蒙版 URL>"
  ],
  "items": [
    {
      "x": 320,
      "y": 240,
      "materialImage": "/materials/mat (1).png",
      "prompt": "based on image 2, change all wall material in image 1."
    },
    {
      "x": 800,
      "y": 150,
      "materialImage": "/materials/mat (2).png"
    }
  ]
}
```

#### 响应参数

| 字段 | 类型 | 说明 |
|------|------|------|
| `finalImage` | `string` | 最终渲染完成的完整效果图，raw base64 PNG。所有指定区域已替换材质并经过最终洗图处理 |

#### 响应示例

```json
{
  "finalImage": "iVBORw0KGgo..."
}
```

#### 内部处理流程

1. 解码 enforcedImage 作为基底图，解码 masks[] 为蒙版图列表
2. 遍历 items，对每个 (x, y) 坐标在蒙版列表中查找白色像素（>128），匹配对应蒙版
3. 去重：如果多个 item 匹配到同一张蒙版，以最后一个 item 的材质和 prompt 为准
4. 逐区域调用 ComfyUI apply-material workflow 生成 RGBA 结果图
5. 将每个 RGBA 结果图通过 alpha 混合叠加到基底图上
6. 运行 finalize workflow 进行最终洗图
7. 返回最终效果图

#### 注意事项

- ⏱ **耗时约 (20-40秒 × 区域数量) + 20-40秒最终洗图**。例如 3 个区域约需 1.5-2.5 分钟
- 🛡️ **Best-effort 模式**：如果某个区域处理失败，后端会跳过该区域继续处理其他区域。只有当所有区域都失败时才返回 500 错误
- `items` 数组不能为空，否则返回 400
- 此接口适合"一键焕色"场景——用户选好所有区域的材质后，一次调用完成全部渲染
- 📐 **坐标说明**：`x`, `y` 为相对于 enforcedImage 的像素坐标，后端会自动 clamp 到图片边界
- 🔀 **去重说明**：多个 items 点击到同一蒙版区域时，以数组中最后一项为准，该区域只渲染一次
- ⚠️ `masks` 必须与 preprocess 返回的完全一致（顺序和内容），后端依赖它来匹配坐标

#### 错误响应

| 状态码 | 说明 |
|--------|------|
| `400` | items 列表为空，或所有坐标均未匹配到任何蒙版区域 |
| `500` | 所有区域渲染均失败 |
| `504` | ComfyUI 处理超时 |

---

### 3.8 ✂️ 区域分割（可选功能）

**`POST /api/v2/split-mask`**

将一个蒙版区域沿指定线段分割为两个独立区域。用于用户需要更细粒度控制时手动分割墙面。

#### 请求参数

| 字段 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `maskImage` | `string` | ✅ | 当前蒙版图的 base64 |
| `targetColor` | `[number, number, number]` | ✅ | 要分割的目标区域颜色 `[R, G, B]` |
| `x1` | `number` | ✅ | 分割线起点 X 坐标 |
| `y1` | `number` | ✅ | 分割线起点 Y 坐标 |
| `x2` | `number` | ✅ | 分割线终点 X 坐标 |
| `y2` | `number` | ✅ | 分割线终点 Y 坐标 |
| `existingColors` | `[number, number, number][]` | ✅ | 已使用的颜色数组，避免新区域颜色冲突 |

#### 请求示例

```typescript
const res = await fetch(`${API_BASE}/api/v2/split-mask`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    maskImage: currentMaskBase64,
    targetColor: [255, 0, 0],
    x1: 100,
    y1: 50,
    x2: 300,
    y2: 400,
    existingColors: [[255, 0, 0], [0, 255, 0], [0, 0, 255]],
  }),
});
const data = await res.json();
```

#### 响应参数

| 字段 | 类型 | 说明 |
|------|------|------|
| `maskImage` | `string` | 更新后的蒙版图 base64，目标区域已被分割为两个不同颜色 |
| `newColor` | `[number, number, number]` | 新分割出的区域所使用的颜色 `[R, G, B]` |

#### 响应示例

```json
{
  "maskImage": "iVBORw0KGgo...",
  "newColor": [255, 255, 0]
}
```

#### 注意事项

- ⚡ 纯像素计算，响应极快（< 100ms）
- 错误码：`422` 分割线未能切分目标区域（线段未穿过该区域或未有效分割）

---

## 4. 图片编码规范

### 格式约定

所有 API 接口中涉及的图片字段均使用 **raw base64** 编码，即：

- ✅ 正确：`iVBORw0KGgoAAAANSUhEUgAA...`
- ❌ 错误：`data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA...`

### 三种获取 base64 的方式

#### 方式一：文件上传（File Input）

```typescript
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      resolve(dataUrl.split(',')[1]); // 去掉 "data:image/xxx;base64," 前缀
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// 使用
const input = document.querySelector<HTMLInputElement>('#file-input');
input.addEventListener('change', async () => {
  const file = input.files?.[0];
  if (file) {
    const base64 = await fileToBase64(file);
    // base64 可直接传给 API
  }
});
```

#### 方式二：URL 下载（材质图片）

```typescript
async function urlToBase64(url: string): Promise<string> {
  const res = await fetch(url);
  const blob = await res.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      resolve(dataUrl.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// 使用：将材质图片 URL 转为 base64
const materialBase64 = await urlToBase64(`${API_BASE}/materials/白色大理石.jpg`);
```

#### 方式三：Canvas 导出

```typescript
function canvasToBase64(canvas: HTMLCanvasElement): string {
  const dataUrl = canvas.toDataURL('image/png');
  return dataUrl.split(',')[1];
}

// 使用：导出合成图供 finalize 接口使用
const compositeBase64 = canvasToBase64(canvasRef.current!);
```

---

## 5. 前端数据类型

以下为推荐的 TypeScript 类型定义：

```typescript
/** 蒙版信息 */
interface MaskInfo {
  /** 该蒙版对应的黑白图 base64 */
  maskData: string;
  /** 在蒙版合成图中的颜色标识 [R, G, B] */
  color: [number, number, number];
  /** 用户选择的材质（可选，未选择时为 null） */
  material: Material | null;
  /** 材质应用后的 RGBA 结果图层 base64 */
  resultLayer: string | null;
}

/** 材质信息 */
interface Material {
  /** 材质显示名称 */
  name: string;
  /** 文件名（含扩展名） */
  filename: string;
  /** 材质图片的相对 URL */
  url: string;
}

/** 预处理响应 */
interface PreprocessResponse {
  enforcedResult: string;
  masks: string[];
}

/** 渲染响应 */
interface RenderResponse {
  resultImage: string;
}

/** 最终渲染响应 */
interface FinalizeResponse {
  finalImage: string;
}

/** 批量渲染请求项 */
interface RenderAllItem {
  /** 用户点击位置 X 坐标（像素坐标） */
  x: number;
  /** 用户点击位置 Y 坐标（像素坐标） */
  y: number;
  /** 材质参考图 URL */
  materialImage: string;
  /** 该区域的替换提示词（可选） */
  prompt?: string;
}

/** 批量渲染响应 */
interface RenderAllResponse {
  /** 最终渲染完成的完整效果图 base64 PNG */
  finalImage: string;
}

/** 区域分割响应 */
interface SplitMaskResponse {
  maskImage: string;
  newColor: [number, number, number];
}
```

---

## 6. 并发控制

### 为什么需要并发控制

`/api/v2/render` 接口在后端是同步处理的 — ComfyUI 同一时刻只能执行一个推理任务。如果前端同时发起多个请求，后端会排队或报错，导致不可预期的行为。

### 互斥锁实现

```typescript
// store.ts (Zustand)
interface AppState {
  isApplying: boolean;
  setIsApplying: (v: boolean) => void;
}

// 在 Zustand store 中管理锁状态
const useStore = create<AppState>((set) => ({
  isApplying: false,
  setIsApplying: (v) => set({ isApplying: v }),
}));
```

### 调用时加锁

```typescript
async function applyMaterial(
  wallIndex: number,
  enforcedImage: string,
  maskImage: string,
  materialImage: string
) {
  const { isApplying, setIsApplying } = useStore.getState();

  // 🔒 检查锁
  if (isApplying) {
    console.warn('有任务正在执行，请等待完成');
    return;
  }

  try {
    setIsApplying(true); // 加锁

    const res = await fetch(`${API_BASE}/api/v2/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enforcedImage, maskImage, materialImage }),
    });

    if (!res.ok) throw new Error(`请求失败: ${res.status}`);

    const data: RenderResponse = await res.json();
    // 处理返回结果，叠加到 canvas ...
    return data.resultImage;
  } finally {
    setIsApplying(false); // 释放锁（无论成功失败）
  }
}
```

### 多面墙顺序处理

当用户选择了多面墙的材质需要一次性应用时，使用队列逐个处理：

```typescript
async function applyAllWalls(walls: Array<{ index: number; mask: string; material: string }>) {
  const { enforcedResult } = useStore.getState();

  for (const wall of walls) {
    await applyMaterial(wall.index, enforcedResult, wall.mask, wall.material);
    // 每面墙完成后更新 UI 进度
  }
}
```

---

## 7. 完整调用示例

以下是一个端到端的 TypeScript 示例，展示从上传图片到获取最终结果的完整流程：

```typescript
const API_BASE = 'http://localhost:8100';

// ==================== 第一步：健康检查 ====================
async function checkHealth(): Promise<boolean> {
  try {
    const res = await fetch(`${API_BASE}/health`);
    const data = await res.json();
    return data.status === 'ok' && data.model_loaded === true;
  } catch {
    return false;
  }
}

// ==================== 第二步：加载材质列表 ====================
async function loadMaterials(): Promise<Material[]> {
  const res = await fetch(`${API_BASE}/api/materials`);
  return res.json();
}

// ==================== 第三步：预处理 ====================
async function preprocess(imageBase64: string): Promise<PreprocessResponse> {
  const res = await fetch(`${API_BASE}/api/v2/preprocess`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image: imageBase64 }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`预处理失败 (${res.status}): ${err.detail || '未知错误'}`);
  }

  return res.json();
}

// ==================== 第四步：逐面墙应用材质 ====================
async function renderWall(
  enforcedImage: string,
  maskImage: string,
  materialImage: string
): Promise<string> {
  const res = await fetch(`${API_BASE}/api/v2/render`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enforcedImage, maskImage, materialImage }),
  });

  if (!res.ok) {
    throw new Error(`渲染失败 (${res.status})`);
  }

  const data: RenderResponse = await res.json();
  return data.resultImage;
}

// ==================== 第五步：最终渲染 ====================
async function finalize(compositeBase64: string): Promise<string> {
  const res = await fetch(`${API_BASE}/api/v2/finalize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ compositeImage: compositeBase64 }),
  });

  if (!res.ok) {
    throw new Error(`最终渲染失败 (${res.status})`);
  }

  const data: FinalizeResponse = await res.json();
  return data.finalImage;
}

// ==================== 完整流程 ====================
async function fullWorkflow(imageFile: File) {
  // 1. 检查后端
  const healthy = await checkHealth();
  if (!healthy) throw new Error('后端服务不可用');

  // 2. 加载材质列表
  const materials = await loadMaterials();
  console.log(`可用材质: ${materials.length} 种`);

  // 3. 读取用户上传的图片
  const imageBase64 = await fileToBase64(imageFile);

  // 4. 预处理（约 2-3 分钟）
  console.log('开始预处理...');
  const { enforcedResult, masks } = await preprocess(imageBase64);
  console.log(`预处理完成，识别到 ${masks.length} 面墙`);

  // 5. 创建 canvas 并绘制增强底图
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  const baseImg = new Image();
  await new Promise<void>((resolve) => {
    baseImg.onload = () => {
      canvas.width = baseImg.width;
      canvas.height = baseImg.height;
      ctx.drawImage(baseImg, 0, 0);
      resolve();
    };
    baseImg.src = `data:image/png;base64,${enforcedResult}`;
  });

  // 6. 逐面墙应用材质（串行处理）
  for (let i = 0; i < masks.length; i++) {
    // 假设用户为每面墙选择了材质
    const selectedMaterial = materials[i % materials.length];
    const materialBase64 = await urlToBase64(`${API_BASE}${selectedMaterial.url}`);

    console.log(`正在渲染第 ${i + 1}/${masks.length} 面墙...`);
    const resultLayer = await renderWall(enforcedResult, masks[i], materialBase64);

    // 叠加到 canvas
    const layerImg = new Image();
    await new Promise<void>((resolve) => {
      layerImg.onload = () => {
        ctx.drawImage(layerImg, 0, 0);
        resolve();
      };
      layerImg.src = `data:image/png;base64,${resultLayer}`;
    });
  }

  // 7. 最终渲染
  console.log('开始最终渲染...');
  const compositeBase64 = canvas.toDataURL('image/png').split(',')[1];
  const finalImage = await finalize(compositeBase64);

  console.log('完成！');
  return finalImage;
}
```

### 方案 B: 批量渲染（一次性完成所有区域）

```typescript
// 方案 B: 批量渲染（一次性完成所有区域）
async function handleRenderAll(
  enforcedResult: string,
  masks: string[],
  assignments: Array<{ x: number; y: number; materialUrl: string }>
) {
  const response = await fetch(`${API_BASE}/api/v2/render-all`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      enforcedImage: enforcedResult,
      masks: masks,
      items: assignments.map(a => ({
        x: a.x,
        y: a.y,
        materialImage: a.materialUrl,
      })),
    }),
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(`批量渲染失败 (${response.status}): ${err.detail || '未知错误'}`);
  }

  const { finalImage } = await response.json();
  return finalImage;
}
```

---

## 8. 性能指标

| 接口 | 方法 | 平均耗时 | 说明 |
|------|------|----------|------|
| `/health` | GET | < 100ms | 简单状态检查 |
| `/api/materials` | GET | < 100ms | 读取文件列表 |
| `/materials/{filename}` | GET | < 100ms | 静态文件服务 |
| `/api/v2/preprocess` | POST | **2-3 分钟** | 包含多轮 AI 推理 + SAM3 分割 |
| `/api/v2/render` | POST | **20-40 秒** | 单面墙 ComfyUI 推理 |
| `/api/v2/finalize` | POST | **20-40 秒** | 最终优化渲染 |
| `/api/v2/render-all` | POST | **(20-40s × N) + 20-40s** | N 个区域串行处理 + 最终洗图 |
| `/api/v2/split-mask` | POST | < 100ms | 纯像素计算 |

> 💡 **提示**：对于耗时较长的接口（preprocess、render、finalize），前端应展示加载状态和进度提示，提升用户体验。

---

## 9. 错误处理

### 通用错误响应格式

```json
{
  "detail": "错误描述信息"
}
```

### HTTP 状态码说明

| 状态码 | 含义 | 常见场景 |
|--------|------|----------|
| `200` | 成功 | 请求正常处理完成 |
| `422` | 参数校验错误 | 缺少必填字段、base64 格式无效、split-mask 分割线无效 |
| `500` | 服务器内部错误 | AI 推理失败、ComfyUI 异常、SAM3 服务不可用 |
| `504` | 网关超时 | render 接口超过 10 分钟未返回 |

### 前端错误处理模板

```typescript
async function safeApiCall<T>(url: string, options: RequestInit): Promise<T> {
  let res: Response;

  try {
    res = await fetch(url, options);
  } catch (e) {
    throw new Error('网络错误：无法连接到后端服务，请确认后端是否启动');
  }

  if (!res.ok) {
    let detail = '未知错误';
    try {
      const err = await res.json();
      detail = err.detail || detail;
    } catch {}

    switch (res.status) {
      case 422:
        throw new Error(`参数错误: ${detail}`);
      case 500:
        throw new Error(`服务器错误: ${detail}`);
      case 504:
        throw new Error('请求超时，请稍后重试');
      default:
        throw new Error(`请求失败 (${res.status}): ${detail}`);
    }
  }

  return res.json();
}
```

### 常见问题 FAQ

**Q: 预处理接口返回 500 错误**
A: 检查后端日志，常见原因：
- ComfyUI 服务未启动或连接失败
- SAM3 分割服务不可用
- GPU 显存不足

**Q: render 接口返回 504 超时**
A: ComfyUI 推理可能因 GPU 负载高导致超时。建议：
- 确保没有其他 GPU 任务在运行
- 检查 ComfyUI 进程是否正常

**Q: 图片上传后接口报 422**
A: 确认 base64 字符串：
- 不包含 `data:image/...;base64,` 前缀
- 字符串编码完整，未被截断
- 原图格式为常见格式（JPG/PNG）

**Q: canvas 合成图颜色不对**
A: 确保使用 `canvas.toDataURL('image/png')` 导出，不要使用 JPEG（会丢失 alpha 通道）。

---

## 10. 废弃接口

以下接口已被 v2 版本替代，**请勿使用**：

| 废弃接口 | 替代方案 |
|----------|----------|
| `POST /enhance` | `POST /api/v2/preprocess` |
| `POST /process-masks` | `POST /api/v2/preprocess` |
| `POST /process-upload` | `POST /api/v2/preprocess` |
| `POST /debug-segment` | `POST /api/v2/preprocess` |
| `POST /apply-material` | `POST /api/v2/render` |
| `POST /finalize` | `POST /api/v2/finalize` |
| `POST /api/v2/segment` | `POST /api/v2/preprocess` |

> ⚠️ 废弃接口可能在未来版本中被移除，请尽快迁移到 v2 接口。
