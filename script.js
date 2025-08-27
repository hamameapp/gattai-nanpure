// script.js — Cloudflare Pages front-end（置き換え可）
// - 画像保存：問題と解答を「別々のPNG」に出力（タイムスタンプ付きファイル名）
//   * gattai_problem_YYYYMMDD_HHMMSS.png
//   * gattai_solution_YYYYMMDD_HHMMSS.png
// - パン：背景左ドラッグ/Space/右/中ドラッグで滑らかに移動（前回どおり）
// - そのほか既存機能は変更していません

(() => {
  document.addEventListener('DOMContentLoaded', () => {
    // ===== DOM =====
    const byId = (id) => document.getElementById(id) || null;

    const canvas = byId('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });

    const statusDiv = byId('status');
    const addSquareButton = byId('addSquareButton');
    const deleteButton = byId('deleteButton');
    const clearAllBoardsButton = byId('clearAllBoardsButton');
    const generateProblemButton = byId('generateProblemButton');
    const checkButton = byId('checkButton');     // 矛盾チェック
    const solveButton = byId('solveButton');     // 解答トグル
    const exportTextButton = byId('exportTextButton');   // JSON保存
    // どちらのIDでも拾う（互換）
    const exportImageButton = byId('exportImageAllButton') || byId('saveAllPngButton');
    const difficultySel = byId('difficulty');

    // ズームUI
    const zoomOutBtn = byId('zoomOut');
    const zoomInBtn = byId('zoomIn');
    const zoomFitBtn = byId('zoomFit');
    const zoom100Btn = byId('zoom100');
    const zoomPct = byId('zoomPct');

    // ===== 定数 =====
    const GRID = 9;
    const CELL = 30;
    const BOARD_PIX = GRID * CELL;
    const SNAP_X = CELL;
    const SNAP_Y = CELL * 3; // 縦は3セル単位スナップ
    const FONT = '16px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    const MIN_ZOOM = 0.1, MAX_ZOOM = 2.0, ZOOM_STEP = 0.1;
    const LS_KEY = 'gattai_state_v5';

    // ===== 状態 =====
    let squares = []; // {id,x,y,w,h, problemData,userData,solutionData,checkData,_userBackup}
    let activeSquareId = null;
    let activeCell = null;
    let isProblemGenerated = false;
    let showSolution = false;

    // ビューポート
    let zoom = 1.0, panX = 0, panY = 0;
    let devicePR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    let panning = false, isSpaceDown = false, panStart = null;
    let drag = null;

    // ===== ユーティリティ =====
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const snap  = (v, u) => Math.round(v / u) * u;
    const createEmptyGrid = () => Array.from({ length: GRID }, () => Array(GRID).fill(0));
    const cloneGrid = (g) => g.map(r => r.slice());
    const setStatus = (msg) => { if (statusDiv) statusDiv.textContent = msg; };
    function nextId(){ let m=0; for(const s of squares) m=Math.max(m, +s.id||0); return String(m+1); }

    // ===== ビューポート（ズーム/パン）=====
    function applyTransform(){ ctx.setTransform(devicePR*zoom,0,0,devicePR*zoom, devicePR*panX, devicePR*panY); }
    function toWorld(mx,my){ return { x:(mx - panX)/zoom, y:(my - panY)/zoom }; }

    function setZoomAt(newZ, ax, ay){
      const z = clamp(newZ, MIN_ZOOM, MAX_ZOOM);
      const w = toWorld(ax, ay);
      zoom = z;
      panX = ax - w.x * zoom;
      panY = ay - w.y * zoom;
      applyTransform(); draw(); updateButtonStates(); saveState();
    }
    function setZoom(z){
      const rect = canvas.getBoundingClientRect();
      setZoomAt(z, rect.width/2, rect.height/2);
    }

    function contentBounds(){
      if (squares.length===0) return { minX:0, minY:0, maxX:BOARD_PIX, maxY:BOARD_PIX };
      let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
      for (const s of squares){
        minX=Math.min(minX,s.x); minY=Math.min(minY,s.y);
        maxX=Math.max(maxX,s.x+s.w); maxY=Math.max(maxY,s.y+s.h);
      }
      return {minX,minY,maxX,maxY};
    }
    function fitZoom(margin=40){
      const rect = canvas.getBoundingClientRect();
      const {minX,minY,maxX,maxY} = contentBounds();
      const w = Math.max(1, maxX-minX), h = Math.max(1, maxY-minY);
      const z = clamp(Math.min((rect.width-margin*2)/w, (rect.height-margin*2)/h), MIN_ZOOM, MAX_ZOOM);
      zoom = z;
      const sw = w*z, sh = h*z;
      panX = (rect.width - sw)/2 - minX*z;
      panY = (rect.height - sh)/2 - minY*z;
      applyTransform(); draw(); updateButtonStates(); saveState();
    }
    function autoFitIfOverflow(){
      const rect = canvas.getBoundingClientRect();
      const {minX,minY,maxX,maxY} = contentBounds();
      const w = (maxX-minX), h = (maxY-minY);
      if (w > rect.width/zoom || h > rect.height/zoom) fitZoom();
    }

    // ホイール：Ctrl/⌘+ホイール = ズーム、 Space押しながら = パン（Shiftで横）
canvas.addEventListener('wheel', (e)=>{
  const rect = canvas.getBoundingClientRect();
  if (e.ctrlKey || e.metaKey){
    e.preventDefault();
    const mx=e.clientX-rect.left, my=e.clientY-rect.top;
    setZoomAt(zoom * (1 + (-Math.sign(e.deltaY))*0.1), mx, my);
  }else if (typeof isSpaceDown !== 'undefined' && isSpaceDown){
    e.preventDefault();
    if (e.shiftKey){ panX -= e.deltaY; }
    else { panX -= e.deltaX; panY -= e.deltaY; }
    applyTransform(); draw(); saveState();
  }else{
    return; // 通常スクロール許可
  }
}, { passive:false });

    // 左UI
    zoomOutBtn?.addEventListener('click', ()=> setZoom(zoom - ZOOM_STEP));
    zoomInBtn?.addEventListener('click',  ()=> setZoom(zoom + ZOOM_STEP));
    zoom100Btn?.addEventListener('click', ()=> setZoom(1));
    zoomFitBtn?.addEventListener('click', ()=> fitZoom());

    // ショートカット
    window.addEventListener('keydown', (e)=>{
      if (e.code==='Space') isSpaceDown = true;
      if (e.code === 'KeyF'){ e.preventDefault(); fitZoom(); }
      if (e.key === '+' || e.key === '='){ e.preventDefault(); setZoom(zoom + ZOOM_STEP); }
      if (e.key === '-' || e.key === '_'){ e.preventDefault(); setZoom(zoom - ZOOM_STEP); }
    });
    window.addEventListener('keyup', (e)=>{ if (e.code==='Space') isSpaceDown=false; });

    // ===== 描画 =====
    function draw(){
      // 画面クリア
      ctx.save(); ctx.setTransform(devicePR,0,0,devicePR,0,0);
      ctx.fillStyle='#fff'; ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.restore();

      // 盤
      applyTransform();
      for (const s of squares) drawBoard(s);

      // セル強調
      if (activeCell){
        const s = squares.find(x => String(x.id) === String(activeCell.id));
        if (s){
          ctx.save();
          ctx.globalAlpha=0.25; ctx.fillStyle='#66aaff';
          ctx.fillRect(s.x + activeCell.c*CELL, s.y + activeCell.r*CELL, CELL, CELL);
          ctx.restore();
        }
      }
    }

    function drawBoard(s){
      ctx.save();
      const isActive = String(s.id) === String(activeSquareId);

      // 外枠
      ctx.strokeStyle = isActive ? '#2b90ff' : '#222';
      ctx.lineWidth   = isActive ? 3 : 1.5;
      ctx.strokeRect(s.x-.5, s.y-.5, s.w+1, s.h+1);

      // 細グリッド
      ctx.lineWidth=1; ctx.strokeStyle='#aaa';
      for (let i=1;i<GRID;i++){
        const gx=s.x+i*CELL, gy=s.y+i*CELL;
        ctx.beginPath(); ctx.moveTo(gx+.5, s.y);    ctx.lineTo(gx+.5, s.y+s.h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(s.x,  gy+.5);   ctx.lineTo(s.x+s.w, gy+.5); ctx.stroke();
      }

      // 太線（3x3）
      ctx.lineWidth=2; ctx.strokeStyle='#333';
      for (let i=0;i<=GRID;i+=3){
        const gx=s.x+i*CELL+.5, gy=s.y+i*CELL+.5;
        ctx.beginPath(); ctx.moveTo(gx, s.y);      ctx.lineTo(gx, s.y+s.h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(s.x, gy);      ctx.lineTo(s.x+s.w, gy); ctx.stroke();
      }

      // 数字
      ctx.font=FONT; ctx.textAlign='center'; ctx.textBaseline='middle';
      for (let r=0;r<GRID;r++) for (let c=0;c<GRID;c++){
        const px=s.x+c*CELL+CELL/2, py=s.y+r*CELL+CELL/2;
        const giv=s.problemData[r][c]|0, usr=s.userData[r][c]|0;
        if (giv>0){ ctx.fillStyle='#000'; ctx.fillText(String(giv),px,py); }
        else if (usr>0){
          const bad=((s.checkData[r][c]|0)===1);
          ctx.fillStyle = bad ? '#d11' : (showSolution ? '#0a0' : '#2b90ff');
          ctx.fillText(String(usr),px,py);
        }
      }

      // タグ
      ctx.fillStyle = isActive ? '#2b90ff' : '#666';
      ctx.fillRect(s.x, s.y-18, 30, 18);
      ctx.fillStyle = '#fff';
      ctx.font = '12px system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
      ctx.textAlign='center'; ctx.textBaseline='middle';
      ctx.fillText(s.id, s.x+15, s.y-9);

      ctx.restore();
    }

    // ===== ヒット判定 =====
    function boardAt(x,y){
      for (let i=squares.length-1;i>=0;i--){
        const s=squares[i];
        if (x>=s.x && x<s.x+s.w && y>=s.y && y<s.y+s.h) return s;
      }
      return null;
    }
    function cellAt(s,x,y){
      if (!s) return null;
      const cx = Math.floor((x - s.x)/CELL);
      const cy = Math.floor((y - s.y)/CELL);
      if (cx<0 || cy<0 || cx>=GRID || cy>=GRID) return null;
      return { id:s.id, r:cy, c:cx };
    }

    // ===== 入力（ドラッグ/パン/編集）=====
    canvas.addEventListener('contextmenu', e=>e.preventDefault());

    canvas.addEventListener('mousedown',(e)=>{
      const rect=canvas.getBoundingClientRect();
      const mx=e.clientX-rect.left, my=e.clientY-rect.top;
      const {x:xw,y:yw}=toWorld(mx,my);

      // ビューを掴む（Space / 中 / 右）
      if (isSpaceDown || e.button===1 || e.button===2){
        panning=true; panStart={mx,my,px:panX,py:panY}; return;
      }

      // 背景を左ドラッグでもパン開始（滑らかパン）
      const s = boardAt(xw,yw);
      if (!s && e.button===0){
        panning=true; panStart={mx,my,px:panX,py:panY};
        activeSquareId=null; activeCell=null; draw(); updateButtonStates();
        return;
      }

      // 盤を選択/移動
      if (!s){ activeSquareId=null; activeCell=null; draw(); updateButtonStates(); return; }
      activeSquareId=s.id; activeCell=cellAt(s,xw,yw);
      drag={ id:s.id, offsetX:xw-s.x, offsetY:yw-s.y }; updateButtonStates(); draw();
    });

    // パンを滑らかにするため、キャンバス外でも追従
    function handleMove(e){
      const rect=canvas.getBoundingClientRect();
      const mx=e.clientX-rect.left, my=e.clientY-rect.top;

      // パン
      if (panning && panStart){
        panX=panStart.px+(mx-panStart.mx);
        panY=panStart.py+(my-panStart.my);
        applyTransform(); draw(); return;
      }

      // 盤移動
      if(!drag) return;
      const {x:xw,y:yw}=toWorld(mx,my);
      const s=squares.find(x=>String(x.id)===String(drag.id)); if(!s) return;
      let nx=snap(xw-drag.offsetX,SNAP_X), ny=snap(yw-drag.offsetY,SNAP_Y);
      nx=Math.max(0,nx); ny=Math.max(0,ny); s.x=nx; s.y=ny; draw();
    }
    canvas.addEventListener('mousemove', handleMove);
    window.addEventListener('mousemove', e=>{ if (panning) handleMove(e); });
    window.addEventListener('mouseup',()=>{ panning=false; panStart=null; drag=null; saveState(); });

    // 編集
    window.addEventListener('keydown',(e)=>{
      if (!isProblemGenerated || !activeCell || showSolution) return;
      const s=squares.find(x=>String(x.id)===String(activeCell.id)); if(!s) return;
      if (s.problemData[activeCell.r][activeCell.c] > 0) return;

      if (e.key>='1'&&e.key<='9'){
        s.userData[activeCell.r][activeCell.c] = parseInt(e.key,10);
        s.checkData[activeCell.r][activeCell.c] = 0;
        draw(); e.preventDefault(); saveState(); return;
      }
      if (e.key==='Backspace' || e.key==='Delete' || e.key==='0'){
        s.userData[activeCell.r][activeCell.c] = 0;
        s.checkData[activeCell.r][activeCell.c] = 0;
        draw(); e.preventDefault(); saveState(); return;
      }

      const mv = {ArrowUp:[-1,0], ArrowDown:[1,0], ArrowLeft:[0,-1], ArrowRight:[0,1]}[e.key];
      if (mv){
        const nr = clamp(activeCell.r+mv[0],0,GRID-1);
        const nc = clamp(activeCell.c+mv[1],0,GRID-1);
        activeCell = { id:activeCell.id, r:nr, c:nc };
        draw(); e.preventDefault();
      }
    });

    // ===== ボタン =====
    function newSquareAtWorldCenter(){
      const rect = canvas.getBoundingClientRect();
      const cx = rect.width/2, cy = rect.height/2;
      const world = toWorld(cx,cy);
      const nx = Math.max(0, snap(world.x - BOARD_PIX/2, SNAP_X));
      const ny = Math.max(0, snap(world.y - BOARD_PIX/2, SNAP_Y));
      const id = nextId();
      return { id, x:nx, y:ny, w:BOARD_PIX, h:BOARD_PIX,
        problemData:createEmptyGrid(), userData:createEmptyGrid(),
        checkData:createEmptyGrid(), solutionData:createEmptyGrid(), _userBackup:null };
    }

    addSquareButton?.addEventListener('click', ()=>{
      const s = newSquareAtWorldCenter();
      squares.push(s); activeSquareId=s.id;
      isProblemGenerated=false; showSolution=false;
      setStatus('盤を追加：中心に生成しました。Space/右ドラッグでパン、Ctrl+ホイールでズーム。');
      updateButtonStates(); draw(); saveState(); autoFitIfOverflow();
    });

    deleteButton?.addEventListener('click', ()=>{
      if (activeSquareId==null) return;
      squares = squares.filter(s=>String(s.id)!==String(activeSquareId));
      activeSquareId=null; activeCell=null;
      isProblemGenerated = squares.length>0 && isProblemGenerated;
      showSolution=false;
      setStatus('選択中の盤を削除しました');
      updateButtonStates(); draw(); saveState(); autoFitIfOverflow();
    });

    clearAllBoardsButton?.addEventListener('click', ()=>{
      if (!confirm('配置した盤面をすべて削除します。よろしいですか？')) return;
      squares=[]; activeSquareId=null; activeCell=null; isProblemGenerated=false; showSolution=false;
      localStorage.removeItem(LS_KEY);
      panX=0; panY=0; zoom=1;
      applyTransform(); updateButtonStates(); draw();
      setStatus('すべての盤面をクリアしました');
    });

    // 生成（フロント/サーバどちらでもOKな既存実装を尊重）
    generateProblemButton?.addEventListener('click', handleGenerateProblem);

    checkButton?.addEventListener('click', ()=>{
      if (!isProblemGenerated) return;
      for (const s of squares) runCheck(s);
      runOverlapCheck();
      draw();
      const total = countConflicts();
      setStatus(`矛盾チェック：${total} 件${total===0?'（OK）':''}`);
    });

    solveButton?.addEventListener('click', ()=>{
      if (!isProblemGenerated) return;
      const missing = squares.some(s=>!s.solutionData || s.solutionData.length!==9);
      if (missing){ alert('解答データがありません'); return; }
      if (!showSolution){
        for (const s of squares){
          s._userBackup = cloneGrid(s.userData);
          for (let r=0;r<GRID;r++) for (let c=0;c<GRID;c++){
            if (s.problemData[r][c]===0) s.userData[r][c] = s.solutionData[r][c];
          }
          s.checkData = createEmptyGrid();
        }
        showSolution = true; setStatus('解答を表示中');
      }else{
        for (const s of squares){ if (s._userBackup) s.userData = s._userBackup; s._userBackup=null; }
        showSolution = false; setStatus('解答を隠しました');
      }
      updateButtonStates(); draw(); saveState();
    });

    exportTextButton?.addEventListener('click', ()=>{
      const diff = difficultySel ? String(difficultySel.value||'normal') : 'normal';
      const payload = {
        version: 1,
        difficulty: diff,
        layout: squares.map(s=>({ id:s.id, x:s.x, y:s.y })),
        boards: squares.map(s=>({ id:s.id, grid:s.problemData, solution:s.solutionData }))
      };
      const blob = new Blob([JSON.stringify(payload,null,2)], { type:'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'gattai_export.json'; a.click();
      URL.revokeObjectURL(url);
      setStatus('JSON を保存しました');
    });

    // === 画像保存：問題 と 解答 を「別ファイル」で保存 ===
    exportImageButton?.addEventListener('click', ()=>{
      if (squares.length===0){ alert('まず盤面を追加してください'); return; }
      const {minX,minY,maxX,maxY} = contentBounds();

      const margin = 20;
      const regionW = Math.ceil((maxX-minX) + margin*2);
      const regionH = Math.ceil((maxY-minY) + margin*2);
      const scale = (window.__EXPORT_SCALE__ || 1); // 外部から指定（未指定は1x）
      const baseX = margin - minX;
      const baseY = margin - minY;

      
      // 書き出し用の外枠ストローク（端の太りを防ぐ）
      const strokeRectCrisp = (gctx, x, y, w, h, lineWidth, color) => {
        gctx.save();
        gctx.strokeStyle = color;
        gctx.lineWidth   = lineWidth;
        gctx.lineCap = 'butt';
        gctx.lineJoin = 'miter';
        const needsHalf = (Math.round(lineWidth) % 2 === 1);
        const off = needsHalf ? 0.5 : 0;
        const L = x + off, T = y + off, R = x + w - off, B = y + h - off;
        gctx.beginPath(); gctx.moveTo(L, T); gctx.lineTo(R, T); gctx.stroke();
        gctx.beginPath(); gctx.moveTo(R, T); gctx.lineTo(R, B); gctx.stroke();
        gctx.beginPath(); gctx.moveTo(R, B); gctx.lineTo(L, B); gctx.stroke();
        gctx.beginPath(); gctx.moveTo(L, B); gctx.lineTo(L, T); gctx.stroke();
        gctx.restore();
      };
// 1盤描画（problem/solution切替）
      const drawOne = (gctx, s, ox, oy, mode /* 'problem' | 'solution' */)=>{
        // 外枠（PNGのみ均一化）
        strokeRectCrisp(gctx, ox, oy, s.w, s.h, 2, '#000');

        // 細グリッド
        gctx.lineWidth=1; gctx.strokeStyle='#bbb';
        for (let i=1;i<GRID;i++){
          const gx=ox+i*CELL, gy=oy+i*CELL;
          gctx.beginPath(); gctx.moveTo(gx+.5, oy); gctx.lineTo(gx+.5, oy+s.h); gctx.stroke();
          gctx.beginPath(); gctx.moveTo(ox, gy+.5); gctx.lineTo(ox+s.w, gy+.5); gctx.stroke();
        }
        // 太グリッド
        gctx.lineWidth=2; gctx.strokeStyle='#000';
        for (let i=3;i<GRID;i+=3){
          const gx=ox+i*CELL, gy=oy+i*CELL;
          gctx.beginPath(); gctx.moveTo(gx, oy); gctx.lineTo(gx, oy+s.h); gctx.stroke();
          gctx.beginPath(); gctx.moveTo(ox, gy); gctx.lineTo(ox+s.w, gy); gctx.stroke();
        }
        // 数字
        gctx.font = FONT; gctx.textAlign='center'; gctx.textBaseline='middle'; gctx.fillStyle='#000';
        const grid = (mode==='solution' ? s.solutionData : s.problemData) || [];
        for (let r=0;r<GRID;r++) for (let c=0;c<GRID;c++){
          const v = grid?.[r]?.[c] | 0;
          if (v>0){
            const px=ox+c*CELL+CELL/2, py=oy+r*CELL+CELL/2;
            gctx.fillText(String(v), px, py);
          }
        }
      };

      // キャンバス作成 & 描画
      const makeCanvas = (mode) => {
        const off = document.createElement('canvas');
        off.width = regionW * scale; off.height = regionH * scale;
        const g = off.getContext('2d', { alpha:false });
        g.setTransform(scale,0,0,scale,0,0);
        g.fillStyle = '#fff'; g.fillRect(0,0,regionW,regionH);
        for (const s of squares){
          drawOne(g, s, baseX + s.x, baseY + s.y, mode);
        }
        return off;
      };

      // タイムスタンプ付きファイル名
      const now = new Date();
      const pad2 = (n) => String(n).padStart(2, '0');
      const stamp = `${now.getFullYear()}${pad2(now.getMonth()+1)}${pad2(now.getDate())}_${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
      const fnameProblem  = `gattai_problem_${stamp}.png`;
      const fnameSolution = `gattai_solution_${stamp}.png`;

      // 問題を保存
      const cvP = makeCanvas('problem');
      cvP.toBlob((blob)=>{
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = fnameProblem; a.click();
        URL.revokeObjectURL(url);
      }, 'image/png');

      // 解答が無い場合はスキップして通知
      const hasSolution = squares.some(s =>
        Array.isArray(s.solutionData) && s.solutionData.some(row => row.some(v => v))
      );
      if (!hasSolution){
        setStatus(`PNG を保存しました（${fnameProblem}、解答データが無いため問題のみ）`);
        return;
      }

      // 解答を保存
      const cvS = makeCanvas('solution');
      cvS.toBlob((blob)=>{
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = fnameSolution; a.click();
        URL.revokeObjectURL(url);
      }, 'image/png');

      setStatus(`PNG を保存しました（${fnameProblem} / ${fnameSolution}）`);
    });

    function updateButtonStates(){
      zoomPct && (zoomPct.textContent = `${Math.round(zoom*100)}%`);
      generateProblemButton && (generateProblemButton.disabled = squares.length === 0);
      deleteButton && (deleteButton.disabled = activeSquareId == null);
      clearAllBoardsButton && (clearAllBoardsButton.disabled = squares.length === 0);
      checkButton && (checkButton.disabled = squares.length === 0 || !isProblemGenerated || showSolution);
      exportTextButton && (exportTextButton.disabled = squares.length === 0);
      exportImageButton && (exportImageButton.disabled = squares.length === 0);
      if (solveButton){
        solveButton.disabled = !isProblemGenerated;
        solveButton.textContent = showSolution ? '解答を隠す' : '解答を表示';
      }
    }

    // ===== 矛盾チェック（既存のまま）=====
    function runCheck(sq){
      sq.checkData = createEmptyGrid();
      const val = (r,c)=> (sq.userData[r][c] || sq.problemData[r][c] || 0);
      // 行
      for (let r=0;r<GRID;r++){
        const seen=new Map();
        for (let c=0;c<GRID;c++){
          const v=val(r,c); if (!v) continue;
          if (seen.has(v)){ sq.checkData[r][c]=1; const [rr,cc]=seen.get(v); sq.checkData[rr][cc]=1; } else seen.set(v,[r,c]);
        }
      }
      // 列
      for (let c=0;c<GRID;c++){
        const seen=new Map();
        for (let r=0;r<GRID;r++){
          const v=val(r,c); if (!v) continue;
          if (seen.has(v)){ sq.checkData[r][c]=1; const [rr,cc]=seen.get(v); sq.checkData[rr][cc]=1; } else seen.set(v,[r,c]);
        }
      }
      // 箱
      for (let br=0;br<GRID;br+=3) for (let bc=0;bc<GRID;bc+=3){
        const seen=new Map();
        for (let dr=0;dr<3;dr++) for (let dc=0;dc<3;dc++){
          const r=br+dr, c=bc+dc, v=val(r,c); if (!v) continue;
          if (seen.has(v)){ sq.checkData[r][c]=1; const [rr,cc]=seen.get(v); sq.checkData[rr][cc]=1; } else seen.set(v,[r,c]);
        }
      }
    }

    function buildOverlapsClient(sqs){
      const norm = sqs.map(s=>{
        const ox = Math.round(s.x / CELL);
        let oy = Math.round(s.y / CELL); oy -= oy % 3;
        return { id:String(s.id), ox, oy };
      });
      const n = norm.length, overlaps = [];
      for (let i=0;i<n;i++) for (let j=i+1;j<n;j++){
        const A=norm[i], B=norm[j];
        const R0=Math.max(0,B.oy-A.oy), C0=Math.max(0,B.ox-A.ox);
        const R1=Math.min(8,(B.oy+8)-A.oy), C1=Math.min(8,(B.ox+8)-A.ox);
        if (R0<=R1 && C0<=C1){
          const cells=[];
          for (let r=R0;r<=R1;r++) for (let c=C0;c<=C1;c++){
            const r2=r + A.oy - B.oy, c2=c + A.ox - B.ox;
            cells.push({ r,c,r2,c2,i,j });
          }
          overlaps.push({ i,j,cells });
        }
      }
      return overlaps;
    }

    function runOverlapCheck(){
      const overlaps = buildOverlapsClient(squares);
      const val = (sq,r,c)=> (sq.userData[r][c] || sq.problemData[r][c] || 0);
      for (const {i,j,cells} of overlaps){
        const A=squares[i], B=squares[j];
        for (const {r,c,r2,c2} of cells){
          const va=val(A,r,c), vb=val(B,r2,c2);
          if (va!==0 && vb!==0 && va!==vb){ A.checkData[r][c]=1; B.checkData[r2][c2]=1; }
        }
      }
    }

    function countConflicts(){
      let total=0;
      for (const s of squares) for (let r=0;r<GRID;r++) for (let c=0;c<GRID;c++){
        if ((s.checkData[r][c]|0)===1) total++;
      }
      return total;
    }

    // ===== 生成（サーバ or ローカル） =====
    async function handleGenerateProblem(){
      if (squares.length===0){ alert('まず「盤面を追加」してください'); return; }

      // 初期化
      for (const sq of squares){
        sq.problemData=createEmptyGrid();
        sq.userData=createEmptyGrid();
        sq.checkData=createEmptyGrid();
        sq.solutionData=createEmptyGrid();
        sq._userBackup=null;
      }
      showSolution=false; isProblemGenerated=false; updateButtonStates(); draw();

      // まずサーバAPIを叩ける構成なら優先（既存互換）
      try{
        const difficulty = difficultySel ? String(difficultySel.value||'normal') : 'normal';
        const layout = squares.map(s=>({ id:String(s.id), x:Math.round(s.x), y:Math.round(s.y) }));
        generateProblemButton && (generateProblemButton.disabled=true);
        const res = await fetch('/api/generate', {
          method:'POST',
          headers:{ 'content-type':'application/json' },
          body: JSON.stringify({ layout, difficulty, overlapEmpty: true })
        });
        if (res.ok){
          const data = await res.json();
          if (data?.ok && Array.isArray(data.boards)){
            const map = new Map(data.boards.map(b=>[String(b.id), b]));
            for (const sq of squares){
              const b = map.get(String(sq.id)); if (!b) continue;
              sq.problemData = cloneGrid(b.grid);
              sq.solutionData = cloneGrid(b.solution);
            }
            isProblemGenerated = true;
            updateButtonStates(); draw(); setStatus('問題を作成しました（サーバ生成）'); return;
          }
        }
      }catch(e){ /* フォールバックへ */ }
      finally{ generateProblemButton && (generateProblemButton.disabled=false); }

      // ここまでで作れなければローカル生成（簡易版／既存と同等）
      try{
        const boards = generateAllBoardsUnique(34);
        const map = new Map(boards.map(b=>[String(b.id), b]));
        for (const sq of squares){
          const b = map.get(String(sq.id)); if (!b) continue;
          sq.problemData = cloneGrid(b.grid);
          sq.solutionData = cloneGrid(b.solution);
        }
        isProblemGenerated = true;
        for (const s of squares) runCheck(s); runOverlapCheck(); draw();
        setStatus(`問題を作成しました（ローカル） / 盤数: ${boards.length}`);
        saveState();
      }catch(e){
        console.error(e);
        alert('生成に失敗しました。ページを更新してもう一度お試しください。');
        setStatus('生成に失敗しました');
      }finally{
        updateButtonStates(); draw();
      }
    }

    // === 以下、ローカル生成に必要な最低限の関数（既存流用・簡略） ===
    function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [a[i],a[j]]=[a[j],a[i]]; } return a; }
    function makeGlobalPattern(){
      function makeOrder(){
        const bandOrder = shuffle([0,1,2]); const order=[];
        for (const b of bandOrder){ const inner=shuffle([0,1,2]); for (const k of inner) order.push(b*3+k); }
        return order;
      }
      const rowOrder=makeOrder(), colOrder=makeOrder(), digitPerm=shuffle([1,2,3,4,5,6,7,8,9]);
      const base=(r,c)=>(r*3 + Math.floor(r/3) + c) % 9;
      function valueAt(R,C){
        const r=rowOrder[((R%9)+9)%9], c=colOrder[((C%9)+9)%9];
        return digitPerm[ base(r,c) ];
      }
      return { valueAt };
    }
    function countSolutions(grid, limit=2){
      const ROW = Array.from({length:9}, ()=> new Uint16Array(9));
      const COL = Array.from({length:9}, ()=> new Uint16Array(9));
      const BOX = Array.from({length:9}, ()=> new Uint16Array(9));
      const ALL = 0x3FE;
      for (let r=0;r<9;r++) for (let c=0;c<9;c++){
        const v=grid[r][c]|0;
        if (v){
          const b=Math.floor(r/3)*3+Math.floor(c/3);
          if (ROW[r][v-1] || COL[c][v-1] || BOX[b][v-1]) return 0;
          ROW[r][v-1]=COL[c][v-1]=BOX[b][v-1]=1;
        }
      }
      const blanks=[];
      for (let r=0;r<9;r++) for (let c=0;c<9;c++) if (!grid[r][c]) blanks.push([r,c]);
      const domainMask=(r,c)=>{
        const b=Math.floor(r/3)*3+Math.floor(c/3); let m=ALL;
        for (let d=1; d<=9; d++) if (ROW[r][d-1]||COL[c][d-1]||BOX[b][d-1]) m&=~(1<<d);
        return m;
      };
      blanks.sort((a,b)=>{
        const da=popcnt(domainMask(a[0],a[1])), db=popcnt(domainMask(b[0],b[1])); return da-db;
      });
      let ans=0;
      (function dfs(k){
        if (ans>=limit) return;
        if (k===blanks.length){ ans++; return; }
        const [r,c]=blanks[k]; const b=Math.floor(r/3)*3+Math.floor(c/3);
        let m=domainMask(r,c); if (!m) return;
        while(m){
          const d=ctz(m); m&=m-1;
          if (!ROW[r][d-1] && !COL[c][d-1] && !BOX[b][d-1]){
            ROW[r][d-1]=COL[c][d-1]=BOX[b][d-1]=1;
            grid[r][c]=d; dfs(k+1); grid[r][c]=0;
            ROW[r][d-1]=COL[c][d-1]=BOX[b][d-1]=0;
            if (ans>=limit) return;
          }
        }
      })(0);
      return Math.min(ans, limit);
      function popcnt(x){ x=x-((x>>>1)&0x55555555); x=(x&0x33333333)+((x>>>2)&0x33333333); return (((x+(x>>>4))&0x0F0F0F0F)*0x01010101)>>>24; }
      function ctz(x){ let n=0; while(((x>>>n)&1)===0) n++; return n; }
    }
    function carveUniqueFromSolved(solved, targetHints){
      const g=solved.map(r=>r.slice());
      const pairs=[]; for(let r=0;r<9;r++) for(let c=0;c<9;c++){ const or=8-r, oc=8-c; if (r>or||(r===or&&c>oc)) continue; pairs.push([r,c,or,oc]); }
      shuffle(pairs);
      let hints=81;
      for(const [r,c,or,oc] of pairs){
        if (hints<=targetHints) break;
        const k1=g[r][c], k2=g[or][oc]; if(!k1 && !k2) continue;
        g[r][c]=0; g[or][oc]=0;
        if (countSolutions(g,2)===1){ hints -= (r===or&&c===oc)?1:2; } else { g[r][c]=k1; g[or][oc]=k2; }
      }
      return g;
    }
    function generateAllBoardsUnique(targetHints){
      if (squares.length===0) throw new Error('no boards');
      const layout = squares.map(s=>{
        const ox = Math.round(s.x / CELL);
        let oy = Math.round(s.y / CELL); oy -= oy % 3;
        return { id:String(s.id), ox, oy };
      });
      const pattern = makeGlobalPattern();
      const solved = layout.map(({ox,oy}) =>
        Array.from({length:9}, (_,r) =>
          Array.from({length:9}, (_,c) => pattern.valueAt(oy+r, ox+c))
        )
      );
      const puzzles = solved.map(sol => carveUniqueFromSolved(sol, targetHints));
      return layout.map((o,idx)=>({ id:squares[idx].id, x:o.ox*CELL, y:o.oy*CELL, grid:puzzles[idx], solution:solved[idx] }));
    }

    // ===== 保存/復元 =====
    function saveState(){
      try{
        const payload = {
          zoom, panX, panY,
          squares: squares.map(s=>({
            id:s.id, x:s.x, y:s.y,
            problemData:s.problemData, userData:s.userData, solutionData:s.solutionData
          })),
          isProblemGenerated, showSolution, ts:Date.now()
        };
        localStorage.setItem(LS_KEY, JSON.stringify(payload));
      }catch{}
    }
    function loadState(){
      try{
        const raw = localStorage.getItem(LS_KEY); if (!raw) return false;
        const obj = JSON.parse(raw); if (!obj || !Array.isArray(obj.squares)) return false;
        zoom = clamp(Number(obj.zoom)||1, MIN_ZOOM, MAX_ZOOM);
        panX = Number.isFinite(obj.panX)?obj.panX:0;
        panY = Number.isFinite(obj.panY)?obj.panY:0;
        squares = obj.squares.map(o=>({
          id:o.id, x:snap(o.x||0,SNAP_X), y:snap(o.y||0,SNAP_Y), w:BOARD_PIX, h:BOARD_PIX,
          problemData:o.problemData||createEmptyGrid(),
          userData:o.userData||createEmptyGrid(),
          solutionData:o.solutionData||createEmptyGrid(),
          checkData:createEmptyGrid(), _userBackup:null
        }));
        isProblemGenerated = !!obj.isProblemGenerated && squares.length>0;
        showSolution = false; // 復元時は必ずOFF
        applyTransform(); return true;
      }catch{ return false; }
    }
    function resizeCanvasToDisplaySize(){
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(600, Math.floor(rect.width));
      const h = Math.max(450, Math.floor(rect.height));
      devicePR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      const W = Math.floor(w*devicePR), H = Math.floor(h*devicePR);
      if (canvas.width!==W || canvas.height!==H){
        canvas.width=W; canvas.height=H; applyTransform(); draw();
      }
    }
    window.addEventListener('resize', ()=>{ resizeCanvasToDisplaySize(); draw(); autoFitIfOverflow(); });

    // 起動
    resizeCanvasToDisplaySize();
    if (!loadState()){
      setStatus('盤を追加 →「合体問題を作成」。背景左ドラッグ/Space/右/中ドラッグでパン、Ctrl+ホイールでズーム。');
      applyTransform(); draw();
    }else{
      setStatus(isProblemGenerated ? '前回の問題を復元しました（続きからプレイできます）' : 'レイアウトを復元しました（縦は3セル単位でスナップ）');
      applyTransform(); draw();
    }
    updateButtonStates();
  });
})();
