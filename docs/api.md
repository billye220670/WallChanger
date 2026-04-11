# WallChanger 后端接口文档

> 后端地址默认：`http://localhost:8100`  
> 所有图片字段均为 **raw base64**（不含 `data:image/...;base64,` 前缀）  
> 所有接口均返回 `Content-Type: application/json`

---

## 目录

- [通用说明](#通用说明)
- [工具接口](#工具接口)
  - [GET /health](#get-health)
  - [GET /api/materials](#get-apimaterials)
  - [GET /materials/{filename}](#get-materialsfilename)
- [主流程接口（当前使用）](#主流程接口当前使用)
  - [POST /api/v2/preprocess](#post-apiv2preprocess)
  - [POST /api/v2/render](#post-apiv2render)
  - [POST /api/v2/apply-material](#post-apiv2apply-material)
  - [POST /api/v2/finalize](#post-apiv2finalize)
- [废弃接口（保留兼容，不建议新调用）](#废弃接口保留兼容不建议新调用)

---

## 通用说明

### 图片编码

所有图片字段传 **raw base64 字符串**，不带 data URI 前缀。

```
// 正确
"image": "iVBORw0KGgoAAAANSUhEUgAA..."

// 错误
"image": "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAA..."
```

后端接受带前缀的字符串（会自动剥离），但建议统一传 raw base64。

### 同步约束

`/api/v2/render` 底层调用 ComfyUI，**同一时刻只能有一个任务在跑**。  
前端必须等上一次调用返回后，才能发起下一次。（store 里的 `isApplying` 互斥锁已处理此逻辑。）

### 错误格式

```json
{ "detail": "错误描述" }
```

常见 HTTP 状态码：
- `422` — 参数校验失败（如线段未切分区域）
- `504` — ComfyUI 超时（默认等待上限 10 分钟）
- `500` — ComfyUI 未返回图片

---

## 工具接口

### GET /health

检查后端是否在线。

**响应**

```json
{
  "status": "ok",
  "model_loaded": true
}
```

---

### GET /api/materials

获取材质球列表。材质文件存放在 `public/materials/`，支持 `.jpg` `.jpeg` `.png` `.webp`。

**响应**

```json
[
  {
    "name": "白色乳胶漆",
    "filename": "白色乳胶漆.jpg",
    "url": "/materials/白色乳胶漆.jpg"
  }
]
```

---

### GET /materials/{filename}

直接获取材质图片文件（静态资源）。

```
GET /materials/白色乳胶漆.jpg
```

前端用这个 URL 展示材质缩略图，也用来把材质图转成 base64 传给 apply-material。

---

## 主流程接口（当前使用）

### POST /api/v2/preprocess

**用途：** 用户上传图片后的第一步。调用 ComfyUI 多乐士蒙版识别 workflow，返回增强后的场景图（EnforcedResult）和每个墙面区域的独立黑白蒙版图。

**请求**

```json
{
  "image": "<raw base64>"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| image | string | 用户上传的原始图片，raw base64，支持 JPEG/PNG |

**响应**

```json
{
  "enforcedResult": "<raw base64 PNG>",
  "masks": [
    "<raw base64 PNG>",
    "<raw base64 PNG>"
  ]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| enforcedResult | string | 增强后的场景图（PNG），用于替换显示的原图，也是后续 apply-material 的输入 |
| masks | string[] | 黑白蒙版图数组，每张对应一个墙面区域。白色像素 = 该区域，黑色 = 非该区域。尺寸与 enforcedResult 一致 |

**注意**
- `masks` 数组长度 = 识别到的墙面区域数量，可能为 0（未识别到墙面）
- 前端根据数组索引生成 `MaskInfo`（id = index，颜色由前端随机生成）
- 耗时较长（ComfyUI 处理），建议前端显示 loading 状态

---

### POST /api/v2/render

**用途：** 用户把材质球拖到某个墙面区域后调用。传入场景图、该区域的黑白蒙版、材质参考图，返回带透明通道的换材质结果图，叠加到 canvas 上。

**请求**

```json
{
  "enforcedImage": "<raw base64 PNG>",
  "maskImage": "<raw base64 PNG>",
  "materialImage": "<raw base64 PNG>"
}
```

| 字段 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `enforcedImage` | string | **是** | preprocess 返回的 `enforcedResult`，raw base64 PNG |
| `maskImage` | string | **是** | 目标区域的黑白蒙版图（`masks` 数组中对应的那张），raw base64 PNG。白色像素 = 该区域 |
| `materialImage` | string | **是** | 材质参考图，raw base64（从 `/materials/{filename}` 下载后转 base64）|

**响应**

```json
{
  "resultImage": "<raw base64 PNG>"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `resultImage` | string | 带 alpha 通道的 RGBA PNG。只有目标墙面区域有像素，其余为透明。直接 `ctx.drawImage` 叠在 canvas 上即可 |

**前端合成方式**

```typescript
const img = new Image()
img.onload = () => {
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
}
img.src = `data:image/png;base64,${result.resultImage}`
```

**注意**
- 同步接口，必须等返回后才能发起下一次调用
- 前端用 `isApplying` 互斥锁控制，拖拽时如果 `isApplying === true` 直接忽略
- 该接口同时支持别名 `POST /api/v2/apply-material`，入参出参完全一致

---

### POST /api/v2/apply-material

**用途：** 用户把材质球拖到某个墙面区域后调用。与 `/api/v2/render` 功能完全相同，两个 URL 可互换使用。传入场景图、该区域的黑白蒙版、材质参考图，返回带透明通道的换材质结果图。

**请求**

```json
{
  "enforcedImage": "<raw base64 PNG>",
  "maskImage": "<raw base64 PNG>",
  "materialImage": "<raw base64 PNG>"
}
```

| 字段 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `enforcedImage` | string | **是** | preprocess 返回的 `enforcedResult`，raw base64 PNG |
| `maskImage` | string | **是** | 目标区域的黑白蒙版图（`masks` 数组中对应的那张），raw base64 PNG。白色像素 = 该区域 |
| `materialImage` | string | **是** | 材质参考图，raw base64（从 `/materials/{filename}` 下载后转 base64）|

**响应**

```json
{
  "resultImage": "<raw base64 PNG>"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `resultImage` | string | 带 alpha 通道的 RGBA PNG。只有目标墙面区域有像素，其余为透明。直接 `ctx.drawImage` 叠在 canvas 上即可 |

**前端合成方式**

```typescript
const img = new Image()
img.onload = () => {
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
}
img.src = `data:image/png;base64,${result.resultImage}`
```

**注意**
- 同步接口，必须等返回后才能发起下一次调用
- 前端用 `isApplying` 互斥锁控制，拖拽时如果 `isApplying === true` 直接忽略

---

### POST /api/v2/finalize

**用途：** 用户点击「一键焕色」后调用。传入所有区域换材质后的合成图，返回最终渲染结果。

**请求**

```json
{
  "compositeImage": "<raw base64 PNG>"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| compositeImage | string | canvas 当前状态导出的 PNG，raw base64（`canvas.toDataURL('image/png').split(',')[1]`）|

**响应**

```json
{
  "finalImage": "<raw base64 PNG>"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| finalImage | string | 最终渲染图，raw base64 PNG，直接展示给用户 |

---

## 废弃接口（保留兼容，不建议新调用）

以下接口为旧流程遗留，后端保留但前端不再使用：

| 接口 | 说明 |
|------|------|
| `POST /enhance` | 旧增强步骤（Flux2） |
| `POST /process-masks` | 旧蒙版处理（SAM3 + Flux2 refine） |
| `POST /process-upload` | 旧一体化预处理 |
| `POST /debug-segment` | 调试用 SAM3 直接分割 |
| `POST /apply-material` | 旧换材质（Flux2，无蒙版） |
| `POST /finalize` | 旧最终渲染（Flux2） |
| `POST /api/v2/segment` | 旧 headless 分割 |
| `POST /api/v2/split-mask` | 旧彩色蒙版切分（新流程在前端做，不再调后端）|

---

## 完整流程示意

```
1. 用户上传图片
        ↓
2. POST /api/v2/preprocess
   → enforcedResult（替换显示图）
   → masks[]（每个墙面一张黑白蒙版）
        ↓
3. 用户拖材质球到墙面（可多次）
   POST /api/v2/render（同步，逐个执行）
   → resultImage（RGBA PNG，叠加到 canvas）
        ↓
4. 用户点击「一键焕色」
   POST /api/v2/finalize
   → finalImage（最终展示）
```
