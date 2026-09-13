# MarkAI 发版手册

> 这份文档写的是 **markai 这个项目真实的发版方式**。它存在的理由：通用部署流程假定
> 「有一台服务器 + 健康探针」，而 markai 是浏览器扩展，没有服务端、没有探针，
> 唯一的发布通道是 **GitHub Release**（由 `.github/workflows/release.yml` 自动产出）。

## 0. 先明确：不走 keepgoal 部署主机

markai **不申请** `keepgoal_deploy_access`。那台香港主机是 maodouchat 的生产机
（Caddy + Postgres + server + `/health/*` 探针），与扩展无关。
扩展的"生产"就是 GitHub Release 里那个 zip。

因此本手册对应通用部署流程的等价物：

| 通用流程 | markai 的等价做法 |
| --- | --- |
| 构建 | `npm run zip`（本地）+ Actions 里再构建一次 |
| 上传到新目录 | 推 tag → Actions 产出新的 Release 资产（天然不覆盖旧版） |
| 重启服务 | 没有服务；用户端由 Chrome 重新加载扩展 |
| 健康探针 | **下载 Release 资产并校验其中的 `manifest.json`**（下节「验证」） |
| 回滚 | 删掉出问题的 tag 与 Release，重新打过 |

## 1. 版本号的唯一来源

```
package.json 的 version
      │  WXT 构建时注入
      ▼
manifest.json 的 version  ←── chrome.runtime.getManifest().version
      │                              │
      │                              ▼
      │                    src/lib/version.ts 的 appVersion()
      │                              │
      ▼                              ▼
（产物身份）              config-form / popup 显示的版本号
```

**禁止在界面里硬编码版本号。** 这个坑已经踩过一次：`0.2.0 → 0.2.1` 时
`config-form.tsx` 与 `popup/main.tsx` 里的字面量漏改，界面显示与装进浏览器的产物脱节。
现在 `tests/agent.test.ts` 的 **T25** 会拦住它：

- `appVersion()` 必须等于 `package.json` 的 version；
- 覆盖清单版本时 `appVersion()` 必须跟着变（证明不是常量）；
- `src/` 下不得出现硬编码的三段式版本号（注释除外）；
- 两个 UI 面必须真的调用 `appVersion()`（防止用"干脆不显示版本"绕过守卫）。

## 2. 发版步骤

```bash
# 1) 改版本号：package.json + package-lock.json（根与 packages[""] 两处，别动依赖的版本）
#    然后确认全仓库没有残留的旧版本字面量
grep -rn "0\.2\.[0-9]" package.json package-lock.json src/ README.md | grep -v node_modules

# 2) 本地全绿（缺一不可）
npm run compile && npm test && npm run build
node scripts/falsify.mjs      # 反证：回滚实现 → 对应用例必须变红（它会改写工作区源码，勿并行跑上面几条）

# 3) 本地打包并**开箱检查**（这一步是发版前的最后一道闸）
npm run zip
cd .output && unzip -o -q markai-0.2.2-chrome.zip -d /tmp/markai-check && \
  python3 -c "import json;m=json.load(open('/tmp/markai-check/manifest.json'));print(m['version'],m['manifest_version'],sorted(m['permissions']))"

# 4) 提交 + 推 tag（tag 触发 Release workflow）
git add -A && git commit -m "chore: 版本号 0.2.2" && git push origin main
git tag v0.2.2 && git push origin v0.2.2

# 5) 盯 workflow，别只发不看
gh run list --limit 1
gh run watch <run-id> --exit-status
```

## 3. 验证（不能省的一步）

发版成功的标准是**拿到了可校验的产物**，不是"tag 推上去了"：

```bash
# Release 资产必须存在，且包含 zip
gh release view v0.2.2 --json assets --jq '.assets[].name'

# 下载并校验：zip 里 manifest.json 的版本必须与 tag 一致
gh release download v0.2.2 -p '*chrome*.zip' -D /tmp/markai-rel --clobber
cd /tmp/markai-rel && unzip -o -q '*.zip' -d unpacked
python3 -c "import json;m=json.load(open('unpacked/manifest.json'));print(m['version'])"
```

对着检查：

- `manifest.json` 的 `version` == tag 去掉 `v` 之后的值；
- `manifest_version` == 3，`permissions` 与 `wxt.config.ts` 一致（权限意外变多 = 事故）；
- 入口文件齐全：`background.js`、`sidepanel.html`、`page.html`、`popup.html`、`options.html`。

## 4. 回滚

扩展没有"线上服务"，回滚 = 让错误的产物不再作为最新版存在：

```bash
gh release delete v0.2.2 --yes
git push origin :refs/tags/v0.2.2
git tag -d v0.2.2
```

修好问题后重新打 tag。**已经在用户浏览器里加载的旧 zip 不受影响**——
扩展不发版也能继续用，这是它比服务端安全的地方。

## 5. 已知边界（如实记录，别当成已解决）

- **没有商店渠道**：不发 Chrome Web Store，产物只挂在 GitHub Release，用户手动加载。
- **没有真机验证**：Release 校验只能证明产物结构正确，**证明不了**扩展在真实 Chrome 里
  的行为（拖拽手感、撤销按钮、SW 回收后的存储表现）。这属于 DIRECTION 的 P3。
- **Firefox zip 未实测**：workflow 会一起产出 `*-firefox.zip`，但从未在 Firefox 里装过。
