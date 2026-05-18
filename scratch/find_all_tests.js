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
        } else if (file.includes('test') || file.includes('spec')) {
            if (file.endsWith('.js') || file.endsWith('.ts') || file.endsWith('.tsx') || file.endsWith('.jsx')) {
                results.push(fullPath);
            }
        }
    });
    return results;
}

const files = walk('C:/Users/Danish/Documents/simulator/OpenHW-studio-frontend');
console.log(`Total test files: ${files.length}`);
files.forEach(f => {
    const content = fs.readFileSync(f, 'utf8');
    if (content.includes('piano') || content.includes('btn7') || content.includes('Wokwi_Project')) {
        console.log(`  Relevant: ${f}`);
    }
});
