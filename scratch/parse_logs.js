const fs = require('fs');

const overviewContent = fs.readFileSync('C:/Users/Danish/.gemini/antigravity/brain/1393d434-2e73-4732-9fcb-c65757941aee/.system_generated/logs/overview.txt', 'utf8');
const lines = overviewContent.split('\n');
lines.forEach(line => {
    if (line.includes('http://localhost') || line.includes('localhost:')) {
        console.log(line);
    }
});
