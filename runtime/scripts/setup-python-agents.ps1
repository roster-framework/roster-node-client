param(
  [Parameter(Mandatory=$true)][string]$Python,
  [string]$Environment = (Join-Path ([IO.Path]::GetTempPath()) 'roster-python-agents'),
  [ValidateSet('langgraph','crewai','langgraph,crewai')][string]$Engines = 'langgraph,crewai'
)
$ErrorActionPreference = 'Stop'
$runtimeRepository = Split-Path -Parent $PSScriptRoot
$environmentPath = [IO.Path]::GetFullPath($Environment)
& $Python -m venv $environmentPath
if ($LASTEXITCODE -ne 0) { throw 'Python environment creation failed' }
$runtimePython = Join-Path $environmentPath 'Scripts/python.exe'
$env:PIP_CACHE_DIR = Join-Path (Split-Path -Parent $environmentPath) 'pip-cache'
$previousTempPath = $env:TEMP
$previousTmpPath = $env:TMP
$installTempPath = Join-Path (Split-Path -Parent $environmentPath) 'python-install-tmp'
New-Item -ItemType Directory -Path $installTempPath -Force | Out-Null
try {
  $env:TEMP = $installTempPath
  $env:TMP = $installTempPath
  & $runtimePython -m pip install "$runtimeRepository/python[$Engines]"
  if ($LASTEXITCODE -ne 0) { throw 'Python SDK installation failed' }
} finally {
  $env:TEMP = $previousTempPath
  $env:TMP = $previousTmpPath
}
Write-Output "ROSTER_PYTHON_EXECUTABLE=$runtimePython"
