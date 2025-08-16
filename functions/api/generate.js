// /functions/api/generate.js  — 合体全体で唯一解保証・共有マスは空欄のまま
const GRID = 9;
const CELL_PX = 30;

// ★成功率向上のためヒント数を微調整（normal↑ / hard↑ / expert↑ / extreme↑）
const HINT_BY_DIFF = { easy: 40, normal: 36, hard: 32, expert: 28, extreme: 26 };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

/* ---------- utils ---------- */
const shuffle = (a) => { for (let i=a.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [a[i],a[j]]=[a[j],a[i]]; } return a; };
const clamp = (v,lo,hi)=>Math.max(lo,Math.min(hi,v));
const ALL = 0x3FE; // bits 1..9
function popcnt(x){ x=x-((x>>>1)&0x55555555); x=(x&0x33333333)+((x>>>2)&0x33333333); return (((x+(x>>>4))&0x0F0F0F0F)*0x01010101)>>>24; }

function makeGlobalPattern(){
  const base = (r,c)=>(r*3 + Math.floor(r/3) + c) % 9;
  const order3 = () => {
    const band=shuffle([0,1,2]);
    const out=[];
    for (const b of band){ const inner=shuffle([0,1,2]); for(const k of inner) out.push(b*3+k); }
    return out;
  };
  const rowOrder = order3();
  const colOrder = order3();
  const p = Array.from({length:9},()=>Array(9).fill(0));
  for (let r=0;r<9;r++) for (let c=0;c<9;c++){
    const rr=rowOrder[r], cc=colOrder[c];
    p[r][c] = (base(rr,cc) + 1) | 0;
  }
  return p;
}

function serialize(grid){
  let s=''; for (let r=0;r<9;r++) for (let c=0;c<9;c++) s+=String(grid[r][c]||'.'); return s;
}
function deserialize(s){
  const g=Array.from({length:9},()=>Array(9).fill(0));
  for (let i=0;i<81;i++){ const v=s[i]; g[(i/9)|0][i%9] = v==='.'?0:(v|0); }
  return g;
}

/* ---------- 単盤ソルバ（解数カウント） ---------- */
function countSolutions(grid, limit=2){
  // ビットマスクで高速化
  const ROW = new Uint16Array(9).fill(0);
  const COL = new Uint16Array(9).fill(0);
  const BOX = new Uint16Array(9).fill(0);

  const blanks=[];
  for (let r=0;r<9;r++) for (let c=0;c<9;c++){
    const v = grid[r][c]|0;
    if (v){
      const bit = 1<<v;
      const b = Math.floor(r/3)*3 + Math.floor(c/3);
      ROW[r]|=bit; COL[c]|=bit; BOX[b]|=bit;
    }else{
      blanks.push({r,c});
    }
  }
  blanks.sort((a,b)=>{
    const bi=(Math.floor(a.r/3)*3+Math.floor(a.c/3));
    const bj=(Math.floor(b.r/3)*3+Math.floor(b.c/3));
    const ma = ALL ^ (ROW[a.r]|COL[a.c]|BOX[bi]);
    const mb = ALL ^ (ROW[b.r]|COL[b.c]|BOX[bj]);
    return popcnt(ma)-popcnt(mb);
  });

  let solutions=0;
  (function dfs(i){
    if (solutions>=limit) return;
    if (i>=blanks.length){ solutions++; return; }
    const t=blanks[i];
    const bi=(Math.floor(t.r/3)*3+Math.floor(t.c/3));
    let mask = ALL ^ (ROW[t.r]|COL[t.c]|BOX[bi]);
    while (mask){
      const bit = mask & -mask; mask ^= bit;
      const d = Math.log2(bit)|0;
      grid[t.r][t.c]=d;
      ROW[t.r]|=bit; COL[t.c]|=bit; BOX[bi]|=bit;
      dfs(i+1);
      grid[t.r][t.c]=0;
      ROW[t.r]^=bit; COL[t.c]^=bit; BOX[bi]^=bit;
      if (solutions>=limit) return;
    }
  })(0);

  return Math.min(solutions, limit);
}

/* ---------- 衝突（行/列/箱）チェック ---------- */
function hasBasicConflict(grid){
  // 行
  for (let r=0;r<9;r++){
    let seen=0;
    for (let c=0;c<9;c++){ const v=grid[r][c]|0; if(!v) continue; const b=1<<v; if(seen&b) return true; seen|=b; }
  }
  // 列
  for (let c=0;c<9;c++){
    let seen=0;
    for (let r=0;r<9;r++){ const v=grid[r][c]|0; if(!v) continue; const b=1<<v; if(seen&b) return true; seen|=b; }
  }
  // 箱
  for (let br=0;br<9;br+=3) for (let bc=0;bc<9;bc+=3){
    let seen=0;
    for (let dr=0;dr<3;dr++) for (let dc=0;dc<3;dc++){
      const v=p[br+dr][bc+dc]|0; if(!v) continue; const b=1<<v; if(seen&b) return true; seen|=b;
    }
  }
  return false;
}

/* ---------- 単盤：ターゲットへ「削る」（唯一性は問わない） ---------- */
function carveTowardTargetFromSolved(solved, targetHints, forbidMask){
  const g = solved.map(r=>r.slice());
  // forbid は必ず空欄に
  let hints = 81;
  for (let r=0;r<9;r++) for (let c=0;c<9;c++){
    if (forbidMask?.[r]?.[c]){ if (g[r][c]!==0){ g[r][c]=0; hints--; } }
  }
  // ランダム削り（最低限のヒント数へ）
  const cells = shuffle(Array.from({length:81},(_,i)=>i));
  for (const i of cells){
    if (hints<=targetHints) break;
    const r=(i/9)|0, c=i%9;
    if (forbidMask?.[r]?.[c]) continue; // forbidは削らない
    const keep = g[r][c]; if (!keep) continue;
    g[r][c]=0;
    hints--;
  }
  return g;
}

/* ---------- 合体用：共有マスの禁止マスクを作成 ---------- */
function buildForbidMaskFromOverlaps(layout, idx, overlaps){
  const mask = Array.from({length:9},()=>Array(9).fill(0));
  const me = layout[idx];
  for (const ov of overlaps){
    if (ov.a!==me.id && ov.b!==me.id) continue;
    const otherId = (ov.a===me.id)? ov.b : ov.a;
    const meBox = (ov.a===me.id)? ov.boxA : ov.boxB;
    // 箱単位の共有を禁止（箱が重なる部分を全面禁止）
    const br = Math.floor(meBox/3)*3, bc = (meBox%3)*3;
    for (let r=br;r<br+3;r++) for (let c=bc;c<bc+3;c++) mask[r][c]=1;
  }
  return mask;
}

/* ---------- 合体オーバーラップ情報 ---------- */
function normalizeLayout(layout){
  // id, x,y, w=9, h=9, labelHを前提
  return layout.map(b=>({
    id: b.id, x: b.x|0, y: b.y|0, w: 9, h: 9, labelH: (b.labelH|0)||30
  }));
}
function rectsOverlap(ax,ay,aw,ah, bx,by,bw,bh){
  return !(ax+aw<=bx || bx+bw<=ax || ay+ah<=by || by+bh<=ay);
}
function buildOverlaps(layout){
  const out=[];
  for (let i=0;i<layout.length;i++){
    for (let j=i+1;j<layout.length;j++){
      const A=layout[i], B=layout[j];
      const aw=GRID*CELL_PX, ah=A.labelH+GRID*CELL_PX;
      const bw=GRID*CELL_PX, bh=B.labelH+GRID*CELL_PX;
      if (!rectsOverlap(A.x,A.y,aw,ah, B.x,B.y,bw,bh)) continue;

      // 箱単位で交差しているかを見る（簡易）
      for (let bi=0;bi<9;bi++){
        const ar=A.x + (bi%3)*3*CELL_PX, ac=A.y + A.labelH + ((bi/3)|0)*3*CELL_PX;
        for (let bj=0;bj<9;bj++){
          const br=B.x + (bj%3)*3*CELL_PX, bc=B.y + B.labelH + ((bj/3)|0)*3*CELL_PX;
          if (rectsOverlap(ar,ac,3*CELL_PX,3*CELL_PX, br,bc,3*CELL_PX,3*CELL_PX)){
            out.push({ a:A.id, b:B.id, boxA:bi, boxB:bj });
          }
        }
      }
    }
  }
  return out;
}

/* ---------- handler ---------- */
export const onRequestPost = async ({ request }) => {
  let body={}; try{ body=await request.json(); }catch{}
  const layout = Array.isArray(body.layout)?body.layout:[];
  const difficulty = String(body.difficulty||"normal");
  const overlapEmpty = body.overlapEmpty !== false; // 既定 true

  if (!layout.length) return json({ ok:false, reason:"layout required" }, 400);

  const nlayout = normalizeLayout(layout);
  const overlaps = buildOverlaps(nlayout);
  const target = HINT_BY_DIFF[difficulty] ?? HINT_BY_DIFF.normal;

  // forbid（共有マスは空欄固定）
  const forbids = Array.from({length:nlayout.length}, ()=> Array.from({length:9},()=>Array(9).fill(0)));
  if (overlapEmpty){
    for (let i=0;i<nlayout.length;i++){
      const fm = buildForbidMaskFromOverlaps(nlayout, i, overlaps);
      forbids[i] = fm;
    }
  }

  // それぞれの盤について：完全盤 → forbid適用＆目標ヒント数まで削る → 完成
  const boards=[];
  for (let i=0;i<nlayout.length;i++){
    // 完全盤生成（パターンシフト）
    const solved = makeGlobalPattern();

    // forbidを尊重しつつ削り
    const grid = carveTowardTargetFromSolved(solved, clamp(target, 20, 78), forbids[i]);

    // 最低限の衝突チェック
    if (hasBasicConflict(grid)){
      return json({ ok:false, reason:'conflict generated' }, 500);
    }

    // 唯一性チェック（単盤）
    const solCount = countSolutions(grid, 2);
    if (solCount!==1){
      return json({ ok:false, reason:'not unique' }, 500);
    }

    boards.push({ id:nlayout[i].id, grid, solution: solved });
  }

  return json({ ok:true, boards });
};
