/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Camera, CameraOff, Languages, Volume2, History, Trash2, Loader2, Sparkles, Info, Settings, X, ChevronDown, Globe, Key, Cpu, Undo2, Video, Square, Download } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { translateSignLanguage, generateSpeech, AIConfig } from './services/aiService';

// --- Types ---
interface TranslationItem {
  id: string;
  text: string;
  timestamp: number;
}

export default function App() {
  // --- State ---
  const [isCameraActive, setIsCameraActive] = useState(false);
  const [isTranslating, setIsTranslating] = useState(false);
  const [currentTranslation, setCurrentTranslation] = useState<string>("");
  const [confidence, setConfidence] = useState<number>(0);
  const [handBox, setHandBox] = useState<[number, number, number, number] | null>(null);
  const [history, setHistory] = useState<TranslationItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isProcessingFrame, setIsProcessingFrame] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordedVideoUrl, setRecordedVideoUrl] = useState<string | null>(null);
  const [isAutoSpeakEnabled, setIsAutoSpeakEnabled] = useState(true);
  const [voiceMode, setVoiceMode] = useState<'system' | 'ai'>('system');
  const [lastTranslatedId, setLastTranslatedId] = useState<string>("");
  const [showShutter, setShowShutter] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [aiConfig, setAiConfig] = useState<AIConfig>(() => {
    const saved = localStorage.getItem('signbridge_ai_config');
    if (saved) {
      try {
        return JSON.parse(saved);
      } catch (e) {
        console.error("Failed to parse saved AI config", e);
      }
    }
    return {
      provider: 'gemini',
      apiKey: '',
      model: 'gemini-3-flash-preview',
      confidenceThreshold: 50,
      contextWindowSize: 3
    };
  });
  const [debugInfo, setDebugInfo] = useState<{ fps: number; lastCapture: string; apiStatus: 'idle' | 'testing' | 'ok' | 'error' }>({ 
    fps: 0, 
    lastCapture: "Never",
    apiStatus: 'idle'
  });

  // --- Refs ---
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const translationTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const lastFrameTimeRef = useRef<number>(performance.now());

  useEffect(() => {
    localStorage.setItem('signbridge_ai_config', JSON.stringify(aiConfig));
  }, [aiConfig]);

  // --- Camera Logic ---
  useEffect(() => {
    if (isCameraActive && videoRef.current && streamRef.current && videoRef.current.srcObject !== streamRef.current) {
      videoRef.current.srcObject = streamRef.current;
      videoRef.current.onloadedmetadata = () => {
        videoRef.current?.play().catch(e => console.error("Video play failed:", e));
      };
    }
  }, [isCameraActive]);

  const startCamera = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ 
        video: { 
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 720 }
        } 
      });
      
      streamRef.current = stream;
      setIsCameraActive(true);
      setError(null);
    } catch (err: any) {
      console.error("Error accessing camera:", err);
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setError("摄像头访问被拒绝。请点击浏览器地址栏左侧的“锁”图标，将“摄像头”权限设为“允许”，然后刷新页面。");
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        setError("未找到摄像头设备。请检查设备连接。");
      } else {
        setError("无法访问摄像头。请确保已授予权限并使用 HTTPS 连接。");
      }
    }
  };

  const stopCamera = () => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
    setIsCameraActive(false);
    stopTranslation();
    stopRecording();
  };

  const startRecording = () => {
    if (!videoRef.current?.srcObject) return;
    
    const stream = videoRef.current.srcObject as MediaStream;
    const mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    
    recordedChunksRef.current = [];
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        recordedChunksRef.current.push(event.data);
      }
    };
    
    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunksRef.current, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      setRecordedVideoUrl(url);
    };
    
    mediaRecorder.start();
    mediaRecorderRef.current = mediaRecorder;
    setIsRecording(true);
    setRecordedVideoUrl(null);
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  };

  const downloadRecording = () => {
    if (!recordedVideoUrl) return;
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = recordedVideoUrl;
    a.download = `sign-bridge-session-${new Date().getTime()}.webm`;
    document.body.appendChild(a);
    a.click();
    // We don't revoke immediately to allow multiple downloads if needed, 
    // but in a real app we might want to manage this better.
  };

  // --- Translation Logic ---
  const captureFrame = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return null;
    
    const canvas = canvasRef.current;
    const video = videoRef.current;
    
    // Set canvas size to match video
    canvas.width = video.videoWidth || 640;
    canvas.height = video.videoHeight || 480;
    
    if (video.readyState < 2) {
      console.warn("Video not ready for capture (readyState < 2)");
      return null;
    }
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    
    setDebugInfo(prev => ({ ...prev, lastCapture: new Date().toLocaleTimeString() }));
    
    // Convert to base64 jpeg
    return canvas.toDataURL('image/jpeg', 0.7).split(',')[1];
  }, []);

  // --- Translation Loop ---
  useEffect(() => {
    let timeoutId: NodeJS.Timeout;

    const runLoop = async () => {
      if (!isTranslating || !isCameraActive || isProcessingFrame) {
        timeoutId = setTimeout(runLoop, 1000);
        return;
      }

      const frameData = captureFrame();
      if (!frameData) {
        timeoutId = setTimeout(runLoop, 1000);
        return;
      }

      setIsProcessingFrame(true);
      setShowShutter(true);
      setTimeout(() => setShowShutter(false), 150);

      const now = performance.now();
      const diff = now - lastFrameTimeRef.current;
      const currentFps = diff > 0 ? 1000 / diff : 0;
      lastFrameTimeRef.current = now;
      setDebugInfo(prev => ({ ...prev, fps: parseFloat(currentFps.toFixed(1)) }));

      try {
        const prevContext = history.slice(-aiConfig.contextWindowSize).map(h => h.text);
        const result = await translateSignLanguage(frameData, aiConfig, prevContext);
        
        const cleanResult = result.text.trim();
        setConfidence(result.confidence);
        setHandBox(result.handBox || null);

        if (cleanResult && cleanResult !== "正在分析..." && cleanResult !== "Error interpreting sign") {
          if (result.confidence >= aiConfig.confidenceThreshold) {
            setCurrentTranslation(cleanResult);
            if (isAutoSpeakEnabled) speak(cleanResult);
            
            const newId = Date.now().toString();
            setLastTranslatedId(newId);
            setHistory(prev => {
              const last = prev[0];
              if (last && last.text === cleanResult) return prev;
              return [{ id: newId, text: cleanResult, timestamp: Date.now() }, ...prev].slice(0, 50);
            });
          }
        }
      } catch (err: any) {
        console.error("Translation loop error:", err);
        if (err.message === "API_KEY_MISSING") {
          setError("API Key 未配置。请点击右上角齿轮设置，或在 Secrets 中设置 GEMINI_API_KEY。");
          setIsTranslating(false);
          return;
        }
      } finally {
        setIsProcessingFrame(false);
        timeoutId = setTimeout(runLoop, 3000);
      }
    };

    if (isTranslating && isCameraActive) {
      runLoop();
    }

    return () => {
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [isTranslating, isCameraActive, aiConfig, isAutoSpeakEnabled, captureFrame]); // Remove history and isProcessingFrame to stabilize

  const startTranslation = () => {
    if (!isCameraActive) return;
    setIsTranslating(true);
    setError(null);
  };

  const stopTranslation = () => {
    setIsTranslating(false);
  };

  const clearHistory = () => {
    setHistory([]);
    setCurrentTranslation("");
  };

  const undoLastTranslation = () => {
    setHistory(prev => {
      if (prev.length === 0) return prev;
      const newHistory = prev.slice(1);
      setCurrentTranslation(newHistory.length > 0 ? newHistory[0].text : "");
      return newHistory;
    });
  };

  const testConnection = async () => {
    setDebugInfo(prev => ({ ...prev, apiStatus: 'testing' }));
    try {
      // Simple test call
      const result = await translateSignLanguage("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", aiConfig, []); // Tiny transparent gif
      if (result) {
        setDebugInfo(prev => ({ ...prev, apiStatus: 'ok' }));
        setTimeout(() => setDebugInfo(prev => ({ ...prev, apiStatus: 'idle' })), 3000);
      }
    } catch (err: any) {
      console.error("Connection test failed:", err);
      setDebugInfo(prev => ({ ...prev, apiStatus: 'error' }));
      if (err.message === "API_KEY_MISSING") {
        setError("API Key 未配置。请在 AI Studio 的 Secrets 面板中设置 GEMINI_API_KEY。");
      } else {
        setError(`连接失败: ${err.message || "未知错误"}`);
      }
    }
  };

  const speak = async (text: string) => {
    if (voiceMode === 'ai') {
      try {
        const audioBase64 = await generateSpeech(text, aiConfig);
        if (audioBase64) {
          const audio = new Audio(`data:audio/wav;base64,${audioBase64}`);
          audio.play();
          return;
        }
      } catch (err) {
        console.error("AI Voice failed, falling back to system voice", err);
      }
    }

    // Fallback to System Voice
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
      const utterance = new SpeechSynthesisUtterance(text);
      utterance.lang = 'zh-CN';
      window.speechSynthesis.speak(utterance);
    }
  };

  // --- Effects ---
  useEffect(() => {
    if (isCameraActive) {
      // Small delay to ensure video stream is stable
      const timer = setTimeout(() => {
        startTranslation();
      }, 1000);
      return () => clearTimeout(timer);
    } else {
      stopTranslation();
    }
  }, [isCameraActive]);

  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, []);

  // --- UI Components ---
  return (
    <div className="min-h-screen bg-[#0A0A0A] text-white font-sans selection:bg-emerald-500/30">
      {/* Header */}
      <header className="border-b border-white/5 bg-black/40 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-7xl mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-emerald-500 rounded-lg flex items-center justify-center shadow-lg shadow-emerald-500/20">
              <Languages className="w-5 h-5 text-black" />
            </div>
            <h1 className="text-xl font-semibold tracking-tight">SignBridge AI</h1>
          </div>
          
          <div className="flex items-center gap-4">
            {isCameraActive && (
              <div className="flex items-center bg-zinc-800 rounded-full p-1 border border-white/5">
                {recordedVideoUrl ? (
                  <button 
                    onClick={downloadRecording}
                    className="px-3 py-1 rounded-full text-xs font-medium bg-emerald-500 text-black shadow-sm flex items-center gap-1.5"
                  >
                    <Download className="w-3 h-3" /> 下载录像
                  </button>
                ) : (
                  <button 
                    onClick={isRecording ? stopRecording : startRecording}
                    className={`px-3 py-1 rounded-full text-xs font-medium transition-all flex items-center gap-1.5 ${
                      isRecording ? 'bg-red-500 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    {isRecording ? <Square className="w-3 h-3 fill-current" /> : <Video className="w-3 h-3" />}
                    {isRecording ? '停止录制' : '录制会话'}
                  </button>
                )}
              </div>
            )}
            <div className="flex items-center bg-zinc-800 rounded-full p-1 border border-white/5">
              <button 
                onClick={() => setVoiceMode('system')}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-all ${
                  voiceMode === 'system' ? 'bg-zinc-700 text-white shadow-sm' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                系统语音
              </button>
              <button 
                onClick={() => setVoiceMode('ai')}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-all ${
                  voiceMode === 'ai' ? 'bg-emerald-500 text-black shadow-sm' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                AI 语音
              </button>
            </div>
            <button 
              onClick={() => setIsAutoSpeakEnabled(!isAutoSpeakEnabled)}
              className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all ${
                isAutoSpeakEnabled 
                ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20' 
                : 'bg-zinc-800 text-zinc-400 border border-white/5'
              }`}
            >
              <Volume2 className="w-4 h-4" />
              {isAutoSpeakEnabled ? '自动播报: 开' : '自动播报: 关'}
            </button>
            <button 
              onClick={() => setShowSettings(true)}
              className="p-2 rounded-full bg-zinc-800 text-zinc-400 hover:text-white border border-white/5 transition-colors"
              title="AI 设置"
            >
              <Settings className="w-5 h-5" />
            </button>
            <button 
              onClick={isCameraActive ? stopCamera : startCamera}
              className={`flex items-center gap-2 px-4 py-2 rounded-full text-sm font-medium transition-all ${
                isCameraActive 
                ? 'bg-red-500/10 text-red-400 hover:bg-red-500/20 border border-red-500/20' 
                : 'bg-emerald-500 text-black hover:bg-emerald-400'
              }`}
            >
              {isCameraActive ? <CameraOff className="w-4 h-4" /> : <Camera className="w-4 h-4" />}
              {isCameraActive ? '关闭摄像头' : '开启摄像头'}
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-6 py-8 grid grid-cols-1 lg:grid-cols-3 gap-8">
        {/* Left Column: Camera & Live Feed */}
        <div className="lg:col-span-2 space-y-6">
          <div className={`relative aspect-video bg-zinc-900 rounded-3xl overflow-hidden border transition-all duration-500 shadow-2xl group ${
            isTranslating && isProcessingFrame ? 'border-emerald-500/50 ring-1 ring-emerald-500/20' : 'border-white/5'
          }`}>
            {/* Recording Indicator */}
            {isRecording && (
              <div className="absolute top-6 left-6 z-50 flex items-center gap-2 bg-red-500/20 backdrop-blur-md border border-red-500/30 px-3 py-1.5 rounded-full">
                <div className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
                <span className="text-[10px] font-bold text-red-500 uppercase tracking-widest">REC</span>
              </div>
            )}

            {/* Success Pulse Effect */}
            <AnimatePresence>
              {lastTranslatedId && (
                <motion.div 
                  key={`pulse-${lastTranslatedId}`}
                  initial={{ opacity: 0.8, scale: 1 }}
                  animate={{ opacity: 0, scale: 1.05 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.6 }}
                  className="absolute inset-0 z-10 border-4 border-emerald-500 rounded-3xl pointer-events-none"
                />
              )}
            </AnimatePresence>

            {/* Shutter Flash */}
            <AnimatePresence>
              {showShutter && (
                <motion.div 
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 0.3 }}
                  exit={{ opacity: 0 }}
                  className="absolute inset-0 bg-white z-30 pointer-events-none"
                />
              )}
            </AnimatePresence>

            {!isCameraActive ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center text-zinc-500 space-y-4">
                <div className="w-16 h-16 rounded-full bg-zinc-800 flex items-center justify-center">
                  <Camera className="w-8 h-8" />
                </div>
                <p className="text-sm font-medium">摄像头未开启</p>
                <button 
                  onClick={startCamera}
                  className="px-6 py-2 bg-white text-black rounded-full text-sm font-semibold hover:bg-zinc-200 transition-colors"
                >
                  立即开启
                </button>
              </div>
            ) : (
              <>
                <video 
                  ref={videoRef} 
                  autoPlay 
                  playsInline 
                  muted 
                  className="w-full h-full object-cover"
                />

                {/* Focus Brackets */}
                <div className="absolute inset-0 pointer-events-none">
                  <motion.div 
                    animate={{ 
                      scale: isProcessingFrame ? 1.05 : 1,
                      borderColor: isProcessingFrame ? 'rgba(16, 185, 129, 0.4)' : 'rgba(255, 255, 255, 0.2)'
                    }}
                    className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-64 h-64 border-2 rounded-3xl"
                  >
                    <div className={`absolute -top-1 -left-1 w-8 h-8 border-t-4 border-l-4 rounded-tl-lg transition-colors duration-300 ${isProcessingFrame ? 'border-emerald-400' : 'border-emerald-500'}`} />
                    <div className={`absolute -top-1 -right-1 w-8 h-8 border-t-4 border-r-4 rounded-tr-lg transition-colors duration-300 ${isProcessingFrame ? 'border-emerald-400' : 'border-emerald-500'}`} />
                    <div className={`absolute -bottom-1 -left-1 w-8 h-8 border-b-4 border-l-4 rounded-bl-lg transition-colors duration-300 ${isProcessingFrame ? 'border-emerald-400' : 'border-emerald-500'}`} />
                    <div className={`absolute -bottom-1 -right-1 w-8 h-8 border-b-4 border-r-4 rounded-br-lg transition-colors duration-300 ${isProcessingFrame ? 'border-emerald-400' : 'border-emerald-500'}`} />
                    
                    {/* Inner Glow when processing */}
                    {isProcessingFrame && (
                      <motion.div 
                        initial={{ opacity: 0 }}
                        animate={{ opacity: [0.1, 0.3, 0.1] }}
                        transition={{ duration: 1.5, repeat: Infinity }}
                        className="absolute inset-0 bg-emerald-500/10 rounded-3xl"
                      />
                    )}
                  </motion.div>
                </div>

                {/* Floating Text Overlay */}
                <AnimatePresence>
                  {currentTranslation && (
                    <motion.div
                      key={`float-${lastTranslatedId}`}
                      initial={{ opacity: 0, y: 20, scale: 0.8 }}
                      animate={{ opacity: 1, y: -40, scale: 1 }}
                      exit={{ opacity: 0, y: -100, scale: 1.1 }}
                      transition={{ duration: 1.2, ease: "easeOut" }}
                      className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-40 pointer-events-none"
                    >
                      <div className="flex flex-col items-center gap-2">
                        <span className="text-6xl font-bold text-white drop-shadow-[0_0_20px_rgba(16,185,129,0.8)] whitespace-nowrap">
                          {currentTranslation}
                        </span>
                        {confidence > 0 && (
                          <span className="text-xs font-bold text-emerald-400 bg-black/60 px-2 py-1 rounded-full border border-emerald-500/30">
                            置信度: {confidence}%
                          </span>
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Hand Bounding Box */}
                <AnimatePresence>
                  {handBox && isTranslating && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="absolute border-2 border-emerald-500/50 rounded-xl z-30 pointer-events-none shadow-[0_0_15px_rgba(16,185,129,0.3)]"
                      style={{
                        top: `${handBox[0] / 10}%`,
                        left: `${handBox[1] / 10}%`,
                        height: `${(handBox[2] - handBox[0]) / 10}%`,
                        width: `${(handBox[3] - handBox[1]) / 10}%`,
                      }}
                    >
                      <div className="absolute -top-6 left-0 bg-emerald-500 text-black text-[10px] font-bold px-1.5 py-0.5 rounded-t-lg">
                        HAND DETECTED
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Scanning Line */}
                {isTranslating && isProcessingFrame && (
                  <motion.div 
                    initial={{ top: "0%" }}
                    animate={{ top: "100%" }}
                    transition={{ duration: 2, repeat: Infinity, ease: "linear" }}
                    className="absolute left-0 right-0 h-1 bg-gradient-to-r from-transparent via-emerald-500 to-transparent z-20 shadow-[0_0_15px_rgba(16,185,129,0.8)]"
                  />
                )}

                {/* AI Status Badge */}
                <div className="absolute top-6 right-6 flex flex-col items-end gap-2">
                  <div className="flex items-center gap-2 bg-black/40 backdrop-blur-md px-3 py-1.5 rounded-full border border-white/10">
                    <div className={`w-2 h-2 rounded-full ${isTranslating ? 'bg-emerald-500 animate-pulse' : 'bg-zinc-500'}`} />
                    <span className="text-[10px] font-bold uppercase tracking-widest text-white/80">
                      {isTranslating ? (isProcessingFrame ? 'Analyzing' : 'Observing') : 'Standby'}
                    </span>
                  </div>
                  
                  {isTranslating && (
                    <div className="bg-black/40 backdrop-blur-md px-2 py-1 rounded-lg border border-white/5 text-[8px] font-mono text-zinc-400 uppercase tracking-tighter flex flex-col items-end">
                      <span>Last Frame: {debugInfo.lastCapture}</span>
                      <span className="text-emerald-500 font-bold">Rate: {debugInfo.fps} FPS</span>
                    </div>
                  )}
                </div>
                
                {/* Overlay Controls */}
                <div className="absolute bottom-6 left-6 right-6 flex items-center justify-between">
                  <div className="flex flex-col gap-2">
                    <div className={`px-6 py-3 rounded-2xl flex items-center gap-2 font-semibold transition-all ${
                      isTranslating 
                      ? 'bg-emerald-500 text-black shadow-lg shadow-emerald-500/40' 
                      : 'bg-white/10 backdrop-blur-md text-white border border-white/10'
                    }`}>
                      {isTranslating ? (
                        <>
                          <Loader2 className="w-5 h-5 animate-spin" />
                          实时翻译已开启
                        </>
                      ) : (
                        <>
                          <Sparkles className="w-5 h-5" />
                          等待摄像头就绪...
                        </>
                      )}
                    </div>
                  </div>
                  
                  {isProcessingFrame && (
                    <motion.div 
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="bg-black/60 backdrop-blur-md px-4 py-2 rounded-xl border border-white/10 flex items-center gap-2"
                    >
                      <div className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
                      <span className="text-xs font-mono uppercase tracking-widest text-emerald-400">AI Processing</span>
                    </motion.div>
                  )}
                </div>
              </>
            )}
            
            {/* Hidden Canvas for Frame Capture */}
            <canvas ref={canvasRef} className="hidden" />
          </div>

          {/* Current Translation Display */}
          <AnimatePresence mode="wait">
            {currentTranslation && (
              <motion.div 
                key={currentTranslation}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.95 }}
                className="bg-zinc-900/50 border border-white/5 rounded-3xl p-8 relative overflow-hidden group"
              >
                <div className="absolute top-4 right-4 flex gap-2">
                  <button 
                    onClick={() => speak(currentTranslation)}
                    className="p-2 rounded-xl bg-white/5 hover:bg-white/10 text-zinc-400 hover:text-white transition-all"
                    title="朗读"
                  >
                    <Volume2 className="w-5 h-5" />
                  </button>
                </div>
                <div className="space-y-2">
                  <span className="text-[10px] font-mono uppercase tracking-[0.2em] text-emerald-500/60 font-bold">Live Translation</span>
                  <p className="text-4xl font-medium tracking-tight leading-tight">
                    {currentTranslation}
                  </p>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {error && (
            <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-6 rounded-2xl space-y-4">
              <div className="flex items-center gap-3">
                <Info className="w-5 h-5 shrink-0" />
                <p className="text-sm font-semibold">摄像头访问错误</p>
              </div>
              <p className="text-sm leading-relaxed">{error}</p>
              <div className="pt-4 border-t border-red-500/10 space-y-2">
                <p className="text-[10px] font-bold uppercase tracking-widest opacity-60">如何修复：</p>
                <ol className="text-xs space-y-2 list-decimal list-inside opacity-80">
                  <li>点击浏览器地址栏左侧的 🔒 <b>锁图标</b></li>
                  <li>找到 <b>摄像头 (Camera)</b> 选项</li>
                  <li>将其切换为 <b>允许 (Allow)</b></li>
                  <li><b>刷新页面</b> 即可生效</li>
                </ol>
              </div>
            </div>
          )}
        </div>

        {/* Right Column: History & Info */}
        <div className="space-y-6">
          <div className="bg-zinc-900/50 border border-white/5 rounded-3xl flex flex-col h-[calc(100vh-12rem)] sticky top-24">
            <div className="p-6 border-b border-white/5 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <History className="w-5 h-5 text-zinc-400" />
                <h2 className="font-semibold">翻译历史</h2>
              </div>
              <div className="flex items-center gap-1">
                <button 
                  onClick={undoLastTranslation}
                  disabled={history.length === 0}
                  className={`p-2 rounded-lg transition-colors ${
                    history.length > 0 
                    ? 'hover:bg-white/5 text-zinc-500 hover:text-emerald-400' 
                    : 'text-zinc-800 cursor-not-allowed'
                  }`}
                  title="撤销上一步"
                >
                  <Undo2 className="w-4 h-4" />
                </button>
                <button 
                  onClick={clearHistory}
                  className="p-2 rounded-lg hover:bg-white/5 text-zinc-500 hover:text-red-400 transition-colors"
                  title="清除历史"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3 custom-scrollbar">
              {history.length === 0 ? (
                <div className="h-full flex flex-col items-center justify-center text-zinc-600 space-y-2">
                  <History className="w-8 h-8 opacity-20" />
                  <p className="text-sm">暂无历史记录</p>
                </div>
              ) : (
                history.map((item) => (
                  <motion.div 
                    layout
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    key={item.id}
                    className="p-4 rounded-2xl bg-white/5 border border-white/5 hover:border-white/10 transition-all group"
                  >
                    <div className="flex justify-between items-start gap-4">
                      <p className="text-lg font-medium text-zinc-200">{item.text}</p>
                      <button 
                        onClick={() => speak(item.text)}
                        className="p-1.5 rounded-lg bg-white/5 opacity-0 group-hover:opacity-100 transition-opacity hover:text-emerald-400"
                      >
                        <Volume2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <p className="text-[10px] font-mono text-zinc-500 mt-2">
                      {new Date(item.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </p>
                  </motion.div>
                ))
              )}
            </div>

            <div className="p-6 bg-emerald-500/5 border-t border-white/5 rounded-b-3xl space-y-4">
              <button 
                onClick={testConnection}
                disabled={debugInfo.apiStatus === 'testing'}
                className={`w-full py-2 rounded-xl text-xs font-semibold flex items-center justify-center gap-2 transition-all ${
                  debugInfo.apiStatus === 'ok' ? 'bg-emerald-500 text-black' :
                  debugInfo.apiStatus === 'error' ? 'bg-red-500 text-white' :
                  'bg-white/5 text-zinc-400 hover:bg-white/10 border border-white/5'
                }`}
              >
                {debugInfo.apiStatus === 'testing' ? <Loader2 className="w-3 h-3 animate-spin" /> : <Sparkles className="w-3 h-3" />}
                {debugInfo.apiStatus === 'testing' ? '正在测试连接...' : 
                 debugInfo.apiStatus === 'ok' ? '连接成功!' :
                 debugInfo.apiStatus === 'error' ? '连接失败 (点击重试)' : '测试 AI 连接'}
              </button>

              <div className="flex gap-3">
                <div className="w-10 h-10 rounded-xl bg-emerald-500/20 flex items-center justify-center shrink-0">
                  <Info className="w-5 h-5 text-emerald-500" />
                </div>
                <div className="space-y-1">
                  <p className="text-xs font-semibold text-emerald-400 uppercase tracking-wider">使用说明</p>
                  <p className="text-[11px] text-zinc-400 leading-relaxed">
                    开启摄像头并点击“开始实时翻译”。AI 将每隔几秒分析您的手势并将其转换为文字。
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      <style dangerouslySetInnerHTML={{ __html: `
        .custom-scrollbar::-webkit-scrollbar {
          width: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: transparent;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.1);
          border-radius: 10px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.2);
        }
      `}} />

      {/* Settings Modal */}
      <AnimatePresence>
        {showSettings && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
            <motion.div 
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              onClick={() => setShowSettings(false)}
              className="absolute inset-0 bg-black/80 backdrop-blur-sm"
            />
            <motion.div 
              initial={{ opacity: 0, scale: 0.9, y: 20 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.9, y: 20 }}
              className="relative w-full max-w-lg bg-zinc-900 border border-white/10 rounded-3xl shadow-2xl overflow-hidden"
            >
              <div className="p-6 border-b border-white/5 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <Settings className="w-5 h-5 text-emerald-500" />
                  <h2 className="text-lg font-semibold">AI 服务配置</h2>
                </div>
                <button 
                  onClick={() => setShowSettings(false)}
                  className="p-2 rounded-xl hover:bg-white/5 text-zinc-500 hover:text-white transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>

              <div className="p-8 space-y-6">
                {/* Provider Selection */}
                <div className="space-y-3">
                  <label className="text-xs font-bold uppercase tracking-widest text-zinc-500 flex items-center gap-2">
                    <Globe className="w-3 h-3" /> 服务供应商
                  </label>
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { id: 'gemini', name: 'Gemini', icon: Sparkles },
                      { id: 'openai', name: 'OpenAI', icon: Globe },
                      { id: 'custom', name: '自定义', icon: Cpu }
                    ].map((p) => (
                      <button
                        key={p.id}
                        onClick={() => setAiConfig(prev => ({ 
                          ...prev, 
                          provider: p.id as any,
                          model: p.id === 'gemini' ? 'gemini-3-flash-preview' : (p.id === 'openai' ? 'gpt-4o-mini' : prev.model)
                        }))}
                        className={`flex flex-col items-center gap-2 p-4 rounded-2xl border transition-all ${
                          aiConfig.provider === p.id 
                          ? 'bg-emerald-500/10 border-emerald-500 text-emerald-400' 
                          : 'bg-white/5 border-white/5 text-zinc-500 hover:border-white/10 hover:text-zinc-300'
                        }`}
                      >
                        <p.icon className="w-5 h-5" />
                        <span className="text-xs font-medium">{p.name}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* API Key */}
                <div className="space-y-3">
                  <label className="text-xs font-bold uppercase tracking-widest text-zinc-500 flex items-center gap-2">
                    <Key className="w-3 h-3" /> API Key
                  </label>
                  <div className="relative">
                    <input 
                      type="password"
                      value={aiConfig.apiKey}
                      onChange={(e) => setAiConfig(prev => ({ ...prev, apiKey: e.target.value }))}
                      placeholder={aiConfig.provider === 'gemini' ? "留空则使用系统默认 Key" : "输入您的 API Key"}
                      className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-emerald-500 transition-colors"
                    />
                  </div>
                  <p className="text-[10px] text-zinc-500 leading-relaxed">
                    您的 API Key 仅保存在本地浏览器中，不会上传到我们的服务器。
                  </p>
                </div>

                {/* Custom Endpoint (for Custom) */}
                {aiConfig.provider === 'custom' && (
                  <div className="space-y-3">
                    <label className="text-xs font-bold uppercase tracking-widest text-zinc-500 flex items-center gap-2">
                      <Globe className="w-3 h-3" /> 接口地址 (Endpoint)
                    </label>
                    <input 
                      type="text"
                      value={aiConfig.endpoint}
                      onChange={(e) => setAiConfig(prev => ({ ...prev, endpoint: e.target.value }))}
                      placeholder="https://api.your-provider.com/v1/chat/completions"
                      className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-emerald-500 transition-colors"
                    />
                  </div>
                )}

                {/* Model Name */}
                <div className="space-y-3">
                  <label className="text-xs font-bold uppercase tracking-widest text-zinc-500 flex items-center gap-2">
                    <Cpu className="w-3 h-3" /> 模型名称 (Model)
                  </label>
                  <input 
                    type="text"
                    value={aiConfig.model}
                    onChange={(e) => setAiConfig(prev => ({ ...prev, model: e.target.value }))}
                    placeholder={aiConfig.provider === 'gemini' ? "gemini-3-flash-preview" : "gpt-4o-mini"}
                    className="w-full bg-black/40 border border-white/10 rounded-xl px-4 py-3 text-sm focus:outline-none focus:border-emerald-500 transition-colors"
                  />
                </div>

                {/* Advanced Parameters */}
                <div className="grid grid-cols-2 gap-6 pt-4 border-t border-white/5">
                  <div className="space-y-3">
                    <label className="text-xs font-bold uppercase tracking-widest text-zinc-500 flex items-center justify-between">
                      <span>置信度阈值</span>
                      <span className="text-emerald-400">{aiConfig.confidenceThreshold}%</span>
                    </label>
                    <input 
                      type="range"
                      min="0"
                      max="100"
                      step="5"
                      value={aiConfig.confidenceThreshold}
                      onChange={(e) => setAiConfig(prev => ({ ...prev, confidenceThreshold: parseInt(e.target.value) }))}
                      className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                    />
                    <p className="text-[9px] text-zinc-600">低于此分数的翻译将被忽略</p>
                  </div>

                  <div className="space-y-3">
                    <label className="text-xs font-bold uppercase tracking-widest text-zinc-500 flex items-center justify-between">
                      <span>上下文窗口</span>
                      <span className="text-emerald-400">{aiConfig.contextWindowSize} 条</span>
                    </label>
                    <input 
                      type="range"
                      min="1"
                      max="10"
                      step="1"
                      value={aiConfig.contextWindowSize}
                      onChange={(e) => setAiConfig(prev => ({ ...prev, contextWindowSize: parseInt(e.target.value) }))}
                      className="w-full h-1.5 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-emerald-500"
                    />
                    <p className="text-[9px] text-zinc-600">发送给 AI 的历史记录条数</p>
                  </div>
                </div>
              </div>

              <div className="p-6 bg-black/40 border-t border-white/5 flex gap-3">
                <button 
                  onClick={() => setShowSettings(false)}
                  className="flex-1 py-3 bg-emerald-500 text-black rounded-2xl font-bold hover:bg-emerald-400 transition-colors"
                >
                  保存并应用
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}
