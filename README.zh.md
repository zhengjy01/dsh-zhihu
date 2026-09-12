# @zhengjy01/dsh-zhihu

[DeepSeek Harness](https://github.com/deepseek-ai/dsh) 的知乎插件：把本机的知乎命令行工具 **[pyzhihu-cli](https://github.com/BAIGUANGMEI/zhihu-cli)**（命令名 `zhihu`）包装成 `zhihu_*` agent 工具——搜问题、看热榜、读问题/回答/评论、查用户、刷推荐流、看话题与通知；发布、点赞、关注、删除等写操作**默认关闭**，由 `readOnly` 开关显式放开。

- **读取类工具**调用 `zhihu <command> --json`，把原始知乎 API JSON 归一化成紧凑条目（id / 类型 / 标题 / 链接 / 作者 / 赞同数 / 回答数）。
- **登录**走知乎官方二维码接口：CLI 把二维码写成 PNG，插件把路径交给 agent 展示给用户扫码；也支持粘贴 Cookie（插件直接写 CLI 的 Cookie 文件，令牌不会出现在进程列表里）。
- **写操作**默认不注册，避免误发/误删。

## 前置条件

```bash
# 安装知乎 CLI（Python 3.10+；推荐 uv，独立 venv 不污染系统 Python）
uv tool install pyzhihu-cli      # 或 pipx install pyzhihu-cli
zhihu --version                  # zhihu-cli, version 0.2.4
```

插件会自动在 `$PATH`、`~/.local/bin`、`/opt/homebrew/bin`、`/usr/local/bin` 里找 `zhihu`；装在别处就用 `zhihu_config` 的 `cliPath` 指绝对路径。

> **重要**：pyzhihu-cli 的**所有**命令都要求先登录——未登录时连热榜都会以 `Not authenticated` 失败。所以第一次使用必须先完成一次 `zhihu_login`。

## 工具

### 管理与认证

| 工具 | 用途 |
|---|---|
| `zhihu_status` | 状态：CLI 是否可用及版本、是否已登录（Cookie 是否含 `z_c0`/`_xsrf`/`d_c0`）、当前只读与否、路径与超时。**不回显 Cookie 内容** |
| `zhihu_config` | 配置 `readOnly` / `cliPath` / `timeoutMs` / `loginWaitMs` / `proxy` / `cliHome`；`reset: true` 恢复默认。不带参数即读当前配置 |
| `zhihu_login` | 登录。`mode: qrcode`（默认）返回二维码 PNG 路径（`~/.zhihu-cli/login_qrcode.png`）供展示扫码，可反复调用继续等待（不会重复生成二维码）；`mode: cookie` 粘贴 `z_c0/_xsrf/d_c0` 登录并联网校验 |
| `zhihu_logout` | 删除 CLI 的 Cookie 文件 |
| `zhihu_whoami` | 当前账号资料 |

### 读取

| 工具 | 用途 |
|---|---|
| `zhihu_search` | 搜索问题/回答/文章/用户/话题（`type: general\|people\|topic`） |
| `zhihu_hot` | 知乎热榜（标题 + 热度 + 链接） |
| `zhihu_question` | 问题详情；`answers: true` 时附带回答列表（`limit` / `sort`） |
| `zhihu_answer` | 回答正文；`comments: true` 时附带评论 |
| `zhihu_user` | 用户资料，或该用户的回答/文章/粉丝/关注（`include`） |
| `zhihu_feed` | 首页推荐流；`withComments: true` 走 CLI 的「推荐+评论」文本模式 |
| `zhihu_topic` | 话题详情；`hotQuestions: true` 时附话题热门问题 |
| `zhihu_notifications` | 通知（支持 `offset` 翻页） |
| `zhihu_collections` | 收藏夹列表 |

### 写入（仅在 `readOnly: false` 时注册）

| 工具 | 用途 |
|---|---|
| `zhihu_publish` | 发布提问 / 想法 / 文章（`kind: ask\|pin\|article`，支持话题与本地图片；`dryRun: true` 只回显命令） |
| `zhihu_vote` | 赞同 / 取消赞同回答 |
| `zhihu_follow_question` | 关注 / 取消关注问题 |
| `zhihu_delete` | 删除自己发布的提问 / 想法 / 文章（必须显式 `confirm: true`） |

## Web 面板（可视化入口）

插件在 Web GUI 里有两个入口，都由同一个面板组件渲染：

1. **右下角悬浮球**（蓝色「知」字圆钮）——任何页面都能打开，点开是 380px 宽的浮层面板。
2. **设置页「知乎」卡片**——`设置` 页面里的一个 section。

面板能力：

| 区块 | 内容 |
|---|---|
| 登录 | 登录状态；未登录时一键「二维码登录」，**二维码直接渲染在面板里**，扫码成功自动切到已登录；已登录可「退出登录」 |
| 账号 | 昵称 / `@url_token` / 签名 / 回答数 / 关注者数，可刷新 |
| 能力 | 只读开关（复选框，关掉即注册写工具）、代理（继承 / 不走 / 自定义）、超时（ms），以及配置文件路径 |
| 热榜 | 一键拉取热榜前 10 条，点标题跳知乎 |
| 搜索 | 关键词搜索知乎内容，返回前 5 条，点标题跳知乎 |

面板走 loopback-only 路由 `/api/dsh-zhihu/*`：`status` / `config` / `login` / `qrcode` / `logout` / `whoami` / `hot` / `search`（非 127.0.0.1/::1 且非本机 Host、跨站 Origin 一律 403）。二维码以 PNG data URL 返回，不落任何新文件。

> 改客户端改动后需要**硬刷新浏览器**；改 host 端或改 `dsh.client` 清单后需要**重启 `dsh web`**。

## 只读开关（写操作默认关闭）

插件的**默认行为是只读**：写工具根本不注册，模型看不到也就调不动。

放开写操作（两步）：

```jsonc
// 1) 安装时在 cordis.patch.yml 里把 readOnly 设为 false（首次生效的种子值）
- insert:
    - id: zhihu
      name: dsh-zhihu
      config:
        readOnly: false
```

```
2) 或运行时用工具改（存 ~/.dsh/dsh-zhihu.json，立即重挂工具）：
   zhihu_config({ readOnly: false })     # 放开写工具
   zhihu_config({ readOnly: true })      # 收回
```

`~/.dsh/dsh-zhihu.json` 里的值优先于安装时的种子值；两者都没有时默认只读。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `readOnly` | `true` | 只注册读取类工具；`false` 才注册写工具 |
| `cliPath` | `zhihu` | CLI 命令名或绝对路径 |
| `timeoutMs` | `90000` | 单次 CLI 调用超时 |
| `loginWaitMs` | `15000` | `zhihu_login` 等待扫码的时间；超时可再调一次继续等 |
| `proxy` | 空 | 空 = 继承环境变量；`none` = 强制不走代理（知乎是国内站点，系统代理反而可能出问题）；也可填 `http://host:port` |
| `cliHome` | `~/.zhihu-cli` | CLI 配置目录。CLI 硬编码 `Path.home()/".zhihu-cli"`，所以插件通过改子进程的 `HOME` 实现覆盖 |

配置存 `~/.dsh/dsh-zhihu.json`（权限 0600）。登录凭据**不在**这里——Cookie 由 CLI 保存在 `<cliHome>/cookies.json`（CLI 自己 chmod 0600）。

## 登录

**方式一：二维码（推荐）**

```
zhihu_login()                     → 返回 qrcodePath（~/.zhihu-cli/login_qrcode.png）
   ↓ agent 用 read_image / present 展示给用户
用户在知乎 App 里扫码
zhihu_login()                     → 继续等待，成功后返回 authenticated: true
```

**方式二：粘贴 Cookie**

```
zhihu_login({ mode: "cookie", cookie: "z_c0=...; _xsrf=...; d_c0=..." })
```

插件把 Cookie 直接写进 CLI 的 `cookies.json`（格式与 CLI 的 `save_cookies` 完全一致），再调 `zhihu whoami` 联网校验；校验失败会删除该文件并报错。相比 `zhihu login --cookie`，这条路径**不会把令牌暴露在进程列表里**。

## 兼容性

要求 **DeepSeek Harness ≥ 0.1.5-rc.1**（已在包清单的 `dsh.engines.dsh` 中声明，DSH 插件市场据此显示兼容版本），已在 **0.1.5-rc.1** 实测通过。本构建遵循 DSH 0.1.5 的工具结果严格校验契约（lossless-JSON 快照、`additionalProperties: false` 的 schema 校验、`output.render` 返回 `ContentBlock[]`），并使用不依赖宿主 PATH 的可执行文件解析（launchd 托管的宿主 `PATH` 只有 `/usr/bin:/bin`）。

## 已知限制

- CLI 的 `--json` 模式对**评论**、**推荐+评论（`feeds`）**、**话题热门问题**不生效——这三处插件改用文本模式，结果放在返回值的 `text` 字段（已剥离 Rich 的 ANSI 颜色码）。
- `zhihu_search` / `zhihu_hot` 的 `-a/--answers`（每条附带回答）只在 CLI 的人类可读模式下生效，JSON 模式下被忽略，因此插件不暴露该参数。
- 知乎有风控。插件是薄封装，频率与合规责任在使用方；请勿高频抓取。
- 公开的知乎 API 行为可能变化；命令面以本机 `zhihu <cmd> --help` 为准（README 描述可能领先或落后于实际版本）。

## 开发

```bash
pnpm install
pnpm typecheck       # tsc --noEmit（host + client）
pnpm build           # tsc 出 .d.ts + tsdown 出 lib/index.js（host）与 lib/client.js（浏览器）
pnpm test            # 冒烟测试（含真实 CLI 调用；写操作全部落在临时目录）
pnpm test:e2e        # 直接调插件工具跑真实 CLI（不用重启宿主）
node tests/routes.mjs  # 用合成 req/res 打 /api/dsh-zhihu/* 路由
node tests/client.mjs  # 在合成的 __ModuleLoader__ 里执行 lib/client.js，验证面板注册
```

构建产物：`lib/index.js`（host，ESM）+ `lib/client.js`（浏览器，closure-factory）+ `lib/types/`（.d.ts）。

## 安装到 profile

```bash
dsh plugin --profile web add @zhengjy01/dsh-zhihu
dsh plugin --profile web add link:/path/to/dsh-zhihu
# 或发布后
dsh plugin --profile web add github:zhengjy01/dsh-zhihu
```

安装后需重启 DSH web 服务（无热重载）。

## 许可证

MIT。知乎 CLI 本体（pyzhihu-cli）为 Apache-2.0，本项目仅通过子进程调用它，不包含其代码。
