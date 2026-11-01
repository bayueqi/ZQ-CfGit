# ZQ-CfGit

运行在 Cloudflare Workers 上的 Git 服务。仓库、代码浏览、合并请求、Issue、Wiki 和 CI 都在自己的 Cloudflare 账号内运行，数据存放在 D1、R2 与 Durable Objects 中。

## 功能

- 仓库托管：HTTPS clone / push / fetch，支持分支、标签、Fork、Git LFS
- 代码浏览：文件历史、Diff、Blame、语法高亮，支持 Markdown、图片与 Jupyter Notebook 预览
- 协作：Issue、看板、里程碑、合并请求、行级评论、CODEOWNERS、受保护分支
- CI：推送或定时触发，日志、变量密钥、缓存、构建产物
- 其他：包仓库、Wiki、通知、审计日志、Webhook、REST API、MCP
- 账户：访问令牌、双重验证、密码恢复

## 部署

需要 Cloudflare 账号。CI 构建与动态应用托管需 Workers 付费计划，其余功能在免费计划下可用。

### 1. 创建资源

```sh
wrangler d1 create zq-cfgit
wrangler r2 bucket create zq-cfgit-objects
wrangler r2 bucket create zq-cfgit-npm-cache
wrangler queues create zq-cfgit-events
wrangler vectorize create zq-cfgit-code --dimensions=1024 --metric=cosine
wrangler vectorize create-metadata-index zq-cfgit-code --property-name=repo --type=string
```

把生成的 `database_id` 填入 `wrangler.jsonc` 与 `wrangler.apps.jsonc`。

### 2. 执行数据库迁移

```sh
npx wrangler d1 migrations apply DB --remote
```

### 3. 写入密钥

```sh
wrangler secret put BOOTSTRAP_SECRET
wrangler secret put CREDENTIAL_ENCRYPTION_KEY
```

`BOOTSTRAP_SECRET` 用于首次创建管理员，取任意随机字符串。`CREDENTIAL_ENCRYPTION_KEY` 用于加密外部凭据，取 32 字节随机值的 Base64。

### 4. 部署

```sh
npm run deploy:build
npm run deploy:apps
npm run deploy
```

首次打开站点会进入初始化页，填入初始化密钥、用户名和密码后即可使用。

## 变量

| 名称 | 说明 |
|---|---|
| `APP_ORIGIN` | 主站地址，例如 `https://git.example.com` |
| `APPS_ORIGIN` | 应用网关地址 |
| `LEGACY_APP_ORIGIN` | 旧地址，仅用于页面跳转，可省略 |
| `SYNC_ALLOWED_HOSTS` | 允许同步的上游 Git 主机 |

## 本地运行

```sh
npm ci
npm run db:local
npm run dev
```

打开 http://localhost:8787。

## 限制

单次推送的 pack 上限 64 MiB，单个 Git 对象 24 MiB，单次 2 万个对象。超出需拆分提交历史后分批推送。云端 CI 只构建 JavaScript 与 WASM，不执行任意 shell 或 Python 脚本。
