const { createCanvas } = require('canvas');
const fs = require('fs');
const toIco = require('to-ico');

const size = 256;
const canvas = createCanvas(size, size);
const ctx = canvas.getContext('2d');

// Background circle (music theme - blue)
ctx.fillStyle = '#4A90D9';
ctx.beginPath();
ctx.arc(128, 128, 120, 0, Math.PI * 2);
ctx.fill();

// Draw music note
ctx.fillStyle = '#FFFFFF';
ctx.font = 'bold 140px Arial';
ctx.textAlign = 'center';
ctx.textBaseline = 'middle';
ctx.fillText('♪', 128, 130);

// Save as PNG first
const pngBuffer = canvas.toBuffer('image/png');
fs.writeFileSync('public/favicon.png', pngBuffer);
console.log('PNG created');

// Convert to ICO using toIco
toIco([pngBuffer])
  .then(buf => {
    fs.writeFileSync('public/favicon.ico', buf);
    console.log('ICO created successfully');
  })
  .catch(err => {
    console.error('Error:', err);
  });