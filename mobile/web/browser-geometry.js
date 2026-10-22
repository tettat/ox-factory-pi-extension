export function fitView(width, height, pageWidth, pageHeight, mode = 'auto') {
  const scale = mode === 'height' || (mode === 'auto' && height > width) ? height / pageHeight : Math.min(width / pageWidth, height / pageHeight);
  return clampView({ scale, x: 0, y: 0 }, width, height, pageWidth, pageHeight);
}
export function clampView(v, w, h, pw, ph) {
  const bound = (n, area, size) => size <= area ? (area - size) / 2 : Math.min(0, Math.max(area - size, n));
  return { ...v, x: bound(v.x, w, pw * v.scale), y: bound(v.y, h, ph * v.scale) };
}
export function zoomView(v, factor, cx, cy, w, h, pw, ph) {
  const minimum = Math.min(w / pw, h / ph) / 2, scale = Math.min(6, Math.max(minimum, v.scale * factor));
  return clampView({ scale, x: cx - (cx - v.x) * scale / v.scale, y: cy - (cy - v.y) * scale / v.scale }, w, h, pw, ph);
}
export function remotePoint(v, x, y, width, height) {
  const p = { x: (x - v.x) / v.scale, y: (y - v.y) / v.scale };
  return p.x >= 0 && p.y >= 0 && p.x < width && p.y < height ? p : null;
}
