// script.js — Cloudflare Pages フロント（画像保存=全体のみ／“掴んで”パン + 慣性）
// ・ズーム/パン（背景左ドラッグ=パン、右/中ドラッグ、Space、ホイールパン、Ctrl+ホイールでズーム）
// ・盤面追加は画面中心に生成、Yは3セル単位にスナップ
// ・サーバ生成（/api/generate）
// ・矛盾チェック（行/列/箱/共有）／解答トグル
// ・エクスポート：JSON保存、PNG保存（全体。ID帯は省略）
// ・フィットはID帯も含め必ず入る（下限2%まで）
// ・保存キー: v4
(() => {
  document.addEventListener('DOMContentLoaded', () => {
    const USE_LOCAL_ONLY = false; // サーバ生成を使う

    // ===== DOM =====
    const canvas = byId('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });
    const statusDiv = byId('status');

    const addSquareButton = byId('addSquareButton');
    const deleteButton = byId('deleteButton');
    const clearAllBoardsButton = byId('clearAllBoardsButton');
    const generateProblemButton = byId('generateProblemButton');
    const checkButton = byId('checkButton');
    const solveButton = byId('solveButton');

    const exportTextButton = byId('exportTextButton');
    const exportImageAllButton = byId('exportImageAllButton');

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
    const SNAP_Y = CELL * 3;
    const FONT = '16px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';

    const MIN_ZOOM = 0.1;       // 通常操作の下限
    const MIN_ZOOM_FIT = 0.02;  // フィット時はここまで許容
    const MAX_ZOOM = 2.0;
    const ZOOM_STEP = 0.1;

    const LABEL_H = 18; // 盤上部のID帯の高さ
    const LS_KEY = 'gattai_state_v4';

    // ===== 状態 =====
    let squares = [];
    let isProblemGenerated = false;
    let activeSquareId = null;
    let activeCell = null;

    // ドラッグ・パン
    let draggingBoard = null; // {id, offsetX, offsetY}
    let panning = false;
    let panStart = null;      // {mx,my,px,py}
    let isSpaceDown = false;

    // 慣性
    let velX = 0, velY = 0;
    let lastMoveT = 0, lastMX = 0, lastMY = 0;
    let inertiaRAF = null;

    let zoom = 1.0, panX = 0, panY = 0;
    let devicePR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    let showSolution = false;

    // ===== Utils =====
    function byId(id){ return document.getElementById(id) || null; }
    const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
    const snap=(v,u)=>Math.round(v/u)*u;
    const createEmptyGrid=()=>Array.from({length:GRID},()=>Array(GRID).fill(0));
    const cloneGrid=g=>g.map(r=>r.slice());
    function nextId(){ let m=0; for(const s of squares) m=Math.max(m, +s.id||0); return String(m+1); }
    const setStatus = msg => { if (statusDiv) statusDiv.textContent = msg; };

    function updateButtonStates(){
      zoomPct && (zoomPct.textContent = `${Math.round(zoom*100)}%`);
      const hasSquares = squares.length > 0;
      if (generateProblemButton) generateProblemButton.disabled = !hasSquares;
      if (deleteButton) deleteButton.disabled = (activeSquareId == null);
      if (clearAllBoardsButton) clearAllBoardsButton.disabled = !hasSquares;
      if (checkButton) checkButton.disabled = (!hasSquares || !isProblemGenerated || showSolution);
      if (solveButton){ solveButton.disabled = !isProblemGenerated; solveButton.textContent = showSolution ? '解答を隠す' : '解答を表示'; }
      if (exportTextButton) exportTextButton.disabled = !hasSquares;
      if (exportImageAllButton) exportImageAllButton.disabled = !hasSquares;
    }

    // ===== ズーム/パン =====
    function applyTransform(){ ctx.setTransform(devicePR*zoom,0,0,devicePR*zoom, devicePR*panX, devicePR*panY); }
    function toWorld(mx,my){ return { x:(mx-panX)/zoom, y:(my-panY)/zoom }; }
    function setZoomAt(newZ, ax, ay){
      const z=clamp(newZ, MIN_ZOOM, MAX_ZOOM);
      const w=toWorld(ax,ay);
      zoom=z; panX=ax - w.x*zoom; panY=ay - w.y*zoom;
      stopInertia();
      applyTransform(); draw(); updateButtonStates(); saveState();
    }
    function setZoom(z){ const rect=canvas.getBoundingClientRect(); setZoomAt(z, rect.width/2, rect.height/2); }

    function contentBounds(){
      if (squares.length===0) return {minX:0,minY:0,maxX:BOARD_PIX,maxY:BOARD_PIX};
      let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
      for (const s of squares){
        minX = Math.min(minX, s.x);
        minY = Math.min(minY, s.y - LABEL_H);  // ID帯も含める
        maxX = Math.max(maxX, s.x + s.w);
        maxY = Math.max(maxY, s.y + s.h);
      }
      return {minX,minY,maxX,maxY};
    }
    function fitZoom(margin=40){
      const rect=canvas.getBoundingClientRect();
      const {minX,minY,maxX,maxY}=contentBounds();
      const w=Math.max(1, maxX-minX), h=Math.max(1, maxY-minY);
      const zWanted = Math.min((rect.width-margin*2)/w, (rect.height-margin*2)/h);
      const z = clamp(zWanted, MIN_ZOOM_FIT, MAX_ZOOM);
      zoom=z;
      const sw=w*z, sh=h*z;
      panX=(rect.width - sw)/2 - minX*z;
      panY=(rect.height - sh)/2 - minY*z;
      stopInertia();
      applyTransform(); draw(); updateButtonStates(); saveState();
    }
    function autoFitIfOverflow(){
      const rect=canvas.getBoundingClientRect();
      const {minX,minY,maxX,maxY}=contentBounds();
      const w=(maxX-minX), h=(maxY-minY);
      if (w > rect.width/zoom || h > rect.height/zoom) fitZoom();
    }

    // ===== 描画 =====
    function draw(){
      // 背景クリア
      ctx.save(); ctx.setTransform(devicePR,0,0,devicePR,0,0); ctx.fillStyle='#fff'; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.restore();
      // 盤面
      applyTransform();
      for (const s of squares) drawBoardGeneric(ctx, s, /*omitLabels*/false);
      // 選択セル
      if (activeCell){
        const s=squares.find(x=>String(x.id)===String(activeCell.id));
        if (s){ ctx.save(); ctx.globalAlpha=.25; ctx.fillStyle='#66aaff';
          const x=s.x+activeCell.c*CELL, y=s.y+activeCell.r*CELL; ctx.fillRect(x,y,CELL,CELL); ctx.restore(); }
      }
    }
    function drawBoardGeneric(c2, s, omitLabels=false, ox=0, oy=0){
      c2.save();
      const isActive=String(s.id)===String(activeSquareId);
      c2.strokeStyle=isActive && !omitLabels ? '#2b90ff' : '#222';
      c2.lineWidth=isActive && !omitLabels ? 3 : 1.5;
      c2.strokeRect(ox+s.x-.5, oy+s.y-.5, s.w+1, s.h+1);

      // 細線
      c2.lineWidth=1; c2.strokeStyle='#aaa';
      for(let i=1;i<GRID;i++){
        const gx=ox+s.x+i*CELL, gy=oy+s.y+i*CELL;
        c2.beginPath(); c2.moveTo(gx+.5,oy+s.y); c2.lineTo(gx+.5,oy+s.y+s.h); c2.stroke();
        c2.beginPath(); c2.moveTo(ox+s.x,gy+.5); c2.lineTo(ox+s.x+s.w,gy+.5); c2.stroke();
      }
      // 太線
      c2.lineWidth=2; c2.strokeStyle='#333';
      for(let i=0;i<=GRID;i+=3){
        const gx=ox+s.x+i*CELL+.5, gy=oy+s.y+i*CELL+.5;
        c2.beginPath(); c2.moveTo(gx,oy+s.y); c2.lineTo(gx,oy+s.y+s.h); c2.stroke();
        c2.beginPath(); c2.moveTo(ox+s.x,gy); c2.lineTo(ox+s.x+s.w,gy); c2.stroke();
      }
      // 数字
      c2.font=FONT; c2.textAlign='center'; c2.textBaseline='middle';
      for(let r=0;r<GRID;r++) for(let c=0;c<GRID;c++){
        const px=ox+s.x+c*CELL+CELL/2, py=oy+s.y+r*CELL+CELL/2;
        const giv=s.problemData[r][c]|0, usr=s.userData[r][c]|0;
        if (giv>0){ c2.fillStyle='#000'; c2.fillText(String(giv),px,py); }
        else if (usr>0){ const bad=((s.checkData[r][c]|0)===1);
          c2.fillStyle = bad ? '#d11' : (showSolution ? '#0a0' : '#2b90ff');
          c2.fillText(String(usr),px,py);
        }
      }
      // ID帯（画像保存では省略）
      if (!omitLabels){
        c2.fillStyle=isActive?'#2b90ff':'#666';
        c2.fillRect(ox+s.x, oy+s.y-LABEL_H, 30, LABEL_H);
        c2.fillStyle='#fff'; c2.font='12px system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
        c2.textAlign='center'; c2.textBaseline='middle';
        c2.fillText(s.id, ox+s.x+15, oy+s.y-LABEL_H/2);
      }
      c2.restore();
    }

    // ===== ヒット判定 =====
    const boardAt=(x,y)=>{ for(let i=squares.length-1;i>=0;i--){ const s=squares[i]; if(x>=s.x&&x<s.x+s.w&&y>=s.y&&y<s.y+s.h) return s; } return null; };
    const cellAt=(s,x,y)=>{ if(!s) return null; const cx=Math.floor((x-s.x)/CELL), cy=Math.floor((y-s.y)/CELL);
      if(cx<0||cy<0||cx>=GRID||cy>=GRID) return null; return { id:s.id, r:cy, c:cx }; };

    // ===== 入力（盤ドラッグ or 画面パン + 慣性）=====
    canvas.addEventListener('contextmenu', e=>e.preventDefault());

    canvas.addEventListener('mousedown',(e)=>{
      const rect=canvas.getBoundingClientRect(); const mx=e.clientX-rect.left, my=e.clientY-rect.top;
      const {x:xw,y:yw}=toWorld(mx,my);
      stopInertia();

      // 右/中クリックは常にパン開始
      if (e.button===1 || e.button===2 || isSpaceDown){
        e.preventDefault();
        panning = true;
        panStart = { mx, my, px:panX, py:panY };
        lastMoveT = performance.now(); lastMX = mx; lastMY = my; velX = velY = 0;
        return;
      }

      const s=boardAt(xw,yw);
      if (s){
        // 盤のドラッグ
        activeSquareId=s.id; activeCell=cellAt(s,xw,yw);
        draggingBoard = { id:s.id, offsetX:xw - s.x, offsetY:yw - s.y };
        updateButtonStates(); draw();
      }else{
        // 背景を左クリック → パン開始（“掴んで移動”）
        e.preventDefault();
        panning = true;
        panStart = { mx, my, px:panX, py:panY };
        lastMoveT = performance.now(); lastMX = mx; lastMY = my; velX = velY = 0;
        // 背景を掴んだときは選択解除
        activeSquareId = null; activeCell = null; updateButtonStates(); draw();
      }
    });

    canvas.addEventListener('mousemove',(e)=>{
      const rect=canvas.getBoundingClientRect(); const mx=e.clientX-rect.left, my=e.clientY-rect.top;

      if (panning && panStart){
        const now = performance.now();
        panX = panStart.px + (mx - panStart.mx);
        panY = panStart.py + (my - panStart.my);
        // 慣性用速度推定
        const dt = Math.max(1, now - lastMoveT);
        velX = (mx - lastMX) / dt * 16.67; // 60fps基準に正規化
        velY = (my - lastMY) / dt * 16.67;
        lastMoveT = now; lastMX = mx; lastMY = my;

        applyTransform(); draw();
        return;
      }

      if (draggingBoard){
        const {x:xw,y:yw}=toWorld(mx,my);
        const s=squares.find(x=>String(x.id)===String(draggingBoard.id)); if(!s) return;
        let nx=snap(xw - draggingBoard.offsetX, SNAP_X);
        let ny=snap(yw - draggingBoard.offsetY, SNAP_Y);
        nx=Math.max(0,nx); ny=Math.max(0,ny);
        s.x=nx; s.y=ny; draw();
        return;
      }
    });

    window.addEventListener('mouseup',()=>{
      // 盤ドラッグ終了
      if (draggingBoard){ draggingBoard = null; saveState(); }
      // パン終了→慣性開始
      if (panning){
        panning = false;
        startInertia(); // 惰性スクロール
        saveState();
      }
    });

    function startInertia(){
      stopInertia();
      const friction = 0.92;         // 摩擦係数（0.9〜0.95くらいが自然）
      const minSpeed = 0.05;         // 停止閾値
      const step = ()=>{
        velX *= friction; velY *= friction;
        if (Math.abs(velX) < minSpeed && Math.abs(velY) < minSpeed){
          stopInertia(); return;
        }
        panX += velX; panY += velY;
        applyTransform(); draw();
        inertiaRAF = requestAnimationFrame(step);
      };
      inertiaRAF = requestAnimationFrame(step);
    }
    function stopInertia(){
      if (inertiaRAF){ cancelAnimationFrame(inertiaRAF); inertiaRAF = null; }
      velX = velY = 0;
    }

    // キー入力（数字/削除/矢印 + ショートカット）
    window.addEventListener('keydown',(e)=>{
      if (e.code==='Space') isSpaceDown=true;
      if (e.code==='KeyF'){ e.preventDefault(); fitZoom(); }
      if (e.key==='+' || e.key==='='){ e.preventDefault(); setZoom(zoom+ZOOM_STEP); }
      if (e.key==='-' || e.key==='_'){ e.preventDefault(); setZoom(zoom-ZOOM_STEP); }
      if (e.key.toLowerCase()==='c'){ e.preventDefault(); checkAllAndReport(); }

      if (!isProblemGenerated || !activeCell || showSolution) return;
      const s=squares.find(x=>String(x.id)===String(activeCell.id)); if(!s) return;
      if (s.problemData[activeCell.r][activeCell.c] > 0) return;

      if (e.key>='1'&&e.key<='9'){
        s.userData[activeCell.r][activeCell.c]=parseInt(e.key,10);
        s.checkData[activeCell.r][activeCell.c]=0;
        draw(); e.preventDefault(); saveState(); return;
      }
      if (e.key==='Backspace'||e.key==='Delete'||e.key==='0'){
        s.userData[activeCell.r][activeCell.c]=0;
        s.checkData[activeCell.r][activeCell.c]=0;
        draw(); e.preventDefault(); saveState(); return;
      }
      const mv={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1]}[e.key];
      if (mv){
        const nr=clamp(activeCell.r+mv[0],0,GRID-1), nc=clamp(activeCell.c+mv[1],0,GRID-1);
        activeCell={ id:activeCell.id, r:nr, c:nc }; draw(); e.preventDefault();
      }
    });
    window.addEventListener('keyup',(e)=>{ if (e.code==='Space') isSpaceDown=false; });

    // ===== ボタン =====
    addSquareButton?.addEventListener('click',()=>{
      const rect=canvas.getBoundingClientRect();
      const cx=rect.width/2, cy=rect.height/2;
      const world=toWorld(cx,cy);
      const nx=Math.max(0, snap(world.x-BOARD_PIX/2, SNAP_X));
      const ny=Math.max(0, snap(world.y-BOARD_PIX/2, SNAP_Y));
      const s={ id:nextId(), x:nx, y:ny, w:BOARD_PIX, h:BOARD_PIX,
        problemData:createEmptyGrid(), userData:createEmptyGrid(), checkData:createEmptyGrid(), solutionData:createEmptyGrid(), _userBackup:null };
      squares.push(s); activeSquareId=s.id; isProblemGenerated=false; showSolution=false;
      setStatus('盤を追加：中心に生成しました（背景をドラッグでパン／Ctrl+ホイールでズーム）');
      updateButtonStates(); draw(); saveState(); autoFitIfOverflow();
    });

    deleteButton?.addEventListener('click',()=>{
      if (activeSquareId==null) return;
      squares=squares.filter(s=>String(s.id)!==String(activeSquareId));
      activeSquareId=null; activeCell=null;
      isProblemGenerated = squares.length>0 && isProblemGenerated;
      showSolution=false; setStatus('選択中の盤を削除');
      updateButtonStates(); draw(); saveState(); autoFitIfOverflow();
    });

    clearAllBoardsButton?.addEventListener('click', ()=>{
      if (!confirm('配置した盤面をすべて削除します。よろしいですか？')) return;
      squares=[]; activeSquareId=null; activeCell=null; isProblemGenerated=false; showSolution=false;
      localStorage.removeItem(LS_KEY);
      panX=0; panY=0; zoom=1;
      stopInertia();
      applyTransform(); updateButtonStates(); draw();
      setStatus('すべての盤面をクリアしました');
    });

    generateProblemButton?.addEventListener('click', handleGenerateProblem);
    checkButton?.addEventListener('click', checkAllAndReport);

    solveButton?.addEventListener('click', ()=>{
      if (!isProblemGenerated) return;
      const missing = squares.some(s=>!s.solutionData || s.solutionData.length!==9);
      if (missing){ alert('解答データがありません'); return; }
      if (!showSolution){
        for (const s of squares){
          s._userBackup = cloneGrid(s.userData);
          for (let r=0;r<GRID;r++) for (let c=0;c<GRID;c++){
            if (s.problemData[r][c]===0) s.userData[r][c]=s.solutionData[r][c];
          }
          s.checkData=createEmptyGrid();
        }
        showSolution=true; setStatus('解答を表示中');
      }else{
        for (const s of squares){ if (s._userBackup) s.userData=s._userBackup; s._userBackup=null; }
        showSolution=false; setStatus('解答を隠しました');
      }
      updateButtonStates(); draw(); saveState();
    });

    // === エクスポート（JSON / 画像 全体） ===
    exportTextButton?.addEventListener('click', ()=>{
      const data={ layout:squares.map(s=>({id:s.id,x:s.x,y:s.y})),
        boards:squares.map(s=>({id:s.id,problem:s.problemData,user:s.userData,solution:s.solutionData})) };
      const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});
      downloadBlob(blob, `gattai_${timestamp()}.json`);
    });

    // 画像保存（全体を1枚。ID帯は描かない）
    exportImageAllButton?.addEventListener('click', ()=>{
      const {minX,minY,maxX,maxY}=contentBounds();
      const pad = 20;
      const worldW = Math.ceil(maxX - minX + pad*2);
      const worldH = Math.ceil(maxY - minY + pad*2);
      const maxDim = 8192;
      const scale = Math.min(2, maxDim / worldW, maxDim / worldH);
      const W = Math.max(1, Math.floor(worldW * scale));
      const H = Math.max(1, Math.floor(worldH * scale));

      const off = document.createElement('canvas');
      off.width = W; off.height = H;
      const octx = off.getContext('2d', { alpha:false });

      octx.fillStyle = '#ffffff';
      octx.fillRect(0,0,W,H);

      octx.save();
      octx.scale(scale, scale);
      const ox = 20 - minX;
      const oy = 20 - minY;
      for (const s of squares) drawBoardGeneric(octx, s, /*omitLabels*/true, ox, oy);
      octx.restore();

      off.toBlob((blob)=>{
        if (!blob) return;
        downloadBlob(blob, `gattai_all_${timestamp()}.png`);
      });
    });

    function downloadBlob(blob, filename){
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename;
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    }
    function timestamp(){
      const d=new Date();
      const p=n=>String(n).padStart(2,'0');
      return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
    }

    // ===== 生成（サーバ）=====
    async function handleGenerateProblem(){
      if (squares.length===0){ alert('まず「盤面を追加」してください'); return; }
      // 初期化
      for (const sq of squares){ sq.problemData=createEmptyGrid(); sq.userData=createEmptyGrid(); sq.checkData=createEmptyGrid(); sq.solutionData=createEmptyGrid(); sq._userBackup=null; }
      showSolution=false; isProblemGenerated=false; updateButtonStates(); draw();

      const diff = difficultySel ? String(difficultySel.value||'normal') : 'normal';
      const layout = squares.map(s=>({ id:String(s.id), x:Math.round(s.x), y:Math.round(s.y) }));
      generateProblemButton.disabled=true;

      try{
        setStatus(`問題を生成しています...（難易度:${diff}）`);
        if (USE_LOCAL_ONLY) throw new Error('local mode disabled');
        const boards = await generateFromServer(layout, false, diff);
        renderBoards(boards);
        isProblemGenerated=true;
        const cnt=checkAllAndReport();
        setStatus(`問題を作成しました！（${boards.length}盤） / 矛盾 ${cnt} 件${cnt===0?'（OK）':''}`);
        autoFitIfOverflow();
      }catch(err){
        console.error(err);
        alert(err?.message || '生成に失敗しました');
        setStatus('生成に失敗しました');
      }finally{
        generateProblemButton.disabled=false; updateButtonStates(); draw(); saveState();
      }
    }
    async function generateFromServer(layout, adShown=false, difficulty='normal'){
      const res = await fetch('/api/generate',{ method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({layout,adShown,difficulty}) });
      if (!res.ok){ const t=await res.text().catch(()=> ''); throw new Error(`API ${res.status} ${t}`); }
      const data=await res.json(); if (!data?.ok) throw new Error(data?.reason||'ok=false');
      return data.puzzle?.boards||[];
    }
    function renderBoards(boards){
      const map=new Map(boards.map(b=>[String(b.id),b]));
      for (const sq of squares){
        const b=map.get(String(sq.id)); if(!b) continue;
        sq.problemData=cloneGrid(b.grid); sq.solutionData=cloneGrid(b.solution||createEmptyGrid());
        sq.userData=createEmptyGrid(); sq.checkData=createEmptyGrid();
      }
      updateButtonStates(); draw(); saveState();
    }

    // ===== 矛盾チェック（行/列/箱/共有）=====
    function runCheck(sq){
      sq.checkData=createEmptyGrid();
      const val=(r,c)=> (sq.userData[r][c] || sq.problemData[r][c] || 0);
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
          const r=br+dr, c=bc+dc, v=val(r,c);
          if (!v) continue;
          if (seen.has(v)){ sq.checkData[r][c]=1; const [rr,cc]=seen.get(v); sq.checkData[rr][cc]=1; } else seen.set(v,[r,c]);
        }
      }
    }
    function normalizeLayoutFront(sqs){
      return sqs.map(s=>{ const ox=Math.round(s.x/CELL); let oy=Math.round(s.y/CELL); oy -= oy%3; return { id:String(s.id), ox, oy }; });
    }
    function buildOverlapsClient(sqs){
      const norm=normalizeLayoutFront(sqs); const n=norm.length, overlaps=[];
      for(let i=0;i<n;i++) for(let j=i+1;j<n;j++){
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
      const overlaps=buildOverlapsClient(squares);
      const val=(sq,r,c)=>(sq.userData[r][c] || sq.problemData[r][c] || 0);
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
      for (const s of squares) for (let r=0;r<GRID;r++) for (let c=0;c<GRID;c++) if ((s.checkData[r][c]|0)===1) total++;
      return total;
    }
    function checkAllAndReport(){
      if (squares.length===0 || !isProblemGenerated) return 0;
      for (const s of squares) runCheck(s); runOverlapCheck(); draw();
      const total=countConflicts(); setStatus(`矛盾チェック：${total} 件${total===0?'（OK）':''}`); return total;
    }

    // ===== 保存/復元 =====
    function saveState(){
      try{
        const payload={ zoom, panX, panY,
          squares:squares.map(s=>({id:s.id,x:s.x,y:s.y,problemData:s.problemData,userData:s.userData,solutionData:s.solutionData})),
          isProblemGenerated, showSolution, ts:Date.now() };
        localStorage.setItem(LS_KEY, JSON.stringify(payload));
      }catch{}
    }
    function loadState(){
      try{
        const raw=localStorage.getItem(LS_KEY); if(!raw) return false;
        const obj=JSON.parse(raw); if(!obj||!Array.isArray(obj.squares)) return false;
        zoom=clamp(Number(obj.zoom)||1, MIN_ZOOM, MAX_ZOOM);
        panX=Number.isFinite(obj.panX)?obj.panX:0; panY=Number.isFinite(obj.panY)?obj.panY:0;
        squares=obj.squares.map(o=>({ id:o.id, x:snap(o.x||0,SNAP_X), y:snap(o.y||0,SNAP_Y), w:BOARD_PIX, h:BOARD_PIX,
          problemData:o.problemData||createEmptyGrid(), userData:o.userData||createEmptyGrid(), solutionData:o.solutionData||createEmptyGrid(),
          checkData:createEmptyGrid(), _userBackup:null }));
        isProblemGenerated=!!obj.isProblemGenerated && squares.length>0;
        showSolution=false; applyTransform(); return true;
      }catch{ return false; }
    }
    function resizeCanvasToDisplaySize(){
      const rect=canvas.getBoundingClientRect();
      const w=Math.max(600, Math.floor(rect.width)), h=Math.max(450, Math.floor(rect.height));
      devicePR=Math.max(1,Math.min(2,window.devicePixelRatio||1));
      const W=Math.floor(w*devicePR), H=Math.floor(h*devicePR);
      if (canvas.width!==W || canvas.height!==H){ canvas.width=W; canvas.height=H; applyTransform(); draw(); }
    }
    window.addEventListener('resize', ()=>{ resizeCanvasToDisplaySize(); draw(); autoFitIfOverflow(); });

    // ===== 起動 =====
    resizeCanvasToDisplaySize();
    if (!loadState()){
      setStatus('「盤面を追加」→「合体問題を作成」。背景ドラッグでパン／Ctrl+ホイールでズーム／ホイールで移動（Shiftで横）');
      applyTransform(); draw();
    }else{
      setStatus(isProblemGenerated ? 'プレイ再開できます' : 'レイアウトを復元しました（縦は3セル単位）');
      applyTransform(); draw();
    }
    updateButtonStates();
  });
})();
