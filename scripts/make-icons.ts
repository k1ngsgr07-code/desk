// Draws the home-screen icons (navy square, gold ring, red TEST strip). Run: npx tsx scripts/make-icons.ts
import fs from 'fs';
import path from 'path';
import { PNG } from 'pngjs';

for (const size of [192, 512]) {
  const png = new PNG({ width: size, height: size });
  const c = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - c, y - c) / size;
      let rgb = [10, 14, 39];                            // navy background
      if (d < 0.34 && d > 0.24) rgb = [212, 175, 55];    // gold ring
      if (d < 0.12) rgb = [255, 215, 0];                 // gold dot
      if (y > size * 0.86) rgb = [200, 16, 46];          // red strip = test build
      const i = (y * size + x) * 4;
      png.data[i] = rgb[0];
      png.data[i + 1] = rgb[1];
      png.data[i + 2] = rgb[2];
      png.data[i + 3] = 255;
    }
  }
  fs.writeFileSync(path.join(__dirname, '..', 'public', `icon-${size}.png`), PNG.sync.write(png));
}
console.log('Icons written to public/.');
