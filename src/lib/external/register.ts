/**
 * 对外接口注册。
 *
 * 两个入口共用这份代码，但职责不同：
 *  · **background**：读配置 → 启动/停止轮询循环；配置变了自动重启；
 *  · **UI 页面**：什么都不启动，只保证模块可加载（功能开关据此显示"可用"）。
 *
 * 为什么必须区分：轮询循环每个上下文各跑一份的话，桥上的同一个请求会被
 * 侧边栏、完整页、设置页同时领走——虽然有 id 去重，但会白跑工具、还会互相
 * 抢 `/v1/result`。只让 Service Worker 跑是唯一正确的拓扑。
 */
import { EXTERNAL_STORAGE_KEY, type ExternalApiConfig } from '@/lib/features/external';
import { readExternalConfig, startExternalRuntime, stopExternalRuntime } from './runtime';

/** 当前是否在 MV3 的 Service Worker 里（只有它该跑轮询） */
export function isServiceWorkerContext(): boolean {
  const g = globalThis as {
    ServiceWorkerGlobalScope?: { prototype: unknown };
    self?: unknown;
    document?: unknown;
  };
  const ctor = g.ServiceWorkerGlobalScope;
  if (!ctor) return false;
  // 有 document 就是普通页面，即使全局上有 ServiceWorkerGlobalScope 构造器
  if (g.document) return false;
  return g.self instanceof (ctor as unknown as new () => unknown);
}

let installed = false;

export function installExternalApi(): void {
  if (installed) return;
  installed = true;
  if (!isServiceWorkerContext()) return;

  void readExternalConfig().then((config) => {
    if (config?.enabled && config.token) startExternalRuntime(config);
  });

  // 设置页改了开关/端口/token：重启循环。不重启的话用户会看到"已启用"但请求永远不来。
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes[EXTERNAL_STORAGE_KEY]) return;
      const next = changes[EXTERNAL_STORAGE_KEY].newValue as Partial<ExternalApiConfig> | undefined;
      if (!next?.enabled || !next.token) {
        stopExternalRuntime();
        return;
      }
      void readExternalConfig().then((config) => {
        if (config) startExternalRuntime(config);
      });
    });
  } catch {
    // 没有 storage 事件（测试环境）就只依赖启动时读一次
  }
}

/** 仅供测试：复位安装标记 */
export function resetExternalInstallForTest(): void {
  installed = false;
  stopExternalRuntime();
}
