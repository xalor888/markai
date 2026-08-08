import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// ── MarkAI 智能书签 Agent：WXT 配置 ──
export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'MarkAI',
    description: '你的智能书签管家 —— 自由对话的 AI Agent，整理、清理、管理浏览器收藏夹',
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
