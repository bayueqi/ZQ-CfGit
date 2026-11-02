# ZQ-CfGit REST API 参考

站点、用户名、访问令牌以用户提供为准，下文用 `<站点>`、`<用户名>`、`<令牌>` 占位。所有 `/api/*` 接口用 JSON。

## 认证

三种认证方式，按优先级：

1. `Authorization: Bearer <令牌>`（PAT，API 用）
2. `Authorization: Basic base64(<用户名>:<令牌>)`（Git 用）
3. 会话 Cookie `zq-cfgit_session`（浏览器登录后自动带）

写操作（POST / PUT / PATCH / DELETE）额外要求请求头带正确的 `Origin`，与 `APP_ORIGIN` 不一致返回 403。

## 通用返回

- 错误：`{"error":"<消息>"}`，状态码 400 / 401 / 403 / 404 / 409 / 413 / 429 / 503
- 成功：各接口不同

## 账号

| 方法 | 路径 | 认证 | body | 返回 |
|---|---|---|---|---|
| GET | `/api/health` | 无 | — | `{name,version,status}` |
| GET | `/api/bootstrap` | 可选 | — | `{user,required}` |
| GET | `/api/setup` | 无 | — | `{required}` |
| POST | `/api/setup` | 无 | `{username,password,secret}` | `{id,username}` (201) |
| POST | `/api/login` | 无 | `{username,password}` | `{id,username,admin}`，设置 Cookie |
| POST | `/api/logout` | 会话 | — | `{ok:true}` |
| POST | `/api/password` | 会话 | `{current_password,new_password}` | `{ok:true}` |
| GET | `/api/me` | 任意 | — | `{user}` |

## 访问令牌

| 方法 | 路径 | 认证 | body | 返回 |
|---|---|---|---|---|
| GET | `/api/tokens` | 会话/PAT | — | `{tokens:[...]}` |
| POST | `/api/tokens` | 会话 | `{name,scope,days}` | `{id,token}` (201)，token 只显示一次 |
| DELETE | `/api/tokens/:id` | 会话/PAT | — | `{ok:true}` |

`scope`：`read` | `write`，默认 `write`。`days`：1–365，默认 90。

## 仓库

| 方法 | 路径 | 认证 | body | 返回 |
|---|---|---|---|---|
| GET | `/api/repos` | PAT | — | `{repositories:[...],page,has_more,next_cursor}` |
| POST | `/api/repos` | write | `{name,description?,default_branch?,namespace?}` | `{id,namespace,name,description,default_branch,clone_url}` (201) |
| GET | `/api/repos/:ns/:repo` | PAT | — | 仓库详情 + `role` + `clone_url` |
| PATCH | `/api/repos/:ns/:repo` | write | `{description?,default_branch?}` | `{ok:true}` |
| DELETE | `/api/repos/:ns/:repo` | write | — | 引擎响应 |
| POST | `/api/repos/:ns/:repo/transfer` | write | `{name,revision}` | 重命名结果 |
| PUT | `/api/repos/:ns/:repo/lifecycle` | write | `{archived,revision}` | 归档结果 |
| POST | `/api/repos/:ns/:repo/sync` | write | `{source}` | `{...result,source,branch,files}` |
| GET | `/api/repo-url/:id` | PAT | — | `{id,namespace,name,url,ephemeral_url}` |

`GET /api/repos` 参数：`q`（搜索名/描述）、`namespace`、`limit`（1–100，默认 50）、`page`（从 0 起）、`cursor`（翻页游标）。

仓库详情字段：`id`、`owner_id`、`namespace`、`name`、`description`、`default_branch`、`created_at`、`archived_at`、`lifecycle_revision`、`base_repo`。

## 浏览与内容

| 方法 | 路径 | 认证 | 说明 |
|---|---|---|---|
| GET | `/api/repos/:ns/:repo/browse` | PAT | 仓库概览（默认分支、README） |
| GET | `/api/repos/:ns/:repo/tree` | PAT | 文件树 |
| GET | `/api/repos/:ns/:repo/blob` | PAT | 文件内容 |
| GET | `/api/repos/:ns/:repo/file` | PAT | 文件内容，支持 HEAD 与范围请求 |
| GET | `/api/repos/:ns/:repo/commits` | PAT | 提交历史 |
| GET | `/api/repos/:ns/:repo/branches` | PAT | 分支列表 |
| GET | `/api/repos/:ns/:repo/tags` | PAT | 标签列表 |
| GET | `/api/repos/:ns/:repo/commit-detail` | PAT | 单个提交详情 |
| GET | `/api/repos/:ns/:repo/diff` | PAT | 提交 Diff |
| GET | `/api/repos/:ns/:repo/search` | PAT | 仓库内代码搜索 |
| GET | `/api/repos/:ns/:repo/preview` | PAT | 图片预览（PNG/JPEG/GIF/WebP） |
| POST | `/api/repos/:ns/:repo/commit` | write | 在线提交，body `{branch,message,files:[{path,content}],expected_sha?}` |
| POST | `/api/repos/:ns/:repo/branches/create` | write | 建分支，body `{target_branch,base_branch?,base_ref?}` |
| DELETE | `/api/repos/:ns/:repo/branches` | write | 删分支，body `{branch,expected_sha?}` |
| POST | `/api/repos/:ns/:repo/tags` | write | 建标签，body `{name,sha?或ref?}` |
| DELETE | `/api/repos/:ns/:repo/tags/:tag` | write | 删标签 |
| POST | `/api/repos/:ns/:repo/archive` | read | 下载源码归档 |

`/commit` 的 `files` 数组每项 `{path,content}`，`content` 为 `null` 表示删除该文件，最多 30 个文件，单个内容 ≤ 1 MiB。

## Git Smart HTTP

Git 客户端访问 `.git` 路径，用 Basic 认证（用户名 + 令牌）。

| 端点 | 说明 |
|---|---|
| `GET /:ns/:repo.git/info/refs?service=git-upload-pack` | 拉取（fetch/clone）发现 |
| `GET /:ns/:repo.git/info/refs?service=git-receive-pack` | 推送（push）发现 |
| `POST /:ns/:repo.git/git-upload-pack` | 拉取 pack |
| `POST /:ns/:repo.git/git-receive-pack` | 推送 pack |
| `POST /:ns/:repo.git/info/lfs/objects/batch` | LFS 批量上传/下载，body `{operation,objects:[{oid,size}]}` |
| `GET\|PUT /:ns/:repo.git/info/lfs/objects/:oid` | LFS 对象读写 |

仓库名后加 `+ephemeral`（如 `MyRepo+ephemeral.git`）访问临时命名空间。

## 字段校验规则

- 用户名 / 命名空间：`^[A-Za-z0-9][A-Za-z0-9_-]{0,47}$`，`admin`、`api` 等保留名不可用
- 仓库名：每段须满足上述规则，最多 5 段，总长 ≤ 200
- 分支名：≤ 200，不能以 `-` 或 `/` 开头、不能含 `..` 或 `@{` 等
- sha：`^[0-9a-f]{40}$`
