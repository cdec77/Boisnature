#!/usr/bin/env sh
set -eu

SOURCE="${1:-images2.jpg}"
if command -v magick >/dev/null 2>&1; then IM="magick"; else IM="convert"; fi
mkdir -p icons

for size in 16 32 72 96 128 144 152 192 384 512; do
  $IM "$SOURCE" -auto-orient -resize "${size}x${size}^" -gravity center -extent "${size}x${size}" "icons/icon-${size}.png"
done

cp icons/icon-16.png icons/favicon-16x16.png
cp icons/icon-32.png icons/favicon-32x32.png
$IM "$SOURCE" -auto-orient -resize "180x180^" -gravity center -extent 180x180 icons/apple-touch-icon.png
$IM "$SOURCE" -auto-orient -resize "128x128^" -gravity center -extent 128x128 -bordercolor '#C5D94C' -border 32 icons/maskable-192.png
$IM "$SOURCE" -auto-orient -resize "342x342^" -gravity center -extent 342x342 -bordercolor '#C5D94C' -border 85 icons/maskable-512.png
$IM icons/favicon-16x16.png icons/favicon-32x32.png favicon.ico

echo "Icônes générées dans icons/ et favicon.ico créé."
