// script.js — フロント（Cloudflare Pages）
// ・/api/generate → 失敗時はローカル生成に自動フォールバック
// ・解答トグル、チェック、ズーム
// ・「すべてクリア」で localStorage も消す
// ・保存キー: v4

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
    const CELL = 30;  // ★サーバの CELL_PX=30 と一致
    const BOARD_PIX = GRID * CELL;
    const SNAP = CELL;
    const FONT = '16px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';

    const MIN_ZOOM = 0.5, MAX_ZOOM = 2.0, ZOOM_STEP = 0.1;
    const LS_KEY = 'gattai_state_v4';

    // ===== 状態 =====
    let squares = [];
    let isProblemGenerated = false;
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
        checkData:createEmptyGrid(), solutionData:createEmptyGrid(), _userBackup:null };
    }
    function setStatus(msg){ if (statusDiv) statusDiv.textContent = msg; }
    function updateButtonStates(){
      zoomPct && (zoomPct.textContent = `${Math.round(zoom*100)}%`);
      generateProblemButton && (generateProblemButton.disabled = squares.length === 0);
      deleteButton && (deleteButton.disabled = activeSquareId == null);
      clearAllBoardsButton && (clearAllBoardsButton.disabled = squares.length === 0);
      checkButton && (checkButton.disabled = !isProblemGenerated || showSolution);
      exportTextButton && (exportTextButton.disabled = squares.length === 0);
      if (solveButton) { solveButton.disabled = !isProblemGenerated; solveButton.textContent = showSolution ? '解答を隠す' : '解答を表示'; }
    }

    // ===== ズーム =====
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
      setZoom(Math.min(scaleX, scaleY));
    }
    zoomOutBtn?.addEventListener('click', () => setZoom(zoom - ZOOM_STEP));
    zoomInBtn?.addEventListener('click', () => setZoom(zoom + ZOOM_STEP));
    zoom100Btn?.addEventListener('click', () => setZoom(1));
    zoomFitBtn?.addEventListener('click', fitZoom);
    canvas.addEventListener('wheel', (e) => {
      if (e.ctrlKey || e.metaKey) { e.preventDefault(); const dir = -Math.sign(e.deltaY); setZoom(zoom * (1 + dir * 0.1)); }
    }, { passive:false });

    // ===== 描画 =====
    function draw(){
      ctx.save(); ctx.setTransform(devicePR,0,0,devicePR,0,0); ctx.fillStyle='#fff'; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.restore();
      applyTransform();
      for (const s of squares) drawBoard(s);
      if (activeCell) {
        const s = squares.find(x => String(x.id) === String(activeCell.id));
        if (s) { ctx.save(); ctx.globalAlpha=.25; ctx.fillStyle='#66aaff';
          const x=s.x + activeCell.c*CELL, y=s.y + activeCell.r*CELL; ctx.fillRect(x,y,CELL,CELL); ctx.restore(); }
      }
    }
    function drawBoard(s){
      ctx.save();
      const isActive = String(s.id) === String(activeSquareId);
      ctx.strokeStyle = isActive ? '#2b90ff' : '#222';
      ctx.lineWidth = isActive ? 3 : 1.5;
      ctx.strokeRect(s.x - .5, s.y - .5, s.w + 1, s.h + 1);
      ctx.lineWidth = 1; ctx.strokeStyle='#aaa';
      for (let i=1;i<GRID;i++){
        const gx=s.x+i*CELL, gy=s.y+i*CELL;
        ctx.beginPath(); ctx.moveTo(gx+.5,s.y); ctx.lineTo(gx+.5,s.y+s.h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(s.x,gy+.5); ctx.lineTo(s.x+s.w,gy+.5); ctx.stroke();
      }
      ctx.lineWidth=2; ctx.strokeStyle='#333';
      for (let i=0;i<=GRID;i+=3){
        const gx=s.x+i*CELL+.5, gy=s.y+i*CELL+.5;
        ctx.beginPath(); ctx.moveTo(gx,s.y); ctx.lineTo(gx,s.y+s.h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(s.x,gy); ctx.lineTo(s.x+s.w,gy); ctx.stroke();
      }
      ctx.font = FONT; ctx.textAlign='center'; ctx.textBaseline='middle';
      for (let r=0;r<GRID;r++) for (let c=0;c<GRID;c++){
        const px=s.x+c*CELL+CELL/2, py=s.y+r*CELL+CELL/2;
        const giv=s.problemData[r][c]|0, usr=s.userData[r][c]|0;
        if (giv>0){ ctx.fillStyle='#000'; ctx.fillText(String(giv),px,py); }
        else if (usr>0){ const bad = (!showSolution) && ((s.checkData[r][c]|0)===1);
          ctx.fillStyle = bad ? '#d11' : (showSolution ? '#0a0' : '#2b90ff');
          ctx.fillText(String(usr),px,py);
        }
      }
      ctx.fillStyle = isActive ? '#2b90ff' : '#666';
      ctx.fillRect(s.x, s.y-18, 30, 18);
      ctx.fillStyle='#fff'; ctx.font='12px system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
      ctx.fillText(s.id, s.x+15, s.y-9);
      ctx.restore();
    }

    // ===== ヒット判定 =====
    function boardAt(x,y){ for (let i=squares.length-1;i>=0;i--){ const s=squares[i]; if (x>=s.x&&x<s.x+s.w&&y>=s.y&&y<s.y+s.h) return s; } return null; }
    function cellAt(s,x,y){ if(!s) return null; const cx=Math.floor((x-s.x)/CELL), cy=Math.floor((y-s.y)/CELL);
      if (cx<0||cy<0||cx>=GRID||cy>=GRID) return null; return { id:s.id, r:cy, c:cx }; }

    // ===== 入力 =====
    canvas.addEventListener('mousedown',(e)=>{
      const rect=canvas.getBoundingClientRect();
      const {x:xw,y:yw}=toWorld(e.clientX-rect.left, e.clientY-rect.top);
      const s=boardAt(xw,yw);
      if (!s){ activeSquareId=null; activeCell=null; draw(); updateButtonStates(); return; }
      activeSquareId=s.id; activeCell=cellAt(s,xw,yw);
      drag={ id:s.id, offsetX:xw-s.x, offsetY:yw-s.y };
      updateButtonStates(); draw();
    });
    canvas.addEventListener('mousemove',(e)=>{
      if (!drag) return;
      const s=squares.find(x=>String(x.id)===String(drag.id)); if(!s) return;
      const rect=canvas.getBoundingClientRect();
      const {x:xw,y:yw}=toWorld(e.clientX-rect.left, e.clientY-rect.top);
      let nx=snap(xw-drag.offsetX,SNAP), ny=snap(yw-drag.offsetY,SNAP);
      nx=clamp(nx,0,(canvas.width/devicePR/zoom)-s.w);
      ny=clamp(ny,0,(canvas.height/devicePR/zoom)-s.h);
      s.x=nx; s.y=ny; draw();
    });
    window.addEventListener('mouseup',()=>{ drag=null; saveState(); });

    window.addEventListener('keydown',(e)=>{
      if (!isProblemGenerated || !activeCell || showSolution) return;
      const s=squares.find(x=>String(x.id)===String(activeCell.id)); if(!s) return;
      if (s.problemData[activeCell.r][activeCell.c] > 0) return;
      if (e.key>='1'&&e.key<='9'){ s.userData[activeCell.r][activeCell.c]=parseInt(e.key,10); s.checkData[activeCell.r][activeCell.c]=0; draw(); e.preventDefault(); saveState(); return; }
      if (e.key==='Backspace'||e.key==='Delete'||e.key==='0'){ s.userData[activeCell.r][activeCell.c]=0; s.checkData[activeCell.r][activeCell.c]=0; draw(); e.preventDefault(); saveState(); return; }
      const mv={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1]}[e.key];
      if (mv){ const nr=clamp(activeCell.r+mv[0],0,GRID-1), nc=clamp(activeCell.c+mv[1],0,GRID-1); activeCell={ id:activeCell.id, r:nr, c:nc }; draw(); e.preventDefault(); }
    });

    // ===== ボタン =====
    addSquareButton?.addEventListener('click', ()=>{
      const count=squares.length, col=count%4, row=Math.floor(count/4), m=18;
      const s=newSquare(snap(m+col*(BOARD_PIX+m),SNAP), snap(40+row*(BOARD_PIX+m),SNAP));
      squares.push(s); activeSquareId=s.id; isProblemGenerated=false; showSolution=false;
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
      squares=[]; activeSquareId=null; activeCell=null; isProblemGenerated=false; showSolution=false;
      localStorage.removeItem(LS_KEY);
      setStatus('すべての盤面をクリアしました'); updateButtonStates(); draw();
    });

    checkButton?.addEventListener('click', ()=>{
      if (!isProblemGenerated || showSolution) return;
      for (const s of squares) runCheck(s);
      runOverlapCheck();
      setStatus('チェック完了：赤は矛盾（行/列/ブロック/共有マス）');
      draw();
    });

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
          s.checkData = createEmptyGrid();
        }
        showSolution = true; setStatus('解答を表示中');
      } else {
        for (const s of squares) { if (s._userBackup) s.userData = s._userBackup; s._userBackup=null; }
        showSolution = false; setStatus('解答を隠しました');
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
      const a = document.createElement('a'); a.href=url; a.download='gattai_export.json'; a.click(); URL.revokeObjectURL(url);
    });

    // ===== サーバ生成 + フォールバック =====
    async function handleGenerateProblem(){
      if (squares.length===0) { alert('まず「盤面を追加」してください'); return; }
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
      const layout = squares.map(s=>({ id:String(s.id), x:Math.round(s.x), y:Math.round(s.y) }));

      try{
        generateProblemButton.disabled=true;
        setStatus(`問題を生成しています...（難易度: ${diff}）`);
        // 1) サーバ
        const boards = await generateFromServer(layout, /*adShown=*/false, diff);
        renderBoards(boards);
        isProblemGenerated=true;
        setStatus(`問題を作成しました！（サーバ生成 / ${boards.length}盤）`);
        saveState();
      } catch(err){
        console.warn('API失敗。ローカル生成に切替: ', err);
        // 2) ローカル・フォールバック
        const boards = generateLocally(layout, diff);
        renderBoards(boards);
        isProblemGenerated=true;
        setStatus(`問題を作成しました！（ローカル生成 / ${boards.length}盤）`);
        saveState();
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
      if (!res.ok) {
        const t = await safeText(res);
        throw new Error(`API ${res.status}: ${t || res.statusText}`);
      }
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
      saveState();
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

    // （合体用）共有マス不一致の検出
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

    // ===== 保存/復元 =====
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
        localStorage.setItem(LS_KEY, JSON.stringify(payload));
      }catch{}
    }
    function loadState(){
      try{
        const raw = localStorage.getItem(LS_KEY); if (!raw) return false;
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
        showSolution = false; // 復元時はオフ
        applyTransform(); return true;
      }catch{ return false; }
    }

    // ===== 初期化 =====
    function resizeCanvasToDisplaySize(){
      const rect = canvas.getBoundingClientRect();
      const w=Math.max(600, Math.floor(rect.width)), h=Math.max(450, Math.floor(rect.height));
      devicePR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
      const W=Math.floor(w*devicePR), H=Math.floor(h*devicePR);
      if (canvas.width!==W || canvas.height!==H){ canvas.width=W; canvas.height=H; applyTransform(); draw(); }
    }
    window.addEventListener('resize', ()=>{ resizeCanvasToDisplaySize(); draw(); });

    resizeCanvasToDisplaySize();
    if (!loadState()) setStatus('レイアウト編集モード：盤を追加して配置してください');
    else setStatus(isProblemGenerated ? 'プレイ再開できます' : 'レイアウトは復元されました');
    updateButtonStates(); draw();

    // ========= ここからローカル生成ロジック =========

    function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [a[i],a[j]]=[a[j],a[i]]; } return a; }

    function makeGlobalPattern(){
      function makeOrder(){
        const bandOrder = shuffle([0,1,2]);
        const order=[];
        for(const b of bandOrder){ const inner=shuffle([0,1,2]); for(const k of inner) order.push(b*3+k); }
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

    function carveBoard(solved, hintTarget){
      const g = solved.map(r=>r.slice());
      const cells=[...Array(81).keys()]; shuffle(cells);
      let toRemove=Math.max(0, 81-hintTarget);
      for(const idx of cells){
        if(toRemove<=0) break;
        const r=(idx/9)|0, c=idx%9, or=8-r, oc=8-c;
        if(g[r][c]===0 && g[or][oc]===0) continue;
        g[r][c]=0; g[or][oc]=0;
        toRemove -= (r===or && c===oc) ? 1 : 2;
      }
      return g;
    }

    function normalizeLayout(layout){
      return layout.map(o=>({
        id:String(o.id),
        ox: Math.round((Number(o.x)||0)/CELL),
        oy: Math.round((Number(o.y)||0)/CELL),
        rawx: Number(o.x)||0,
        rawy: Number(o.y)||0
      }));
    }
    function buildOverlaps(nlayout){
      const n=nlayout.length, overlaps=Array.from({length:n},()=>[]);
      for (let i=0;i<n;i++) for (let j=i+1;j<n;j++){
        const A=nlayout[i], B=nlayout[j];
        const R0=Math.max(0, B.oy-A.oy), C0=Math.max(0, B.ox-A.ox);
        const R1=Math.min(8, (B.oy+8)-A.oy), C1=Math.min(8, (B.ox+8)-A.ox);
        if (R0<=R1 && C0<=C1){
          const cells=[];
          for (let r=R0;r<=R1;r++) for (let c=C0;c<=C1;c++){
            const r2=r + A.oy - B.oy, c2=c + A.ox - B.ox;
            cells.push({ r,c,r2,c2 });
          }
          overlaps[i].push({ j, cells });
          overlaps[j].push({ j:i, cells: cells.map(({r,c,r2,c2})=>({ r:r2,c:c2,r2:r,c2:c })) });
        }
      }
      return overlaps;
    }
    function unifyGivenCells(puzzles, overlaps){
      for (let i=0;i<overlaps.length;i++){
        for (const e of overlaps[i]){
          const j=e.j;
          for (const {r,c,r2,c2} of e.cells){
            const a=puzzles[i][r][c], b=puzzles[j][r2][c2];
            if (a!==0 && b===0) puzzles[j][r2][c2]=a;
            else if (b!==0 && a===0) puzzles[i][r][c]=b;
          }
        }
      }
    }
    function enforceOverlapBySolution(puzzles, solved, overlaps){
      for (let i=0;i<overlaps.length;i++){
        for (const e of overlaps[i]){
          const j=e.j;
          for (const {r,c,r2,c2} of e.cells){
            const sVal=solved[i][r][c];
            if (puzzles[i][r][c]!==0 || puzzles[j][r2][c2]!==0){
              puzzles[i][r][c]=sVal; puzzles[j][r2][c2]=sVal;
            }
          }
        }
      }
    }
    function clampPuzzleToSolution(puzzle, solution){
      for(let r=0;r<9;r++) for(let c=0;c<9;c++){
        const v=puzzle[r][c]|0; if(v!==0) puzzle[r][c]=solution[r][c];
      }
    }

    function generateLocally(layout, difficulty='normal'){
      const HINT = { easy:40, normal:36, hard:30 }[difficulty] ?? 36;
      const nlayout = normalizeLayout(layout);
      const pattern = makeGlobalPattern();
      const solved = nlayout.map(({ox,oy}) =>
        Array.from({length:GRID},(_,r)=> Array.from({length:GRID},(_,c)=> pattern.valueAt(oy+r, ox+c)))
      );
      let puzzles = solved.map(g=>carveBoard(g, HINT));
      const overlaps = buildOverlaps(nlayout);
      unifyGivenCells(puzzles, overlaps);
      enforceOverlapBySolution(puzzles, solved, overlaps);
      for (let i=0;i<puzzles.length;i++) clampPuzzleToSolution(puzzles[i], solved[i]);
      return nlayout.map((o, idx) => ({
        id: layout[idx].id,
        x: o.rawx, y: o.rawy,
        grid: puzzles[idx],
        solution: solved[idx],
      }));
    }
    // ========= ローカル生成ここまで =========
  });
})();
