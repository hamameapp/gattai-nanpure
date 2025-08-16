// script.js — Cloudflare Pages front-end (置き換え可)
// - 盤追加/削除/全消し
// - ズーム（10%〜200%）/パン（Space or 右/中ドラッグ、ホイールパン、Shift+ホイール横）/フィット
// - ローカル生成（各盤を唯一解に調整）/ 矛盾チェック（行・列・箱・共有）/ 解答トグル
// - エクスポート：PNG（全体, ラベル非表示）＋ JSON（読み込みやすい）
// - 保存：localStorage（キー v5）
// 依存なし（WASM不要）

(() => {
  document.addEventListener('DOMContentLoaded', () => {

    // =========================================================
    // 設定
    // =========================================================
    const GRID = 9;
    const CELL = 30;                 // 1セルの表示サイズ
    const BOARD_PIX = GRID * CELL;   // 1盤の外形ピクセル
    const SNAP_X = CELL;
    const SNAP_Y = CELL * 3;         // 縦は箱境界に沿って3セル単位スナップ
    const MIN_ZOOM = 0.1, MAX_ZOOM = 2.0, ZOOM_STEP = 0.1;
    const FONT = '16px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    const LS_KEY = 'gattai_state_v5';

    // 難易度：残すヒント数（値が大きい＝易しい）
    const HINTS = { easy: 40, normal: 34, hard: 30, expert: 26, extreme: 24 };

    // オーバーラップ部を必ず空欄にするか（既定: false）
    const BAN_OVERLAP_GIVENS = false;

    // =========================================================
    // DOM
    // =========================================================
    const byId = (id) => document.getElementById(id) || null;

    const canvas = byId('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });

    const statusDiv = byId('status');

    const addSquareButton       = byId('addSquareButton');
    const deleteButton          = byId('deleteButton');
    const clearAllBoardsButton  = byId('clearAllBoardsButton');
    const generateProblemButton = byId('generateProblemButton');
    const checkButton           = byId('checkButton');
    const solveButton           = byId('solveButton');
    const exportTextButton      = byId('exportTextButton');
    const exportImageButton     = byId('exportImageButton');   // 全体画像保存（存在すれば使う）
    const difficultySel         = byId('difficulty');

    // ズームUI（存在すれば使う）
    const zoomOutBtn  = byId('zoomOut');
    const zoomInBtn   = byId('zoomIn');
    const zoomFitBtn  = byId('zoomFit');
    const zoom100Btn  = byId('zoom100');
    const zoomPct     = byId('zoomPct');

    // =========================================================
    // 状態
    // =========================================================
    let squares = [];           // {id,x,y,w,h, problemData,userData,solutionData,checkData,_userBackup}
    let activeSquareId = null;
    let activeCell = null;
    let isProblemGenerated = false;
    let showSolution = false;

    // ビューポート
    let zoom = 1.0, panX = 0, panY = 0;
    let devicePR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    let panning = false, isSpaceDown = false, panStart = null;
    let drag = null;

    // =========================================================
    // ユーティリティ
    // =========================================================
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const snap  = (v, u) => Math.round(v / u) * u;
    const createEmptyGrid = () => Array.from({ length: GRID }, () => Array(GRID).fill(0));
    const cloneGrid = (g) => g.map(r => r.slice());
    const setStatus = (msg) => { if (statusDiv) statusDiv.textContent = msg; };

    function nextId(){ let m=0; for(const s of squares) m=Math.max(m, +s.id||0); return String(m+1); }
    function normalizeLayoutFront(sqs){
      return sqs.map(s=>{
        const ox = Math.round(s.x / CELL);
        let oy = Math.round(s.y / CELL); oy -= oy % 3;
        return { id:String(s.id), ox, oy };
      });
    }

    // =========================================================
    // ビューポート（ズーム/パン/フィット）
    // =========================================================
    function applyTransform(){
      ctx.setTransform(devicePR*zoom, 0, 0, devicePR*zoom, devicePR*panX, devicePR*panY);
    }
    function toWorld(mx, my){ return { x:(mx - panX)/zoom, y:(my - panY)/zoom }; }

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
      if (squares.length === 0) return { minX:0, minY:0, maxX:BOARD_PIX, maxY:BOARD_PIX };
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

    // マウスホイール：Ctrl/⌘+ホイール = ズーム、 それ以外 = パン（Shiftで横）
    canvas.addEventListener('wheel', (e)=>{
      const rect = canvas.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey){
        e.preventDefault();
        const mx=e.clientX-rect.left, my=e.clientY-rect.top;
        setZoomAt(zoom * (1 + (-Math.sign(e.deltaY))*0.1), mx, my);
      }else{
        e.preventDefault();
        if (e.shiftKey){
          panX -= e.deltaY;
        }else{
          panX -= e.deltaX; panY -= e.deltaY;
        }
        applyTransform(); draw(); saveState();
      }
    }, { passive:false });

    // 左UI
    zoomOutBtn?.addEventListener('click', ()=> setZoom(zoom - ZOOM_STEP));
    zoomInBtn?.addEventListener('click',  ()=> setZoom(zoom + ZOOM_STEP));
    zoom100Btn?.addEventListener('click', ()=> setZoom(1));
    zoomFitBtn?.addEventListener('click', ()=> fitZoom());

    // ショートカット
    window.addEventListener('keydown', (e)=>{
      if (e.code === 'KeyF'){ e.preventDefault(); fitZoom(); }
      if (e.key === '+' || e.key === '='){ e.preventDefault(); setZoom(zoom + ZOOM_STEP); }
      if (e.key === '-' || e.key === '_'){ e.preventDefault(); setZoom(zoom - ZOOM_STEP); }
    });

    // =========================================================
    // 描画
    // =========================================================
    function draw(){
      // クリア（画面座標）
      ctx.save();
      ctx.setTransform(devicePR,0,0,devicePR,0,0);
      ctx.fillStyle = '#fff';
      ctx.fillRect(0,0,canvas.width,canvas.height);
      ctx.restore();

      // 盤
      applyTransform();
      for (const s of squares) drawBoard(s);

      // セル強調
      if (activeCell){
        const s = squares.find(x => String(x.id) === String(activeCell.id));
        if (s){
          ctx.save();
          ctx.globalAlpha = 0.25;
          ctx.fillStyle = '#66aaff';
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
      ctx.lineWidth = isActive ? 3 : 1.5;
      ctx.strokeRect(s.x-.5, s.y-.5, s.w+1, s.h+1);

      // 細グリッド
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#aaa';
      for (let i=1;i<GRID;i++){
        const gx=s.x+i*CELL, gy=s.y+i*CELL;
        ctx.beginPath(); ctx.moveTo(gx+.5, s.y);    ctx.lineTo(gx+.5, s.y+s.h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(s.x,  gy+.5);   ctx.lineTo(s.x+s.w, gy+.5); ctx.stroke();
      }

      // 太グリッド（3刻み）
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#333';
      for (let i=0;i<=GRID;i+=3){
        const gx=s.x+i*CELL+.5, gy=s.y+i*CELL+.5;
        ctx.beginPath(); ctx.moveTo(gx, s.y);      ctx.lineTo(gx, s.y+s.h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(s.x, gy);      ctx.lineTo(s.x+s.w, gy); ctx.stroke();
      }

      // 数字
      ctx.font = FONT;
      ctx.textAlign='center';
      ctx.textBaseline='middle';
      for (let r=0;r<GRID;r++) for (let c=0;c<GRID;c++){
        const px=s.x+c*CELL+CELL/2, py=s.y+r*CELL+CELL/2;
        const giv=s.problemData[r][c]|0, usr=s.userData[r][c]|0;
        if (giv>0){ ctx.fillStyle='#000'; ctx.fillText(String(giv),px,py); }
        else if (usr>0){
          const bad = ((s.checkData[r][c]|0)===1);
          ctx.fillStyle = bad ? '#d11' : (showSolution ? '#0a0' : '#2b90ff');
          ctx.fillText(String(usr),px,py);
        }
      }

      // タイトルタグ（画面描画時のみ）
      ctx.fillStyle = isActive ? '#2b90ff' : '#666';
      ctx.fillRect(s.x, s.y-18, 30, 18);
      ctx.fillStyle = '#fff';
      ctx.font = '12px system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
      ctx.fillText(s.id, s.x+15, s.y-9);

      ctx.restore();
    }

    // =========================================================
    // ヒット判定
    // =========================================================
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

    // =========================================================
    // 入力（ドラッグ/パン/編集）
    // =========================================================
    canvas.addEventListener('contextmenu', e=>e.preventDefault());

    canvas.addEventListener('mousedown', (e)=>{
      const rect=canvas.getBoundingClientRect();
      const mx=e.clientX-rect.left, my=e.clientY-rect.top;
      const {x:xw,y:yw}=toWorld(mx,my);

      if (isSpaceDown || e.button===1 || e.button===2){
        panning = true;
        panStart = { mx,my, px:panX, py:panY };
        return;
      }

      const s = boardAt(xw,yw);
      if (!s){ activeSquareId=null; activeCell=null; draw(); updateButtonStates(); return; }
      activeSquareId = s.id;
      activeCell = cellAt(s,xw,yw);
      drag = { id:s.id, offsetX:xw-s.x, offsetY:yw-s.y };
      updateButtonStates(); draw();
    });

    canvas.addEventListener('mousemove', (e)=>{
      const rect=canvas.getBoundingClientRect();
      const mx=e.clientX-rect.left, my=e.clientY-rect.top;

      if (panning && panStart){
        panX = panStart.px + (mx - panStart.mx);
        panY = panStart.py + (my - panStart.my);
        applyTransform(); draw();
        return;
      }

      if (!drag) return;
      const {x:xw,y:yw}=toWorld(mx,my);
      const s = squares.find(x=>String(x.id)===String(drag.id));
      if (!s) return;
      let nx = snap(xw - drag.offsetX, SNAP_X);
      let ny = snap(yw - drag.offsetY, SNAP_Y);
      nx = Math.max(0, nx); ny = Math.max(0, ny);
      s.x = nx; s.y = ny; draw();
    });

    window.addEventListener('mouseup', ()=>{
      panning=false; panStart=null; drag=null; saveState();
    });

    window.addEventListener('keydown', (e)=>{
      if (e.code==='Space') isSpaceDown = true;

      if (!isProblemGenerated || !activeCell || showSolution) return;
      const s = squares.find(x => String(x.id)===String(activeCell.id));
      if (!s) return;

      if (e.key>='1'&&e.key<='9'){
        if (s.problemData[activeCell.r][activeCell.c] > 0) return;
        s.userData[activeCell.r][activeCell.c] = parseInt(e.key,10);
        s.checkData[activeCell.r][activeCell.c] = 0;
        draw(); e.preventDefault(); saveState(); return;
      }
      if (e.key==='Backspace' || e.key==='Delete' || e.key==='0'){
        if (s.problemData[activeCell.r][activeCell.c] > 0) return;
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
    window.addEventListener('keyup', (e)=>{ if (e.code==='Space') isSpaceDown=false; });

    // =========================================================
    // ボタン群
    // =========================================================
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

    // 全体画像保存（ラベル非表示）
    exportImageButton?.addEventListener('click', ()=>{
      if (squares.length===0){ alert('まず盤面を追加してください'); return; }
      const {minX,minY,maxX,maxY} = contentBounds();
      const margin = 20;
      const W = Math.ceil((maxX-minX) + margin*2);
      const H = Math.ceil((maxY-minY) + margin*2);
      const scale = 2; // 高解像度で出力

      const c = document.createElement('canvas');
      c.width = Math.floor(W*scale); c.height = Math.floor(H*scale);
      const g = c.getContext('2d');
      g.setTransform(scale,0,0,scale,0,0);
      g.fillStyle='#fff'; g.fillRect(0,0,W,H);

      const drawOne = (s)=>{
        const ox = (s.x - minX) + margin;
        const oy = (s.y - minY) + margin;

        // 外枠
        g.strokeStyle = '#000'; g.lineWidth = 1.5;
        g.strokeRect(ox+.5, oy+.5, s.w-1, s.h-1);

        // 細グリッド
        g.lineWidth=1; g.strokeStyle='#bbb';
        for (let i=1;i<GRID;i++){
          const gx=ox+i*CELL, gy=oy+i*CELL;
          g.beginPath(); g.moveTo(gx+.5, oy); g.lineTo(gx+.5, oy+s.h); g.stroke();
          g.beginPath(); g.moveTo(ox, gy+.5); g.lineTo(ox+s.w, gy+.5); g.stroke();
        }
        // 太グリッド
        g.lineWidth=2; g.strokeStyle='#000';
        for (let i=0;i<=GRID;i+=3){
          const gx=ox+i*CELL+.5, gy=oy+i*CELL+.5;
          g.beginPath(); g.moveTo(gx, oy); g.lineTo(gx, oy+s.h); g.stroke();
          g.beginPath(); g.moveTo(ox, gy); g.lineTo(ox+s.w, gy); g.stroke();
        }
        // 数字（問題のみ）
        g.font = FONT; g.textAlign='center'; g.textBaseline='middle'; g.fillStyle='#000';
        for (let r=0;r<GRID;r++) for (let c0=0;c0<GRID;c0++){
          const v = s.problemData[r][c0]|0;
          if (v>0){
            const px=ox+c0*CELL+CELL/2, py=oy+r*CELL+CELL/2;
            g.fillText(String(v), px, py);
          }
        }
      };

      for (const s of squares) drawOne(s);
      c.toBlob((blob)=>{
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = 'gattai_all.png'; a.click();
        URL.revokeObjectURL(url);
      });
      setStatus('PNG を保存しました');
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

    // =========================================================
    // チェック（行/列/箱/共有）
    // =========================================================
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
      const norm = normalizeLayoutFront(sqs);
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

    // =========================================================
    // 生成（ローカル・唯一解保証/重なり整合）
    // =========================================================
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

      const diff = difficultySel ? String(difficultySel.value||'normal') : 'normal';
      const hintTarget = HINTS[diff] ?? HINTS.normal;

      setStatus(`問題を生成しています…（難易度：${diff}）`);
      generateProblemButton && (generateProblemButton.disabled = true);

      try{
        const boards = generateAllBoardsUnique(hintTarget);
        // 反映
        const map = new Map(boards.map(b=>[String(b.id), b]));
        for (const sq of squares){
          const b = map.get(String(sq.id)); if (!b) continue;
          sq.problemData = cloneGrid(b.grid);
          sq.solutionData = cloneGrid(b.solution);
          sq.userData = createEmptyGrid();
          sq.checkData = createEmptyGrid();
        }
        isProblemGenerated = true;

        // チェック
        for (const s of squares) runCheck(s); runOverlapCheck(); draw();
        const total = countConflicts();
        setStatus(`問題を作成しました！（${boards.length}盤） / 矛盾 ${total} 件${total===0?'（OK）':''}`);
        autoFitIfOverflow(); saveState();
      }catch(e){
        console.error(e);
        alert('生成に失敗しました。ページを更新してもう一度お試しください。');
        setStatus('生成に失敗しました');
      }finally{
        generateProblemButton && (generateProblemButton.disabled = false);
        updateButtonStates(); draw();
      }
    }

    // ---- 解作成の核：グローバルパターン（重なり整合）
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

    // ---- 単盤ソルバ（解の個数を 0/1/2 で返す）
    function countSolutions(grid, limit=2){
      const ROW = Array.from({length:9}, ()=> new Uint16Array(9));
      const COL = Array.from({length:9}, ()=> new Uint16Array(9));
      const BOX = Array.from({length:9}, ()=> new Uint16Array(9));
      const BIT = d => 1<<d; const ALL = 0x3FE;

      // 初期配置
      for (let r=0;r<9;r++) for (let c=0;c<9;c++){
        const v = grid[r][c]|0;
        if (v>0){
          const bi=Math.floor(r/3)*3 + Math.floor(c/3);
          const bit=BIT(v);
          if (ROW[r][v-1] || COL[c][v-1] || BOX[bi][v-1]) return 0; // 既に矛盾
          ROW[r][v-1]=1; COL[c][v-1]=1; BOX[bi][v-1]=1;
        }
      }

      const blanks=[];
      for (let r=0;r<9;r++) for (let c=0;c<9;c++) if (!grid[r][c]) blanks.push([r,c]);

      // MRVソート
      function domainMask(r,c){
        const bi=Math.floor(r/3)*3+Math.floor(c/3);
        let mask=ALL;
        for (let d=1; d<=9; d++){
          if (ROW[r][d-1] || COL[c][d-1] || BOX[bi][d-1]) mask &= ~(1<<d);
        }
        return mask;
      }
      blanks.sort((a,b)=>{
        const da=popcnt(domainMask(a[0],a[1])), db=popcnt(domainMask(b[0],b[1]));
        return da-db;
      });

      let solutions=0;
      (function dfs(k){
        if (solutions>=limit) return;
        if (k===blanks.length){ solutions++; return; }
        const [r,c]=blanks[k];
        const bi=Math.floor(r/3)*3+Math.floor(c/3);
        let mask=domainMask(r,c); if (!mask) return;
        while(mask){
          const d = ctz(mask); mask &= mask-1;
          const bit = 1<<d;
          if (!ROW[r][d-1] && !COL[c][d-1] && !BOX[bi][d-1]){
            ROW[r][d-1]=1; COL[c][d-1]=1; BOX[bi][d-1]=1;
            dfs(k+1);
            ROW[r][d-1]=0; COL[c][d-1]=0; BOX[bi][d-1]=0;
            if (solutions>=limit) return;
          }
        }
      })(0);
      return Math.min(solutions, limit);

      function popcnt(x){ x=x-((x>>>1)&0x55555555); x=(x&0x33333333)+((x>>>2)&0x33333333); return (((x+(x>>>4))&0x0F0F0F0F)*0x01010101)>>>24; }
      function ctz(x){ let n=0; while(((x>>>n)&1)===0) n++; return n; }
    }

    // ---- 対称性（点対称）で削除候補を作り、唯一解を保ったまま削る
    function carveUniqueFromSolved(solved, targetHints, forbidMask=null){
      // forbidMask[r][c] === true のセルはヒントを置かない（=必ず空欄）
      const g = solved.map(r=>r.slice());             // 作業中の盤
      const empty = Array.from({length:9},()=>Array(9).fill(false));

      // まず forbid を空ける
      if (forbidMask){
        for (let r=0;r<9;r++) for (let c=0;c<9;c++){
          if (forbidMask[r][c]){ g[r][c]=0; empty[r][c]=true; }
        }
      }

      // 目標ヒント数（すでに空いている forbid 分を考慮）
      let currentHints = 81 - countZeros(g);
      const target = Math.max(17, Math.min(81, targetHints)); // 安全下限

      // 候補ペア（点対称）
      const pairs = [];
      for (let r=0;r<9;r++) for (let c=0;c<9;c++){
        const or=8-r, oc=8-c;
        if (r>or || (r===or && c>oc)) continue; // 重複回避
        pairs.push([r,c,or,oc]);
      }
      shuffle(pairs);

      // 一意性を維持しながら削る
      for (const [r,c,or,oc] of pairs){
        if (currentHints <= target) break;

        // 既に空 or forbid はスキップ
        if (!g[r][c] && !g[or][oc]) continue;
        if ((forbidMask && (forbidMask[r]?.[c])) || (forbidMask && (forbidMask[or]?.[oc]))) continue;

        // 試しに空ける
        const keep1=g[r][c], keep2=g[or][oc];
        g[r][c]=0; g[or][oc]=0;

        // 唯一性判定
        if (countSolutions(g, 2) === 1){
          currentHints -= (r===or && c===oc) ? 1 : 2;
          // 採用
        }else{
          // 戻す
          g[r][c]=keep1; g[or][oc]=keep2;
        }
      }

      // まだヒントが多すぎる場合、片側だけ削ることも試す
      if (currentHints > target){
        const singles=[];
        for (let r=0;r<9;r++) for (let c=0;c<9;c++){
          if (g[r][c] && !(forbidMask && forbidMask[r]?.[c])) singles.push([r,c]);
        }
        shuffle(singles);
        for (const [r,c] of singles){
          if (currentHints<=target) break;
          const keep=g[r][c]; g[r][c]=0;
          if (countSolutions(g,2)===1){ currentHints--; } else { g[r][c]=keep; }
        }
      }

      return g;

      function countZeros(mat){
        let z=0; for (let r=0;r<9;r++) for (let c=0;c<9;c++) if (!mat[r][c]) z++; return z;
      }
    }

    // ---- 全盤生成（重なり禁止マスクを作って盤ごとに carve）
    function generateAllBoardsUnique(targetHints){
      if (squares.length===0) throw new Error('no boards');
      const layout = normalizeLayoutFront(squares);
      const pattern = makeGlobalPattern();

      // 解（重なり整合）
      const solved = layout.map(({ox,oy}) =>
        Array.from({length:9}, (_,r) =>
          Array.from({length:9}, (_,c) => pattern.valueAt(oy+r, ox+c))
        )
      );

      // forbid（オーバーラップを空欄にしたい場合のみ）
      const overlaps = buildOverlapsClient(squares);
      const forbids = Array.from({length:squares.length}, ()=> Array.from({length:9},()=>Array(9).fill(false)));
      if (BAN_OVERLAP_GIVENS){
        for (const {i,j,cells} of overlaps){
          for (const {r,c,r2,c2} of cells){ forbids[i][r][c]=true; forbids[j][r2][c2]=true; }
        }
      }

      // 各盤を carve（唯一解保証）
      const puzzles = solved.map((sol, idx)=> carveUniqueFromSolved(sol, targetHints, forbids[idx]));

      // 仕上げ：盤ごとのヒント数差を緩和（バランス）
      balanceHintCounts(puzzles, solved, forbids, targetHints);

      // 返却
      return layout.map((o,idx)=>({ id:squares[idx].id, x:o.ox*CELL, y:o.oy*CELL, grid:puzzles[idx], solution:solved[idx] }));
    }

    function balanceHintCounts(puzzles, solved, forbids, target){
      // 各盤のヒント数が極端にならないよう、±3程度に寄せる
      const hints = puzzles.map(p => 81 - countZeros(p));
      const avg = hints.reduce((a,b)=>a+b,0)/hints.length;
      for (let pass=0; pass<2; pass++){
        for (let i=0;i<puzzles.length;i++){
          if (hints[i] > Math.max(target, Math.round(avg)+3)){
            // 少し削る
            const p=puzzles[i], sol=solved[i], fb=forbids[i];
            const singles=[];
            for (let r=0;r<9;r++) for (let c=0;c<9;c++){
              if (p[r][c] && !(fb && fb[r][c])) singles.push([r,c]);
            }
            shuffle(singles);
            for (const [r,c] of singles){
              if (hints[i] <= Math.max(target, Math.round(avg)+3)) break;
              const keep=p[r][c]; p[r][c]=0;
              if (countSolutions(p,2)===1) hints[i]--; else p[r][c]=keep;
            }
          }
        }
      }
      function countZeros(mat){ let z=0; for (let r=0;r<9;r++) for (let c=0;c<9;c++) if (!mat[r][c]) z++; return z; }
    }

    // =========================================================
    // 保存/復元/初期化
    // =========================================================
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
      setStatus('盤を追加 →「合体問題を作成」。Space/右ドラッグでパン、Ctrl+ホイールでズーム、ホイールで移動（Shiftで横）。');
      applyTransform(); draw();
    }else{
      setStatus(isProblemGenerated ? 'プレイ再開できます' : 'レイアウトを復元しました（縦は3セル単位でスナップ）');
      applyTransform(); draw();
    }
    updateButtonStates();
  });
})();
