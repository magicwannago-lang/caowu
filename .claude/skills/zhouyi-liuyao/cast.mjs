#!/usr/bin/env node
// 周易铜钱起卦：六掷，每掷三枚铜钱。
// 铜钱：字(正面)=2，背(反面)=3。和 6/7/8/9 对应：
//   6 老阴 ×（阴动，变阳）  7 少阳
//   8 少阴                 9 老阳 ○（阳动，变阴）
// 用法：node cast.mjs            随机起卦
//       node cast.mjs 323 233 ... 给定六掷结果（每枚 2 或 3，初爻在前）
//       node cast.mjs --lines 9 8 7 6 8 7   直接给六爻 6/7/8/9
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

// 上卦 × 下卦（顺序：乾兑离震巽坎艮坤）
const TRI = ['乾', '兑', '离', '震', '巽', '坎', '艮', '坤'];
// 行＝上卦，列＝下卦（序：乾兑离震巽坎艮坤）
const TABLE = {
  乾: ['乾为天', '天泽履', '天火同人', '天雷无妄', '天风姤', '天水讼', '天山遁', '天地否'],
  兑: ['泽天夬', '兑为泽', '泽火革', '泽雷随', '泽风大过', '泽水困', '泽山咸', '泽地萃'],
  离: ['火天大有', '火泽睽', '离为火', '火雷噬嗑', '火风鼎', '火水未济', '火山旅', '火地晋'],
  震: ['雷天大壮', '雷泽归妹', '雷火丰', '震为雷', '雷风恒', '雷水解', '雷山小过', '雷地豫'],
  巽: ['风天小畜', '风泽中孚', '风火家人', '风雷益', '巽为风', '风水涣', '风山渐', '风地观'],
  坎: ['水天需', '水泽节', '水火既济', '水雷屯', '水风井', '坎为水', '水山蹇', '水地比'],
  艮: ['山天大畜', '山泽损', '山火贲', '山雷颐', '山风蛊', '山水蒙', '艮为山', '山地剥'],
  坤: ['地天泰', '地泽临', '地火明夷', '地雷复', '地风升', '地水师', '地山谦', '坤为地'],
};
// 三爻自下而上的阴阳（1 阳 0 阴）→ 八卦序号
const TRI_CODE = [[1, 1, 1], [1, 1, 0], [1, 0, 1], [1, 0, 0],
                  [0, 1, 1], [0, 1, 0], [0, 0, 1], [0, 0, 0]];

function triIndex(code) {
  const b = code.map(Number);
  return TRI_CODE.findIndex(c => c[0] === b[0] && c[1] === b[1] && c[2] === b[2]);
}

function castLine(arg) {
  if (arg) {
    const coins = arg.split('').map(Number);
    if (coins.length !== 3 || coins.some(c => c !== 2 && c !== 3)) {
      throw new Error(`每掷须是三位 2/3，收到：${arg}`);
    }
    return coins.reduce((a, b) => a + b, 0);
  }
  // crypto 真随机，每枚铜钱 2 或 3
  const r = new Uint8Array(3);
  globalThis.crypto.getRandomValues(r);
  return [...r].map(x => (x & 1) ? 2 : 3).reduce((a, b) => a + b, 0);
}

const args = process.argv.slice(2);
let lines;
if (args[0] === '--lines') {
  lines = args.slice(1, 7).map(Number);
  if (lines.length !== 6 || lines.some(v => ![6, 7, 8, 9].includes(v))) {
    throw new Error('--lines 后须给六个 6/7/8/9');
  }
} else {
  lines = Array.from({length: 6}, (_, i) => castLine(args[i]));
}

const yangNow = lines.map(v => v === 7 || v === 9);      // 本卦
const yangBian = lines.map(v => v === 6 || v === 7);     // 变卦（6→阳 9→阴）
const moving = lines.map((v, i) => (v === 6 || v === 9) ? i + 1 : 0).filter(Boolean);

const lower = triIndex(yangNow.slice(0, 3));
const upper = triIndex(yangNow.slice(3, 6));
const name = TABLE[TRI[upper]][lower];

let bianName = null;
if (moving.length) {
  const lb = triIndex(yangBian.slice(0, 3));
  const ub = triIndex(yangBian.slice(3, 6));
  bianName = TABLE[TRI[ub]][lb];
}

// 干支历（北京时间，月以节气近似——精确排盘请核对当日真实节气与日柱）
const now = new Date();
const gan = '甲乙丙丁戊己庚辛壬癸', zhi = '子丑寅卯辰巳午未申酉戌亥';
const dayIdx = Math.floor((Date.now() - Date.UTC(1900, 0, 1)) / 86400000) + 10;
const dayGanZhi = gan[((dayIdx % 10) + 10) % 10] + zhi[((dayIdx % 12) + 12) % 12];
const monthZhi = zhi[(now.getMonth() + 3) % 12]; // 寅月≈立春所在公历2月

const yaoNames = ['初', '二', '三', '四', '五', '上'];
const detail = lines.map((v, i) => ({
  pos: yaoNames[i],
  value: v,
  kind: ({6: '老阴×', 7: '少阳', 8: '少阴', 9: '老阳○'})[v],
  moving: v === 6 || v === 9,
}));

const zhouyi = JSON.parse(readFileSync(join(here, 'data/zhouyi.json'), 'utf8'));
const gua = zhouyi[name];
const text = {
  cast_at: now.toISOString().slice(0, 19).replace('T', ' ') + ' UTC',
  month_zhi: monthZhi, day_ganzhi: dayGanZhi,
  hexagram: name, bian: bianName, moving,
  lines: detail,
  gua_ci: gua?.gua_ci ?? null,
  yao_ci: moving.length === 1 ? gua?.yao?.[`${yaoNames[moving[0] - 1]}${yangNow[moving[0] - 1] ? '九' : '六'}`] ?? null : null,
};
console.log(JSON.stringify(text, null, 2));
