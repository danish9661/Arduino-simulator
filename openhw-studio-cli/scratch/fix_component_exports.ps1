$componentsDir = "c:\Users\Danish\Documents\simulator\openhw-studio-emulator\src\components"
$files = Get-ChildItem -Path $componentsDir -Filter "index.ts" -Recurse

foreach ($file in $files) {
    $content = Get-Content $file.FullName -Raw
    if ($content -match "import \{ validate \} from './validation'") {
        Write-Host "Fixing $($file.FullName)"
        $content = $content -replace "import \{ validate \} from './validation'", "import { validation } from './validation'"
        $content = $content -replace "    validate,", "    validation,"
        Set-Content $file.FullName $content
    }
}
