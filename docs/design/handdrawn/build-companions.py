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
VAN_STYLE = '''.convoy{animation:van-exit 6s linear infinite;animation-delay:var(--arrival)}
.front-calf{animation:calf-step .5s ease-in-out infinite}.front-hoof{animation:hoof-step .5s ease-in-out infinite}.front-hoof.other{animation-delay:-.25s}
@keyframes calf-step{0%,100%{transform:translateY(0) rotate(-1deg)}50%{transform:translateY(-2px) rotate(1deg)}}
@keyframes hoof-step{50%{transform:translateY(-4px)}}
@keyframes van-exit{0%{transform:translate(0,-4px) scale(.43);opacity:0}10%{transform:translate(-2px,7px) scale(.47);opacity:1}35%{transform:translate(-11px,35px) scale(.58);opacity:1}80%{transform:translate(-29px,98px) scale(.85);opacity:1}96%,100%{transform:translate(-36px,116px) scale(.95);opacity:0}}
@media(prefers-reduced-motion:reduce){.jumper,.convoy,.ripple,.front-calf,.front-hoof{animation:none!important}.convoy{transform:translate(var(--park-x),var(--park-y)) scale(var(--park-scale))}}
.still .jumper,.still .convoy,.still .ripple{animation:none!important}.still .convoy{transform:translate(var(--park-x),var(--park-y)) scale(var(--park-scale))}
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

def front_calf():
    # Same blue scarf, cream/brown markings and round glasses, redrawn facing camera.
    return '''<g class="front-calf ink">
<ellipse cx="0" cy="2" rx="23" ry="4" fill="#776953" opacity=".17" stroke="none"/>
<g class="front-hoof"><path d="M-18-19l-1 17q7 6 14 0l-1-19" fill="#fff3d9"/><path d="M-19-5q6 3 14 0v5q-6 5-14 0z" fill="#685646"/></g>
<g class="front-hoof other"><path d="M6-19 5-2q7 6 14 0l-1-19" fill="#fff3d9"/><path d="M5-5q6 3 14 0v5q-6 5-14 0z" fill="#685646"/></g>
<path d="M-20-50q-14 12-10 26l10-2m39-24q14 12 11 26l-10-2" fill="#fff3d9"/>
<path d="M-22-48q-10 27 0 35 22 10 44 0 10-10 0-35z" fill="#fff8e6"/>
<path d="M-22-35q13-8 15 6-2 12-17 10m28-6q15-4 16 10l-13 2" fill="#99856a" stroke="none"/>
<path d="M-22-49q20 13 44 0l-2 10q-20 12-40 0zM-1-38l-8 16 16-4-1-13" fill="#82a9b1"/>
<path d="M-23-73q-25-11-19 3 6 10 19 5m46-8q25-11 19 3-6 10-19 5" fill="#fff0d1"/>
<path d="M-20-79q-16-4-12-17 4 10 16 9m32 0q13-1 16-11 5 15-12 19" fill="#d8c08c"/>
<path d="M-26-71q-1-21 26-21 27 0 26 21l2 21q-4 15-28 16-24-1-28-16z" fill="#fff8e6"/>
<path d="M-25-78q13-11 16 6-4 12-17 9" fill="#99856a" stroke="none"/>
<ellipse cx="0" cy="-49" rx="22" ry="13" fill="#e7bdaa"/>
<path d="M-9-51v2m18-2v2m-15 8q6 4 12 0" fill="none" stroke-width="1.8"/>
<g fill="none" stroke-width="2"><circle cx="-13" cy="-68" r="11"/><circle cx="13" cy="-68" r="11"/><path d="M-2-70h4"/></g>
<g class="eye" fill="#514737" stroke="none"><ellipse cx="-12" cy="-68" rx="2" ry="3"/><ellipse cx="12" cy="-68" rx="2" ry="3"/></g>
<path d="M-5-88l4-6 3 7 5-4" fill="#aa9471"/>
</g>'''

def scene(name):
    if name=='cow-truck':
        calves=''.join(f'<g transform="translate(248 214)"><g class="convoy" style="--arrival:-{i*1.5}s;--park-x:{-i*10}px;--park-y:{i*31}px;--park-scale:{.43+i*.14}">{front_calf()}</g></g>' for i in range(4))
        return f'''<ellipse cx="200" cy="247" rx="145" ry="29" fill="#d9d1bc" opacity=".4"/>
<g class="ink">
<!-- Rear-to-front roof, front face and near side form a compact three-quarter van. -->
<path d="M72 120 235 59q13-4 23 1l66 36q10 7 10 19v79L165 265 66 220v-77q0-15 6-23" fill="#94a68e"/>
<path d="M72 120 161 158 334 96 254 59q-8-4-19 0z" fill="#c0cdb4"/>
<path d="M72 120q-6 14-6 25v75l99 45v-88q0-15-4-19z" fill="#8c9f87"/>
<path d="M80 133 151 165v46l-78-33z" fill="#d3e4dc"/>
<path d="M87 140l21 9m-22 1 13 6" stroke="#f8fbef" stroke-width="3"/>
<path d="M87 174l20 8m20 1 16 7" fill="none" stroke="#6f8173"/>
<path d="M170 169 202 157v43l-32 13z" fill="#cfdfd5"/>
<path d="M67 211l98 43v11l-99-43z" fill="#677869"/>
<path d="M77 195l19 8v12l-19-9zm59 25 18 8v12l-18-8z" fill="#efd79e"/>
<path d="M103 213l23 10m-23-5 23 10" fill="none" stroke-width="2"/>
<ellipse cx="184" cy="252" rx="13" ry="20" transform="rotate(19 184 252)" fill="#5b554b"/>
<ellipse cx="184" cy="252" rx="6" ry="11" transform="rotate(19 184 252)" fill="#bdb79e"/>
<ellipse cx="313" cy="201" rx="12" ry="18" transform="rotate(19 313 201)" fill="#5b554b"/>
<ellipse cx="313" cy="201" rx="5" ry="9" transform="rotate(19 313 201)" fill="#bdb79e"/>
<!-- Open central sliding door, panel parked toward rear rather than a long ramp. -->
<path id="side-door" d="M211 152 276 127v85l-65 27z" fill="#4b6055"/>
<path d="M218 158 269 139v64l-51 21z" fill="#64766a" stroke="none"/>
<path d="M281 127 326 110v81l-45 18z" fill="#a8b99e"/>
<path d="M287 135 319 124v29l-32 12z" fill="#d6e2d4"/>
<path d="M286 178l8-3m-85-28 116-43" fill="none"/>
<path d="M211 230 276 204l10 7-67 29z" fill="#c8bb9b"/>
<path d="M219 240 286 213v5l-67 29z" fill="#7f8976"/>
</g>
{calves}'''
    if name=='leopard-jump':
        return f'''<path d="M312 166q-25 40-18 115h84q-12-55 18-115" fill="#d5e8e7"/>
<path d="M45 226q137-24 250 0m88 0q115-18 222 0" stroke="#a5b98c" stroke-width="3" fill="none"/>
<g class="ripple" stroke="#90bcbd" fill="none"><path d="M315 245h24m-11 15h28m-31-30h24"/></g>
<g transform="translate(86 38)"><g class="jumper">{leopard()}</g></g>
<text x="44" y="278" font-family="system-ui,sans-serif" font-size="13" fill="#7b806b">蓄力 → 跃起 → 落地 · 豹拉跳小河</text>'''
    return f'<ellipse cx="325" cy="210" rx="89" ry="5" fill="#e8dfc8"/><g transform="translate(205 13)">{leopard()}</g>'

for name,cls,title in [('leopard','idle','豹拉：站立张望'),('leopard-run','fast','豹拉：轻巧快跑'),('leopard-jump','jump','豹拉：跳过小河'),('cow-truck','truck','一车小牛下来帮忙')]:
    for still in [False,True]:
        (ROOT/f'{name}-mascots{"-still" if still else ""}.svg').write_text(f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {400 if name=='cow-truck' else 640} {360 if name=='cow-truck' else 300 if name=='leopard-jump' else 240}" role="img" aria-labelledby="title desc" class="{cls} {'still' if still else ''}" style="--step:.38s"><title id="title">{title}</title><desc id="desc">与牛马同系列的原创 SVG 小样，支持减少动态效果。</desc><style>{STYLE}{VAN_STYLE if name=='cow-truck' else ''}</style>{scene(name)}</svg>''')
