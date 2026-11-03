---
name: zq-cfgit
description: 操作 ZQ-CfGit 个人 Git 备份服务。ZQ-CfGit 是部署在 Cloudflare Workers 上的单用户私有 Git 仓库（R2 存对象、D1 存元数据），本技能提供它的认证方式和完整操作手册，用于建仓/重命名/归档/删除仓库、从 GitHub 同步最新代码快照、管理访问令牌、Git clone/push，以及调用 REST API。当用户要求备份代码、同步 GitHub 仓库、或操作 ZQ-CfGit 仓库时使用本技能。
agent_created: true
---

# ZQ-CfGit 操作手册

## 用途

对用户的 ZQ-CfGit 实例执行仓库管理、代码同步和 Git 操作，无需下载其源代码。ZQ-CfGit 是单用户私有 Git 服务，部署在 Cloudflare Workers 上，R2 存 Git 对象与 LFS 文件，D1 存账号与元数据。

## 连接信息

操作前先向用户确认三样信息，不要写死或猜测：

- 站点地址（形如 `https://git.example.com`，结尾不带斜杠）
- 用户名
- 访问令牌（write 权限，形如 `os_...`）

下面所有示例里的 `<站点>`、`<用户名>`、`<令牌>` 都用这三样替换。

## 认证方式

- REST API：请求头 `Authorization: Bearer <令牌>`
- Git 操作：Basic 认证，用户名是账号名，密码填访问令牌；也可写 `https://<用户名>:<令牌>@<站点>/...`
- 写操作（POST / PUT / PATCH / DELETE）必须带 `Origin: <站点>` 头，否则返回 403（跨域校验）

## 常用操作

### 列出仓库

```sh
curl -s -H "Authorization: Bearer <令牌>" "<站点>/api/repos"
```

返回 JSON，仓库在 `repositories` 数组里，每项含 `namespace`、`name`、`description`、`default_branch`、`lifecycle_revision`、`archived_at`、`base_repo` 等字段。支持 `?q=` 搜索、`?namespace=` 过滤、`?limit=` 与 `?page=` 分页。

### 创建仓库

```sh
curl -s -X POST "<站点>/api/repos" \
  -H "Authorization: Bearer <令牌>" -H "Content-Type: application/json" \
  -H "Origin: <站点>" \
  -d '{"name":"MyRepo","description":"描述","default_branch":"main"}'
```

仓库名支持大小写字母、数字、`-`、`_`，以及最多 5 层的分组路径（如 `team/project`）。`description` 和 `default_branch` 可省略。

### 从 GitHub 同步（备份核心操作）

```sh
curl -s -X POST "<站点>/api/repos/<用户名>/MyRepo/sync" \
  -H "Authorization: Bearer <令牌>" -H "Content-Type: application/json" \
  -H "Origin: <站点>" \
  -d '{"source":"owner/name"}'
```

- `source` 填 `owner/name`，也可带 `https://github.com/` 前缀或 `.git` 后缀，服务会解析。
- 只同步默认分支的最新快照，覆盖本仓库内容，不保留 commit 历史、issue、PR。
- 单文件 ≤ 12 MiB（超出跳过并在 `skipped` 里列出）、解压后总量 ≤ 64 MiB、≤ 3000 个文件；GitHub 仓库须公开。
- 默认分支走 api.github.com 查询，下载走 codeload.github.com；`main` 不存在时回退 `master`。

### 重命名

```sh
curl -s -X POST "<站点>/api/repos/<用户名>/MyRepo/transfer" \
  -H "Authorization: Bearer <令牌>" -H "Content-Type: application/json" \
  -H "Origin: <站点>" \
  -d '{"name":"NewName","revision":<当前 lifecycle_revision>}'
```

### 归档 / 取消归档

```sh
curl -s -X PUT "<站点>/api/repos/<用户名>/MyRepo/lifecycle" \
  -H "Authorization: Bearer <令牌>" -H "Content-Type: application/json" \
  -H "Origin: <站点>" \
  -d '{"archived":true,"revision":<当前 lifecycle_revision>}'
```

归档后仓库只读，写入被拒绝；`archived:false` 取消归档。

### 删除仓库

```sh
curl -s -X DELETE "<站点>/api/repos/<用户名>/MyRepo" \
  -H "Authorization: Bearer <令牌>" -H "Origin: <站点>"
```

### Git clone / push

```sh
git clone "https://<用户名>:<令牌>@<站点>/<用户名>/MyRepo.git"
git push "https://<用户名>:<令牌>@<站点>/<用户名>/MyRepo.git" main:main
```

大仓库用「只推最新快照」：`git clone --depth 1` 后删 `.git`、重新 `git init`，再单次提交 push。

### 访问令牌

- 列表：`GET /api/tokens`（Bearer 认证）
- 创建：`POST /api/tokens`，body `{"name":"...","scope":"write","days":90}`，返回 `{id,token}`，token 只显示一次
- 删除：`DELETE /api/tokens/:id`

创建令牌须在浏览器会话下进行（不能用 PAT 调这个接口）。`scope` 取 `read` 或 `write`。

## 关键规则与坑

- 重命名、归档都要传 `revision`（仓库当前的 `lifecycle_revision`，先 GET 详情拿），不一致返回 409。
- 只读令牌（scope=read）不能写；写操作用 write 令牌。
- 写操作缺 `Origin` 头或 Origin 与站点不一致会 403。
- 同步是覆盖式的，会清掉本仓库原有内容；同步前确认目标仓库就是要被覆盖的那个。
- GitHub 同步只保留最新快照，不保留历史，适合做代码备份。
- 大仓库受内存限制（单 pack 64 MiB、单文件 24 MiB），超限只能推最新快照。

## 完整接口

见 `references/api.md`，含全部端点、请求体与返回说明。
