/**
 * 供应商清单（下拉里那份列表）。
 *
 * 这里**只是选项**，不代表"已经配置好"：选中后会把接口地址/模型填进表单，
 * key 还得自己填。地址留空的表示这个平台的 OpenAI 兼容地址还没内置，
 * 需要按官方文档填（界面上会提示）。
 */

export interface CatalogEntry {
  /** 存进配置里的 provider 标识 */
  id: string
  /** 下拉里显示的名字 */
  name: string
  /** 站点（显示用，也是让用户核对去哪拿 key） */
  site: string
  /** 该平台有几个可用入口（仅显示，内置的兼容地址通常是 1 个） */
  versions?: number
  /** 需要网关/路由才能用 */
  needsRoute?: boolean
  /** OpenAI 兼容地址；空字符串 = 还没内置，要用户自己填 */
  baseUrl: string
  /** 默认模型（知道就填，不知道留空） */
  model?: string
  /** 环境变量名（有的话会去环境里找 key） */
  envKey?: string
}

export const PROVIDER_CATALOG: CatalogEntry[] = [
  {
    id: 'astron',
    name: 'Astron Coding Plan',
    site: 'maas.xfyun.cn',
    baseUrl: 'https://maas.xfyun.cn/v1',
    envKey: 'XFYUN_API_KEY',
  },
  {
    id: 'qianfan',
    name: 'Baidu Qianfan',
    site: 'cloud.baidu.com',
    versions: 3,
    baseUrl: 'https://qianfan.baidubce.com/v2',
    envKey: 'QIANFAN_API_KEY',
  },
  {
    id: 'ant-ling',
    name: 'BaiLing',
    site: 'developer.ant-ling.com',
    needsRoute: true,
    baseUrl: '',
    envKey: 'ANTLING_API_KEY',
  },
  {
    id: 'byteplus',
    name: 'BytePlus',
    site: 'byteplus.com',
    baseUrl: 'https://ark.ap-southeast.bytepluses.com/api/v3',
    envKey: 'BYTEPLUS_API_KEY',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    site: 'platform.deepseek.com',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    envKey: 'DEEPSEEK_API_KEY',
  },
  {
    id: 'volcengine',
    name: '火山 Agent Plan',
    site: 'volcengine.com',
    versions: 3,
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    envKey: 'ARK_API_KEY',
  },
  {
    id: 'kimi',
    name: 'Kimi',
    site: 'platform.kimi.com',
    versions: 4,
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2-turbo-preview',
    envKey: 'MOONSHOT_API_KEY',
  },
  {
    id: 'longcat',
    name: 'Longcat',
    site: 'longcat.chat',
    baseUrl: 'https://api.longcat.chat/openai/v1',
    envKey: 'LONGCAT_API_KEY',
  },
  {
    id: 'minimax',
    name: 'MiniMax',
    site: 'platform.minimax.cn',
    versions: 2,
    baseUrl: 'https://api.minimax.chat/v1',
    envKey: 'MINIMAX_API_KEY',
  },
  {
    id: 'qianwen',
    name: '千问AI平台',
    site: 'platform.qianwenai.com',
    versions: 2,
    baseUrl: '',
    envKey: 'QWEN_API_KEY',
  },
  {
    id: 'qwencloud',
    name: 'QwenCloud',
    site: 'home.qwencloud.com',
    versions: 3,
    baseUrl: '',
    envKey: 'QWENCLOUD_API_KEY',
  },
  {
    id: 'stepfun',
    name: 'StepFun',
    site: 'platform.stepfun.com',
    versions: 4,
    baseUrl: 'https://api.stepfun.com/v1',
    envKey: 'STEPFUN_API_KEY',
  },
  {
    id: 'tencent',
    name: '腾讯云',
    site: 'cloud.tencent.com',
    versions: 7,
    baseUrl: 'https://api.hunyuan.cloud.tencent.com/v1',
    envKey: 'HUNYUAN_API_KEY',
  },
  {
    id: 'xiaomi-mimo',
    name: 'Xiaomi MiMo',
    site: 'platform.xiaomimimo.com',
    versions: 2,
    baseUrl: '',
    envKey: 'MIMO_API_KEY',
  },
  {
    id: 'zhipu',
    name: 'Zhipu GLM',
    site: 'open.bigmodel.cn',
    versions: 2,
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4.6',
    envKey: 'ZHIPU_API_KEY',
  },
  {
    id: 'openai',
    name: 'OpenAI',
    site: 'platform.openai.com',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4.1-mini',
    envKey: 'OPENAI_API_KEY',
  },
]

export function findCatalogEntry(id: string): CatalogEntry | undefined {
  return PROVIDER_CATALOG.find((entry) => entry.id === id)
}

/** 下拉里的显示文字：名称 · 站点（· N 个版本）。 */
export function catalogLabel(entry: CatalogEntry): string {
  const parts = [entry.name, entry.site]
  const text = parts.join(' · ')
  const suffix = entry.versions ? ` · ${entry.versions} 个版本` : ''
  return `${text}${suffix}`
}
