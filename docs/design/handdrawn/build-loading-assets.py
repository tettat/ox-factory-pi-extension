"""Publish only the three approved loading actions; no raster art or dependencies."""
from pathlib import Path
import re
root=Path(__file__).parent
out=root.parents[2]/'web'/'skins'/'handdrawn'
out.mkdir(parents=True,exist_ok=True)
for action in ['running','grazing','cow-truck']:
 for still in ['', '-still']:
  svg=(root/f'{action}-mascots{still}.svg').read_text()
  svg=re.sub(r'<!--.*?-->','',svg,flags=re.S)
  svg=re.sub(r'>\s+<','><',svg)
  svg=re.sub(r'\s+',' ',svg).strip()
  (out/f'{action}{still}.svg').write_text(svg)
print(sum(p.stat().st_size for p in out.glob('*.svg')), 'bytes total for loading assets')
