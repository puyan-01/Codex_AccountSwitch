param(
  [string]$TargetDir = "C:\project\Codex_AccountSwitch\window\Codex_AccountSwitch_Portable_windows_x64_v1.3.17",
  [string]$Configuration = "Release",
  [string]$Architecture = "x64",
  [string]$Toolset = "v143",
  [switch]$NoRelaunch
)

$ErrorActionPreference = "Stop"

function Write-Step {
  param([string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Resolve-MSBuildPath {
  $cmd = Get-Command msbuild -ErrorAction SilentlyContinue
  if ($cmd -and $cmd.Path) {
    return $cmd.Path
  }

  $vswherePath = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (Test-Path -LiteralPath $vswherePath) {
    $installPath = & $vswherePath -latest -products * -requires Microsoft.Component.MSBuild -property installationPath
    if (-not [string]::IsNullOrWhiteSpace($installPath)) {
      $candidate = Join-Path $installPath "MSBuild\Current\Bin\MSBuild.exe"
      if (Test-Path -LiteralPath $candidate) {
        return $candidate
      }
    }
  }

  $fallbackPaths = @(
    "C:\Program Files\Microsoft Visual Studio\2022\Community\MSBuild\Current\Bin\MSBuild.exe",
    "C:\Program Files\Microsoft Visual Studio\2022\Professional\MSBuild\Current\Bin\MSBuild.exe",
    "C:\Program Files\Microsoft Visual Studio\2022\Enterprise\MSBuild\Current\Bin\MSBuild.exe",
    "C:\Program Files (x86)\Microsoft Visual Studio\2022\BuildTools\MSBuild\Current\Bin\MSBuild.exe"
  )
  foreach ($path in $fallbackPaths) {
    if (Test-Path -LiteralPath $path) {
      return $path
    }
  }

  throw "MSBuild was not found. Install Visual Studio Build Tools or run from Developer PowerShell."
}

function Assert-ChildPath {
  param(
    [string]$Path,
    [string]$Parent,
    [string]$Label
  )
  $resolvedPath = (Resolve-Path -LiteralPath $Path).Path
  $resolvedParent = (Resolve-Path -LiteralPath $Parent).Path
  if (-not $resolvedPath.StartsWith($resolvedParent, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label is outside expected parent: $resolvedPath"
  }
  return $resolvedPath
}

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$repoRoot = (Resolve-Path -LiteralPath (Join-Path $scriptDir "..")).Path
$projectPath = Join-Path $repoRoot "Codex_AccountSwitch\Codex_AccountSwitch.vcxproj"
$portableScript = Join-Path $repoRoot "tools\build_portable.ps1"
$windowRoot = Join-Path $repoRoot "window"
$resolvedTarget = Assert-ChildPath -Path $TargetDir -Parent $windowRoot -Label "TargetDir"

if (-not (Test-Path -LiteralPath $projectPath)) {
  throw "Project file not found: $projectPath"
}
if (-not (Test-Path -LiteralPath $portableScript)) {
  throw "Portable build script not found: $portableScript"
}

Write-Step "Build $Configuration | $Architecture with $Toolset"
$msbuild = Resolve-MSBuildPath
Push-Location $repoRoot
try {
  & $msbuild $projectPath "/p:Configuration=$Configuration" "/p:Platform=$Architecture" "/p:PlatformToolset=$Toolset" "/m"
  if ($LASTEXITCODE -ne 0) {
    throw "MSBuild failed with exit code $LASTEXITCODE"
  }
}
finally {
  Pop-Location
}

Write-Step "Create portable package"
& powershell -ExecutionPolicy Bypass -NoProfile -File $portableScript -Configuration $Configuration -Platform $Architecture -TargetPlatform windows -TargetArchitecture $Architecture
if ($LASTEXITCODE -ne 0) {
  throw "Portable package script failed with exit code $LASTEXITCODE"
}

$zipPath = Get-ChildItem -LiteralPath (Join-Path $repoRoot "dist") -Filter "Codex_AccountSwitch_Portable_windows_${Architecture}_v*.zip" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if (-not $zipPath) {
  throw "Portable zip not found under dist."
}

Write-Step "Replace portable directory"
Get-Process Codex_AccountSwitch -ErrorAction SilentlyContinue |
  Where-Object { $_.Path -and $_.Path.StartsWith($resolvedTarget, [System.StringComparison]::OrdinalIgnoreCase) } |
  Stop-Process -Force
Start-Sleep -Milliseconds 500

$tempRoot = Join-Path $env:TEMP ("Codex_AccountSwitch_Portable_" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $tempRoot | Out-Null
try {
  Expand-Archive -LiteralPath $zipPath.FullName -DestinationPath $tempRoot -Force

  Copy-Item -LiteralPath (Join-Path $tempRoot "Codex_AccountSwitch.exe") -Destination (Join-Path $resolvedTarget "Codex_AccountSwitch.exe") -Force
  Copy-Item -LiteralPath (Join-Path $tempRoot "WebView2Loader.dll") -Destination (Join-Path $resolvedTarget "WebView2Loader.dll") -Force
  Copy-Item -LiteralPath (Join-Path $tempRoot "portable.mode") -Destination (Join-Path $resolvedTarget "portable.mode") -Force

  $targetWebui = Join-Path $resolvedTarget "webui"
  if (Test-Path -LiteralPath $targetWebui) {
    Assert-ChildPath -Path $targetWebui -Parent $resolvedTarget -Label "webui" | Out-Null
    Remove-Item -LiteralPath $targetWebui -Recurse -Force
  }
  Copy-Item -LiteralPath (Join-Path $tempRoot "webui") -Destination $targetWebui -Recurse -Force

  $configPath = Join-Path $resolvedTarget "data\config.json"
  if (Test-Path -LiteralPath $configPath) {
    $config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
    if (-not $config.PSObject.Properties["clientTarget"]) {
      $target = switch -Regex ($config.ideExe) {
        "^Code\.exe$" { "vscode"; break }
        "^Trae\.exe$" { "trae"; break }
        "^Kiro\.exe$" { "kiro"; break }
        "^Antigravity\.exe$" { "antigravity"; break }
        default { "codex" }
      }
      $config | Add-Member -NotePropertyName clientTarget -NotePropertyValue $target -Force
    }
    if (-not $config.PSObject.Properties["ideExe"] -or [string]::IsNullOrWhiteSpace([string]$config.ideExe)) {
      $config | Add-Member -NotePropertyName ideExe -NotePropertyValue "Codex.exe" -Force
    }
    $config | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $configPath -Encoding UTF8
  }
}
finally {
  if (Test-Path -LiteralPath $tempRoot) {
    Remove-Item -LiteralPath $tempRoot -Recurse -Force
  }
}

Write-Step "Refresh desktop shortcuts"
$portableShortcut = Join-Path $env:USERPROFILE "Desktop\Codex Account Switch 便携版.lnk"
$quickBuildShortcut = Join-Path $env:USERPROFILE "Desktop\快速构建 Codex Account Switch 便携版.lnk"
$shell = New-Object -ComObject WScript.Shell

$portableLnk = $shell.CreateShortcut($portableShortcut)
$portableLnk.TargetPath = Join-Path $resolvedTarget "Codex_AccountSwitch.exe"
$portableLnk.WorkingDirectory = $resolvedTarget
$portableLnk.IconLocation = (Join-Path $resolvedTarget "Codex_AccountSwitch.exe") + ",0"
$portableLnk.Save()

$quickLnk = $shell.CreateShortcut($quickBuildShortcut)
$quickLnk.TargetPath = "powershell.exe"
$quickLnk.Arguments = "-NoExit -ExecutionPolicy Bypass -NoProfile -File `"$PSCommandPath`""
$quickLnk.WorkingDirectory = $repoRoot
$quickLnk.IconLocation = (Join-Path $resolvedTarget "Codex_AccountSwitch.exe") + ",0"
$quickLnk.Save()

if (-not $NoRelaunch) {
  Write-Step "Relaunch portable app"
  Start-Process -FilePath (Join-Path $resolvedTarget "Codex_AccountSwitch.exe") -WorkingDirectory $resolvedTarget -WindowStyle Hidden
}

Write-Step "Done"
Write-Host "Portable target: $resolvedTarget"
Write-Host "Portable zip:    $($zipPath.FullName)"
Write-Host "Shortcut:        $quickBuildShortcut"
