"""Original leopard and truck scenes, sharing the existing cow SVG drawing."""
from pathlib import Path
import runpy
ROOT = Path(__file__).parent
base = runpy.run_path(str(ROOT / 'build-mascots.py'))
STYLE = base['STYLE'] + '''
.leopard .tail{transform-origin:57px 122px}.leopard .head{transform-origin:140px 103px}
.idle .body{animation:breathe 3s ease-in-out infinite}.idle .leg{animation:none}.idle .head{animation:look 5s ease-in-out infinite}
@keyframes look{0%,65%,100%{transform:rotate(0)}78%{transform:rotate(-7deg)}}
.jumper{animation:jump 3.6s ease-in-out infinite}.jump .body{animation:none}.jump .leg{animation:tuck 3.6s ease-in-out infinite}
@keyframes jump{0%,15%{transform:translate(0,0)}24%{transform:translate(15px,6px)}48%{transform:translate(102px,-55px)}68%{transform:translate(185px,0)}73%{transform:translate(185px,4px)}80%{transform:translate(185px,0);opacity:1}88%,92%{transform:translate(185px,0);opacity:0}93%{transform:translate(0,0);opacity:0}100%{transform:translate(0,0);opacity:1}}
@keyframes tuck{0%,24%,68%,100%{transform:rotate(0)}40%,55%{transform:rotate(-48deg)}}
.ripple{animation:ripple 2s ease-in-out infinite alternate}@keyframes ripple{to{transform:translateX(8px);opacity:.5}}
.convoy{animation:unload 6s linear infinite;animation-delay:var(--arrival)}
.convoy .body{animation:bounce .44s ease-in-out infinite}.convoy .leg{animation:stride .44s ease-in-out infinite}.convoy .rear{animation-delay:-.22s}
.passenger .body,.passenger .leg,.passenger .head{animation:none}
@keyframes unload{0%{transform:translate(0,0);opacity:0}8%{transform:translate(8px,4px);opacity:1}42%{transform:translate(90px,44px);opacity:1}85%{transform:translate(230px,44px);opacity:1}98%,100%{transform:translate(270px,44px);opacity:0}}
@media(prefers-reduced-motion:reduce){.jumper,.convoy,.ripple{animation:none!important}.convoy{transform:translate(var(--parking),44px)}}
.still .jumper,.still .convoy,.still .ripple{animation:none!important}.still .convoy{transform:translate(var(--parking),44px)}
'''

def rosette(x,y,r=4):
    return f'<g transform="translate({x} {y})"><path d="M-{r} 0q-2-{r} 2-{r+1}m3 0q{r} 1 {r-1} {r}m-1 3q-3 3-5 0" fill="none" stroke="#725039" stroke-width="2.3"/><circle cx="0" cy="0" r="1.5" fill="#b58645" stroke="none"/></g>'

def paw(x,far=False):
    return f'''<g transform="translate({x} 144)"><g class="leg {'rear' if far else ''}"><path d="M-6-4Q-9 17-3 30L-4 35Q6 40 17 34q1-6-9-7L6-4" fill="{'#c99d5c' if far else '#e4bd75'}"/><path d="M7 29q10 0 10 5-8 6-18 2l-2-7" fill="#fae9c8"/><path d="M5 33v3m5-4v3" fill="none" stroke-width="1.2"/></g></g>'''

def leopard():
    spots=''.join(rosette(x,y) for x,y in [(69,116),(86,110),(105,112),(125,119),(65,133),(84,130),(106,132),(125,142)])
    return f'''<g class="leopard ink"><g class="body">
<g class="tail"><path d="M58 124C19 137-2 121 7 88q6-16 17-7" fill="none" stroke="#725039" stroke-width="12"/><path d="M58 124C19 137-2 121 7 88q6-16 17-7" fill="none" stroke="#e4bd75" stroke-width="8"/><path d="M10 91l-7-2m10 19-8 3m25 15-1 8m18-9 2 7" stroke="#725039" stroke-width="4"/></g>
{paw(75,True)}{paw(130,True)}
<path d="M55 111Q75 96 107 104l37 9q13 12 4 28-13 18-49 15-53-2-44-45" fill="#e4bd75"/>
<path d="M64 144q40 20 76-6" stroke="#f7e4bf" stroke-width="9" fill="none"/>{spots}
{paw(63)}{paw(115)}
<path d="M122 124q-7-27 5-45l32 13-5 37" fill="#e4bd75"/>
<path d="M120 110q22 11 40 0l-1 12q-19 10-40 0zM127 122l-7 24 19-10-3-14" fill="#94a785"/>
<g class="head"><g class="ear"><circle cx="123" cy="51" r="14" fill="#d3a865"/><circle cx="161" cy="49" r="14" fill="#d3a865"/><circle cx="123" cy="51" r="8" fill="#755746"/><circle cx="161" cy="49" r="8" fill="#755746"/></g>
<path d="M114 66Q117 44 142 45q32-1 35 28l-1 22q-8 24-34 24-32-2-32-29z" fill="#e8c27c"/>
{rosette(134,55,3)}{rosette(153,57,3)}{rosette(116,78,3)}{rosette(172,82,3)}
<path d="M122 77q5-12 16-3m13-2q13-8 19 4" fill="none" stroke-width="1.6"/>
<g class="eye"><ellipse cx="131" cy="82" rx="8" ry="10" fill="#fff5da"/><ellipse cx="159" cy="82" rx="8" ry="10" fill="#fff5da"/><ellipse cx="134" cy="83" rx="3.5" ry="6" fill="#665337" stroke="none"/><ellipse cx="162" cy="83" rx="3.5" ry="6" fill="#665337" stroke="none"/><circle cx="135" cy="80" r="1.8" fill="white" stroke="none"/><circle cx="163" cy="80" r="1.8" fill="white" stroke="none"/></g>
<path d="M118 100q5-13 25-6 20-8 26 6-1 16-25 16-23 0-26-16" fill="#fff0d0" stroke="none"/>
<path d="M137 94q7-4 14 0l-7 7z" fill="#80543e"/><path d="M144 101v5m-11 0q6 7 11 0 5 7 11-1" fill="none" stroke-width="1.6"/>
<g fill="#725039" stroke="none"><circle cx="126" cy="99" r="1"/><circle cx="130" cy="102" r="1"/><circle cx="163" cy="99" r="1"/><circle cx="159" cy="102" r="1"/></g>
<path d="M124 101l-19-3m20 7-17 2m57-6 18-4m-19 8 18 2" fill="none" stroke-width="1"/>
</g></g></g>'''

def scene(name):
    if name=='cow-truck':
        cow=base['animal']()
        calves=''.join(f'<g transform="translate(225 100) scale(.42)"><g class="convoy" style="--arrival:-{i*1.5}s;--parking:{i*70}px">{cow}</g></g>' for i in range(4))
        # The translated parent is outside the animated element: positions do not get overwritten.
        # Convoy displacements are in scaled units, keeping the scene within the viewBox.
        return f'''<path d="M40 216h545" stroke="#c7baa0" fill="none"/>
<g class="ink"><rect x="125" y="80" width="199" height="89" rx="6" fill="#91a38a"/>
<path d="M124 101H68L43 139v44h90" fill="#79927f"/><path d="M77 111h35v33H57z" fill="#d6e7e2"/>
<rect x="46" y="160" width="15" height="13" rx="3" fill="#f2d997"/>
<path d="M131 180h190m-4-11 84 44h-30l-63-34" fill="#c7ad80"/>
<circle cx="87" cy="183" r="23" fill="#655d50"/><circle cx="87" cy="183" r="11" fill="#d5c6a8"/>
<circle cx="280" cy="183" r="23" fill="#655d50"/><circle cx="280" cy="183" r="11" fill="#d5c6a8"/>
</g><rect x="125" y="83" width="197" height="16" fill="#91a38a" stroke="#514737" stroke-width="2"/>
{calves}
'''
    if name=='leopard-jump':
        return f'''<path d="M312 166q-25 40-18 115h84q-12-55 18-115" fill="#d5e8e7"/>
<path d="M45 226q137-24 250 0m88 0q115-18 222 0" stroke="#a5b98c" stroke-width="3" fill="none"/>
<g class="ripple" stroke="#90bcbd" fill="none"><path d="M315 245h24m-11 15h28m-31-30h24"/></g>
<g transform="translate(86 38)"><g class="jumper">{leopard()}</g></g>
<text x="44" y="278" font-family="system-ui,sans-serif" font-size="13" fill="#7b806b">蓄力 → 跃起 → 落地 · 豹拉跳小河</text>'''
    return f'<ellipse cx="325" cy="210" rx="89" ry="5" fill="#e8dfc8"/><g transform="translate(205 13)">{leopard()}</g>'

for name,cls,title in [('leopard','idle','豹拉：站立张望'),('leopard-run','fast','豹拉：轻巧快跑'),('leopard-jump','jump','豹拉：跳过小河'),('cow-truck','truck','一车小牛下来帮忙')]:
    for still in [False,True]:
        (ROOT/f'{name}-mascots{"-still" if still else ""}.svg').write_text(f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 {300 if name=='leopard-jump' else 240}" role="img" aria-labelledby="title desc" class="{cls} {'still' if still else ''}" style="--step:.38s"><title id="title">{title}</title><desc id="desc">与牛马同系列的原创 SVG 小样，支持减少动态效果。</desc><style>{STYLE}</style>{scene(name)}</svg>''')
