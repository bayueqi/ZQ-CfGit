# ZQ-CfGit

在 Cloudflare Workers 上运行的 Git 服务，代码和数据存放在自己的 Cloudflare 账号里：R2 存 Git 对象，D1 存账号与索引，每个仓库一个 Durable Object 协调写入，Queues 处理后台任务。不需要服务器、Docker 或外部 Git 服务。

## 功能

- 仓库托管：HTTPS clone / push / fetch，分支、标签、Fork、Git LFS、上游同步
- 代码浏览：提交历史、Diff、Blame、语法高亮、Markdown / 图片 / Notebook 预览、全库搜索
- 语义搜索：文字与向量混合检索，按行返回结果
- 协作：Issue、看板、里程碑、合并请求、行级评论、CODEOWNERS、受保护分支
- CI：推送或定时触发，变量与密钥、缓存与产物，云端构建 TS/TSX、JS/CSS
- 其他：包仓库、Wiki、Webhook、REST API、访问令牌、双重验证

单用户部署，没有团队与多账号管理。

## 部署

需要 Node.js 22.13+ 和 Cloudflare 账号，账号需开通 Workers、D1、R2、Queues、Vectorize、Workers AI。

### 1. 创建资源

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

### 2. 填写资源 ID

`wrangler.jsonc` 与 `wrangler.apps.jsonc` 里的 `database_id` 换成 `d1 create` 返回的 UUID，两处必须相同。仓库里的值是部署者本人实例的 ID，克隆后需要全部替换。R2 桶名、Queue 名、向量索引名同样改成自己的。

三个配置文件的绑定关系：

| 文件 | Worker | 说明 |
|---|---|---|
| `wrangler.jsonc` | 主服务 | Git 协议、页面、API，绑定 DB、OBJECTS、REPOSITORIES、EVENTS、BUILDER、CODE_VECTORS、AI |
| `wrangler.build.jsonc` | 编译服务 | 只绑定 npm 缓存桶 `NPM_CACHE`，不接触 Git 数据 |
| `wrangler.apps.jsonc` | 应用网关 | 托管已发布的应用程序，绑定 DB 与 OBJECTS |

逻辑绑定名 `DB`、`OBJECTS`、`REPOSITORIES`、`EVENTS`、`BUILDER`、`CODE_VECTORS`、`NPM_CACHE` 不要改，代码按这些名字取值。

### 3. 发布

```sh
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy --config wrangler.build.jsonc
npx wrangler deploy --config wrangler.apps.jsonc
npx wrangler deploy
```

顺序不能颠倒：先应用迁移，再发布编译服务和应用网关，最后主服务。主配置里的 `BUILDER` 服务名要与 `wrangler.build.jsonc` 的 Worker 名一致。

### 4. 设置变量与密钥

```sh
npx wrangler secret put APP_ORIGIN                  # https://<主服务地址>
npx wrangler secret put APPS_ORIGIN                 # https://<应用网关地址>
npx wrangler secret put BOOTSTRAP_SECRET            # openssl rand -hex 32
npx wrangler secret put CREDENTIAL_ENCRYPTION_KEY   # openssl rand -base64 32
```

这四个值必须用 `secret put` 写入，不要用 `--var`：`wrangler deploy` 每次按配置文件覆盖运行时变量，配置里没有的变量会被删除，密钥不受影响。

访问 `/api/health` 返回 `{"name":"ZQ-CfGit","version":"1.0.0","status":"ok"}` 说明服务正常。

## 运行时变量与密钥

| 名称 | 作用 | 缺失或错误时 |
|---|---|---|
| `APP_ORIGIN` | 站点对外地址，含协议、不带结尾斜杠，例如 `https://git.example.com`。用于登录与写操作的来源校验、生成绝对链接和 Webhook 地址、签发 Cookie | 页面请求 500；与浏览器地址不一致时写操作和 LFS 上传返回 403 |
| `APPS_ORIGIN` | 应用网关地址，用于拼接已发布应用的访问链接 | 应用发布链接不可用 |
| `LEGACY_APP_ORIGIN` | 旧域名。只对页面请求做 308 跳转到 `APP_ORIGIN`，Git 与 API 不跳转 | 可选，不设置则无跳转 |
| `BOOTSTRAP_SECRET` | 首次初始化的口令，只在 `POST /api/setup` 校验一次 | 无法初始化；初始化完成后可以删除 |
| `CREDENTIAL_ENCRYPTION_KEY` | AES-GCM 密钥，base64 编码的 32 字节随机值，加密保存 GitHub App 私钥、Webhook 密钥、上游同步凭据、CI 变量值 | 缺失或长度不为 32 字节时相关功能返回 503；更换后已保存的凭据无法解密 |
| `WEBHOOK_ALLOWED_HOSTS` | 允许投递的 Webhook 接收端主机名，逗号分隔，仅 https、无端口、非 localhost 与内网域名 | 留空表示禁止创建 Webhook |
| `SYNC_ALLOWED_HOSTS` | 额外的上游同步主机名白名单，逗号分隔。github.com、gitlab.com、codeberg.org、git.sr.ht 等公共主机已内置，无需填写 | 留空只能同步公共主机 |
| `CI_ALLOWED_HOSTS` | CI 步骤中允许访问的外部主机名白名单，逗号分隔 | 留空表示 CI 不能请求外部地址 |

## 绑定

| 绑定 | 类型 | 指向 | 作用 |
|---|---|---|---|
| `DB` | D1 数据库 | `zq-cfgit` | 账号、仓库索引、Issue、合并请求、CI、包等元数据 |
| `OBJECTS` | R2 桶 | `zq-cfgit-objects` | Git 对象、LFS 文件、附件、构建产物 |
| `REPOSITORIES` | Durable Object | 类 `Repository`，每个仓库一个实例 | 串行化引用更新、暂存待发布的对象、保存每个仓库的引用表 |
| `EVENTS` | Queue | `zq-cfgit-events` | Webhook 投递、索引等后台任务；生产与消费是同一个队列，每 5 分钟由 Cron 兜底重试 |
| `BUILDER` | Service 绑定 | `zq-cfgit-build` | 云端 CI 构建：esbuild 编译、npm 依赖安装与缓存 |
| `NPM_CACHE` | R2 桶 | `zq-cfgit-npm-cache` | 编译服务专用，缓存 npm 包与构建中间产物 |
| `CODE_VECTORS` | Vectorize 索引 | `zq-cfgit-code` | 语义搜索的向量索引，1024 维、cosine，`repo` 字段作为元数据索引 |
| `AI` | Workers AI | — | `@cf/baai/bge-m3` 生成代码分块与查询的向量 |
| `ASSETS` | Static Assets | `./public` | 前端页面与静态文件。`run_worker_first: true` 使 Worker 先处理路由，未命中的路径回落到 `index.html` |
| `LOADER` | Dynamic Workers | — | 在 Worker 内部加载并运行用户发布的应用、执行云端 CI 沙箱。免费计划没有此绑定 |

缺少 `BUILDER` 时 CI 构建失败；缺少 `CODE_VECTORS` 或 `AI` 时语义搜索不可用；缺少 `LOADER` 时应用运行与云端执行模板不可用，其余功能正常。

## 域名

默认使用 workers.dev 地址。绑定自己的域名有两种方式：在控制台给主 Worker 添加 Custom Domain，或添加 Route 指向通配子域。之后把 `APP_ORIGIN` 改成该地址，重新用 `secret put` 写入。

`APP_ORIGIN` 必须与浏览器地址完全一致，协议、端口、子域都算，否则写操作被跨域校验拒绝。旧域名可以设到 `LEGACY_APP_ORIGIN`。

应用网关建议使用独立子域，与主服务分开。

## 初始化

打开站点，填初始化密钥、用户名、密码（至少 12 位）。用户名字段按 `^[a-z0-9][a-z0-9_-]{0,47}$` 校验，`admin`、`api` 等保留名不可用。创建成功后 D1 会锁定初始化，之后可以在 Worker 设置里删除 `BOOTSTRAP_SECRET`。

## 免费计划

Workers Free 计划下有三处配置会导致部署被拒，需要先删除：

| 位置 | 删除项 | 报错码 |
|---|---|---|
| `wrangler.jsonc` | `limits.subrequests` | 100328 |
| `wrangler.build.jsonc` | `limits.cpu_ms` | 100328 |
| `wrangler.jsonc`、`wrangler.apps.jsonc` | `worker_loaders` | 10195 |

代价是云端 CI 构建（CPU 上限 10ms）和应用托管（依赖 Dynamic Workers）不可用，仓库、浏览、Issue、合并请求、语义搜索正常。D1 免费额度为每天 10 万行写入、500 万行读取，账户级共享，UTC 午夜重置。配额耗尽时迁移与写入会失败，接口返回 500，等待重置后重试即可。

## 容量限制

单次传输的 pack 上限 64 MiB，单个文件 24 MiB，单个 pack 最多 2 万个对象。超限的仓库无法导入也无法推送，这是纯 JavaScript 在 128 MB 内存里解析 pack 决定的，调高常量只会触发内存超限。大仓库建议只推送最新快照，或先清理历史中的大文件。

## 备份

需要同时备份三处：D1、R2 中的 `repos/` 与 `lfs/` 前缀、每个仓库 Durable Object 的 `refs.v2`。只备份 R2 无法恢复引用和账号。没有跨服务的一致性备份工具，也不要在 Git 对象上配置到期策略。
