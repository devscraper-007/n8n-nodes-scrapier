'use strict';
// Copies non-TS assets into dist after tsc runs.
const fs = require('fs');
const path = require('path');

const files = [
	['nodes/Scrapier/scrapier.svg', 'dist/nodes/Scrapier/scrapier.svg'],
];

for (const [src, dest] of files) {
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.copyFileSync(src, dest);
	console.log(`copied ${src} -> ${dest}`);
}
