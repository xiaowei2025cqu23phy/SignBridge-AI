import { GoogleGenAI, GenerateContentResponse } from "@google/genai";

export interface AIConfig {
  provider: 'gemini' | 'openai' | 'custom';
  apiKey: string;
  endpoint?: string;
  model?: string;
  confidenceThreshold: number; // 0-100
  contextWindowSize: number; // 1-10
}

const DEFAULT_GEMINI_KEY = process.env.GEMINI_API_KEY || "";

export interface TranslationResult {
  text: string;
  confidence: number;
  handBox?: [number, number, number, number]; // [ymin, xmin, ymax, xmax] normalized 0-1000
}

export async function translateSignLanguage(
  imageBase64: string, 
  config: AIConfig,
  previousContext: string[] = []
): Promise<TranslationResult> {
  const apiKey = config.apiKey || (config.provider === 'gemini' ? DEFAULT_GEMINI_KEY : "");
  
  if (!apiKey && config.provider !== 'custom') {
    throw new Error("API_KEY_MISSING");
  }

  const prompt = `你是一位专业的手语翻译员。请观察这张图片中的手势，并将其翻译成简洁的中文词汇或短语。
            
  之前的翻译上下文：${previousContext.join(" ")}
  
  请以 JSON 格式返回结果，包含以下字段：
  - text: 翻译后的文字（如果手势不清晰，返回 "正在分析..."）
  - confidence: 置信度分数（0-100 之间的整数）
  - handBox: 手部在图片中的位置 [ymin, xmin, ymax, xmax]，坐标范围为 0-1000。如果没发现手，返回 null。
  
  要求：
  1. 只返回 JSON，不要有任何解释。
  2. 尽量保持翻译的连贯性。`;

  if (config.provider === 'gemini') {
    const ai = new GoogleGenAI({ apiKey });
    try {
      const response: GenerateContentResponse = await ai.models.generateContent({
        model: config.model || "gemini-3-flash-preview",
        contents: {
          parts: [
            { inlineData: { mimeType: "image/jpeg", data: imageBase64 } },
            { text: prompt },
          ],
        },
        config: {
          responseMimeType: "application/json",
        }
      });
      
      const result = JSON.parse(response.text || "{}");
      return {
        text: result.text || "",
        confidence: result.confidence || 0,
        handBox: result.handBox || undefined
      };
    } catch (error) {
      console.error("Gemini Translation Error:", error);
      throw error;
    }
  } else {
    // OpenAI or Custom OpenAI-compatible endpoint
    const endpoint = config.provider === 'openai' 
      ? "https://api.openai.com/v1/chat/completions" 
      : (config.endpoint || "");
    
    const model = config.provider === 'openai' ? (config.model || "gpt-4o-mini") : config.model;

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`
        },
        body: JSON.stringify({
          model: model,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: prompt },
                {
                  type: "image_url",
                  image_url: {
                    url: `data:image/jpeg;base64,${imageBase64}`
                  }
                }
              ]
            }
          ],
          response_format: { type: "json_object" },
          max_tokens: 150
        })
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.error?.message || "API Request Failed");
      }

      const data = await response.json();
      const result = JSON.parse(data.choices?.[0]?.message?.content || "{}");
      return {
        text: result.text || "",
        confidence: result.confidence || 0,
        handBox: result.handBox || undefined
      };
    } catch (error) {
      console.error(`${config.provider} Translation Error:`, error);
      throw error;
    }
  }
}

export async function generateSpeech(text: string, config: AIConfig): Promise<string | null> {
  // Only Gemini supports native TTS in this service for now
  // For others, we fallback to system voice in App.tsx
  if (config.provider !== 'gemini') return null;

  const apiKey = config.apiKey || DEFAULT_GEMINI_KEY;
  if (!apiKey) return null;

  const ai = new GoogleGenAI({ apiKey });
  try {
    const response = await ai.models.generateContent({
      model: "gemini-2.5-flash-preview-tts",
      contents: [{ parts: [{ text: `Say cheerfully: ${text}` }] }],
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: "Kore" },
          },
        },
      },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    return base64Audio || null;
  } catch (error) {
    console.error("Gemini TTS Error:", error);
    return null;
  }
}
