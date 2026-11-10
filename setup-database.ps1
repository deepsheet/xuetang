param(
  [string]$MysqlExe = "",
  [string]$RootPassword = "",
  [string]$AppPassword = ""
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Database = "apprentice_attendance"
$AppUser = "attendance_app"

function Write-Step([string]$Text) {
  Write-Host ""
  Write-Host ("== " + $Text) -ForegroundColor Cyan
}

function New-RandomPassword([int]$Length = 24) {
  $chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
  $bytes = New-Object byte[] $Length
  $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $builder = New-Object System.Text.StringBuilder
  foreach ($byte in $bytes) { [void]$builder.Append($chars[$byte % $chars.Length]) }
  return $builder.ToString()
}

function Find-Mysql([string]$ExplicitPath) {
  if ($ExplicitPath -and (Test-Path $ExplicitPath)) {
    return (Resolve-Path $ExplicitPath).Path
  }
  $command = Get-Command mysql.exe -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }
  $candidates = @(
    "C:\Program Files\MySQL\MySQL Server 8.4\bin\mysql.exe",
    "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe",
    "C:\Program Files\MySQL\MySQL Server 9.0\bin\mysql.exe",
    "C:\Program Files\MySQL\MySQL Server 8.1\bin\mysql.exe"
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate) { return $candidate }
  }
  $found = Get-ChildItem "C:\Program Files\MySQL" -Filter "mysql.exe" -Recurse -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($found) { return $found.FullName }
  return ""
}

Write-Host ""
Write-Host "  学徒考勤系统 · 数据库初始化" -ForegroundColor Green
Write-Host "  将创建数据库、应用账号并执行表结构迁移"
Write-Host ""

$MysqlExe = Find-Mysql $MysqlExe
if (-not $MysqlExe) {
  Write-Host "未找到 mysql.exe。" -ForegroundColor Red
  Write-Host "请先安装 MySQL 8.4 LTS，并确保 MySQL 服务已启动。"
  Write-Host "下载地址：https://dev.mysql.com/downloads/mysql/"
  Read-Host "按 Enter 退出"
  exit 1
}

if (-not $RootPassword) {
  $secure = Read-Host "请输入 MySQL root 密码" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try {
    $RootPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

if (-not $AppPassword) {
  $AppPassword = New-RandomPassword 24
}

$configDir = Join-Path $Root "config"
if (-not (Test-Path $configDir)) {
  New-Item -ItemType Directory -Path $configDir -Force | Out-Null
}
$configFile = Join-Path $configDir "database.env"
$sqlFile = Join-Path $env:TEMP ("attendance-setup-" + [guid]::NewGuid().ToString("N") + ".sql")

$setupSql = @"
CREATE DATABASE IF NOT EXISTS apprentice_attendance CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE USER IF NOT EXISTS 'attendance_app'@'localhost' IDENTIFIED BY '$AppPassword';
ALTER USER 'attendance_app'@'localhost' IDENTIFIED BY '$AppPassword';
CREATE USER IF NOT EXISTS 'attendance_app'@'127.0.0.1' IDENTIFIED BY '$AppPassword';
ALTER USER 'attendance_app'@'127.0.0.1' IDENTIFIED BY '$AppPassword';
GRANT SELECT, INSERT, UPDATE, DELETE ON apprentice_attendance.* TO 'attendance_app'@'localhost';
GRANT SELECT, INSERT, UPDATE, DELETE ON apprentice_attendance.* TO 'attendance_app'@'127.0.0.1';
FLUSH PRIVILEGES;
"@
[System.IO.File]::WriteAllText($sqlFile, $setupSql, (New-Object System.Text.UTF8Encoding($false)))

$env:MYSQL_PWD = $RootPassword
try {
  Write-Step "创建数据库和应用账号"
  $cmd = "`"$MysqlExe`" --protocol=TCP --host=127.0.0.1 --port=3306 --user=root --default-character-set=utf8mb4 < `"$sqlFile`""
  & cmd.exe /c $cmd
  if ($LASTEXITCODE -ne 0) {
    throw "创建数据库或应用账号失败。请确认 MySQL 已启动，root 密码正确。"
  }

  Write-Step "执行表结构迁移"
  foreach ($migration in @("001_init.sql", "002_tasks.sql")) {
    $migrationFile = Join-Path $Root ("database\" + $migration)
    if (-not (Test-Path $migrationFile)) {
      throw "缺少迁移文件：$migrationFile"
    }
    $cmd = "`"$MysqlExe`" --protocol=TCP --host=127.0.0.1 --port=3306 --user=root --database=apprentice_attendance --default-character-set=utf8mb4 < `"$migrationFile`""
    & cmd.exe /c $cmd
    if ($LASTEXITCODE -ne 0) {
      throw "执行迁移失败：$migration"
    }
    Write-Host ("  已完成 " + $migration)
  }

  $envText = @"
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=apprentice_attendance
DB_USER=attendance_app
DB_PASSWORD=$AppPassword
DB_CHARSET=utf8mb4
"@
  [System.IO.File]::WriteAllText($configFile, $envText, (New-Object System.Text.UTF8Encoding($false)))

  Write-Host ""
  Write-Host "数据库初始化完成。" -ForegroundColor Green
  Write-Host "数据库：apprentice_attendance"
  Write-Host "应用账号：attendance_app"
  Write-Host ("应用密码：" + $AppPassword) -ForegroundColor Yellow
  Write-Host ""
  Write-Host "配置已写入：config\database.env"
  Write-Host "下一步：双击 start.bat 启动网站。"
  Write-Host "首次打开会显示管理员初始化页面。"
  Write-Host ""
  Read-Host "按 Enter 退出"
} catch {
  Write-Host ""
  Write-Host ("初始化失败：" + $_.Exception.Message) -ForegroundColor Red
  Write-Host "如果 MySQL 尚未安装，请先安装 MySQL 8.4 LTS 并启动 MySQL84 服务。"
  Read-Host "按 Enter 退出"
  exit 1
} finally {
  Remove-Item Env:MYSQL_PWD -ErrorAction SilentlyContinue
  Remove-Item $sqlFile -Force -ErrorAction SilentlyContinue
}
