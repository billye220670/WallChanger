# WallChanger V2 API 对接文档

> Base URL: `http://<host>:8100`
>
> Content-Type: `application/json`
>
> 所有图片字段均为 **raw base64 字符串**（不带 `data:image/...;base64,` 前缀）

---

## 整体流程

```
步骤1                          步骤1.5（可选）                步骤2
POST /api/v2/segment           POST /api/v2/split-mask        POST /api/v2/render
上传原图 ──────────────► 拿到 masks ──────────► 细分区域 ──────────────► 最终成图
                         + refinedMask          (可多次调用)
                         + enhancedImage
```

调用方拿到步骤1的返回后，可通过步骤1.5将某一区域用一条线分割成两个子区域（例如将一面大墙分成左右两块贴不同材质）。步骤1.5可连续调用多次。确认区域划分后，进入步骤2完成最终渲染。

---

## 1. 分割识别 — `POST /api/v2/segment`

上传一张室内照片，后端自动完成：增强 → 清理 → 墙面分割 → mask精修，返回可用的区域信息。

### 请求

```json
{
  "image": "<base64 string>",
  "promptEnhance": "Realistic render",
  "promptClean": "empty room",
  "promptRefine": "Remove all black outlines..."
}
```

| 字段 | 类型 | 必须 | 默认值 | 说明 |
|------|------|------|--------|------|
| `image` | string | **是** | — | 原始图片的 base64 编码（jpg/png 均可） |
| `promptEnhance` | string | 否 | `"Realistic render"` | 增强阶段的提示词 |
| `promptClean` | string | 否 | `"empty room"` | 清理阶段的提示词（去除家具杂物） |
| `promptRefine` | string | 否 | *(见下方)* | mask精修阶段的提示词 |

> `promptRefine` 默认值：`"Remove all black outlines and black boundary lines between color regions. Make each colored area fill seamlessly to their edges without any black gaps, borders, or outlines. The result should have clean, sharp color boundaries where colors meet directly with no black separation lines."`

### 响应

```json
{
  "enhancedImage": "<base64 JPEG>",
  "refinedMask": "<base64 PNG>",
  "rawMask": "<base64 PNG>",
  "masks": [
    { "id": 0, "label": "wall", "color": [255, 0, 0] },
    { "id": 1, "label": "wall", "color": [0, 255, 0] }
  ]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `enhancedImage` | string | 增强后的图片（base64 JPEG），可用于步骤2的 `image` 入参 |
| `refinedMask` | string | 精修后的分割 mask 图（base64 PNG），**传给步骤2** |
| `rawMask` | string | 原始 SAM3 分割 mask 图（base64 PNG），仅供参考/调试 |
| `masks` | array | 检测到的区域列表 |
| `masks[].id` | int | 区域编号 |
| `masks[].label` | string | 区域标签（如 `"wall"`） |
| `masks[].color` | int[3] | 该区域在 mask 图中的 RGB 颜色，**用于步骤2中指定 `maskColor`** |

> **关键**：`masks[].color` 是步骤1和步骤2之间的对应桥梁。步骤2的 `regions[].maskColor` 必须与这里返回的颜色对应。

### 示例

```bash
curl -X POST http://localhost:8100/api/v2/segment \
  -H "Content-Type: application/json" \
  -d '{
    "image": "'$(base64 -w0 room.jpg)'"
  }'
```

---

## 1.5 区域细分（可选）— `POST /api/v2/split-mask`

在步骤1和步骤2之间可选调用。用一条直线将 mask 图中某个颜色区域分成两个子区域，返回更新后的 mask 图和新区域颜色。可多次调用以进一步细分。

> **注意**：这是纯像素计算，不调用 AI 模型，响应速度极快（毫秒级）。

### 请求

```json
{
  "maskImage": "<base64 PNG>",
  "targetColor": [255, 0, 0],
  "x1": 100,
  "y1": 50,
  "x2": 300,
  "y2": 400,
  "existingColors": [
    [255, 0, 0],
    [0, 255, 0]
  ]
}
```

| 字段 | 类型 | 必须 | 说明 |
|------|------|------|------|
| `maskImage` | string | **是** | 当前 mask 图的 base64 PNG（步骤1返回的 `refinedMask`，或上次 split 返回的 `maskImage`） |
| `targetColor` | int[3] | **是** | 要分割的区域颜色 RGB，对应 `masks[].color` |
| `x1`, `y1` | int | **是** | 分割线起点坐标（**mask 图像素坐标系**） |
| `x2`, `y2` | int | **是** | 分割线终点坐标（**mask 图像素坐标系**） |
| `existingColors` | int[3][] | 否 | 当前所有已有 mask 颜色，用于生成不撞色的新颜色（不传则默认只避开 targetColor） |

> **线的方向**：分割线有方向性。`(x1,y1)→(x2,y2)` 方向右侧的像素（叉积 < 0）被分配新颜色；左侧保持原颜色。

### 响应

```json
{
  "maskImage": "<base64 PNG>",
  "newColor": [128, 64, 200]
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `maskImage` | string | 更新后的 mask 图（base64 PNG），用于传给步骤2或下一次 split |
| `newColor` | int[3] | 新子区域的 RGB 颜色（侧 B），可存为新的 mask 条目 |

### 错误

| 状态码 | 原因 |
|--------|------|
| `422` | 分割线未能分开目标区域（所有像素都在同侧），或目标颜色在 mask 图中不存在 |

### 示例

```bash
curl -X POST http://localhost:8100/api/v2/split-mask \
  -H "Content-Type: application/json" \
  -d '{
    "maskImage": "<步骤1返回的refinedMask>",
    "targetColor": [255, 0, 0],
    "x1": 100, "y1": 0,
    "x2": 100, "y2": 600,
    "existingColors": [[255,0,0],[0,255,0]]
  }'
```

---

## 2. 渲染出图 — `POST /api/v2/render`

将步骤1（或多次 split 后）的 mask 图 + 用户点击的坐标 + 每个区域的参考图/提示词提交，后端自动识别坐标对应的 mask 区域，并行替换材质，合成后最终洗图输出。

### 请求

```json
{
  "image": "<base64 string>",
  "refinedMask": "<base64 PNG>",
  "items": [
    {
      "x": 320,
      "y": 240,
      "referenceImage": "<base64 string>",
      "prompt": "based on image 2, change all wall material in image 1."
    },
    {
      "x": 800,
      "y": 150,
      "referenceImage": "<base64 string>",
      "prompt": "based on image 2, change wall to wood panel in image 1."
    }
  ],
  "promptFinalize": "realistic render"
}
```

#### 顶层字段

| 字段 | 类型 | 必须 | 默认值 | 说明 |
|------|------|------|--------|------|
| `image` | string | **是** | — | 原图或增强图的 base64（建议用步骤1返回的 `enhancedImage`） |
| `refinedMask` | string | **是** | — | 步骤1返回的 `refinedMask`，原样传入 |
| `items` | array | **是** | — | 要替换的区域列表，每项包含点击坐标 + 参考图 + 提示词 |
| `promptFinalize` | string | 否 | `"realistic render"` | 最终洗图阶段的提示词 |

#### `items[]` 子字段

| 字段 | 类型 | 必须 | 默认值 | 说明 |
|------|------|------|--------|------|
| `x` | int | **是** | — | 用户点击位置的 X 坐标（相对于 `image` 图片像素坐标） |
| `y` | int | **是** | — | 用户点击位置的 Y 坐标（相对于 `image` 图片像素坐标） |
| `referenceImage` | string | **是** | — | 材质参考图片的 base64 编码 |
| `prompt` | string | 否 | `"based on image 2, change all wall material in image 1."` | 该区域的替换提示词 |

> **说明**：
> - 后端自动根据 `(x, y)` 在 `refinedMask` 上采样颜色，识别对应的区域，无需调用方了解 mask 颜色体系。
> - 若多个 `items` 点击到同一 mask 颜色区域，以数组中最后一项的参考图和提示词为准，该区域只生成一次。
> - 多个区域会**并行处理**，不会串行等待。

### 响应

```json
{
  "finalImage": "<base64 PNG>"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `finalImage` | string | 最终渲染完成的图片（base64 PNG） |

### 示例

```bash
curl -X POST http://localhost:8100/api/v2/render \
  -H "Content-Type: application/json" \
  -d '{
    "image": "'$(base64 -w0 room.jpg)'",
    "refinedMask": "<步骤1返回的refinedMask>",
    "items": [
      {
        "x": 320,
        "y": 240,
        "referenceImage": "'$(base64 -w0 marble.jpg)'",
        "prompt": "based on image 2, change all wall material in image 1."
      }
    ]
  }'
```

---

## 错误响应

所有接口错误统一返回 JSON：

```json
{ "detail": "错误描述" }
```

| HTTP 状态码 | 场景 |
|-------------|------|
| `400` | 请求参数缺失或格式错误 |
| `422` | JSON 字段校验失败（Pydantic） |
| `500` | 模型推理失败 / SAM3 未检测到区域 |

---

## 健康检查

```
GET /health
```

```json
{ "status": "ok", "model_loaded": true }
```

---

## 注意事项

1. **图片格式**：所有 base64 字段传 raw base64，不要带 `data:image/png;base64,` 前缀
2. **超时**：单次生图约 20-40s，步骤1包含4次生图调用总计约 2-3 分钟，步骤2取决于区域数（并行，耗时≈单次生图时间+最终洗图时间）
3. **坐标需在图片范围内**：`items[].x` / `items[].y` 为相对于 `image` 的像素坐标，超出范围会被自动 clamp 到边界
4. **同区域去重**：多个 `items` 点击同一 mask 颜色，只生成一次，使用数组中最后一项的参考图和提示词
