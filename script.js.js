
// script.js — drop-in replacement
// Minimal-risk patch: adds Pointer Events so boards can be moved on mobile.
// Other logic stays the same as before.
//
// Features kept:
// - Multiple boards layout (9x9 each), snap move (x=1 cell, y=3 cells)
// - Pan/zoom (mouse: wheel+Ctrl / buttons optional), status text
// - Server generation POST /api/generate (expects {ok:true, boards:[...] } or {ok:true, puzzle:{boards}})
// - Export JSON
// - Export PNG (problem & solution) with clean borders
// - Check conflicts + show solution toggle
//
// If your HTML has different button IDs, this script tries to find alternates where possible.

(() => {
  document.addEventListener('DOMContentLoaded', () => {
    // ===== DOM =====
    const byId = (id) => document.getElementById(id) || null;

    const canvas = byId('canvas');
    if (!canvas) { console.error('canvas#canvas not found'); return; }
    const ctx = canvas.getContext('2d', { alpha: false });
    // IMPORTANT for touch dragging: prevent browser scrolling/zoom gestures over the canvas area
    canvas.style.touchAction = 'none';

    const statusDiv = byId('status');
    const addSquareButton = byId('addSquareButton');
    const deleteButton = byId('deleteButton');
    const clearAllBoardsButton = byId('clearAllBoardsButton');
    const generateProblemButton = byId('generateProblemButton');
    const checkButton = byId('checkButton');
    const solveButton = byId('solveButton');
    const exportTextButton = byId('exportTextButton');
    const exportImageButton = byId('exportImageAllButton') || byId('saveAllPngButton');
    const difficultySel = byId('difficulty');
    const zoomOutBtn = byId('zoomOut'), zoomInBtn = byId('zoomIn');
    const zoomResetBtn = byId('zoomReset'), zoomFitBtn = byId('zoomFit'), zoomPct = byId('zoomPct');

    // ===== Constants =====
    const GRID = 9;
    const CELL = 30;
    const BOARD = GRID * CELL;
    const SNAP_X = CELL;
    const SNAP_Y = CELL * 3; // vertical snap = 3 rows

    const MIN_ZOOM = 0.3, MAX_ZOOM = 3, ZOOM_STEP = 1.15;
    const FONT = '18px system-ui,-apple-system,Segoe UI,Roboto,sans-serif';

    // ===== State =====
    let squares = []; // {id,x,y,w,h,problemData,userData,solution,checkData}
    let activeSquareId = null;
    let showSolution = false;
    let isGenerated = false;

    // Viewport
    const DPR = window.devicePixelRatio || 1;
    let zoom = 1, panX = 40, panY = 40;

    // Interaction
    let dragging = null;   // {id, dx, dy}
    let panning = false;
    let panStart = null;   // {mx,my, px,py}
    let isSpaceDown = false;

    // ===== Utils =====
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const newGrid = () => Array.from({length:GRID}, () => Array(GRID).fill(0));
    const cloneGrid = (g) => g.map(r => r.slice());
    const setStatus = (m) => { if (statusDiv) statusDiv.textContent = m; };

    function toWorld(mx,my){ return { x:(mx - panX)/zoom, y:(my - panY)/zoom }; }
    function applyTransform(){ ctx.setTransform(DPR*zoom,0,0,DPR*zoom, DPR*panX, DPR*panY); }

    function contentBounds(){
      if (!squares.length) return {minX:0,minY:0,maxX:1,maxY:1};
      let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
      for(const s of squares){
        minX=Math.min(minX,s.x); minY=Math.min(minY,s.y);
        maxX=Math.max(maxX,s.x+s.w); maxY=Math.max(maxY,s.y+s.h);
      }
      return {minX,minY,maxX,maxY};
    }

    function nextId(){ let m=0; for(const s of squares)m=Math.max(m, +s.id||0); return String(m+1); }

    // ===== Boards =====
    function addSquare(x=0,y=0){
      const s = {
        id: nextId(), x: Math.round(x/CELL)*CELL, y: Math.round(y/(CELL*3))*CELL*3,
        w: BOARD, h: BOARD,
        problemData: newGrid(), userData: newGrid(), solution: null, checkData: newGrid()
      };
      squares.push(s); activeSquareId = s.id; isGenerated = false; showSolution = false;
      draw(); updateButtons();
    }
    function deleteActive(){
      if (!activeSquareId) return;
      squares = squares.filter(s => String(s.id)!==String(activeSquareId));
      activeSquareId = squares.length ? squares[squares.length-1].id : null;
      draw(); updateButtons();
    }
    function clearAll(){
      squares = []; activeSquareId = null; isGenerated=false; showSolution=false;
      draw(); updateButtons();
    }
    function hitSquare(wx,wy){
      for(let i=squares.length-1;i>=0;i--){
        const s=squares[i]; if (wx>=s.x && wx<=s.x+s.w && wy>=s.y && wy<=s.y+s.h) return s;
      } return null;
    }

    // ===== Drawing =====
    function strokeRectCrisp(g, x,y,w,h, lineWidth, color){
      g.save();
      g.strokeStyle=color; g.lineWidth=lineWidth; g.lineCap='butt'; g.lineJoin='miter';
      const off = (Math.round(lineWidth)%2===1) ? .5 : 0;
      const L=x+off,T=y+off,R=x+w-off,B=y+h-off;
      g.beginPath(); g.moveTo(L,T); g.lineTo(R,T); g.stroke();
      g.beginPath(); g.moveTo(R,T); g.lineTo(R,B); g.stroke();
      g.beginPath(); g.moveTo(R,B); g.lineTo(L,B); g.stroke();
      g.beginPath(); g.moveTo(L,B); g.lineTo(L,T); g.stroke();
      g.restore();
    }

    function drawBoard(s){
      const isActive = String(s.id)===String(activeSquareId);

      // Fine grid
      ctx.lineWidth=1; ctx.strokeStyle='#bbb';
      for(let i=1;i<GRID;i++){
        const gx=s.x+i*CELL, gy=s.y+i*CELL;
        ctx.beginPath(); ctx.moveTo(gx+.5, s.y); ctx.lineTo(gx+.5, s.y+s.h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(s.x, gy+.5); ctx.lineTo(s.x+s.w, gy+.5); ctx.stroke();
      }

      // Bold 3x3 grid (avoid 0/GRID overlap; integer coords)
      ctx.lineWidth=2; ctx.strokeStyle='#000';
      for(let i=3;i<GRID;i+=3){
        const gx=s.x+i*CELL, gy=s.y+i*CELL;
        ctx.beginPath(); ctx.moveTo(gx, s.y); ctx.lineTo(gx, s.y+s.h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(s.x, gy); ctx.lineTo(s.x+s.w, gy); ctx.stroke();
      }

      // Numbers
      ctx.font=FONT; ctx.textAlign='center'; ctx.textBaseline='middle'; ctx.fillStyle='#000';
      for(let r=0;r<GRID;r++) for(let c=0;c<GRID;c++){
        const v=s.problemData[r][c]|0; const u=s.userData[r][c]|0;
        const px=s.x+c*CELL+CELL/2, py=s.y+r*CELL+CELL/2;
        if (v>0) ctx.fillText(String(v),px,py);
        else if (u>0){ ctx.fillStyle= showSolution ? '#0a0' : '#2b90ff'; ctx.fillText(String(u),px,py); ctx.fillStyle='#000'; }
      }

      // Outer border (screen)
      strokeRectCrisp(ctx, s.x, s.y, s.w, s.h, 2, isActive ? '#2b90ff' : '#222');
    }

    function draw(){
      // resize backing store
      const rect = canvas.getBoundingClientRect();
      const needW = Math.round(rect.width * DPR), needH = Math.round(rect.height * DPR);
      if (canvas.width !== needW || canvas.height !== needH){ canvas.width=needW; canvas.height=needH; }
      // clear background
      ctx.save(); ctx.setTransform(1,0,0,1,0,0);
      ctx.fillStyle='#fff'; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.restore();
      // draw world
      applyTransform();
      for (const s of squares) drawBoard(s);
    }

    // ===== Server Generate =====
    async function generateFromServer(){
      if (!squares.length){ alert('盤がありません'); return; }
      const layout = squares.map(s=>({ id:s.id, x:s.x/CELL, y:s.y/CELL }));
      const diff = difficultySel ? String(difficultySel.value||'normal') : 'normal';
      setStatus('サーバーで生成中…');
      try{
        const res = await fetch('/api/generate', {
          method:'POST', headers:{'content-type':'application/json'},
          body: JSON.stringify({ layout, difficulty: diff })
        });
        if (!res.ok) throw new Error('server '+res.status);
        const data = await res.json();
        const boards = data?.boards ?? data?.puzzle?.boards;
        if (!Array.isArray(boards)) throw new Error('invalid payload');
        const mp = new Map(boards.map(b=>[String(b.id),b]));
        for(const s of squares){
          const b = mp.get(String(s.id)); if (!b) continue;
          s.problemData = cloneGrid(b.grid);
          s.solution = cloneGrid(b.solution||newGrid());
          s.userData = newGrid(); s.checkData=newGrid();
        }
        isGenerated = true; showSolution=false;
        setStatus('生成完了'); draw(); updateButtons();
      }catch(err){
        console.error(err); setStatus('生成失敗: '+(err?.message||String(err)));
      }
    }

    // ===== Export =====
    function exportJSON(){
      const payload = {
        version:1,
        layout: squares.map(s=>({id:s.id, x:s.x, y:s.y})),
        boards: squares.map(s=>({id:s.id, grid:s.problemData, solution:s.solution}))
      };
      const blob = new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});
      const a = document.createElement('a'); a.href=URL.createObjectURL(blob);
      a.download='gattai_export.json'; a.click(); URL.revokeObjectURL(a.href);
      setStatus('JSON を保存しました');
    }

    function exportPNGs(){
      if (!squares.length){ alert('盤がありません'); return; }
      const {minX,minY,maxX,maxY} = contentBounds();
      const margin = 24;
      const W = Math.ceil(maxX-minX) + margin*2;
      const H = Math.ceil(maxY-minY) + margin*2;
      const scale = 2; // hi-res

      const makeCanvas = (mode) => {
        const c = document.createElement('canvas');
        c.width = W*scale; c.height = H*scale;
        const g = c.getContext('2d', {alpha:false});
        g.setTransform(scale,0,0,scale,0,0);
        g.fillStyle='#fff'; g.fillRect(0,0,W,H);
        const ox = margin - minX, oy = margin - minY;

        // draw each board
        g.font=FONT; g.textAlign='center'; g.textBaseline='middle';
        for (const s of squares){
          const x=ox+s.x, y=oy+s.y;
          // outer border with crisp helper
          strokeRectCrisp(g, x, y, s.w, s.h, 2, '#000');
          // fine grid
          g.lineWidth=1; g.strokeStyle='#bbb';
          for(let i=1;i<GRID;i++){
            const gx=x+i*CELL, gy=y+i*CELL;
            g.beginPath(); g.moveTo(gx+.5,y); g.lineTo(gx+.5,y+s.h); g.stroke();
            g.beginPath(); g.moveTo(x,gy+.5); g.lineTo(x+s.w,gy+.5); g.stroke();
          }
          // bold grid
          g.lineWidth=2; g.strokeStyle='#000';
          for(let i=3;i<GRID;i+=3){
            const gx=x+i*CELL, gy=y+i*CELL;
            g.beginPath(); g.moveTo(gx,y); g.lineTo(gx,y+s.h); g.stroke();
            g.beginPath(); g.moveTo(x,gy); g.lineTo(x+s.w,gy); g.stroke();
          }
          // numbers
          const grid = (mode==='solution' ? (s.solution||newGrid()) : s.problemData);
          g.fillStyle='#000';
          for(let r=0;r<GRID;r++) for(let c2=0;c2<GRID;c2++){
            const v=grid[r][c2]|0; if (v<=0) continue;
            const px=x+c2*CELL+CELL/2, py=y+r*CELL+CELL/2;
            g.fillText(String(v),px,py);
          }
        }
        return c;
      };

      const ts = (()=>{ const d=new Date(); const p=n=>String(n).padStart(2,'0');
        return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; })();

      const c1 = makeCanvas('problem');
      c1.toBlob((b)=>{ const url=URL.createObjectURL(b); const a=document.createElement('a');
        a.href=url; a.download=`gattai_problem_${ts}.png`; a.click(); URL.revokeObjectURL(url); }, 'image/png');

      const c2 = makeCanvas('solution');
      c2.toBlob((b)=>{ const url=URL.createObjectURL(b); const a=document.createElement('a');
        a.href=url; a.download=`gattai_solution_${ts}.png`; a.click(); URL.revokeObjectURL(url); }, 'image/png');

      setStatus('PNG を保存しました');
    }

    // ===== Check & Show Solution =====
    function runCheck(){
      if (!activeSquareId) return;
      const sq = squares.find(s=>String(s.id)===String(activeSquareId)); if (!sq) return;
      const val = (r,c)=> (sq.userData[r][c] || sq.problemData[r][c] || 0);
      sq.checkData = newGrid();
      // rows
      for(let r=0;r<GRID;r++){ const seen=new Map();
        for(let c=0;c<GRID;c++){ const v=val(r,c); if (!v) continue;
          if(seen.has(v)){ sq.checkData[r][c]=1; sq.checkData[r][seen.get(v)]=1; } else seen.set(v,c);
        } }
      // cols
      for(let c=0;c<GRID;c++){ const seen=new Map();
        for(let r=0;r<GRID;r++){ const v=val(r,c); if (!v) continue;
          if(seen.has(v)){ sq.checkData[r][c]=1; sq.checkData[seen.get(v)][c]=1; } else seen.set(v,r);
        } }
      // blocks
      for(let br=0;br<3;br++) for(let bc=0;bc<3;bc++){
        const seen=new Map();
        for(let r=br*3;r<br*3+3;r++) for(let c=bc*3;c<bc*3+3;c++){
          const v=val(r,c); if(!v) continue;
          const k=`${v}`; if(seen.has(k)){ const [rr,cc]=seen.get(k); sq.checkData[r][c]=1; sq.checkData[rr][cc]=1; } else seen.set(k,[r,c]);
        }
      }
      draw();
    }

    function toggleSolution(){
      if (!isGenerated) return;
      showSolution = !showSolution;
      for (const s of squares){
        s.userData = showSolution && s.solution ? cloneGrid(s.solution) : newGrid();
      }
      draw(); updateButtons();
    }

    // ===== Inputs: mouse + wheel =====
    canvas.addEventListener('mousedown', (e)=>{
      const rect=canvas.getBoundingClientRect(); const mx=e.clientX-rect.left, my=e.clientY-rect.top;
      const w = toWorld(mx,my);
      if (e.button===1 || e.button===2 || isSpaceDown){ panning=true; panStart={mx,my,px:panX,py:panY}; return; }
      const s = hitSquare(w.x,w.y);
      if(!s){ if(e.button===0){ panning=true; panStart={mx,my,px:panX,py:panY}; } return; }
      activeSquareId=s.id; dragging={id:s.id, dx:w.x-s.x, dy:w.y-s.y}; draw(); updateButtons();
    });
    window.addEventListener('mousemove', (e)=>{
      const rect=canvas.getBoundingClientRect(); const mx=e.clientX-rect.left, my=e.clientY-rect.top;
      if (panning && panStart){ panX = panStart.px + (mx-panStart.mx); panY = panStart.py + (my-panStart.my); applyTransform(); draw(); return; }
      if (!dragging) return;
      const w = toWorld(mx,my); const s = squares.find(ss=>String(ss.id)===String(dragging.id)); if(!s) return;
      s.x = Math.round((w.x - dragging.dx)/SNAP_X)*SNAP_X;
      s.y = Math.round((w.y - dragging.dy)/SNAP_Y)*SNAP_Y;
      draw();
    });
    window.addEventListener('mouseup', ()=>{ dragging=null; panning=false; panStart=null; });
    canvas.addEventListener('wheel', (e)=>{
      if (e.ctrlKey){ e.preventDefault();
        const rect=canvas.getBoundingClientRect(); const mx=e.clientX-rect.left, my=e.clientY-rect.top;
        const factor = (e.deltaY<0)?ZOOM_STEP:(1/ZOOM_STEP); // pinch-zoom gesture
        const w = toWorld(mx,my); zoom = clamp(zoom*factor, MIN_ZOOM, MAX_ZOOM);
        panX = mx - w.x*zoom; panY = my - w.y*zoom; draw();
      }
    }, {passive:false});

    // ===== Inputs: Pointer Events (mobile friendly) =====
    canvas.addEventListener('pointerdown', (e)=>{
      if (e.isPrimary === false) return;
      if (e.pointerType !== 'mouse') e.preventDefault();
      canvas.setPointerCapture?.(e.pointerId);
      const rect=canvas.getBoundingClientRect(); const mx=e.clientX-rect.left, my=e.clientY-rect.top;
      const w = toWorld(mx,my);
      const s = hitSquare(w.x,w.y);
      if(!s){ panning=true; panStart={mx,my,px:panX,py:panY}; return; }
      activeSquareId=s.id; dragging={id:s.id, dx:w.x-s.x, dy:w.y-s.y}; draw(); updateButtons();
    });
    canvas.addEventListener('pointermove', (e)=>{
      if (e.isPrimary === false) return;
      if (!panning && !dragging) return;
      if (e.pointerType !== 'mouse') e.preventDefault();
      const rect=canvas.getBoundingClientRect(); const mx=e.clientX-rect.left, my=e.clientY-rect.top;
      if (panning && panStart){ panX = panStart.px + (mx-panStart.mx); panY = panStart.py + (my-panStart.my); applyTransform(); draw(); return; }
      if (dragging){ const w=toWorld(mx,my); const s=squares.find(ss=>String(ss.id)===String(dragging.id)); if(!s) return;
        s.x = Math.round((w.x - dragging.dx)/SNAP_X)*SNAP_X;
        s.y = Math.round((w.y - dragging.dy)/SNAP_Y)*SNAP_Y;
        draw();
      }
    });
    function endPointer(e){ try{ canvas.releasePointerCapture?.(e.pointerId); }catch{} dragging=null; panning=false; panStart=null; }
    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);

    // ===== Buttons =====
    addSquareButton?.addEventListener('click', ()=>addSquare(0,0));
    deleteButton?.addEventListener('click', deleteActive);
    clearAllBoardsButton?.addEventListener('click', clearAll);
    generateProblemButton?.addEventListener('click', generateFromServer);
    checkButton?.addEventListener('click', runCheck);
    solveButton?.addEventListener('click', toggleSolution);
    exportTextButton?.addEventListener('click', exportJSON);
    exportImageButton?.addEventListener('click', exportPNGs);
    zoomOutBtn?.addEventListener('click', ()=>{ zoom=clamp(zoom/ZOOM_STEP,MIN_ZOOM,MAX_ZOOM); draw(); });
    zoomInBtn ?.addEventListener('click', ()=>{ zoom=clamp(zoom*ZOOM_STEP,MIN_ZOOM,MAX_ZOOM); draw(); });
    zoomResetBtn?.addEventListener('click', ()=>{ zoom=1; panX=40; panY=40; draw(); });
    zoomFitBtn  ?.addEventListener('click', ()=>{
      const {minX,minY,maxX,maxY}=contentBounds(); const rect=canvas.getBoundingClientRect();
      const z = clamp(Math.min((rect.width-80)/(maxX-minX||1),(rect.height-80)/(maxY-minY||1)), MIN_ZOOM, MAX_ZOOM);
      zoom=z; panX=(rect.width - (maxX-minX)*z)/2 - minX*z; panY=(rect.height - (maxY-minY)*z)/2 - minY*z; draw();
    });

    window.addEventListener('keydown', (e)=>{ if (e.code==='Space') isSpaceDown=true; });
    window.addEventListener('keyup',   (e)=>{ if (e.code==='Space') isSpaceDown=false; });

    // ===== Init =====
    function initDemoIfEmpty(){
      if (squares.length) return;
      addSquare(0,0); addSquare(BOARD*0.9, BOARD); addSquare(BOARD*1.8, 0);
      draw();
    }
    const ro = new ResizeObserver(()=>draw()); ro.observe(canvas);
    initDemoIfEmpty();
    setStatus('指でドラッグ：盤移動 / 背景ドラッグ：パン / Ctrl+ホイール：ズーム');
  });
})();
