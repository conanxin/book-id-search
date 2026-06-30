param(
  [Parameter(Mandatory = $true)]
  [string]$Host,

  [string]$User = "root",

  [string]$KeyPath,

  [string]$LocalFile = "E:\读秀512w（下架书及ss与isbn码）.txt",

  [string]$RemoteFile = "/data/book-id-search/private-data/books.txt"
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path -LiteralPath $LocalFile)) {
  throw "Local data file does not exist: $LocalFile"
}

$target = "$User@$Host"
$sshArgs = @()
if ($KeyPath) {
  $sshArgs += @("-i", $KeyPath)
}

Write-Host "[upload] ensuring remote private data directory"
& ssh @sshArgs $target "mkdir -p /data/book-id-search/private-data"
if ($LASTEXITCODE -ne 0) {
  throw "ssh mkdir failed"
}

Write-Host "[upload] uploading private TXT to $target`:$RemoteFile"
& scp @sshArgs $LocalFile "$target`:$RemoteFile"
if ($LASTEXITCODE -ne 0) {
  throw "scp upload failed"
}

Write-Host "[upload] done"
