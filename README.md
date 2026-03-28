# WallChanger

室内材质替换 AI 应用 - 本地运行版本

## 功能

- 上传室内照片
- AI 自动识别墙面、地板、天花板等区域
- 拖拽材质球到对应区域进行材质替换
- 一键生成最终渲染效果

## 技术栈

- **后端**: Python FastAPI + SAM3 + Flux Klein 4B API
- **前端**: React + TypeScript + Vite + Tailwind CSS + Zustand

## 环境要求

- Python 3.9+
- Node.js 18+
- SAM3 已部署在本机 (C:/Users/Tintt/Documents/SAM3D)
- FAL API Key

## 安装步骤

### 1. 后端设置

```bash
cd backend
pip install -r requirements.txt
```

创建 `.env` 文件（参考 `.env.example`）:

```
FAL_KEY=your_fal_api_key_here
SAM3D_PATH=C:/Users/Tintt/Documents/SAM3D
MATERIALS_PATH=../public/materials
```

### 2. 前端设置

```bash
npm install
```

### 3. 材质库设置

将材质图片（512×512，jpg/png/webp）放入 `public/materials/` 文件夹

## 启动应用

### 方式一：一键启动（推荐）

双击 `start.bat`

### 方式二：分别启动

**终端 1 - 后端**:
```bash
cd backend
python main.py
```

**终端 2 - 前端**:
```bash
npm run dev
```

## 访问

- **电脑访问**: http://localhost:5173
- **手机访问**:
  1. 确保手机和电脑在同一 WiFi
  2. 在应用设置中填入电脑本机 IP (如 http://192.168.1.x:8100)
  3. 手机浏览器访问 http://192.168.1.x:5173

## 使用流程

1. 上传室内照片
2. 等待 AI 处理（约 1 分钟）
3. 从底部抽屉拖拽材质到墙面
4. 点击"一键焕色"生成最终效果
5. 保存图片

## 注意事项

- 首次启动后端需要加载 SAM3 模型（约 10-30 秒）
- 确保 FAL API Key 有效
- 材质图片建议 512×512 尺寸
