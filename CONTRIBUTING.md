# 参与 MiaoTV

修正文档、补充复现步骤、修复问题和新增功能都可以提 PR。较大的功能调整建议先开 [Issue](https://github.com/bytedo/miaotv/issues)，说明使用场景和准备怎么改，避免做完后才发现方向不合适。

## 准备开发环境

使用 [.nvmrc](.nvmrc) 中的 Node.js 22.23.2 和 `package.json` 固定的 pnpm 10.14.0。克隆仓库后，复制 `.env.example` 为 `.env.local`，填写站长用户名和密码：

```sh
git clone https://github.com/bytedo/miaotv.git
cd miaotv
cp .env.example .env.local
corepack enable
corepack prepare pnpm@10.14.0 --activate
pnpm install --frozen-lockfile
pnpm dev:local
```

Windows PowerShell 用 `Copy-Item .env.example .env.local` 复制配置。开发服务默认在 [http://127.0.0.1:3000](http://127.0.0.1:3000)。`dev:local` 会从项目环境文件读取 `USERNAME`，Windows 开发也用这个命令。需要局域网访问时再用 `pnpm dev`。

浏览器本地存储适合查看页面和调试播放。测试注册、后台设置和账号数据时，需要配置服务端存储，见[配置说明](docs/deployment/CONFIGURATION.md)。请使用单独的开发数据库。

项目使用 Next.js 16 App Router。修改框架相关代码前，阅读 [AGENTS.md](AGENTS.md) 及安装包内 `node_modules/next/dist/docs/` 的对应文档。旧版 Next.js 的 API 和配置不一定适用。

## 目录

| 路径                                           | 用途                                       |
| ---------------------------------------------- | ------------------------------------------ |
| `src/app/`                                     | 页面与 API 路由                            |
| `src/components/`                              | 播放器、导航和管理面板等组件               |
| `src/lib/`                                     | 认证、存储、媒体源、代理和播放逻辑         |
| `src/hooks/`                                   | 页面和播放器使用的 React Hooks             |
| `src/lib/__tests__/`、`src/app/api/__tests__/` | Node.js 回归测试和测试辅助文件             |
| `src/proxy.ts`                                 | 请求入口的认证与路由处理                   |
| `public/`                                      | 图标、模型权重和下载所需的静态文件         |
| `scripts/`                                     | 开发启动、清单生成、平台构建和容器验证脚本 |
| `docs/`                                        | 使用、部署和开发说明                       |

`public/sw.js` 是下载功能使用的 Service Worker，`public/mitm.html` 会注册它。修改下载流程时需要一起检查这两个文件。

## 检查改动

```sh
pnpm typecheck
pnpm lint
pnpm test
pnpm build
```

`typecheck` 先生成 Next.js 路由类型，再运行 TypeScript；Next.js 16 的构建不会代替 ESLint 检查。`pnpm test` 使用 Node.js 内置测试运行器，`pnpm test:watch` 可监听文件变化。默认测试不连接生产数据库。

只改文档时，检查命令、链接和排版即可。格式化请指定改过的文件，例如 `pnpm exec prettier --write README.md docs/README.md`，不要为了一个小改动重排整个仓库。

### Redis / Lua 回归

CI 还会启动本机的 fakeredis 服务执行 Lua 脚本测试。这部分需要 Python 3.12 和 [scripts/test-requirements.txt](scripts/test-requirements.txt) 中的测试依赖，默认 `pnpm test` 会跳过它们。

macOS / Linux：

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r scripts/test-requirements.txt
MIAOTV_REDIS_LUA_TESTS=1 MIAOTV_LUA_PYTHON=.venv/bin/python pnpm test
```

PowerShell：

```powershell
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r scripts/test-requirements.txt
$env:MIAOTV_REDIS_LUA_TESTS = '1'
$env:MIAOTV_LUA_PYTHON = (Resolve-Path .venv\Scripts\python.exe).Path
pnpm test
```

仓库还保留了单独的 Kvrocks 集成脚本。它需要显式开启和专用测试配置，不在默认测试范围内；只有确认目标是隔离的测试库后才运行。

### 改动范围

修复行为时，补充能复现问题的回归测试。文案和排版调整通常不需要新增测试。涉及旧账号、存储结构或权限的改动，要说明兼容方式，避免把普通读取变成批量迁移。

增加环境变量或后台开关时，同步更新[配置说明](docs/deployment/CONFIGURATION.md)；影响启动的变量也要更新 `.env.example`。不要提交真实的账号密码、Cookie、订阅令牌、数据备份或带个人信息的日志。

## 提交 PR

一个 PR 尽量解决一件事。描述中写清楚原来的问题、现在的行为和验证方法；界面改动附截图，修复问题附复现步骤或关联 Issue。暂未验证的部分直接写明。

仓库使用 Conventional Commits，例如：

```text
fix: 修复切换视频源后进度丢失
docs: 补充 Redis 部署步骤
chore: 清理过期构建配置
```

安装依赖后会启用 Git hooks，检查暂存文件和提交信息。`pnpm-lock.yaml` 与依赖清单一起提交；不相关的依赖升级放到单独的 PR。

发布时再统一更新 `CHANGELOG` 和版本号。`src/lib/changelog.ts` 由 `scripts/convert-changelog.js` 生成，不要单独修改生成结果。应用版本中的 `+` 会在 Docker 标签中转成 `-`，例如 `6.6.6+1` 对应 `6.6.6-1`；只有发布流程成功后，相应镜像才可用。

## 报告问题

先搜索 [Issues](https://github.com/bytedo/miaotv/issues) 是否已有相同问题。新报告请提供版本号、部署方式、浏览器或客户端版本、复现步骤、预期结果，以及脱敏后的报错。第三方源失败时，说明是搜索、详情、封面还是播放出错。

安全漏洞请按 [SECURITY.md](SECURITY.md) 的方式报告，不要在公开 Issue 中贴可利用细节或凭据。

提交的改动沿用仓库的 [CC BY-NC-SA 4.0](LICENSE)。引用其他项目的代码、图片、字体或模型时，保留来源和相应许可，参见 [NOTICE.md](NOTICE.md)。
