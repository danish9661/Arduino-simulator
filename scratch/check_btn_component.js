const fs = require('fs');

const filePath = 'C:/Users/Danish/Documents/simulator/workflow/Wokwi_Project_by_Uri_Shaked_5.json';
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

console.log('btn7 components data:');
data.components.forEach(c => {
    if (c.id === 'btn7' || c.id.includes('btn')) {
        console.log(c);
    }
});
