# SignBridge AI (手语桥) 🧠👋

SignBridge AI 是一款基于 Google Gemini AI 视觉能力的实时手语翻译应用。它能够通过摄像头捕捉动态手势，并将其转化为文本和语音，致力于消除听障人士与外部世界的沟通隔阂。

## ✨ 核心特性

- **实时视觉识别**：利用 Gemini 多模态模型，秒级识别视频流手势。
- **双模式语音合成**：内置系统语音与 AI 高清语音（TTS）支持。
- **历史记录跟踪**：自动保存对话流，支持一键清空与回溯。
- **跨平台视频录制**：内置会话录制功能，方便查看识别过程。
- **高度可定制**：
  - 支持自定义 API 代理及模型（如 DeepSeek 等）。
  - 可调置信度阈值，过滤无效干扰。
- **隐私保护**：视频流本地处理，仅按需发送关键帧至 AI 加密接口。

## 🚀 部署指南

### 1. 环境变量配置
在部署或运行前，请确保设置以下环境变量（在 AI Studio 中可通过 **Secrets** 面板配置）：

- `GEMINI_API_KEY`: 您的 Google AI 密钥。
- `VITE_CUSTOM_API_URL` (可选): 如果您使用中转 API，可以在设置界面配置。

### 2. 本地开发
如果您希望在本地运行此项目：

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev
```

### 3. 构建发布
执行以下命令生成生产环境静态文件：

```bash
npm run build
```
生成的 `dist` 目录可部署于任何静态托管服务（Vercel, Netlify, Cloudflare Pages 等）。

## 💡 使用技巧

1. **光线与背景**：请确保面部和手部光线均匀，背景尽量简洁。
2. **手势区域**：将手部尽量保持在画面中央的 **绿色方框** 内。
3. **停顿识别**：做一个手势后稍作停顿（约1秒），系统捕捉更准确。
4. **API 设置**：
   - 点击右上角 **齿轮图标** 进入设置。
   - 建议将 `Confidence Threshold`（置信度）设为 `60-70%` 以平衡准确度。

## 🛠️ 技术栈

- **前端**: React 19 + TypeScript + Vite
- **动画**: Motion (Framer Motion)
- **图标**: Lucide React
- **AI 引擎**: Google Generative AI (Gemini Flash)
- **样式**: Tailwind CSS (Modern Utility-first)

## ⚖️ 开源协议
本项目采用 [Apache-2.0](LICENSE) 协议发布。
