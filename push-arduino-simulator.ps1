# push-arduino-simulator.ps1
# Usage: .\push-arduino-simulator.ps1 "your commit message"
# Commits and pushes the full simulator to Arduino-simulator on GitHub.

param(
    [Parameter(Mandatory=$true)]
    [string]$Message
)

$root = "c:\Users\Danish\Documents\simulator"
$subs = @(
    "OpenHW-studio-frontend-danish",
    "openhw-studio-backend-danish",
    "openhw-studio-emulator-danish"
)

Set-Location $root
Write-Host "Committing to Arduino-simulator..." -ForegroundColor Cyan

# Temporarily hide sub-repo .git folders so root git tracks files (not submodules)
foreach ($sub in $subs) {
    $gitPath = Join-Path $root "$sub\.git"
    if (Test-Path $gitPath) {
        Rename-Item $gitPath ".git_bak"
    }
}

try {
    git add .
    git commit -m $Message
    git push origin main
    Write-Host ""
    Write-Host "Done! Pushed to https://github.com/danish9661/Arduino-simulator" -ForegroundColor Green
} finally {
    # Always restore sub-repo .git folders, even if push fails
    foreach ($sub in $subs) {
        $bakPath = Join-Path $root "$sub\.git_bak"
        if (Test-Path $bakPath) {
            Rename-Item $bakPath ".git"
        }
    }
    Write-Host "Sub-repo git folders restored." -ForegroundColor DarkGray
}
