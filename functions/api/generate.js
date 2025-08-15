// 最小生成版：完成盤1枚のみ（固定/重なり/問題化なし）
export const onRequestPost = async (context) => {
  try {
    const { request } = context;
    const body = await request.json().catch(() => ({}));
    const layout = Array.isArray(body.layout) ? body.layout : [{ id:"a", x:0, y:0 }];

    // タイムアウト（安全）
    const start = Date.now();
    const TIMEOUT = 3500;
    const deadline = () => Date.now() - start > TIMEOUT;

    // 完成盤生成
    const solved = makeSolvedSudokuWithFixed([], deadline);
    if (!solved) throw new Error("failed_generate_minimal");

    // レイアウトのid/x/yだけ反映して返す
    const boards = layout.slice(0,1).map(b => ({ id:b.id, x:b.x, y:b.y, grid: solved }));
    return j({ ok:true, puzzle:{ boards }, kind:"minimal-solved" });
  } catch (e) {
    return j({ ok:false, reason:"exception", message:String(e&&e.message||e) }, 500);
  }
};

function j(d,s=200){ return new Response(JSON.stringify(d),{status:s,headers:{'content-type':'application/json'}}); }

// 完成盤（固定なし）生成
function makeSolvedSudokuWithFixed(fixedCells, deadline){
  const g = Array.from({length:9},()=>Array(9).fill(0));
  // 固定（今回は空配列）
  for(const f of fixedCells){ if(!place(g,f.r,f.c,f.val)) return null; }
  const cells=[]; for(let r=0;r<9;r++)for(let c=0;c<9;c++) if(g[r][c]===0) cells.push([r,c]);
  shuffle(cells);
  function dfs(i){
    if (deadline()) return false;
    if (i===cells.length) return true;
    const [r,c]=cells[i]; const nums=[1,2,3,4,5,6,7,8,9]; shuffle(nums);
    for(const v of nums){ if(canPlace(g,r,c,v)){ g[r][c]=v; if(dfs(i+1)) return true; g[r][c]=0; } }
    return false;
  }
  return dfs(0)?g:null;
}
function canPlace(g,r,c,v){ for(let i=0;i<9;i++) if(g[r][i]===v||g[i][c]===v) return false;
  const br=Math.floor(r/3)*3, bc=Math.floor(c/3)*3;
  for(let i=0;i<3;i++) for(let j=0;j<3;j++) if(g[br+i][bc+j]===v) return false; return true; }
function place(g,r,c,v){ if(!canPlace(g,r,c,v)) return false; g[r][c]=v; return true; }
function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [a[i],a[j]]=[a[j],a[i]]; } }
