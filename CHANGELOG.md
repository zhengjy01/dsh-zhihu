# Changelog

> `@zhengjunyao/dsh-zhihu` 的全部版本变更。本文件由 `scripts/release.mjs` 在发布时自动补写。
> 格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.1] - 2026-09-13

### 修复 (Fixed)

- fix(home): 配置与数据目录认 DSH_HOME（补 v0.1.1）
- fix(parse): 风控 403/unhuman 与 x-zse-96 签名失败给出可操作提示

### 其它 (Changed)

- docs: README 增补故障排查与可移植性验证命令；收录条目去掉非法 tarball
- chore: 接入可移植性验证 SOP（同步 kit 版 portability.mjs + verify 脚本）
- chore: 准备 awesome-dsh-plugin 收录条目（待仓库满 1 天 + 提交数 ≥ 10 后提 PR）

### 兼容性 (Compatibility)

- DSH：`>=0.1.5-rc.1`
- Node：`^22.19.0 || >=24.0.0`
- DSH peer：^0.1.0-rc.6 || ^0.1.1-rc.1 || ^0.1.2-alpha.1 || ^0.1.5-rc.1

## [0.1.0] - 2026-09-12

### 新增 (Added)

- feat: 首发 dsh-zhihu —— 知乎 CLI 连接插件（18 工具 + Web 面板）

### 修复 (Fixed)

- fix: 配置目录按 DSH_HOME 解析（可移植性）+ 发布工具链

### 其它 (Changed)

- chore: 版本基线归零（0.1.0 尚未发布过，首个公开版本由 release.mjs 从 0.0.0 起算）

### 兼容性 (Compatibility)

- DSH：`>=0.1.5-rc.1`
- Node：`^22.19.0 || >=24.0.0`
- DSH peer：^0.1.0-rc.6 || ^0.1.1-rc.1 || ^0.1.2-alpha.1 || ^0.1.5-rc.1

<!-- 日常提交的内容会累积到这里；发布时脚本会在本行下方插入新版本段落 -->
