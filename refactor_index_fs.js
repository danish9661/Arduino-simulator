const fs = require('fs');
const path = require('path');

const componentsDir = path.join(__dirname, 'openhw-studio-emulator', 'src', 'components');

function walkDir(dir, callback) {
    fs.readdirSync(dir).forEach(f => {
        let dirPath = path.join(dir, f);
        if (fs.statSync(dirPath).isDirectory()) {
            walkDir(dirPath, callback);
        } else {
            callback(dirPath);
        }
    });
}

walkDir(componentsDir, (filePath) => {
    if (filePath.endsWith('index.ts')) {
        let content = fs.readFileSync(filePath, 'utf8');
        
        if (content.includes("import fs from 'node:fs';")) {
            console.log("Refactoring fs imports in: " + filePath);
            
            // Remove the import
            content = content.replace(/import fs from 'node:fs';\r?\n?/g, '');
            
            // We want to replace instances of fs.readFileSync with our dynamic Node-only fallback.
            // First we need to make sure we define our dynamic fs loader at the top of the file, right after imports.
            
            // Inject dynamic loader
            const dynamicLoader = `
let _nodeFs: any = null;
try {
    if (typeof process !== 'undefined' && process.versions && process.versions.node) {
        // @ts-ignore
        _nodeFs = eval("require('node:fs')");
    }
} catch (e) {}
`;
            
            // Find the last import
            const lastImportRegex = /import .*;\r?\n/g;
            let lastImportMatch;
            let lastIndex = 0;
            while ((lastImportMatch = lastImportRegex.exec(content)) !== null) {
                lastIndex = lastImportRegex.lastIndex;
            }
            
            content = content.slice(0, lastIndex) + dynamicLoader + content.slice(lastIndex);
            
            // Replace fs.readFileSync with _nodeFs?.readFileSync
            content = content.replace(/fs\.readFileSync/g, '_nodeFs?.readFileSync');
            
            fs.writeFileSync(filePath, content);
        }
    }
});
