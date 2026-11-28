/**
 * 对外接口注册（占位实现）。
 *
 * 真实实现负责：本机回环 HTTP 服务 / MCP 桥、token 校验、审计日志、设置页开关。
 * 未安装时设置页显示"未启用"，不显示一个点了没反应的开关。
 */
export function installExternalApi(): void {
  // 占位：不启动任何监听
}
