const fs = require('fs');
const path = require('path');

function walk(dir) {
    let results = [];
    const list = fs.readdirSync(dir);
    list.forEach(file => {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat && stat.isDirectory()) {
            if (file !== 'node_modules' && file !== '.git') {
                results = results.concat(walk(fullPath));
            }
        } else if (file.endsWith('.js') || file.endsWith('.jsx') || file.endsWith('.ts') || file.endsWith('.tsx')) {
            results.push(fullPath);
        }
    });
    return results;
}

const files = walk('C:/Users/Danish/Documents/simulator/OpenHW-studio-frontend/src');
files.forEach(file => {
    const content = fs.readFileSync(file, 'utf8');
    if (content.includes('keydown') || content.includes('keypress')) {
        const lines = content.split('\n');
        lines.forEach((line, idx) => {
            if (line.includes('preventDefault') || line.includes('key') || line.includes('code')) {
                // print file and line
                if (line.trim().length > 0 && !line.includes('*') && !line.includes('//')) {
                    console.log(`${path.basename(file)}:${idx + 1}: ${line.trim()}`);
                }
            }
        });
    }
});
