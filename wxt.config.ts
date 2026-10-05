import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// ── MarkAI 智能书签 Agent：WXT 配置 ──
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'MarkAI',
    description: '你的智能书签管家 —— 自由对话的 AI Agent，整理、清理、管理浏览器收藏夹',
    // 固定扩展 ID（公钥，base64 无换行）。
    //
    // 为什么必须有：Chrome 派生的扩展 ID 默认依赖**加载目录的绝对路径**——没有 key 时
    // 它对路径做 SHA-256 取前 128 bit。而 chrome.storage.local 是**按扩展 ID 隔离**的，
    // 所以每次把新版 zip 解压到新目录加载 → 路径变 → ID 变 → API Key / 模型 / 主题 /
    // 对话记录全都读不到，用户表现为"每次更新都要重新填一遍配置"。
    //
    // 有了 key，ID 由公钥派生，恒为 ojlfhclcoecgjbgklbjcbcfbjjjlhjhd，与目录无关。
    // 公钥可以公开（它就是放进 zip 的东西），**私钥 .keys/markai.pem 已被 .gitignore
    // 排除、绝不提交**；将来若上 Chrome Web Store，商店会分配自己的 ID，届时删掉此字段。
    key: 'MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA3TNHgP/OL3lqvdwJtL3B0lTr5/8nXIa40wuUhuTAHCWAXU5KiPpXL+PqpYjbRLRFt2bvuHIDj2mlI+2kdIreMlfTEpAKzOiloTJ2rFf2sap+ZQth8uASTY0eX0+Ln7+wi3NHk5wI1TaFx8gFdRiXEPqSwdtkx7sWMBgtT2sdTFjrZ/BOlBDmvt+NHW+0Hb5A4j87FfJXdIYF7L2V5MpVRy0DK/DxmS3jzwxInBqbABE19l7CeeI81VBjKR+wDFQPI/516E55SjeBxpc2Tfm2ZshdGYVtaD3ax5AXE+swC2+D7doGsO2uMZOYi2eGasK6mzVgbgQ14uEfLr8t7ndSQwIDAQAB',
    permissions: ['bookmarks', 'storage', 'tabs', 'tabGroups', 'contextMenus', 'sidePanel'],
    // <all_urls>：兼容任意自定义 Base URL（OpenAI / DeepSeek / Moonshot / 本地 Ollama / 代理）
    host_permissions: ['<all_urls>'],
    action: {
      default_title: 'MarkAI 智能书签管家',
    },
    // 设置页打开方式由 entrypoint 的 options.html meta 标签配置（openInTab: true）
    side_panel: {
      default_path: 'sidepanel.html',
    },
    // 全局快捷键：Ctrl+Shift+M 打开侧边栏
    commands: {
      'open-markai': {
        suggested_key: { default: 'Ctrl+Shift+M', mac: 'MacCtrl+Shift+M' },
        description: '打开 MarkAI 侧边栏',
      },
    },
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
