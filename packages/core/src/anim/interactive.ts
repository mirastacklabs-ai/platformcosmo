/**
 * Interactive mode: Play/Pause/Step controls and a small DOM-only script. Only works when the SVG
 * is inlined in a page (scripts do not run in `<img>`). Nothing from the spec reaches the script:
 * it holds ids derived from the id prefix and numbers.
 */
import type { Rect, SvgElement } from "../contracts/index.js";
import { el, r2, t4 } from "./css.js";

export interface ControlIds {
  readonly root: string;
  readonly group: string;
  readonly play: string;
  readonly step: string;
}

export function controlIds(prefix: string, root: string): ControlIds {
  return {
    root,
    group: `${prefix}_controls`,
    play: `${prefix}_btn_play`,
    step: `${prefix}_btn_step`,
  };
}

const BTN_W = 60;
const BTN_H = 22;
const GAP = 8;

function button(id: string, cls: string, label: string, x: number, y: number): SvgElement {
  return el(
    "g",
    {
      id,
      class: cls,
      role: "button",
      tabindex: 0,
      "aria-label": label,
      transform: `translate(${r2(x)},${r2(y)})`,
    },
    [
      el("rect", { width: BTN_W, height: BTN_H, rx: 4 }),
      el("text", { x: BTN_W / 2, y: 15, "text-anchor": "middle" }, [label]),
    ],
  );
}

/**
 * Control nodes for the `overlay` layer (bottom-left of the view box). The layer sits inside the
 * camera group, so under zoom the controls carry the inverse of the camera keyframes (same
 * timing, same easing) and stay put on screen; transform values are rounded to 4 decimals, so
 * they can drift by far less than a pixel mid-transition.
 */
export function controlNodes(prefix: string, ids: ControlIds, viewBox: Rect): SvgElement {
  const cls = `${prefix}_btn`;
  const y = viewBox.y + viewBox.height - BTN_H - 12;
  const x = viewBox.x + 12;
  return el("g", { id: ids.group, role: "group", "aria-label": "Animation controls" }, [
    button(ids.play, cls, "Pause", x, y),
    button(ids.step, cls, "Step", x + BTN_W + GAP, y),
  ]);
}

export function controlCss(prefix: string): string {
  const b = `.${prefix}_btn`;
  return [
    `${b}{cursor:pointer;outline:none}`,
    `${b} rect{fill:var(--pc-metric-fill);stroke:var(--pc-metric-stroke);stroke-width:1}`,
    `${b}:hover rect,${b}:focus rect{stroke-width:2}`,
    `${b} text{fill:var(--pc-metric-value);font-family:var(--pc-font-family);font-size:11px;pointer-events:none}`,
  ].join("\n");
}

/**
 * `starts` are per-step start seconds; `targets` where Step pauses for each step: its start, except
 * step 1, whose view is reached only after the opening ease (the loop starts on the overview).
 * `total` is the loop length.
 */
export function interactiveScript(
  ids: ControlIds,
  starts: readonly number[],
  targets: readonly number[],

  total: number,
): string {
  const nums = (a: readonly number[]) => `[${a.map(t4).join(",")}]`;
  return `(function(){
var svg=document.getElementById(${JSON.stringify(ids.root)});
var play=document.getElementById(${JSON.stringify(ids.play)});
var step=document.getElementById(${JSON.stringify(ids.step)});
if(!svg||!play||!step||!svg.getAnimations)return;
var S=${nums(starts)},G=${nums(targets)},T=${t4(total)},playing=true;
var label=play.getElementsByTagName("text")[0];
function anims(){return svg.getAnimations({subtree:true}).filter(function(a){return a.animationName!==undefined;});}
function isParticle(a){var t=a.effect&&a.effect.target;return !!t&&t.tagName==="circle";}
function now(){var l=anims(),a=l.filter(function(x){return !isParticle(x);})[0]||l[0];return a&&T>0?((a.currentTime/1000)%T+T)%T:0;}
function index(){var t=now(),k=0;for(var i=0;i<S.length;i++)if(t>=S[i])k=i;return k;}
function seek(t){anims().forEach(function(a){a.currentTime=t*1000;});if(svg.setCurrentTime)svg.setCurrentTime(t);}
function set(p){
playing=p;
anims().forEach(function(a){if(p)a.play();else a.pause();});
if(p){if(svg.unpauseAnimations)svg.unpauseAnimations();}else if(svg.pauseAnimations)svg.pauseAnimations();
if(label)label.textContent=p?"Pause":"Play";
play.setAttribute("aria-label",p?"Pause":"Play");
}
function onStep(){
if(!S.length)return;
set(false);
seek(G[(index()+1)%S.length]);
}
function bind(node,fn){
node.addEventListener("click",fn);
node.addEventListener("keydown",function(e){if(e.key==="Enter"||e.key===" "){e.preventDefault();fn();}});
}
bind(play,function(){set(!playing);});
bind(step,onStep);
})();`;
}
