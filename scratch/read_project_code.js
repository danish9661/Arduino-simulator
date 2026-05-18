const fs = require('fs');
const path = require('path');

const files = fs.readdirSync('C:/Users/Danish/Documents/simulator/workflow');
files.forEach(file => {
    if (file.endsWith('.json')) {
        try {
            const data = JSON.parse(fs.readFileSync(path.join('C:/Users/Danish/Documents/simulator/workflow', file), 'utf8'));
            if (data.code) {
                console.log(`--- Code in ${file} ---`);
                console.log(data.code);
            } else if (data.files) {
                console.log(`--- Files in ${file} ---`);
                data.files.forEach(f => {
                    if (f.name && (f.name.endsWith('.ino') || f.name.endsWith('.cpp'))) {
                        console.log(`  File: ${f.name}`);
                        console.log(f.content);
                    }
                });
            }
        } catch (e) {
            // ignore
        }
    }
});
