const fs = require('fs');

const filePath = 'C:/Users/Danish/Documents/simulator/workflow/Wokwi_Project_by_Uri_Shaked_5.json';
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

console.log('Project top-level keys:', Object.keys(data));
if (data.boardHexMap) {
    console.log('boardHexMap keys:', Object.keys(data.boardHexMap));
}
if (data.hex) {
    console.log('hex field exists, length:', data.hex.length);
}
