// MIoT 智能音箱插件 - 轮询调试日志开关
//
// 会话监听默认每秒轮询，稳态（无新消息）下若打印大量 info 日志会构造模板字符串
// 并跨 __go_console 桥，纯浪费且刷屏。用一个同步可读的布尔缓存门控这些日志：
// 轮询在热路径上，不能每 tick 去 await 读配置，因此由配置加载/更新时通过
// setPollDebug 写入本模块的缓存，热路径用 isPollDebug() 同步读取。
//
// 对应设置项 PluginConfig.conversation_poll_debug（默认 false）。

let _pollDebug = false;

/** 热路径同步读取当前轮询调试日志开关。 */
export function isPollDebug(): boolean {
  return _pollDebug;
}

/** 由配置加载/更新时调用，更新缓存的开关值。 */
export function setPollDebug(enabled: boolean): void {
  _pollDebug = !!enabled;
}

// ===== 详细日志总开关（verbose_log）=====
//
// 排查不稳定问题时把日志详细程度拉满：开启后关键链路（语音命令全流程、
// 问答播报轮询、DeepSeek 请求/响应、工具调用、播放器操作、播放列表切歌）
// 打印全量日志，便于精确定位。与轮询开关同模式：配置加载/更新时写入缓存，
// 热路径用 isVerbose() 同步读取。对应 PluginConfig.verbose_log（默认 false）。

let _verbose = false;

/** 热路径同步读取详细日志总开关。 */
export function isVerbose(): boolean {
  return _verbose;
}

/** 由配置加载/更新时调用，更新缓存的开关值。 */
export function setVerbose(enabled: boolean): void {
  _verbose = !!enabled;
}
