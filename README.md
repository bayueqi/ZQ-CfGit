# ZQ-CfGit

在 Cloudflare Workers 上运行的个人 Git 服务，代码和数据存放在自己的 Cloudflare 账号里：R2 存 Git 对象，D1 存账号与元数据，每个仓库一个 Durable Object 协调写入。不需要服务器、Docker 或外部 Git 服务。

## 功能

- 仓库托管：HTTPS clone / push / fetch，分支、标签、Git LFS
- 代码浏览：提交历史、Diff、语法高亮，Markdown / 图片 / Notebook 预览
- 搜索：仓库内代码内容检索
- 在线编辑：直接在网页新建、修改文件并提交
- 备份同步：从 GitHub 拉取最新代码快照，覆盖式同步到本服务
- 接口：REST API、个人访问令牌

单用户部署，没有团队与多账号管理。

## 使用

### 从 GitHub 同步仓库

1. 新建项目，进入该项目的「设置」页。
2. 在「从 GitHub 同步」输入框填入 `owner/name`，例如 `bayueqi/ZQ-CfGit`。
3. 点「同步最新代码」。会下载 GitHub 默认分支的最新快照并覆盖本仓库内容。

同步只保留最新代码快照，不保留 commit 历史与 issue 等数据，适合做代码备份。

### 用 Git 克隆与推送

仓库页点「克隆地址」复制 HTTPS 地址。推送和克隆需要认证：

```
git clone https://<站点地址>/<用户名>/<仓库名>.git
git push origin main
```

HTTPS 凭证用「用户名 + 访问令牌」：用户名为你的账号名，密码填访问令牌。

### 访问令牌

顶栏「访问令牌」页创建，可选只读（read）或可写（write）权限。令牌用于 Git 认证和 API 调用，API 请求头格式为 `Authorization: Bearer <令牌>`。

## 部署

需要 Node.js 22.13+ 和 Cloudflare 账号，账号需开通 Workers、D1、R2。

### 1. 创建资源

```sh
npm ci
npx wrangler login
npx wrangler d1 create zq-cfgit
npx wrangler r2 bucket create zq-cfgit-objects
```

### 2. 填写资源 ID

把 `d1 create` 返回的 UUID 填进 `wrangler.jsonc` 的 `database_id`。仓库里的值是部署者本人实例的 ID，克隆后需要替换。R2 桶名同样改成自己的。

逻辑绑定名 `DB`、`OBJECTS`、`REPOSITORIES` 不要改，代码按这些名字取值。

### 3. 发布

```sh
npx wrangler d1 migrations apply DB --remote
npx wrangler deploy
```

### 4. 设置变量与密钥

```sh
npx wrangler secret put APP_ORIGIN        # https://<站点地址>，结尾不带斜杠
npx wrangler secret put BOOTSTRAP_SECRET  # openssl rand -hex 32
```

这两个值用 `secret put` 写入，不要用 `--var`：`wrangler deploy` 每次按配置文件覆盖运行时变量，配置里没有的变量会被删除，密钥不受影响。

访问 `/api/health` 返回 `{"name":"ZQ-CfGit","version":"1.0.0","status":"ok"}` 说明服务正常。

## 运行时变量与密钥

| 名称 | 作用 | 缺失或错误时 |
|---|---|---|
| `APP_ORIGIN` | 站点对外地址，含协议、不带结尾斜杠，例如 `https://git.example.com`。用于登录与写操作的来源校验、生成绝对链接和签发 Cookie | 页面请求 500；与浏览器地址不一致时写操作和 LFS 上传返回 403 |
| `LEGACY_APP_ORIGIN` | 旧域名。只对页面请求做 308 跳转到 `APP_ORIGIN`，Git 与 API 不跳转 | 可选，不设置则无跳转 |
| `BOOTSTRAP_SECRET` | 首次初始化的口令，只在 `POST /api/setup` 校验一次 | 无法初始化；初始化完成后可以删除 |

## 绑定

| 绑定 | 类型 | 指向 | 作用 |
|---|---|---|---|
| `DB` | D1 数据库 | `zq-cfgit` | 账号与仓库元数据 |
| `OBJECTS` | R2 桶 | `zq-cfgit-objects` | Git 对象、LFS 文件 |
| `REPOSITORIES` | Durable Object | 类 `Repository`，每个仓库一个实例 | 串行化引用更新、暂存待发布的对象、保存每个仓库的引用表 |
| `ASSETS` | Static Assets | `./public` | 前端页面与静态文件。`run_worker_first: true` 使 Worker 先处理路由，未命中的路径回落到 `index.html` |

## 域名

默认使用 workers.dev 地址。绑定自己的域名有两种方式：在控制台给 Worker 添加 Custom Domain，或添加 Route 指向通配子域。之后把 `APP_ORIGIN` 改成该地址，重新用 `secret put` 写入。

`APP_ORIGIN` 必须与浏览器地址完全一致，协议、端口、子域都算，否则写操作被跨域校验拒绝。旧域名可以设到 `LEGACY_APP_ORIGIN`。

## 初始化

打开站点，填初始化密钥、用户名、密码（至少 12 位）。用户名字段按 `^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$` 校验，`admin`、`api` 等保留名不可用。创建成功后 D1 会锁定初始化，之后可以在 Worker 设置里删除 `BOOTSTRAP_SECRET`。

## 容量限制

单次传输的 pack 上限 64 MiB，单个文件 24 MiB，单个 pack 最多 2 万个对象。超限的仓库无法导入也无法推送，这是纯 JavaScript 在 128 MB 内存里解析 pack 决定的，调高常量只会触发内存超限。大仓库建议只推送最新快照，或先清理历史中的大文件。

D1 免费额度为每天 10 万行写入、500 万行读取，账户级共享，UTC 午夜重置。配额耗尽时写入会失败，接口返回 500，等待重置后重试即可。

## 备份

需要同时备份三处：D1、R2 中的 `repos/` 与 `lfs/` 前缀、每个仓库 Durable Object 的 `refs.v2`。只备份 R2 无法恢复引用和账号。没有跨服务的一致性备份工具，也不要在 Git 对象上配置到期策略。
