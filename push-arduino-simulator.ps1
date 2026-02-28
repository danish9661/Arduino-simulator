# push-arduino-simulator.ps1
# Usage: .\push-arduino-simulator.ps1 "your commit message"
# Commits and pushes everything in the simulator folder to Arduino-simulator on GitHub.

param(
    [Parameter(Mandatory=$true)]
    [string]$Message
)

$root = "c:\Users\Danish\Documents\simulator"

Write-Host "Committing to Arduino-simulator..." -ForegroundColor Cyan

Set-Location $root

# Stage all changes (node_modules and .git sub-folders are excluded via .gitignore)
git add .
git commit -m $Message
git push origin main

Write-Host ""
Write-Host "Done! Pushed to https://github.com/danish9661/Arduino-simulator" -ForegroundColor Green
