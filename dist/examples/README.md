# 官方案例目录

每个案例一个子目录，命名为 `example1`、`example2` 等。

## 文件格式要求

每个子目录包含：
- `original.jpg` — 原始室内照片
- `mask.png` — 彩色分区掩码图

## mask.png 格式要求

- 必须是 **PNG** 格式（保留精确颜色，无压缩损失）
- 每个可编辑区域使用**唯一的纯色 RGB**（如红、绿、蓝等）
- 背景/不可编辑区域使用**纯黑色** `(0, 0, 0)`
- 尺寸与 `original.jpg` 完全相同

## 添加新案例

1. 在此目录下新建文件夹（如 `example4/`）
2. 放入 `original.jpg` 和 `mask.png`
3. 在 `src/components/ExamplesDrawer.tsx` 的 `EXAMPLES` 数组中添加对应条目
