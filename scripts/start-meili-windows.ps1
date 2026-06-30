param(
  [string]$MeiliExe = "C:\Users\haili\AppData\Local\Temp\book-id-search-meili\meilisearch.exe",
  [string]$DbPath = "H:\book-id-search\meili_data",
  [string]$HttpAddr = "127.0.0.1:7700",
  [string]$MasterKey = "book-id-search-dev-key",
  [string]$Env = "development"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $MeiliExe)) {
  Write-Error "meilisearch.exe not found: $MeiliExe. See docs/RUN_WITHOUT_DOCKER_WINDOWS.md for where to download or place the Windows binary."
}

New-Item -ItemType Directory -Force -Path $DbPath | Out-Null

$arguments = @(
  "--db-path", $DbPath,
  "--http-addr", $HttpAddr,
  "--master-key", $MasterKey,
  "--env", $Env
)

Write-Host "[meili] exe: $MeiliExe"
Write-Host "[meili] data dir: $DbPath"
Write-Host "[meili] addr: $HttpAddr"
Write-Host "[meili] command:"
Write-Host "`"$MeiliExe`" $($arguments -join ' ')"

& $MeiliExe @arguments
