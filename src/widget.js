import zlib from 'node:zlib';
import { pad2, truncate } from './util.js';

// 0.14.0: полный список завершённого за неделю — виджетом Telegram (Bot API 10.4, sendWidget): маленькая страница HTML прямо
// в сообщении. Правила виджетов: один документ без сети и внешних файлов, не больше 32768 байт и 4096 байт после сжатия zlib,
// высота до 600 точек без прокрутки, из органов управления — только кнопки. Поэтому список листается кнопками по PER_PAGE пунктов.

const RAW_MAX = 32000; const PACKED_MAX = 3900; // запас к 32768 и 4096: zlib в Node считает на десятки байт иначе, чем сервер
const PER_PAGE = 4; // пунктов на странице: с названием и пользой в две строки это около 450 точек при ширине 320
const dm = (d) => `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}`;
const esc = (t) => String(t ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Размер, как его считает сервер Telegram: zlib, уровень 9. */
export const packedSize = (html) => zlib.deflateSync(Buffer.from(html, 'utf8'), { level: 9 }).length;

const STYLE = 'body{margin:0;padding:10px 12px calc(10px + env(safe-area-inset-bottom))}'
  + '.h{color:var(--tg-theme-hint-color);font-size:.9em}'
  + '.b{height:6px;border-radius:3px;background:var(--tg-theme-secondary-bg-color);overflow:hidden;margin:4px 0 10px}'
  + '.b i{display:block;height:100%;background:var(--tg-theme-button-color)}'
  + '.t,.n{display:flex;gap:6px;align-items:center;margin:8px 0}button{flex:1}'
  + '.o{background:var(--tg-theme-secondary-bg-color);color:var(--tg-theme-text-color)}'
  + '.i{margin:0 0 10px}.i b,.i span{display:block}.i span{color:var(--tg-theme-hint-color);font-size:.9em}'
  + '.n span{flex:1;text-align:center;color:var(--tg-theme-hint-color)}.n button{white-space:nowrap}';
// Код виджета: D — группы [название, [[пункт, польза], …]], g — открытая группа, k — страница
const SCRIPT = (groups) => `var D=${JSON.stringify(groups).replace(/</g, '\\u003c')},g=0,k=0,P=${PER_PAGE},$=function(i){return document.getElementById(i)};`
  + 'function e(s){return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;")}'
  + 'function r(){var a=D[g][1],n=Math.ceil(a.length/P)||1;'
  + '$("t").innerHTML=D.length<2?"":D.map(function(d,i){return"<button"+(i==g?"":" class=o")+" data-g="+i+">"+e(d[0])+" · "+d[1].length+"</button>"}).join("");'
  + '$("l").innerHTML=a.slice(k*P,k*P+P).map(function(x){return"<div class=i><b>"+e(x[0])+"</b>"+(x[1]?"<span>"+e(x[1])+"</span>":"")+"</div>"}).join("");'
  + '$("c").textContent=(k+1)+" из "+n;$("p").disabled=!k;$("x").disabled=k>=n-1;$("n").hidden=n<2}'
  + '$("t").addEventListener("click",function(v){var i=v.target.dataset.g;if(i!=null){g=+i;k=0;r()}});'
  + '$("p").addEventListener("click",function(){if(k){k--;r()}});$("x").addEventListener("click",function(){k++;r()});r()';

function page(data, groups) {
  const g = data.goals;
  const goals = g ? `<div class=h>Цели: сделано ${g.done} из ${g.total}${g.delta > 0 ? ` · +${g.delta} за неделю` : ''}</div><div class=b><i style="width:${Math.round((g.done / g.total) * 100)}%"></i></div>` : '';
  return `<style>${STYLE}</style><b>Итоги недели · ${dm(data.since)}–${dm(data.now)}</b>${goals}`
    + `<div class=t id=t></div><div id=l></div><div class=n id=n><button id=p>‹ Назад</button><span id=c></span><button id=x>Дальше ›</button></div><script>${SCRIPT(groups)}</script>`;
}

/**
 * Виджет «Итоги недели» из weeklyData: все завершённые изменения двумя вкладками — «Новое» (заметные возможности) и «Доработки»
 * (исправления и то, чего снаружи не видно), у каждого пункта название и польза. Возвращает { html, caption, total, shown } или null,
 * если показывать нечего. Не влезает в предел размера — сначала укорачивается польза, потом отбрасываются самые старые пункты
 * (shown < total; сколько не показано — в подписи).
 */
export function weeklyWidget(data, cfg) {
  const items = data.items || [];
  if (!items.length) return null;
  const build = (clip, keep) => {
    const list = items.slice(items.length - keep).reverse(); // свежие сверху
    const row = (x) => [truncate(x.title, 70), clip ? truncate(x.benefit || '', clip) : ''];
    const groups = [['Новое', list.filter((x) => x.notable).map(row)], ['Доработки', list.filter((x) => !x.notable).map(row)]].filter(([, a]) => a.length);
    return page(data, groups);
  };
  const fits = (html) => Buffer.byteLength(html) <= RAW_MAX && packedSize(html) <= PACKED_MAX;
  let html = ''; let shown = items.length;
  for (const clip of [140, 100, 70, 0]) { html = build(clip, shown); if (fits(html)) break; }
  while (!fits(html) && shown > 1) { shown -= 1; html = build(0, shown); }
  if (!fits(html)) return null;
  const caption = `📋 ${esc(cfg.project)}: все изменения недели — ${items.length}${shown < items.length ? ` (в списке последние ${shown})` : ''}`;
  return { html, caption, total: items.length, shown };
}

/**
 * Тот же список расширенным сообщением (Bot API 10.1, sendRichMessage, разметка HTML): заголовок, строка целей и два сворачиваемых
 * раздела; внутри — нумерованный список: название жирным, под ним польза (всё раскрыто сразу). Пределы Telegram — 32768 знаков
 * и 500 блоков; лишние (самые старые) пункты отбрасываются с пометкой.
 */
export function weeklyRichHtml(data, cfg) {
  const all = [...(data.items || [])].reverse();
  const items = all.slice(0, 200);
  // Пункт — строка нумерованного списка: название жирным, польза под ним в той же строке списка — видно, что к чему относится
  const one = (x) => `<li><b>${esc(x.title)}</b>${x.benefit ? `<br>${esc(truncate(x.benefit, 300))}` : ''}</li>`;
  const part = (title, list, open) => (list.length ? `<details${open ? ' open' : ''}><summary><b>${title} · ${list.length}</b></summary><ol>${list.map(one).join('')}</ol></details>` : '');
  const g = data.goals;
  return `<h3>📋 ${esc(cfg.project)} · итоги недели ${dm(data.since)}–${dm(data.now)}</h3>`
    + `<p>Завершено изменений: ${all.length}${items.length < all.length ? ` (в списке последние ${items.length})` : ''}.${g ? ` Цели: сделано ${g.done} из ${g.total}${g.delta > 0 ? `, +${g.delta} за неделю` : ''}.` : ''}</p>`
    + part('Новое', items.filter((x) => x.notable), true) + part('Исправления и доработки', items.filter((x) => !x.notable), false)
    + '<footer>Раздел сворачивается и раскрывается нажатием на его заголовок.</footer>';
}

/** Тот же список обычным текстом (HTML Telegram) — когда виджет и расширенное сообщение не приняты или выключены. */
export function weeklyListHtml(data, cfg) {
  const items = [...(data.items || [])].reverse();
  if (!items.length) return '';
  const line = (x) => `• <b>${esc(x.title)}</b>${x.benefit ? ` — ${esc(truncate(x.benefit, 160))}` : ''}`;
  const fresh = items.filter((x) => x.notable); const other = items.filter((x) => !x.notable);
  return [`📋 <b>${esc(cfg.project)}</b> · все изменения недели (${items.length})`,
    ...(fresh.length ? ['', `<b>Новое (${fresh.length})</b>`, ...fresh.map(line)] : []),
    ...(other.length ? ['', `<b>Исправления и доработки (${other.length})</b>`, ...other.map(line)] : [])].join('\n');
}
