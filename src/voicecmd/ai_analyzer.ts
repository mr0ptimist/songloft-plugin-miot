// MIoT 智能音箱插件 - AI 口令分析器
// 使用 LLM 泛化分析用户语音指令，提取操作类型和参数

/// <reference types="@songloft/plugin-sdk" />

import type { AIConfig, AIAnalysisResult } from '../types';

/** AI System Prompt */
const AI_SYSTEM_PROMPT = `从指令中提取出操作和音乐信息，返回JSON：{"action":"...","params":{...},"confidence":"high|medium|low","rawText":"有效文本"}

行为和参数（只允许使用以下参数，不要自定义新字段）：
- play_song: name(歌曲名), artist(歌手名)
- play_artist: artist(歌手名)
- play_playlist: playlist(歌单名)
- set_play_mode: mode=order|random|single|loop|singlePlay(播放模式，singlePlay 表示当前歌曲播完停止)
- favorite: action=add|remove(收藏/取消收藏当前歌曲)
- sleep_timer: duration(分钟数,整数)或songs_count(曲目数,整数)，两者只填一个。定时停止播放。
- cancel_sleep_timer: 取消定时停止
- query_sleep_timer: 查询定时剩余时间
- next/previous/stop/unknown

规则：
1. "XX的YY"中XX是歌手名则artist=XX,name=YY，否则整句为歌名（如"你的答案"→name）
2. 多歌手用逗号分隔。如"林俊杰、金莎的被风吹过的夏天"→name="被风吹过的夏天",artist="林俊杰,金莎"
3. 翻唱以演唱者（翻唱者）为artist，原唱忽略。如"陈奕迅翻唱周杰伦的淘汰"→name="淘汰",artist="陈奕迅"
4. "来一首"等同于"播放"，划入play_song
5. 明确high模糊low其余medium
6. rawText去语气词、口癖词
7. "播放XX的歌/歌曲/音乐"或"来几首XX"中，name为泛称（歌/歌曲/音乐/曲/曲子）或无name时→action=play_artist,artist=XX。name为具体歌名时仍为play_song
8. 外国歌手用户用中文音译时，artist输出常用英文名：如"泰勒斯威夫特"→"Taylor Swift"、"贾斯汀比伯"→"Justin Bieber"、"阿黛尔"→"Adele"、"碧昂丝"→"Beyoncé"、"艾薇儿"→"Avril Lavigne"。中文名歌手保持中文

示例：
周杰伦的晴天→{"action":"play_song","params":{"name":"晴天","artist":"周杰伦"},"confidence":"high","rawText":"周杰伦 晴天"}
邓紫棋翻唱周杰伦的龙卷风→{"action":"play_song","params":{"name":"龙卷风","artist":"邓紫棋"},"confidence":"high","rawText":"龙卷风 邓紫棋"}
播放周杰伦的歌→{"action":"play_artist","params":{"artist":"周杰伦"},"confidence":"high","rawText":"周杰伦"}
我想听林俊杰的歌曲→{"action":"play_artist","params":{"artist":"林俊杰"},"confidence":"high","rawText":"林俊杰"}
来几首邓紫棋→{"action":"play_artist","params":{"artist":"邓紫棋"},"confidence":"high","rawText":"邓紫棋"}
随机播放→{"action":"set_play_mode","params":{"mode":"random"},"confidence":"high","rawText":"随机播放"}
收藏这首歌→{"action":"favorite","params":{"action":"add"},"confidence":"high","rawText":"收藏这首歌"}
取消收藏→{"action":"favorite","params":{"action":"remove"},"confidence":"high","rawText":"取消收藏"}
半小时后停止播放→{"action":"sleep_timer","params":{"duration":30},"confidence":"high","rawText":"半小时后停止播放"}
30分钟后关闭→{"action":"sleep_timer","params":{"duration":30},"confidence":"high","rawText":"30分钟后关闭"}
一个半小时后停→{"action":"sleep_timer","params":{"duration":90},"confidence":"high","rawText":"一个半小时后停"}
再听3首就停→{"action":"sleep_timer","params":{"songs_count":3},"confidence":"high","rawText":"再听3首就停"}
5首歌后停止播放→{"action":"sleep_timer","params":{"songs_count":5},"confidence":"high","rawText":"5首歌后停止播放"}
取消定时→{"action":"cancel_sleep_timer","params":{},"confidence":"high","rawText":"取消定时"}
还有多久停→{"action":"query_sleep_timer","params":{},"confidence":"high","rawText":"还有多久停"}
播放泰勒斯威夫特的歌→{"action":"play_artist","params":{"artist":"Taylor Swift"},"confidence":"high","rawText":"泰勒斯威夫特"}`;

/** AI 问答 System Prompt（仅在用户以"请问"等触发词发起问答时使用） */
const AI_CHAT_SYSTEM_PROMPT = `你是智能音箱里的 AI 助手（小爱同学）。用中文简洁、准确地回答用户的问题，不超过80字。不要提到"我无法""我不能"等推脱，直接给出答案；不确定就说"我不确定"。`;

/** 任务桥工具声明：LLM 可自主决定调用 query_usage 查询账户余额/用量（走 songloft 任务桥执行） */
const USAGE_TOOLS = [{
  type: 'function',
  function: {
    name: 'query_usage',
    description: '查询 DeepSeek / 火山方舟 / 雷火 的账户余额与用量',
    parameters: {
      type: 'object',
      properties: {
        which: {
          type: 'string',
          enum: ['deepseek', 'ark', 'leihuo'],
          description: '要查询哪种：deepseek=DeepSeek余额, ark=火山方舟用量, leihuo=雷火网关剩余额度',
        },
      },
      required: ['which'],
    },
  },
}] as const;

/** LLM 返回的单条工具调用 */
interface AIToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** LLM 返回的消息（content + 可选 tool_calls） */
interface LLMMessageResult {
  content: string;
  toolCalls: AIToolCall[];
}

/**
 * AI 口令分析器
 * 调用 LLM API 分析用户语音指令，提取操作类型和参数
 */
export class AIAnalyzer {
  /**
   * 调用 AI 分析用户语音指令（静默模式，失败返回 null）
   * @param query 用户语音文本
   * @param config AI 配置
   * @returns 分析结果，超时或失败返回 null
   */
  async analyze(query: string, config: AIConfig): Promise<AIAnalysisResult | null> {
    if (!config.enabled || !config.api_url || !config.api_key) {
      return null;
    }

    try {
      return await this.callAI(query, config);
    } catch (e) {
      songloft.log.warn(`[AIAnalyzer] AI analysis failed: ${String(e)}`);
      return null;
    }
  }

  /**
   * 调用 AI 分析用户语音指令（严格模式，失败则抛出异常）
   * 用于测试页面等需要显示具体错误原因的场景
   * @param query 用户语音文本
   * @param config AI 配置
   * @returns 分析结果
   */
  async strictAnalyze(query: string, config: AIConfig): Promise<AIAnalysisResult | null> {
    if (!config.enabled || !config.api_url || !config.api_key) {
      return null;
    }
    return await this.callAI(query, config);
  }

  /**
   * 调用 LLM API
   */
  /**
   * 调用 LLM API，返回模型生成的文本内容
   * @param opts.json 音乐指令用 JSON 模式（强制 response_format）；问答用纯文本模式
   */
  private async callLLM(messages: Array<{ role: string; content: string }>, config: AIConfig, opts: { json?: boolean } = {}): Promise<string> {
    const res = await this.callLLMMessages(messages, config, opts);
    return res.content;
  }

  /**
   * 调用 LLM API，返回完整消息（content + tool_calls）
   * @param opts.json 音乐指令用 JSON 模式；opts.tools 问答/任务桥工具声明
   */
  private async callLLMMessages(
    messages: Array<{ role: string; content: string | null; tool_calls?: unknown; tool_call_id?: string }>,
    config: AIConfig,
    opts: { json?: boolean; tools?: unknown[] } = {},
  ): Promise<LLMMessageResult> {
    songloft.log.info(`[AIAnalyzer] Calling ${config.api_url} model=${config.model} timeout=${config.timeout}s`);

    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      temperature: 1.0,
      max_tokens: opts.json ? 300 : 500,
    };
    if (opts.json) {
      body.response_format = { type: 'json_object' };
      body.extra_body = { reasoning_split: true };
    }
    if (opts.tools && opts.tools.length) {
      body.tools = opts.tools;
      body.tool_choice = 'auto';
    }

    const fetchPromise = fetch(`${config.api_url}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${config.api_key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('AI API call timed out')), config.timeout * 1000);
    });

    let resp: Response;
    try {
      resp = await Promise.race([fetchPromise, timeoutPromise]);
    } catch (e) {
      songloft.log.warn(`[AIAnalyzer] fetch error: ${String(e)}`);
      throw e;
    }

    if (!resp.ok) {
      throw new Error(`API error: ${resp.status} ${await resp.text()}`);
    }

    const data = await resp.json();
    const msg = data.choices?.[0]?.message as {
      content?: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    } | undefined;
    const finishReason = data.choices?.[0]?.finish_reason as string | undefined;

    if (!msg) {
      throw new Error('Empty response from AI API');
    }
    if (finishReason && finishReason !== 'stop' && finishReason !== 'tool_calls') {
      songloft.log.warn(`[AIAnalyzer] Finish reason: ${finishReason} (content may be truncated)`);
    }

    const content = (msg.content || '').trim();
    const toolCalls: AIToolCall[] = (msg.tool_calls || []).map(tc => {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments || '{}');
      } catch {
        args = { _raw: tc.function.arguments };
      }
      return { id: tc.id, name: tc.function.name, args };
    });

    songloft.log.info(`[AIAnalyzer] API response: "${content.slice(0, 150)}"${toolCalls.length ? ` + ${toolCalls.length} tool_call(s): ${toolCalls.map(t => `${t.name}(${JSON.stringify(t.args)})`).join(', ')}` : ''}`);
    return { content, toolCalls };
  }

  /**
   * 调用 LLM API 分析音乐指令（JSON 模式）
   */
  private async callAI(query: string, config: AIConfig): Promise<AIAnalysisResult> {
    const content = await this.callLLM([
      { role: 'system', content: AI_SYSTEM_PROMPT },
      { role: 'user', content: `用户指令：${query}` },
    ], config, { json: true });
    return this.parseResponse(content);
  }

  /**
   * 问答模式：直接调用 LLM 回答用户问题（纯文本，不 JSON 化）
   * 仅在用户以"请问"等触发词发起问答时调用。
   * @param xiaoaiReply 小爱音箱已先给出的回答文本；非空时让 DeepSeek 判断其正确性并补充/纠正，空则自行理解回答
   */
  async analyzeChat(query: string, config: AIConfig, xiaoaiReply?: string): Promise<string | null> {
    if (!config.enabled || !config.api_url || !config.api_key) {
      return null;
    }
    try {
      const sysPrompt = (xiaoaiReply && xiaoaiReply.trim())
        ? `${AI_CHAT_SYSTEM_PROMPT}\n\n小爱音箱已经先回答了用户的问题，小爱的回答是：「${xiaoaiReply.trim()}」。请判断小爱的回答是否正确、完整：若小爱说错或遗漏，指出哪里不对并给出正确的完整回答；若小爱说得对，简要认可并补充一两个要点。不要重复小爱已说对的内容，总长度不超过80字。`
        : AI_CHAT_SYSTEM_PROMPT;
      const messages: Array<{ role: string; content: string | null; tool_calls?: unknown; tool_call_id?: string }> = [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: query },
      ];
      // 配置了任务桥时启用工具调用：LLM 可自主决定调 query_usage 查询余额/用量
      const tools = (config.bridge_url && config.bridge_token) ? USAGE_TOOLS : undefined;

      let res = await this.callLLMMessages(messages, config, { tools });
      // 工具调用循环：执行桥任务 → 回填 tool 结果 → 再调 LLM（最多 3 轮防死循环）
      let round = 0;
      while (res.toolCalls.length && round < 3) {
        round++;
        songloft.log.info(`[AIAnalyzer] [Tool] round ${round}: executing ${res.toolCalls.length} call(s)`);
        const assistantMsg = {
          role: 'assistant',
          content: res.content || null,
          tool_calls: res.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: JSON.stringify(tc.args) },
          })),
        };
        const toolMessages = [...messages, assistantMsg];
        for (const tc of res.toolCalls) {
          const result = await this.executeBridgeTool(tc, config);
          songloft.log.info(`[AIAnalyzer] [Tool] ${tc.name}(${JSON.stringify(tc.args)}) → ${result}`);
          toolMessages.push({ role: 'tool', tool_call_id: tc.id, content: result });
        }
        res = await this.callLLMMessages(toolMessages, config, { tools });
      }

      const reply = res.content
        .replace(/\*\*|__/g, '')               // 去掉加粗/强调符号，避免 TTS 念出星号
        .replace(/`/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // markdown 链接只留文字
        .replace(/^#{1,6}\s+/gm, '')
        .trim()
        .replace(/^["'“”]+|["'“”]+$/g, '')
        .slice(0, 120);
      return reply || null;
    } catch (e) {
      songloft.log.warn(`[AIAnalyzer] chat analysis failed: ${String(e)}`);
      return null;
    }
  }

  /**
   * 执行任务桥工具：POST {bridge_url}/run {task: which}，返回结果文本
   * 桥在服务器宿主机（songloft-bridge），凭据/脚本都在服务器，全部本地执行
   */
  private async executeBridgeTool(tc: AIToolCall, config: AIConfig): Promise<string> {
    const which = String(tc.args?.which || '');
    if (!config.bridge_url) return '（未配置任务桥）';
    try {
      const resp = await fetch(`${config.bridge_url}/run`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Bridge-Token': config.bridge_token || '',
        },
        body: JSON.stringify({ task: which }),
      });
      const data = await resp.json() as { ok?: boolean; result?: unknown; error?: string };
      if (data.ok) return String(data.result ?? '');
      return `查询失败：${data.error || '未知错误'}`;
    } catch (e) {
      songloft.log.warn(`[AIAnalyzer] [Tool] bridge call failed: ${String(e)}`);
      return `任务桥调用失败：${String(e)}`;
    }
  }

  /**
   * 解析 AI 返回的 JSON
   * reasoning_split=true 时 content 直接是干净 JSON，尝试直接解析
   * 解析失败则兜底：从内容中提取 JSON
   */
  private parseResponse(content: string): AIAnalysisResult {
    const trimmed = content.trim();

    // 优先尝试直接解析（reasoning_split=true 时 content 直接是 JSON）
    try {
      const parsed = JSON.parse(trimmed);
      return {
        action: parsed.action || 'unknown',
        params: parsed.params || {},
        confidence: (parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low')
          ? parsed.confidence
          : 'low',
        rawText: parsed.rawText || '',
      };
    } catch {
      songloft.log.warn(`[AIAnalyzer] Direct JSON parse failed, content: ${content.slice(0, 300)}`);
    }

    // 兜底：去掉思考标签后再提取 JSON
    let cleaned = trimmed
      .replace(/[\[\]/?]*(?:think|思考|THINK)[\[\]/?]*/gi, '');

    const firstBrace = cleaned.indexOf('{');
    if (firstBrace === -1) {
      throw new Error('No JSON found in response');
    }

    let end = cleaned.lastIndexOf('}');
    while (end > firstBrace) {
      const after = cleaned.slice(end + 1);
      if (/^[\s]*$/.test(after)) break;
      end = cleaned.lastIndexOf('}', end - 1);
    }

    const jsonStr = cleaned.slice(firstBrace, end + 1);
    try {
      const parsed = JSON.parse(jsonStr);
      return {
        action: parsed.action || 'unknown',
        params: parsed.params || {},
        confidence: (parsed.confidence === 'high' || parsed.confidence === 'medium' || parsed.confidence === 'low')
          ? parsed.confidence
          : 'low',
        rawText: parsed.rawText || '',
      };
    } catch {
      songloft.log.warn(`[AIAnalyzer] Fallback JSON parse also failed, extracted: ${jsonStr.slice(0, 300)}`);
      throw new Error(`Failed to parse AI response: ${jsonStr.slice(0, 100)}`);
    }
  }
}
