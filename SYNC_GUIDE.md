# 上游同步指南 (Upstream Sync Guide)

本仓库使用双远程仓库模式：

| 远程名 | 地址 | 用途 |
|--------|------|------|
| **origin** | `git.biteplays.com/vibeshort/narrative-canvas.git` | 团队私有仓库（可读可写） |
| **upstream** | `github.com/liuxc123/open-ai-canvas.git` | GitHub 上游仓库（只读同步） |

上游分支：`dev`

---

## 一、首次配置

### 1. 添加 upstream 远程仓库

```bash
git remote add upstream https://github.com/liuxc123/open-ai-canvas.git
```

### 2. 验证远程配置

```bash
git remote -v
```

预期输出：

```
origin     http://...@git.biteplays.com/vibeshort/narrative-canvas.git (fetch)
origin     http://...@git.biteplays.com/vibeshort/narrative-canvas.git (push)
upstream   https://github.com/liuxc123/open-ai-canvas.git (fetch)
upstream   https://github.com/liuxc123/open-ai-canvas.git (push)
```

### 3. 拉取 upstream 分支

```bash
git fetch upstream
```

### 4. 创建本地 dev 分支（跟踪 upstream/dev）

```bash
git checkout -b dev upstream/dev
```

---

## 二、日常同步上游更新

当上游 `dev` 分支有新提交时，按以下步骤同步：

```bash
# 1. 切换到 dev 分支
git checkout dev

# 2. 拉取上游最新代码
git fetch upstream

# 3. 合并上游 dev 分支的更新
git merge upstream/dev

# 4.（可选）同步到团队 origin 仓库
git push origin dev
```

---

## 三、将上游更新合并到 main 分支

如果需要把上游 `dev` 的更新合入团队 `main` 分支：

```bash
# 1. 切换到 main 分支
git checkout main

# 2. 合并 dev 分支
git merge dev

# 3. 解决冲突（如果有），然后提交

# 4. 推送到团队 origin 仓库
git push origin main
```

---

## 四、最佳实践

1. **dev 分支保持只读** — 不要在 `dev` 分支上直接开发，它仅用于跟踪上游更新
2. **自己开发在 main** — 团队的自定义开发在 `main` 或基于 `main` 的 feature 分支上进行
3. **定期同步** — 建议定期执行同步操作，避免积累大量合并冲突
4. **冲突处理** — 合并时遇到冲突，优先保留 `main` 分支中的本地自定义改动
5. **不要 push 到 upstream** — upstream 为只读，不要向其推送代码

---

## 五、常用命令速查

| 操作 | 命令 |
|------|------|
| 查看远程仓库 | `git remote -v` |
| 拉取上游更新 | `git fetch upstream` |
| 查看所有分支 | `git branch -a` |
| 查看本地与上游差异 | `git log dev..upstream/dev --oneline` |
| 同步 dev 到 origin | `git push origin dev` |
| 合并 dev 到 main | `git checkout main && git merge dev` |
