# ZQ-CfGit

在 Cloudflare Workers 上运行的个人 Git 服务，代码和数据存放在自己的 Cloudflare 账号里：R2 存 Git 对象与 LFS 文件，D1 存账号与元数据，每个仓库一个 Durable Object 协调写入。不需要服务器、Docker 或外部 Git 服务，只面向单用户。

## 功能

- 仓库托管：HTTPS clone / push / fetch，分支、标签、Git LFS
- 代码浏览：文件树、提交历史、Diff、语法高亮，Markdown / 图片 / Notebook 预览
- 在线编辑：在网页上新建、修改文件并提交
- 仓库内代码搜索
- 备份同步：从 GitHub 拉取默认分支的最新快照，覆盖式同步到本服务
- 接口：REST API、个人访问令牌（PAT）

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

## 使用

### 1. 初始化

第一次打开站点进入初始化页，填初始化密钥、用户名、密码（至少 12 位）。初始化密钥即 `BOOTSTRAP_SECRET`，只在这里校验一次，完成后可以删除。用户名按 `^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$` 校验，`admin`、`api` 等保留名不可用。

### 2. 登录与账号

- 登录：首页输入用户名 + 密码，得到一个 7 天有效的浏览器会话 Cookie。
- 改密码：登录后在网页里改，须在浏览器会话下进行。
- 登出：顶栏「退出」。

### 3. 创建仓库

首页点「新建项目」，填名称、描述、默认分支（默认 `main`）。仓库名支持大写字母、数字、短横线、下划线，也支持最多 5 层的分组路径，例如 `team/project`。

### 4. 浏览代码

进入仓库后顶部是导航（文件 / 提交 / 分支 / 标签 / 设置）。文件页展示文件树、README 渲染、提交历史与 Diff。

### 5. 用 Git 克隆与推送

仓库页复制「克隆地址」，形如 `https://<站点>/<用户名>/<仓库名>.git`。认证用「用户名 + 访问令牌」，用户名是账号名，密码填访问令牌：

```
git clone https://<站点>/<用户名>/<仓库名>.git
git push origin main
```

大仓库建议只推最新快照：`git clone --depth 1` 后删掉 `.git`、重新 `git init`，再单次提交 push。

### 6. 访问令牌

顶栏「访问令牌」页创建。令牌分 read（只读）与 write（读写）两种，有效期 1–365 天，只在创建时显示一次。令牌用于两类场景：

- Git 认证：用户名 + 令牌作为密码。
- REST API：请求头 `Authorization: Bearer <令牌>`。

创建令牌须在浏览器会话下进行；只读令牌不能做任何写操作（下载归档除外）。

### 7. 从 GitHub 同步

进入仓库「设置」页，在「从 GitHub 同步」输入框填 `owner/name`，例如 `octocat/Hello-World`，点「同步最新代码」。服务会查询 GitHub API 拿默认分支，下载该分支的 tar.gz 快照，覆盖本仓库内容。

限制：

- 只保留最新代码快照，不保留 commit 历史、issue、PR 等。
- 单文件上限 24 MiB，仓库解压后总量上限 30 MiB，最多 3000 个文件。
- 仓库必须是公开的。

### 8. 归档与重命名

- 归档：仓库设置里可归档 / 取消归档，归档后仓库只读，写入被拒绝。
- 重命名：仓库设置里改名，改名后旧地址保留跳转别名。

## REST API

所有 `/api/*` 接口用 JSON。认证分三种：浏览器会话 Cookie、`Authorization: Bearer <令牌>`、Git 的 Basic 认证。写操作（POST / PUT / PATCH / DELETE）还要求请求头带正确的 `Origin`，与站点地址不一致会返回 403。

### 账号

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/health` | 健康检查，返回服务名与版本 |
| GET | `/api/bootstrap` | 当前用户与是否需要初始化 |
| GET | `/api/setup` | 是否需要初始化 |
| POST | `/api/setup` | 初始化，body `{username,password,secret}` |
| POST | `/api/login` | 登录，body `{username,password}`，设置会话 Cookie |
| POST | `/api/logout` | 登出 |
| POST | `/api/password` | 改密码，body `{current_password,new_password}` |
| GET | `/api/me` | 当前登录用户 |

### 访问令牌

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/tokens` | 令牌列表 |
| POST | `/api/tokens` | 创建，body `{name,scope,days}`，返回 `{id,token}`，token 只显示一次 |
| DELETE | `/api/tokens/:id` | 删除令牌 |

### 仓库

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/repos` | 列表，参数 `q`（搜索）、`namespace`、`limit`、`page`、`cursor` |
| POST | `/api/repos` | 创建，body `{name,description,default_branch,namespace?}` |
| GET | `/api/repos/:ns/:repo` | 详情，返回 `lifecycle_revision`、`archived_at`、`base_repo` 等 |
| PATCH | `/api/repos/:ns/:repo` | 改描述或默认分支，body `{description?,default_branch?}` |
| DELETE | `/api/repos/:ns/:repo` | 删除 |
| POST | `/api/repos/:ns/:repo/transfer` | 重命名，body `{name,revision}` |
| PUT | `/api/repos/:ns/:repo/lifecycle` | 归档 / 取消归档，body `{archived,revision}` |
| POST | `/api/repos/:ns/:repo/sync` | 从 GitHub 同步，body `{source}` |
| GET | `/api/repo-url/:id` | 按仓库 id 取克隆地址 |

重命名与归档都要带 `revision`，即仓库当前的 `lifecycle_revision`（先 GET 详情拿到），用于防止并发覆盖，版本不符返回 409。

### 浏览与内容

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/repos/:ns/:repo/browse` | 仓库概览（默认分支、README 等） |
| GET | `/api/repos/:ns/:repo/tree` | 文件树 |
| GET | `/api/repos/:ns/:repo/blob` | 文件内容 |
| GET | `/api/repos/:ns/:repo/blame` | 逐行归属，参数 `ref`、`path` |
| GET | `/api/repos/:ns/:repo/file` | 文件内容（支持 HEAD 与范围请求） |
| GET | `/api/repos/:ns/:repo/commits` | 提交历史 |
| GET | `/api/repos/:ns/:repo/branches` | 分支列表 |
| GET | `/api/repos/:ns/:repo/tags` | 标签列表 |
| GET | `/api/repos/:ns/:repo/commit-detail` | 单个提交详情 |
| GET | `/api/repos/:ns/:repo/diff` | 提交 Diff |
| GET | `/api/repos/:ns/:repo/search` | 仓库内代码搜索 |
| GET | `/api/repos/:ns/:repo/preview` | 图片预览（PNG / JPEG / GIF / WebP） |
| POST | `/api/repos/:ns/:repo/commit` | 在线提交，body `{branch,message,files:[{path,content}],expected_sha?}` |
| POST | `/api/repos/:ns/:repo/branches/create` | 建分支，body `{target_branch,base_branch?}` |
| DELETE | `/api/repos/:ns/:repo/branches` | 删分支，body `{branch}` |
| POST | `/api/repos/:ns/:repo/tags` | 建标签，body `{name,sha?或ref?}` |
| DELETE | `/api/repos/:ns/:repo/tags/:tag` | 删标签 |
| POST | `/api/repos/:ns/:repo/archive` | 下载源码归档 |

### Git Smart HTTP

Git 客户端访问 `.git` 路径，用 Basic 认证（用户名 + 令牌）：

| 端点 | 说明 |
|---|---|
| `GET /:ns/:repo.git/info/refs?service=git-upload-pack` | 拉取（fetch / clone）发现 |
| `GET /:ns/:repo.git/info/refs?service=git-receive-pack` | 推送（push）发现 |
| `POST /:ns/:repo.git/git-upload-pack` | 拉取 pack |
| `POST /:ns/:repo.git/git-receive-pack` | 推送 pack |
| `POST /:ns/:repo.git/info/lfs/objects/batch` | LFS 批量上传 / 下载 |
| `GET\|PUT /:ns/:repo.git/info/lfs/objects/:oid` | LFS 对象读写 |

### 请求示例

创建仓库：

```sh
curl -X POST https://<站点>/api/repos \
  -H "Authorization: Bearer <令牌>" \
  -H "Content-Type: application/json" \
  -d '{"name":"MyRepo","description":"我的项目","default_branch":"main"}'
```

从 GitHub 同步：

```sh
curl -X POST https://<站点>/api/repos/<用户名>/MyRepo/sync \
  -H "Authorization: Bearer <令牌>" \
  -H "Content-Type: application/json" \
  -d '{"source":"octocat/Hello-World"}'
```

重命名（`revision` 从详情接口取）：

```sh
curl -X POST https://<站点>/api/repos/<用户名>/MyRepo/transfer \
  -H "Authorization: Bearer <令牌>" \
  -H "Content-Type: application/json" \
  -d '{"name":"MyRepo2","revision":0}'
```

## 配套 skill

`skills/zq-cfgit/` 是给 AI 助手用的操作手册，装上后无需阅读或修改源码即可完成建仓、同步、归档、Git 推送等操作。

使用时把该目录拷到 `~/.workbuddy/skills/zq-cfgit/`，再向助手提供站点地址、用户名、访问令牌三项信息。目录内 `SKILL.md` 是操作流程与常见坑，`references/api.md` 是完整接口清单。

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

## 容量限制

单次传输的 pack 上限 64 MiB，单个文件 24 MiB，单个 pack 最多 2 万个对象。超限的仓库无法导入也无法推送，这是纯 JavaScript 在 128 MB 内存里解析 pack 决定的，调高常量只会触发内存超限。大仓库建议只推送最新快照，或先清理历史中的大文件。

D1 免费额度为每天 10 万行写入、500 万行读取，账户级共享，UTC 午夜重置。配额耗尽时写入会失败，接口返回 500，等待重置后重试即可。

## 备份

需要同时备份三处：D1、R2 中的 `repos/` 与 `lfs/` 前缀、每个仓库 Durable Object 的 `refs.v2`。只备份 R2 无法恢复引用和账号。没有跨服务的一致性备份工具，也不要在 Git 对象上配置到期策略。
