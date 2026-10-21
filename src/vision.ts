/**
 * 视觉模型（给 C 核验用）。
 *
 * 场景：C 是纯文本模型，看不懂截图。开着这个开关后，B/C 每次截图，
 * 都会把图片交给一个**多模态模型**看，取回文字描述再塞给 C——
 * 于是"文本 C + 视觉模型"两个人配合：C 负责判断和跑测试，视觉模型负责"看"。
 */

import { readFileSync, statSync } from 'node:fs'
import { extname } from 'node:path'

export interface VisionConfig {
  /** 关掉就完全不调视觉模型（默认关：不花这份钱）。 */
  enabled: boolean
  /** 留空则沿用 C 的供应商 */
  provider: string
  /** 留空则沿用 C 的接口地址 */
  baseUrl: string
  /** 必须是一个能看图的模型（gpt-4o / qwen-vl / glm-4v 之类）。 */
  model: string
  /** 留空则沿用 C 的 key */
  apiKey: string
  maxTokens: number
  timeoutMs: number
  /** 单次运行最多看几张图（防止截图刷爆账单）。 */
  maxImages: number
  /** 固定追加的提问（比如"这个游戏画面里分数显示正常吗"）。 */
  question: string
}

export const DEFAULT_VISION: VisionConfig = {
  enabled: false,
  provider: '',
  baseUrl: '',
  model: '',
  apiKey: '',
  maxTokens: 500,
  timeoutMs: 60_000,
  maxImages: 8,
  question: '请客观描述这张截图里能看到的内容：文字（原样抄出来）、布局、颜色、有无明显错位/空白/报错。不要评价好不好看。',
}

export interface VisionRequest {
  baseUrl: string
  apiKey: string
  model: string
  headers: Record<string, string>
  timeoutMs: number
  maxTokens: number
  question: string
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

/** 图片转成 data URL（OpenAI 兼容的 image_url 就吃这个）。 */
export function toDataUrl(file: string): string {
  const mime = MIME[extname(file).toLowerCase()] ?? 'image/png'
  return `data:${mime};base64,${readFileSync(file).toString('base64')}`
}

/** 组装请求体：抽出来单独测，不联网也能验证格式。 */
export function buildVisionBody(request: VisionRequest, dataUrl: string): Record<string, unknown> {
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: request.question },
          { type: 'image_url', image_url: { url: dataUrl } },
        ],
      },
    ],
  }
}

/** 从响应里取文字（兼容 reasoning 字段的网关也能用）。 */
export function pickDescription(payload: unknown): string {
  const record = payload as { choices?: Array<{ message?: { content?: unknown } }> }
  const content = record?.choices?.[0]?.message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) {
    return content
      .map((part) => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : ''))
      .join('\n')
      .trim()
  }
  return ''
}

export interface VisionResult {
  ok: boolean
  description: string
  error?: string
}

/** 让视觉模型看一张图，返回文字描述。失败不抛错——不能让"看不了图"把核验搞崩。 */
export async function describeImage(request: VisionRequest, file: string): Promise<VisionResult> {
  try {
    const size = statSync(file).size
    if (size === 0) return { ok: false, description: '', error: '截图是空文件' }
    if (size > 8 * 1024 * 1024) return { ok: false, description: '', error: `图片太大（${Math.round(size / 1024)}KB）` }

    const response = await fetch(`${request.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(request.apiKey ? { authorization: `Bearer ${request.apiKey}` } : {}),
        ...request.headers,
      },
      body: JSON.stringify(buildVisionBody(request, toDataUrl(file))),
      signal: AbortSignal.timeout(request.timeoutMs),
    })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return { ok: false, description: '', error: `视觉模型返回 ${response.status}：${text.slice(0, 200)}` }
    }
    const payload = await response.json()
    const description = pickDescription(payload)
    if (!description) return { ok: false, description: '', error: '视觉模型没给出描述' }
    return { ok: true, description }
  } catch (error) {
    return { ok: false, description: '', error: (error as Error).message }
  }
}
