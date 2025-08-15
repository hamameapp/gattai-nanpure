// script.js — フロント（Cloudflare Pages）
// ・複数9x9盤のレイアウト→/api/generate で合体生成
// ・「解答を表示」トグル対応（サーバ返却の solution を利用）
// ・ズーム（±ボタン/ホイール/フィット）対応
// ・共有マス矛盾チェック、オートセーブ付き
// ・「入力クリア」を削除し、「すべてクリア」を追加

(() => {
  document.addEventListener('DOMContentLoaded', () => {
    // ===== DOM =====
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });

    const statusDiv = document.getElementById('status');
    const addSquareButton = byId('addSquareButton');
    const deleteButton = byId('deleteButton');
    const clearAllBoardsButton = byId('clearAllBoardsButton');
    const generateProblemButton = byId('generateProblemButton');
    const checkButton = byId('checkButton');
    const solveButton = byId('solveButton');
    const exportTextButton = byId('exportTextButton');
    const difficultySel = document.getElementById('difficulty');

    // ズーム系
    const zoomOutBtn = byId('zoomOut');
    const zoomInBtn = byId('zoomIn');
    const zoomFitBtn = byId('zoomFit');
    const zoom100Btn = byId('zoom100');
    const zoomPct = byId('zoomPct');

    // ===== 定数 =====
    const GRID = 9;
    const CELL = 30;              // ★サーバの CELL_PX=30 と一致
    const BOARD_PIX = GRID * CELL;
    const SNAP = CELL;            // 1マス単位
    const FONT = '16px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';

    const MIN_ZOOM = 0.5, MAX_ZOOM = 2.0, ZOOM_STEP = 0.1;

    // ===== 状態 =====
    let squares = []; // {id,x,y,w,h,problemData,userData,checkData,solutionData,_userBackup?}
    let isProblemGenerated = false;
    let editMode = true;
    let activeSquareId = null;
    let activeCell = null;
    let drag = null;

    let zoom = 1.0;
    let devicePR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));

    let showSolution = false;

    // ===== ユーティリティ =====
    function byId(id) { return document.getElementById(id) || null; }
    function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
    function snap(v, unit) { return Math.round(v / unit) * unit; }
    function createEmptyGrid() { return Array.from({ length: GRID }, () => Array(GRID).fill(0)); }
    function cloneGrid(g) { return g.map(r => r.slice()); }
    function nextId() { let m=0; for (const s of squares) m=Math.max(m, +s.id||0); return String(m+1); }
    function newSquare(x, y) {
      const id = nextId();
      return { id, x, y, w: BOARD_PIX, h: BOARD_PIX,
        problemData:createEmptyGrid(), userData:createEmptyGrid(),
        checkData:createEmptyGrid(), solutionData:createEmptyGrid() };
    }
    function setStatus(msg){ if (statusDiv) statusDiv.textContent = msg; }
    function updateButtonStates(){
      if (generateProblemButton) generateProblemButton.disabled = squares.length === 0;
      if (deleteButton) deleteButton.disabled = activeSquareId == null;
      if (clearAllBoardsButton) clearAllBoardsButton.disabled = squares.length === 0;
      if (checkButton) checkButton.disabled = !isProblemGenerated || showSolution; // 解答表示中は無効
      if (exportTextButton) exportTextButton.disabled = squares.length === 0;
      if (solveButton) {
        solveButton.disabled = !isProblemGenerated;
        solveButton.textContent = showSolution ? '解答を隠す' : '解答を表示';
      }
      if (zoomPct) zoomPct.textContent = `${Math.round(zoom*100)}%`;
    }

    // ===== ズーム/座標変換 =====
    function applyTransform(){ ctx.setTransform(devicePR * zoom, 0, 0, devicePR * zoom, 0, 0); }
    function toWorld(mx, my){ return { x: mx / zoom, y: my / zoom }; }
    function setZoom(z){ zoom = clamp(z, MIN_ZOOM, MAX_ZOOM); applyTransform(); draw(); updateButtonStates(); saveState(); }
    function fitZoom(){
      if (squares.length === 0) { setZoom(1); return; }
      let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
      for (const s of squares) { minX=Math.min(minX,s.x); minY=Math.min(minY,s.y); maxX=Math.max(maxX,s.x+s.w); maxY=Math.max(maxY,s.y+s.h); }
      const rect = canvas.getBoundingClientRect();
      const margin = 40;
      const scaleX = (rect.width - margin)/Math.max(1, (maxX-minX));
      const scaleY = (rect.height - margin)/Math.max(1, (maxY-minY));
      const target = clamp(Math.min(scaleX, scaleY), MIN_ZOOM, MAX_ZOOM);
      setZoom(target);
    }

    // UI: ズーム操作
    byId('zoomOut')?.addEventListener('click', () => setZoom(zoom - ZOOM_STEP));
    byId('zoomIn')?.addEventListener('click', () => setZoom(zoom + ZOOM_STEP));
    byId('zoom100')?.addEventListener('click', () => setZoom(1));
    byId('zoomFit')?.addEventListener('click', fitZoom);
    canvas.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); const dir = -Math.sign(e.deltaY); setZoom(zoom * (1 + dir * 0.1)); }
    }, { passive:false });

    // ===== 描画 =====
    function draw(){
      // 背景クリア
      ctx.save(); ctx.setTransform(devicePR,0,0,devicePR,0,0); ctx.fillStyle = '#ffffff'; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.restore();
      applyTransform();

      // 共有領域の薄ハイライト（編集中のみ）
      if (editMode) drawOverlapHints();

      for (const s of squares) drawBoard(s);

      if (activeCell && !editMode) {
        const s = squares.find(x => String(x.id) === String(activeCell.id));
        if (s) {
          ctx.save(); ctx.globalAlpha = 0.25; ctx.fillStyle = '#66aaff';
          const x = s.x + activeCell.c * CELL, y = s.y + activeCell.r * CELL;
          ctx.fillRect(x, y, CELL, CELL); ctx.restore();
        }
      }
    }

    function drawBoard(s){
      ctx.save();
      const isActive = String(s.id) === String(activeSquareId);

      // 外枠
      ctx.strokeStyle = isActive ? '#2b90ff' : '#222';
      ctx.lineWidth = isActive ? 3 : 1.5;
      ctx.strokeRect(s.x - 0.5, s.y - 0.5, s.w + 1, s.h + 1);

      // 格子
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#aaa';
      for (let i = 1; i < GRID; i++) {
        const gx = s.x + i * CELL, gy = s.y + i * CELL;
        ctx.beginPath(); ctx.moveTo(gx + 0.5, s.y); ctx.lineTo(gx + 0.5, s.y + s.h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(s.x, gy + 0.5); ctx.lineTo(s.x + s.w, gy + 0.5); ctx.stroke();
      }

      // 太線（3x3）
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#333';
      for (let i = 0; i <= GRID; i += 3) {
        const gx = s.x + i * CELL + 0.5, gy = s.y + i * CELL + 0.5;
        ctx.beginPath(); ctx.moveTo(gx, s.y); ctx.lineTo(gx, s.y + s.h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(s.x, gy); ctx.lineTo(s.x + s.w, gy); ctx.stroke();
      }

      // 数字
      ctx.font = FONT;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      for (let r=0;r<GRID;r++){
        for (let c=0;c<GRID;c++){
          const px = s.x + c*CELL + CELL/2, py = s.y + r*CELL + CELL/2;
          const giv = s.problemData[r][c] | 0;
          const usr = s.userData[r][c] | 0;
          if (giv > 0) {
            ctx.fillStyle = '#000'; ctx.fillText(String(giv), px, py);
          } else if (usr > 0) {
            const bad = (!showSolution) && ((s.checkData[r][c] | 0) === 1); // 解答表示中は矛盾表示しない
            ctx.fillStyle = bad ? '#d11' : (showSolution ? '#0a0' : '#2b90ff');
            ctx.fillText(String(usr), px, py);
          }
        }
      }

      // IDラベル
      ctx.fillStyle = isActive ? '#2b90ff' : '#666';
      ctx.fillRect(s.x, s.y - 18, 30, 18);
      ctx.fillStyle = '#fff';
      ctx.font = '12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(s.id, s.x + 15, s.y - 9);

      ctx.restore();
    }

    // 共有領域の薄ハイライト
    function drawOverlapHints(){
      const overlaps = buildOverlapsClient(squares);
      ctx.save(); ctx.globalAlpha = 0.12; ctx.fillStyle = '#00aa88';
      for (const { i, cells } of overlaps) {
        const A = squares[i];
        for (const { r, c } of cells) {
          const x = A.x + c * CELL, y = A.y + r * CELL;
          ctx.fillRect(x, y, CELL, CELL);
        }
      }
      ctx.restore();
    }

    // ===== ヒット判定（ズーム考慮）=====
    function boardAtWorld(xw, yw){
      for (let i=squares.length-1;i>=0;i--){
        const s = squares[i];
        if (xw>=s.x && xw<s.x+s.w && yw>=s.y && yw<s.y+s.h) return s;
      }
      return null;
    }
    function cellAtWorld(s, xw, yw){
      if (!s) return null;
      const cx = Math.floor((xw - s.x) / CELL), cy = Math.floor((yw - s.y) / CELL);
      if (cx<0||cy<0||cx>=GRID||cy>=GRID) return null;
      return { id:s.id, r:cy, c:cx };
    }

    // ===== 入力（マウス：ズーム考慮）=====
    canvas.addEventListener('mousedown', (e)=>{
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const { x:xw, y:yw } = toWorld(mx, my);
      const s = boardAtWorld(xw, yw);
      if (editMode) {
        if (!s) { activeSquareId = null; activeCell = null; draw(); updateButtonStates(); return; }
        activeSquareId = s.id; activeCell=null;
        drag = { id:s.id, offsetX: xw - s.x, offsetY: yw - s.y }; // world座標
      } else {
        if (!s) { activeSquareId = null; activeCell = null; draw(); updateButtonStates(); return; }
        activeSquareId = s.id; activeCell = cellAtWorld(s, xw, yw); draw();
      }
      updateButtonStates();
    });

    canvas.addEventListener('mousemove', (e)=>{
      if (!drag || !editMode) return;
      const s = squares.find(x => String(x.id) === String(drag.id));
      if (!s) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const { x:xw, y:yw } = toWorld(mx, my);
      let nx = snap(xw - drag.offsetX, SNAP), ny = snap(yw - drag.offsetY, SNAP);
      nx = clamp(nx, 0, (canvas.width/devicePR/zoom) - s.w);
      ny = clamp(ny, 0, (canvas.height/devicePR/zoom) - s.h);
      s.x = nx; s.y = ny; draw();
    });

    window.addEventListener('mouseup', () => { if (drag) saveState(); drag=null; });

    // ===== 入力（キーボード：プレイ）=====
    window.addEventListener('keydown', (e)=>{
      if (editMode || !isProblemGenerated || !activeCell || showSolution) return;
      const s = squares.find(x => String(x.id) === String(activeCell.id));
      if (!s) return;
      if (s.problemData[activeCell.r][activeCell.c] > 0) return;

      if (e.key >= '1' && e.key <= '9') {
        s.userData[activeCell.r][activeCell.c] = parseInt(e.key,10);
        s.checkData[activeCell.r][activeCell.c] = 0;
        draw(); e.preventDefault(); saveState(); return;
      }
      if (e.key === 'Backspace' || e.key === 'Delete' || e.key === '0') {
        s.userData[activeCell.r][activeCell.c] = 0;
        s.checkData[activeCell.r][activeCell.c] = 0;
        draw(); e.preventDefault(); saveState(); return;
      }
      const mv = { ArrowUp:[-1,0], ArrowDown:[1,0], ArrowLeft:[0,-1], ArrowRight:[0,1] }[e.key];
      if (mv) { const nr=clamp(activeCell.r+mv[0],0,GRID-1), nc=clamp(activeCell.c+mv[1],0,GRID-1); activeCell={ id:activeCell.id, r:nr, c:nc }; draw(); e.preventDefault(); }
    });

    // ===== ボタン =====
    addSquareButton?.addEventListener('click', ()=>{
      const count=squares.length, col=count%4, row=Math.floor(count/4);
      const margin=18;
      const nx = snap(margin + col*(BOARD_PIX+margin), SNAP);
      const ny = snap(40 + row*(BOARD_PIX+margin), SNAP);
      const s = newSquare(nx, ny);
      squares.push(s);
      activeSquareId=s.id; isProblemGenerated=false; showSolution=false;
      setStatus('盤を追加しました'); updateButtonStates(); draw(); saveState();
    });

    deleteButton?.addEventListener('click', ()=>{
      if (activeSquareId==null) return;
      squares = squares.filter(s=>String(s.id)!==String(activeSquareId));
      activeSquareId=null; activeCell=null;
      isProblemGenerated = squares.length>0 && isProblemGenerated;
      showSolution=false;
      setStatus('選択中の盤を削除しました'); updateButtonStates(); draw(); saveState();
    });

    clearAllBoardsButton?.addEventListener('click', ()=>{
      if (!confirm('配置した盤面をすべて削除します。よろしいですか？')) return;
      squares = []; activeSquareId=null; activeCell=null;
      isProblemGenerated=false; showSolution=false;
      setStatus('すべての盤面をクリアしました'); updateButtonStates(); draw(); saveState();
    });

    generateProblemButton?.addEventListener('click', handleGenerateProblem);

    checkButton?.addEventListener('click', ()=>{
      if (!isProblemGenerated || showSolution) return;
      for (const s of squares) runCheck(s);
      runOverlapCheck();
      setStatus('チェック完了：赤は矛盾（行/列/ブロック/共有マス）');
      draw();
    });

    // ★解答表示トグル（表示中はチェック無効＆赤表示しない）
    solveButton?.addEventListener('click', ()=>{
      if (!isProblemGenerated) return;
      const missing = squares.some(s=>!s.solutionData || s.solutionData.length!==9);
      if (missing) { alert('解答データがありません（サーバを更新してください）'); return; }

      if (!showSolution) {
        for (const s of squares) {
          s._userBackup = cloneGrid(s.userData);
          for (let r=0;r<GRID;r++) for (let c=0;c<GRID;c++){
            if (s.problemData[r][c]===0) s.userData[r][c] = s.solutionData[r][c];
          }
          s.checkData = createEmptyGrid(); // 解答中は矛盾を消す
        }
        showSolution = true;
        setStatus('解答を表示中');
      } else {
        for (const s of squares) { if (s._userBackup) s.userData = s._userBackup; s._userBackup=null; }
        showSolution = false;
        setStatus('解答を隠しました');
      }
      updateButtonStates(); draw(); saveState();
    });

    exportTextButton?.addEventListener('click', ()=>{
      const data = {
        layout: squares.map(s=>({ id:s.id, x:s.x, y:s.y })),
        boards: squares.map(s=>({ id:s.id, problem:s.problemData, user:s.userData, solution:s.solutionData }))
      };
      const blob = new Blob([JSON.stringify(data,null,2)], { type:'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href=url; a.download='gattai_export.json'; a.click();
      URL.revokeObjectURL(url);
    });

    // ===== サーバ生成 =====
    async function handleGenerateProblem(){
      if (squares.length===0) { alert('まず「盤面を追加」してください'); return; }
      for (const sq of squares){
        sq.problemData=createEmptyGrid();
        sq.userData=createEmptyGrid();
        sq.checkData=createEmptyGrid();
        sq.solutionData=createEmptyGrid();
        sq._userBackup=null;
      }
      showSolution=false; isProblemGenerated=false; updateButtonStates(); draw();

      try{
        generateProblemButton.disabled=true;
        const diff = difficultySel ? String(difficultySel.value||'normal') : 'normal';
        setStatus(`問題を生成しています...（難易度: ${diff}）`);
        const layout = squares.map(s=>({ id:String(s.id), x:Math.round(s.x), y:Math.round(s.y) }));
        const boards = await generateFromServer(layout, /*adShown=*/false, diff);
        renderBoards(boards);
        isProblemGenerated=true;
        setStatus(`問題を作成しました！（${boards.length}盤）`);
        saveState();
      } catch(err){
        console.error(err);
        alert(err?.message || 'サーバ生成に失敗しました');
        setStatus('サーバ生成に失敗しました');
      } finally {
        generateProblemButton.disabled=false; updateButtonStates(); draw();
      }
    }

    async function generateFromServer(layout, adShown=false, difficulty='normal'){
      const res = await fetch('/api/generate', {
        method:'POST',
        headers:{ 'content-type':'application/json' },
        body: JSON.stringify({ layout, adShown, difficulty })
      });
      if (!res.ok) { const t = await safeText(res); throw new Error(`APIエラー: ${res.status} ${t}`); }
      const data = await res.json();
      if (!data?.ok) throw new Error(data?.reason || 'ok=false');
      return data.puzzle?.boards || [];
    }
    async function safeText(res){ try{ return await res.text(); } catch{ return ''; } }

    function renderBoards(boards){
      const map = new Map(boards.map(b=>[String(b.id), b]));
      for (const sq of squares){
        const b = map.get(String(sq.id)); if (!b) continue;
        sq.problemData = cloneGrid(b.grid);
        sq.solutionData = cloneGrid(b.solution || createEmptyGrid());
        sq.userData = createEmptyGrid();
        sq.checkData = createEmptyGrid();
      }
      updateButtonStates(); draw();
    }

    // ===== 単盤チェック =====
    function runCheck(sq){
      sq.checkData = createEmptyGrid();
      const val = (r,c)=> (sq.userData[r][c] || sq.problemData[r][c] || 0);
      // 行
      for (let r=0;r<GRID;r++){
        const seen=new Map();
        for (let c=0;c<GRID;c++){
          const v=val(r,c); if (v===0) continue;
          if (seen.has(v)){ sq.checkData[r][c]=1; const [rr,cc]=seen.get(v); sq.checkData[rr][cc]=1; }
          else seen.set(v,[r,c]);
        }
      }
      // 列
      for (let c=0;c<GRID;c++){
        const seen=new Map();
        for (let r=0;r<GRID;r++){
          const v=val(r,c); if (v===0) continue;
          if (seen.has(v)){ sq.checkData[r][c]=1; const [rr,cc]=seen.get(v); sq.checkData[rr][cc]=1; }
          else seen.set(v,[r,c]);
        }
      }
      // ブロック
      for (let br=0;br<GRID;br+=3){
        for (let bc=0;bc<GRID;bc+=3){
          const seen=new Map();
          for (let dr=0;dr<3;dr++) for (let dc=0;dc<3;dc++){
            const r=br+dr, c=bc+dc;
            const v=val(r,c); if (v===0) continue;
            if (seen.has(v)){ sq.checkData[r][c]=1; const [rr,cc]=seen.get(v); sq.checkData[rr][cc]=1; }
            else seen.set(v,[r,c]);
          }
        }
      }
    }

    // ===== 合体ルール違反チェック（共有マス不一致）=====
    function buildOverlapsClient(sqs){
      const norm = sqs.map(s=>({ id:String(s.id), ox:Math.round(s.x/CELL), oy:Math.round(s.y/CELL) }));
      const n = norm.length, overlaps=[];
      for (let i=0;i<n;i++) for (let j=i+1;j<n;j++){
        const A=norm[i], B=norm[j];
        const R0=Math.max(0, B.oy-A.oy), C0=Math.max(0, B.ox-A.ox);
        const R1=Math.min(8, (B.oy+8)-A.oy), C1=Math.min(8, (B.ox+8)-A.ox);
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
      const val = (sq,r,c)=>(sq.userData[r][c] || sq.problemData[r][c] || 0);
      for (const { i,j,cells } of overlaps){
        const A=squares[i], B=squares[j];
        for (const { r,c,r2,c2 } of cells){
          const va=val(A,r,c), vb=val(B,r2,c2);
          if (va!==0 && vb!==0 && va!==vb){ A.checkData[r][c]=1; B.checkData[r2][c2]=1; }
        }
      }
    }

    // ===== オートセーブ/復元 =====
    function saveState(){
      try{
        const payload = {
          zoom,
          squares: squares.map(s=>({
            id:s.id, x:s.x, y:s.y,
            problemData:s.problemData, userData:s.userData, solutionData:s.solutionData
          })),
          isProblemGenerated, showSolution, ts:Date.now()
        };
        localStorage.setItem('gattai_state_v3', JSON.stringify(payload));
      }catch{}
    }
    function loadState(){
      try{
        const raw = localStorage.getItem('gattai_state_v3'); if (!raw) return false;
        const obj = JSON.parse(raw); if (!obj || !Array.isArray(obj.squares)) return false;
        zoom = clamp(Number(obj.zoom)||1, MIN_ZOOM, MAX_ZOOM);
        squares = obj.squares.map(o=>({
          id:o.id, x:o.x, y:o.y, w:BOARD_PIX, h:BOARD_PIX,
          problemData:o.problemData||createEmptyGrid(),
          userData:o.userData||createEmptyGrid(),
          solutionData:o.solutionData||createEmptyGrid(),
          checkData:createEmptyGrid(), _userBackup:null
        }));
        isProblemGenerated = !!obj.isProblemGenerated && squares.length>0;
        showSolution = !!obj.showSolution && isProblemGenerated;
        if (showSolution) {
          // safety: 解答を再合成（与え以外を solution で埋める）
          for (const s of squares) {
            for (let r=0;r<GRID;r++) for (let c=0;c<GRID;c++){
              if (s.problemData[r][c]===0) s.userData[r][c] = s.solutionData[r][c];
            }
            s.checkData = createEmptyGrid();
          }
        }
        applyTransform(); return true;
      }catch{ return false; }
    }

    // ===== キャンバスDPR追従 =====
    function resizeCanvasToDisplaySize(){
      const rect = canvas.getBoundingClientRect();
      const w = Math.max(600, Math.floor(rect.width));
      const h = Math.max(450, Math.floor(rect.height));
      devicePR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      const displayW = Math.floor(w * devicePR), displayH = Math.floor(h * devicePR);
      if (canvas.width !== displayW || canvas.height !== displayH){
        canvas.width = displayW; canvas.height = displayH;
        applyTransform(); draw();
      }
    }
    window.addEventListener('resize', ()=>{ resizeCanvasToDisplaySize(); draw(); });

    // ===== 初期化 =====
    resizeCanvasToDisplaySize();
    if (!loadState()) { setStatus('レイアウト編集モード：盤を追加して配置してください'); applyTransform(); }
    else { setStatus(isProblemGenerated ? (showSolution?'解答表示中':'プレイ再開できます') : 'レイアウトは復元されました'); }
    updateButtonStates(); draw();
  });
})();
