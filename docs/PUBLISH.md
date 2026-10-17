# 发布流程（v1.2.0 实操版）

> 这份是**照着实跑走一遍**的流程，不是设想。每一步都附「为什么」和「踩过的坑」。

---

## 0. 前提

| 项 | 要求 |
|---|---|
| 版本号 | `package.json` 的 `version` |
| 远端 | `https://github.com/azure5100/huahua-dsh-memory-os` |
| 工具 | git（推送凭据在 Windows 凭据管理器）· gh（已登录）· node（`node --check`）|
| 发布内容 | **只发 `files[]` 白名单**，不要把 `ops/`、`qa/`、`.idea/`、`*.tgz` 带进公开仓库 |

---

## 1. 构建「干净发布树」

不要直接在开发仓库上 push —— 开发仓库里有大量内部记录（`ops/`）。做法是**新建一个独立目录**，只拷白名单内容：

```js
const includes = ['lib', 'agents', 'skills', 'scripts', 'vendor',
                  'README.md', 'README.en.md', 'LICENSE', 'package.json'];
```

拷贝时**跳过**：`*.bak`、`*.bak-*`、`*.corrupt-*`、`agents/.ops`。

结果应为 **≈470 文件 / ≈11 MB**。

---

## 2. 脱敏扫描（**最重要的一步**）

对待发布的每个文本文件扫这些模式，命中就替换成占位符：

| 模式 | 替换为 |
|---|---|
| `C:\Users\<user>` | `<USER_HOME>` |
| `D:\DSH` | `<DSH_HOME>` |
| MachineGuid（`HKLM\SOFTWARE\Microsoft\Cryptography`）| `<MACHINE_GUID>` |
| 主机名（`$env:COMPUTERNAME`）| `<HOSTNAME>` |
| 局域网 IP（`192.168.x.x`，**示例 IP 除外**）| `<LAN_IP>` |
| 房间/会话 UUID | `<ROOM_ID>` |
| `sk-xxxxxxxx…` / `ghp_…` / `github_pat_…` | **删掉整行或 `<REDACTED>`** |

### ⚠️ 真实教训（v1.2.0 发布时发生）

- 有 **3 个内部记录文件里带真 API Key**（`sk-a50400c9…`，出现在系统提示词快照里）
- 先确认它**有没有被推送过**：

```bash
git log -S '<key>' --oneline --all
git merge-base --is-ancestor <commit> origin/main && echo PUSHED || echo NOT-PUSHED
```

- 本次结论是 **NOT-PUSHED** ⇒ 本地清掉即可；若结果是 PUSHED ⇒ **必须轮换密钥**，清历史没有意义
- **即使清掉了，也建议轮换**（它曾在本地明文存在过）

**扫完必须做到：零命中。** 用 `git ls-files` 遍历**已提交**的文件再扫一遍（「本地看着干净」不算）。

---

## 3. 语法检查（防「装上去整片坏」）

```bash
node --check <file>    # 对发布树里每个 .js
```

v1.2.0 结果：**88 个 JS 全部通过**。有任何一个不过 ⇒ 停，不要发布。

---

## 4. 版本与元数据

```json
{
  "version": "1.2.0",
  "peerDependencies": { "@deepseek-ai/dsh-client-runtime": ">=0.2.0-rc.2" },
  "repository": { "type": "git", "url": "git+https://github.com/azure5100/huahua-dsh-memory-os.git" },
  "engines": { "node": ">=20" }
}
```

**peer 要放宽**（`>=` 而非 `^`）—— 否则新版 DSH 会被版本闸门直接拒装。

---

## 5. README 的一键安装段

```bash
dsh plugin add https://github.com/azure5100/huahua-dsh-memory-os
```

并写明：装完**必须重启桌面端**（host 半只在启动时加载）。

---

## 6. 建独立干净仓库并提交

```bash
cd <publish-dir>
git init -b main
git config user.name  "huahua"
git config user.email "huahua@users.noreply.github.com"
git add -A
git commit -m "release: HOS v<version> — <一句话>"
```

**为什么要独立仓库**：开发仓库的历史里有内部文件（`ops/`），直接 push 会把它们一起公开。独立仓库 ⇒ **历史天然干净**。

---

## 7. 推送（会改写远端历史，需明确批准）

```bash
git remote add origin https://github.com/azure5100/huahua-dsh-memory-os.git
git push --force -u origin main
```

- `--force` 会**替换**远端现有历史 ⇒ **不可逆** ⇒ 先拿到明确批准，并**先确认旧历史里没有密钥**
- 推送后核对：`git ls-remote origin refs/heads/main` 与 `git rev-list --left-right --count origin/main...HEAD`（应为 `0  0`）

---

## 8. 打 tag

```bash
git tag -a v<version> -m "HOS v<version> — <一句话>"
git push origin v<version>
```

---

## 9. 建 Release（gh）

```bash
gh release create v<version> <path-to-zip> \
  --title "HOS v<version> — <标题>" \
  --notes-file <path-to-notes.md>
```

### ⚠️ 坑：`gh auth status` 在管道下会谎报「未登录」

- 用 `execFileSync(cmd, args, { stdio: 'pipe' })` 调 `gh` ⇒ 它会报 `not logged into any GitHub hosts` —— **假的**
- 原因是 gh 的登录态输出走 stderr / 需要 TTY
- **解法**：直接调 shell（`pwsh -Command`）或在终端里跑 ⇒ 立刻显示 `✓ Logged in ... (keyring)`
- ⇒ 判据：**「未登录」至少两义**：真没登录 ✗ ／ 读数方式不对 ✓ —— 换个方式再读一次

---

## 10. 发布后验证（**别只看命令成功**）

```bash
# ① 远端 ref 与 tag
git ls-remote origin refs/heads/main refs/tags/v<version>

# ② Release 与资产
gh release view v<version> --json tagName,name,isDraft,url,assets

# ③ 真克隆一次，验证「一键安装」路径
git clone --depth 1 https://github.com/azure5100/huahua-dsh-memory-os.git /tmp/verify
git -C /tmp/verify describe --tags --always     # 应为 v<version>
```

v1.2.0 结果：`isDraft=false` · 附件 `4,193,064 B` · `sha256 2ba7995f…` · 克隆后 `version=1.2.0` / `describe=v1.2.0` ✓

---

## 11. 发布检查清单

- [ ] 发布树只含 `files[]` 白名单
- [ ] 脱敏扫描 **零命中**（对 `git ls-files` 的结果扫）
- [ ] 密钥若曾出现在历史 ⇒ 已确认是否推送过；推送过 ⇒ **已轮换**
- [ ] 所有 `.js` 过 `node --check`
- [ ] `version` 已升；`peerDependencies` 用 `>=`
- [ ] README 有一键安装段 + 重启说明
- [ ] 独立干净仓库（`git init`），不是开发仓库直接 push
- [ ] `--force` 推送前：拿到批准 + 确认旧历史无密钥
- [ ] tag 已推
- [ ] Release 已建、`isDraft=false`、附件大小与本地一致
- [ ] **真克隆一次**验证安装路径
- [ ] 新踩的坑写回本文件
