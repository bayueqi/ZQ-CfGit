# ZQ-CfGit

在 Cloudflare Workers 上运行的 Git 服务，代码和数据存放在自己的 Cloudflare 账号里：R2 存 Git 对象，D1 存账号与索引，每个仓库一个 Durable Object 协调写入，Queues 处理后台任务。不需要服务器、Docker 或外部 Git 服务。

## 功能

- 仓库托管：HTTPS clone / push / fetch，分支、标签、Fork、Git LFS、上游同步
- 代码浏览：提交历史、Diff、Blame、语法高亮、Markdown / 图片 / Notebook 预览、全库搜索
- 语义搜索：文字与向量混合检索，按行返回结果
- 协作：Issue、看板、里程碑、合并请求、行级评论、CODEOWNERS、受保护分支
- CI：推送或定时触发，变量与密钥、缓存与产物，云端构建 TS/TSX、JS/CSS
- 其他：包仓库、Wiki、通知、Webhook、REST API、访问令牌、双重验证

单用户部署，没有团队与多账号管理。

## 一键部署

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/bayueqi/ZQ-CfGit/tree/deploy)

按钮读取仓库的 `deploy` 分支，在你的账号下创建 D1、两个 R2 桶、Queue 与向量索引，然后依次应用数据库迁移、发布编译服务、应用网关和主服务。

表单里填写：

| 字段 | 说明 |
|---|---|
| Worker 名称 | 2–50 个小写字母、数字或连字符，字母开头、字母或数字结尾。同时会占用 `<名称>-build` 和 `<名称>-apps` 两个名字 |
| BOOTSTRAP_SECRET | 网页首次初始化的密钥，`openssl rand -hex 32` 生成 |
| CREDENTIAL_ENCRYPTION_KEY | 凭据加密密钥，`openssl rand -base64 32` 生成，升级时必须保持不变 |

部署完成后访问 `<名称>.<你的子域>.workers.dev`，用 BOOTSTRAP_SECRET 创建管理员。

## 手动部署

需要 Node.js 22.13+ 和 Cloudflare 账号，账号需开通 Workers、D1、R2、Queues、Vectorize、Workers AI。

```sh
npm ci
npx wrangler login
npx wrangler d1 create zq-cfgit
npx wrangler r2 bucket create zq-cfgit-objects
npx wrangler r2 bucket create zq-cfgit-npm-cache
npx wrangler queues create zq-cfgit-events
npx wrangler vectorize create zq-cfgit-code --dimensions=1024 --metric=cosine
npx wrangler vectorize create-metadata-index zq-cfgit-code --property-name=repo --type=string
```

把 `d1 create` 返回的 UUID 填进 `wrangler.jsonc` 和 `wrangler.apps.jsonc` 的 `database_id`。两个配置的 `DB` 与 `OBJECTS` 必须指向同一套数据库和对象桶；`wrangler.build.jsonc` 的 `NPM_CACHE` 指向独立的缓存桶。逻辑绑定名 `DB`、`OBJECTS`、`REPOSITORIES`、`EVENTS`、`BUILDER`、`CODE_VECTORS` 不要改。

```sh
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy --config wrangler.build.jsonc
npx wrangler deploy --config wrangler.apps.jsonc
npx wrangler deploy --var APP_ORIGIN:https://<实例地址> --var APPS_ORIGIN:https://<名称>-apps.<子域>.workers.dev
npx wrangler secret put BOOTSTRAP_SECRET
npx wrangler secret put CREDENTIAL_ENCRYPTION_KEY
```

顺序不能颠倒：先编译服务和应用网关，最后主服务。主配置里的 `BUILDER` 服务名要与 `wrangler.build.jsonc` 的 Worker 名一致。编译服务只绑定 npm 缓存桶，不接触 Git 数据；应用网关负责托管已发布的应用，域名要与 Git 登录域名分开。

访问 `/api/health` 返回 `{"name":"ZQ-CfGit","version":"1.0.0","status":"ok"}` 说明服务正常。

## 域名

默认使用 workers.dev 地址。要绑定自己的域名，在 Cloudflare 控制台给主 Worker 添加 Custom Domain 或 Route，然后把 `APP_ORIGIN` 改成该地址重新部署。`APP_ORIGIN` 必须与浏览器地址完全一致，否则写操作和 LFS 上传会被跨域校验拒绝。旧域名可以设到 `LEGACY_APP_ORIGIN`，只对页面请求做 308 跳转，Git 与 API 不跳转。

## 配置项

| 变量 | 用途 |
|---|---|
| `APP_ORIGIN` | 站点规范地址，校验写操作来源、生成 LFS 地址 |
| `APPS_ORIGIN` | 应用网关地址，已发布应用的访问域名 |
| `LEGACY_APP_ORIGIN` | 旧地址，页面请求跳转到 `APP_ORIGIN` |
| `BOOTSTRAP_SECRET` | 首次初始化管理员用，初始化完成后可以删除 |
| `CREDENTIAL_ENCRYPTION_KEY` | 加密上游凭据，32 字节 base64，升级时保持不变 |
| `SYNC_ALLOWED_HOSTS` | 允许同步的自托管 Git 主机名，逗号分隔，仅公网 HTTPS |
| `WEBHOOK_ALLOWED_HOSTS` | 允许投递的 Webhook 接收端主机名，逗号分隔，默认为空 |

## 初始化

打开站点，填初始化密钥、用户名、密码（至少 12 位）。用户名字段按 `^[a-z0-9][a-z0-9_-]{0,47}$` 校验。创建成功后 D1 会锁定初始化，之后可以在 Worker 设置里删除 `BOOTSTRAP_SECRET`。

## 免费计划

Workers Free 计划下有三处配置会导致部署被拒，需要先删除：

| 位置 | 删除项 | 报错码 |
|---|---|---|
| `wrangler.jsonc` | `limits.subrequests` | 100328 |
| `wrangler.build.jsonc` | `limits.cpu_ms` | 100328 |
| `wrangler.jsonc`、`wrangler.apps.jsonc` | `worker_loaders` | 10195 |

代价是云端 CI 构建（CPU 上限 10ms）和应用托管（依赖 Dynamic Workers）不可用，仓库、浏览、Issue、合并请求、语义搜索正常。D1 免费额度为每天 10 万行写入，账户级共享，UTC 午夜重置。

## 容量限制

单次传输的 pack 上限 64 MiB，单个文件 24 MiB，单个 pack 最多 2 万个对象。超限的仓库无法导入也无法推送，这是纯 JavaScript 在 128 MB 内存里解析 pack 决定的，调高常量只会触发内存超限。大仓库建议只推送最新快照，或先清理历史中的大文件。

## 备份

需要同时备份三处：D1、R2 中的 `repos/` 与 `lfs/` 前缀、每个仓库 Durable Object 的 `refs.v2`。只备份 R2 无法恢复引用和账号。没有跨服务的一致性备份工具，也不要在 Git 对象上配置到期策略。
