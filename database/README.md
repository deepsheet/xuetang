# MySQL 数据库说明

## 当前实例

| 项目 | 值 |
| --- | --- |
| MySQL 版本 | 8.4.9 Community Server |
| Windows 服务 | `MySQL84` |
| 监听地址 | `127.0.0.1:3306` |
| 数据库 | `xueting` |
| 字符集 / 排序 | `utf8mb4` / `utf8mb4_0900_ai_ci` |
| 服务端时区 | `+00:00`，所有时间按 UTC 存储 |

服务已设置为自动启动，仅监听本机回环地址。MySQL X Protocol 已关闭，未开放 33060 端口。

## 账号

| 账号 | 权限 |
| --- | --- |
| `root@localhost` | 仅用于本机维护、建表和备份 |
| `attendance_admin@localhost` | `xueting` 内的全部权限，供 SQLPro 管理表结构 |
| `attendance_admin@127.0.0.1` | 同上，供 SQLPro 通过 TCP 连接 |
| `attendance_app@localhost` | `xueting` 的 SELECT / INSERT / UPDATE / DELETE |
| `attendance_app@127.0.0.1` | 同上，供 Node 通过 TCP 连接 |

应用账号没有建库、建表、删表权限。数据库结构管理使用 `attendance_admin` 或 root。

SQLPro 连接信息：

```text
主机：127.0.0.1
端口：3306
数据库：xueting
用户：attendance_admin
密码：C:\ProgramData\ApprenticeAttendance\secrets\mysql-admin.txt
```

如果 SQLPro 仍然报 `using password: YES`，先删除旧连接和已保存的密码，再新建连接。

## 密码与配置位置

密码文件位于网站目录之外，避免被静态服务器访问：

```text
C:\ProgramData\ApprenticeAttendance\secrets\mysql-root.txt
C:\ProgramData\ApprenticeAttendance\secrets\mysql-admin.txt
C:\ProgramData\ApprenticeAttendance\config\database.env
```

`database.env` 的格式：

```dotenv
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=xueting
DB_USER=attendance_app
DB_PASSWORD=...
DB_CHARSET=utf8mb4
```

网站后端通过 `server/config.js` 读取配置，按顺序查找：

```text
APP_DB_ENV 环境变量指定的文件
项目目录 config/database.env
C:\ProgramData\ApprenticeAttendance\config\database.env
```

转发包使用项目内的 `config/database.env`，由 `setup-database.bat` 自动生成。不要提交或转发该文件。

## 表结构

| 表 | 说明 |
| --- | --- |
| `xt_accounts` | 账号、学号/工号、姓名、角色、密码哈希、锁定状态 |
| `xt_number_sequences` | 按年份分配学号和工号序号 |
| `xt_attendance_records` | 签到/签退、位置、时长、状态、补签来源 |
| `xt_tasks` | 管理员发布给学徒的任务、截止时间、开始/完成/取消状态 |
| `xt_sessions` | 服务端登录会话，只存 token 哈希 |
| `xt_login_attempts` | 登录尝试记录，供限流/审计使用 |
| `xt_audit_logs` | 管理操作审计 |
| `xt_app_settings` | 学校名称、时区、定位半径、会话有效期 |
| `xt_schema_migrations` | 数据库版本记录 |

关键约束：

- `xt_accounts.number` 唯一；学号/工号使用 ASCII 二进制排序，区分大小写。
- 管理员必须是工号（`staff`），学徒必须是学号（`student`）。
- `xt_attendance_records.active_account_id` 是生成列并带唯一索引，保证同一账号最多只有一条未签退记录。
- `duration_seconds` 是生成列，根据签到/签退时间自动计算。
- 删除账号被签到记录引用时会受到外键限制，避免历史考勤丢失。
- 所有密码只保存 `scrypt` 哈希，不保存明文。

## 初始化与迁移

结构文件：

```text
database/001_init.sql   账号、考勤、会话、审计、设置
database/002_tasks.sql  任务系统
```

后续变更建议新增 `003_...sql`，不要直接修改已经执行过的迁移文件。

已经执行过的版本记录在 `xt_schema_migrations` 中。

## 备份

建议定期使用 `mysqldump` 逻辑备份。root 密码从受保护文件读取，不写在命令行历史中：

```powershell
$env:MYSQL_PWD = ((Get-Content 'C:\ProgramData\ApprenticeAttendance\secrets\mysql-root.txt' | Where-Object { $_ -like 'password=*' }) -split '=',2)[1]
& 'C:\Program Files\MySQL\MySQL Server 8.4\bin\mysqldump.exe' --protocol=TCP -h 127.0.0.1 -P 3306 -u root --single-transaction --routines --triggers xueting > 'C:\ProgramData\ApprenticeAttendance\backups\attendance_yyyyMMdd.sql'
Remove-Item Env:MYSQL_PWD
```

## 当前状态

数据库已接入 Node 后端：

- 学徒端通过登录 Session 读写自己的考勤和任务；
- 管理员后台通过 `/api/admin/*` 管理账号、考勤、时长、任务和审计；
- 首次管理员由初始化接口创建，系统自动分配工号；
- 所有业务时间使用 UTC 存储，前端按本地时间显示；
- 初始管理员账号：`T2026-0001`，密码在部署交付信息中提供，登录后可在后台修改。
