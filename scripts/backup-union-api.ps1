# Union API Proxy —— 数据库定时备份
#
# 作用：把容器内 SQLite 库做一致快照并导出到宿主机，按份数轮转。
#       登录态（8 个账号）、自定义 API 配置、API 密钥、系统配置全在 proxy.db 里，
#       这是唯一的单点故障——卷丢了就全没了。
#
# 用法：
#   .\backup-union-api.ps1                        # 备份到默认目录，保留 14 份
#   .\backup-union-api.ps1 -Dest D:\bak -Keep 30  # 自定义
#
# 建议配成计划任务：每天 22:00（趁机器还开着）

[CmdletBinding()]
param(
  [string]$Container = 'union-proxy',
  [string]$Dest = "$env:USERPROFILE\union-api-backups",
  [int]$Keep = 14
)

$ErrorActionPreference = 'Stop'
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$helper = Join-Path $PSScriptRoot 'backup-db.mjs'

function Fail($msg) { Write-Error "[union-api-backup] $msg"; exit 1 }

# 0) 前置检查
$running = (docker inspect $Container --format '{{.State.Running}}' 2>$null)
if ($running -ne 'true') { Fail "容器 $Container 未运行，跳过备份" }
if (-not (Test-Path $helper)) { Fail "找不到 $helper" }
New-Item -ItemType Directory -Path $Dest -Force | Out-Null

# 1) 把快照脚本送进容器，生成一致快照（VACUUM INTO，在线安全）
docker cp $helper "${Container}:/tmp/backup-db.mjs" | Out-Null
$snapInContainer = '/tmp/proxy-snapshot.db'
docker exec $Container node /tmp/backup-db.mjs /data/proxy.db $snapInContainer | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "容器内生成快照失败（exit $LASTEXITCODE）" }

# 2) 导出到宿主机
$target = Join-Path $Dest "proxy-$stamp.db"
docker cp "${Container}:${snapInContainer}" $target | Out-Null
if (-not (Test-Path $target)) { Fail "导出快照失败" }

# 3) 顺带备份 session.json（若存在）
$hasSession = (docker exec $Container sh -c 'test -f /data/session.json && echo yes' 2>$null)
if ($hasSession -eq 'yes') {
  docker cp "${Container}:/data/session.json" (Join-Path $Dest "session-$stamp.json") | Out-Null
}

# 4) 清理容器内临时文件
docker exec $Container rm -f /tmp/backup-db.mjs $snapInContainer 2>$null | Out-Null

# 5) 轮转：只保留最新的 $Keep 份
$files = Get-ChildItem $Dest -Filter 'proxy-*.db' | Sort-Object LastWriteTime -Descending
if ($Keep -gt 0 -and $files.Count -gt $Keep) {
  $files | Select-Object -Skip $Keep | ForEach-Object {
    Remove-Item $_.FullName -Force -ErrorAction SilentlyContinue
    $sessionSidecar = Join-Path $Dest ("session-" + ($_.BaseName -replace '^proxy-', '') + '.json')
    if (Test-Path $sessionSidecar) { Remove-Item $sessionSidecar -Force -ErrorAction SilentlyContinue }
  }
}

$size = [math]::Round((Get-Item $target).Length / 1KB, 1)
$kept = (Get-ChildItem $Dest -Filter 'proxy-*.db').Count
Write-Host "[union-api-backup] OK -> $target (${size} KB)，当前保留 $kept 份"
