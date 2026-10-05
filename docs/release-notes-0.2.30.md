# v0.2.30 — 修复「每次更新都要重填配置」

## 症状

每次安装新版 zip，API Key、模型、主题、对话记录全部消失，必须重新填一遍。

## 根因：扩展 ID 变了，而 storage 是按 ID 隔离的

`wxt.config.ts` 的 `manifest` 里**没有 `key` 字段**。

Chrome 派生的扩展 ID 默认依赖**加载目录的绝对路径** —— 没有 `key` 时，它对路径做 SHA-256 取前 128 bit。而 `chrome.storage.local` 是**按扩展 ID 隔离**的存储。

于是：解压新版 zip 到新目录 → 加载 → 路径变了 → **ID 变了** → 整个 `storage.local` 读不到 → 表现为"配置全空"。

实测复现（两份 manifest **内容完全相同**，只是路径不同）：

```
SHA-256("/tmp/idtest/a") → heafpmcdagaodcemenjlccheopjkhmgb
SHA-256("/tmp/idtest/b") → fjcmnefpjgmdndimfjikgkopabcfbpom
```

**这个故障没有任何运行时错误**，日志、测试、构建全部正常，只有用户投诉。

## 修复

1. 生成一对 RSA-2048 密钥，**公钥**（base64）写入 `wxt.config.ts` 的 `manifest.key`。
   该公钥派生出的固定扩展 ID 是 **`ojlfhclcoecgjbgklbjcbcfbjjjlhjhd`**，此后与加载目录无关。
2. 私钥存于 `.keys/markai.pem`，**已被 `.gitignore` 整目录排除**，绝不提交。
   （公钥本来就公开——它就是放进 zip 的东西；私钥泄漏则意味着任何人都能签出同 ID 的扩展。）

验证方式：构建后从产物 `manifest.json` 取出 key，base64 解码成 DER，算 SHA-256 前 128 bit 再把 hex 映射到 `a-p`，得到的 ID 与生成时一致。

## 升级后你需要做一次

**这一次仍然要重填配置** —— 旧版本的 ID 与新 ID 不同，旧数据在旧 ID 那个空间里，Chrome 不会自动迁移。

从 **v0.2.30 起**，只要 ID 不变，之后每次更新都会保留配置。以后再升级不用再填了。

## 新增守卫（T73，两条）

- `manifest.key` 必须存在、是单行 base64、长度符合 RSA-2048 公钥、**且以 `MIIB` 开头**（DER SubjectPublicKeyInfo，即公钥）——防止误把私钥写进 manifest
- `.gitignore` 必须整行排除 `.keys/` —— 防止私钥进仓库

## 验证

- `npm run compile` ✔（退出码实测 0）
- `npm test` **500 项全绿**（498 → 500）
- `npm run build` ✔
- 产物核对：`manifest.json` 含 392 字符的 key，派生的 ID 确为 `ojlfhclcoecgjbgklbjcbcfbjjjlhjhd`
- `git check-ignore -v .keys/markai.pem` 确认私钥被 `.gitignore:26` 排除
- 新增反证 2 条（172 → 174），定向实跑 `RED ✔`

## 已知事项

- **模型能力检测仍未做**：31 个工具、约 5K token 的 schema 无条件随每个请求发出，不支持 tool calling 的小模型没有降级路径。
- **真机未验证**：本轮证据是产物核对 + 幂等的 ID 推导实测 + 替身测试 + 反证。ID 是否真的稳定，**只有装了才知道** —— 建议装上 v0.2.30、改几个设置，然后重装一次 v0.2.30 的 zip，确认设置还在。
