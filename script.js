// script.js — Cloudflare Pages フロント
// ・ズーム 10%〜200%（カーソル中心ズーム）＋ パン（Space/右/中ドラッグ, ホイールパン, Shift+ホイール横）
// ・盤面追加は「いま見ている中心」に生成
// ・Yは3セル単位でスナップ（箱崩れ防止）
// ・ローカル生成（安全バリデーション）/ サーバ連携（オプション）
// ・矛盾チェック（行/列/箱/共有）
// ・★唯一性チェック：削除
// ・★エクスポート：画像(PNG)／テキスト(JSON)
// ・レイアウト自己矛盾の検出（循環で同一盤の同一行/列/箱に同一クラスが複数出現）
// ・すべて削除ボタン
// ・保存キー: v4

(() => {
  document.addEventListener('DOMContentLoaded', () => {
    const USE_LOCAL_ONLY = true; // サーバ優先に戻す場合は false

    // ===== DOM =====
    const canvas = document.getElementById('canvas');
    const ctx = canvas.getContext('2d', { alpha: false });
    const statusDiv = document.getElementById('status');
    const addSquareButton = byId('addSquareButton');
    const deleteButton = byId('deleteButton');
    const clearAllBoardsButton = byId('clearAllBoardsButton');
    const generateProblemButton = byId('generateProblemButton');
    const checkButton = byId('checkButton');     // 矛盾チェック
    const solveButton = byId('solveButton');
    const exportTextButton = byId('exportTextButton');
    const exportImageButton = byId('exportImageButton');
    const difficultySel = document.getElementById('difficulty');

    // ズームUI（ボタンは任意。無ければ無視される）
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
    const SNAP_Y = CELL * 3; // 縦は3セル
    const FONT = '16px system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
    const MIN_ZOOM = 0.1, MAX_ZOOM = 2.0, ZOOM_STEP = 0.1;
    const LS_KEY = 'gattai_state_v4';
    const HINTS = { easy: 40, normal: 36, hard: 30, expert: 28, extreme: 26 };

    // ===== 状態 =====
    let squares = [];
    let isProblemGenerated = false;
    let activeSquareId = null;
    let activeCell = null;
    let drag = null;
    let panning = false, isSpaceDown = false, panStart = null;
    let zoom = 1.0, panX = 0, panY = 0;
    let devicePR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    let showSolution = false;

    // ===== Utils =====
    function byId(id){ return document.getElementById(id) || null; }
    const clamp = (v,lo,hi)=>Math.max(lo,Math.min(hi,v));
    const snap = (v,u)=>Math.round(v/u)*u;
    const createEmptyGrid = ()=>Array.from({length:GRID},()=>Array(GRID).fill(0));
    const cloneGrid = g=>g.map(r=>r.slice());
    function nextId(){ let m=0; for(const s of squares) m=Math.max(m, +s.id||0); return String(m+1); }

    // 新規盤を「画面中心」に生成
    function newSquareAtWorldCenter(){
      const rect = canvas.getBoundingClientRect();
      const cx = rect.width / 2, cy = rect.height / 2;
      const world = toWorld(cx, cy);
      const nx = Math.max(0, snap(world.x - BOARD_PIX/2, SNAP_X));
      const ny = Math.max(0, snap(world.y - BOARD_PIX/2, SNAP_Y));
      const id = nextId();
      return { id, x:nx, y:ny, w:BOARD_PIX, h:BOARD_PIX,
        problemData:createEmptyGrid(), userData:createEmptyGrid(),
        checkData:createEmptyGrid(), solutionData:createEmptyGrid(), _userBackup:null };
    }
    const setStatus = msg => { if (statusDiv) statusDiv.textContent = msg; };
    function updateButtonStates(){
      zoomPct && (zoomPct.textContent = `${Math.round(zoom*100)}%`);
      generateProblemButton && (generateProblemButton.disabled = squares.length === 0);
      deleteButton && (deleteButton.disabled = activeSquareId == null);
      clearAllBoardsButton && (clearAllBoardsButton.disabled = squares.length === 0);
      checkButton && (checkButton.disabled = squares.length === 0 || !isProblemGenerated || showSolution);
      exportTextButton && (exportTextButton.disabled = squares.length === 0 || !isProblemGenerated);
      exportImageButton && (exportImageButton.disabled = squares.length === 0 || !isProblemGenerated);
      if (solveButton) { solveButton.disabled = !isProblemGenerated; solveButton.textContent = showSolution ? '解答を隠す' : '解答を表示'; }
    }

    // ===== ビューポート（ズーム/パン）=====
    function applyTransform(){ ctx.setTransform(devicePR*zoom,0,0,devicePR*zoom, devicePR*panX, devicePR*panY); }
    function toWorld(mx,my){ return { x:(mx-panX)/zoom, y:(my-panY)/zoom }; }
    function setZoomAt(newZ, ax, ay){
      const z=clamp(newZ, MIN_ZOOM, MAX_ZOOM);
      const w=toWorld(ax,ay);
      zoom=z; panX=ax - w.x*zoom; panY=ay - w.y*zoom;
      applyTransform(); draw(); updateButtonStates(); saveState();
    }
    function setZoom(z){ const rect=canvas.getBoundingClientRect(); setZoomAt(z, rect.width/2, rect.height/2); }
    function contentBounds(){
      if (squares.length===0) return {minX:0,minY:0,maxX:BOARD_PIX,maxY:BOARD_PIX};
      let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
      for (const s of squares){ minX=Math.min(minX,s.x); minY=Math.min(minY,s.y); maxX=Math.max(maxX,s.x+s.w); maxY=Math.max(maxY,s.y+s.h); }
      return {minX,minY,maxX,maxY};
    }
    function fitZoom(margin=40){
      const rect=canvas.getBoundingClientRect();
      const {minX,minY,maxX,maxY}=contentBounds(); const w=Math.max(1,maxX-minX), h=Math.max(1,maxY-minY);
      const z=clamp(Math.min((rect.width-margin*2)/w,(rect.height-margin*2)/h), MIN_ZOOM, MAX_ZOOM);
      zoom=z; const sw=w*z, sh=h*z;
      panX=(rect.width - sw)/2 - minX*z; panY=(rect.height - sh)/2 - minY*z;
      applyTransform(); draw(); updateButtonStates(); saveState();
    }
    function autoFitIfOverflow(){
      const rect=canvas.getBoundingClientRect();
      const {minX,minY,maxX,maxY}=contentBounds();
      const w=(maxX-minX), h=(maxY-minY);
      if (w > rect.width/zoom || h > rect.height/zoom) fitZoom();
    }

    // ズームUI
    zoomOutBtn?.addEventListener('click',()=>setZoom(zoom-ZOOM_STEP));
    zoomInBtn?.addEventListener('click',()=>setZoom(zoom+ZOOM_STEP));
    zoom100Btn?.addEventListener('click',()=>setZoom(1));
    zoomFitBtn?.addEventListener('click',()=>fitZoom());

    // ホイール操作：Ctrl/⌘ + ホイールでズーム、修飾なしはパン（Shiftで横パン優先）
    canvas.addEventListener('wheel', (e)=>{
      const rect=canvas.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey){
        e.preventDefault();
        const mx=e.clientX-rect.left, my=e.clientY-rect.top;
        setZoomAt(zoom * (1 + (-Math.sign(e.deltaY))*0.1), mx, my);
      } else {
        e.preventDefault();
        if (e.shiftKey){ panX -= e.deltaY; } else { panX -= e.deltaX; panY -= e.deltaY; }
        applyTransform(); draw(); saveState();
      }
    }, { passive:false });

    // ショートカット：F=Fit、+=拡大、-=縮小
    window.addEventListener('keydown',(e)=>{
      if (e.code==='KeyF'){ e.preventDefault(); fitZoom(); }
      if (e.key==='+' || e.key==='='){ e.preventDefault(); setZoom(zoom+ZOOM_STEP); }
      if (e.key==='-' || e.key==='_'){ e.preventDefault(); setZoom(zoom-ZOOM_STEP); }
      if (e.key.toLowerCase()==='c'){ e.preventDefault(); checkAllAndReport(); }
    });

    // ===== 描画 =====
    function draw(){
      ctx.save(); ctx.setTransform(devicePR,0,0,devicePR,0,0); ctx.fillStyle='#fff'; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.restore();
      applyTransform();
      for (const s of squares) drawBoard(s);
      if (activeCell){
        const s=squares.find(x=>String(x.id)===String(activeCell.id));
        if (s){ ctx.save(); ctx.globalAlpha=.25; ctx.fillStyle='#66aaff';
          const x=s.x+activeCell.c*CELL, y=s.y+activeCell.r*CELL; ctx.fillRect(x,y,CELL,CELL); ctx.restore(); }
      }
    }
    function drawBoard(s){
      ctx.save();
      const isActive=String(s.id)===String(activeSquareId);
      ctx.strokeStyle=isActive?'#2b90ff':'#222'; ctx.lineWidth=isActive?3:1.5;
      ctx.strokeRect(s.x-.5, s.y-.5, s.w+1, s.h+1);
      ctx.lineWidth=1; ctx.strokeStyle='#aaa';
      for(let i=1;i<GRID;i++){
        const gx=s.x+i*CELL, gy=s.y+i*CELL;
        ctx.beginPath(); ctx.moveTo(gx+.5,s.y); ctx.lineTo(gx+.5,s.y+s.h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(s.x,gy+.5); ctx.lineTo(s.x+s.w,gy+.5); ctx.stroke();
      }
      ctx.lineWidth=2; ctx.strokeStyle='#333';
      for(let i=0;i<=GRID;i+=3){
        const gx=s.x+i*CELL+.5, gy=s.y+i*CELL+.5;
        ctx.beginPath(); ctx.moveTo(gx,s.y); ctx.lineTo(gx,s.y+s.h); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(s.x,gy); ctx.lineTo(s.x+s.w,gy); ctx.stroke();
      }
      ctx.font=FONT; ctx.textAlign='center'; ctx.textBaseline='middle';
      for(let r=0;r<GRID;r++) for(let c=0;c<GRID;c++){
        const px=s.x+c*CELL+CELL/2, py=s.y+r*CELL+CELL/2;
        const giv=s.problemData[r][c]|0, usr=s.userData[r][c]|0;
        if (giv>0){ ctx.fillStyle='#000'; ctx.fillText(String(giv),px,py); }
        else if (usr>0){ const bad=((s.checkData[r][c]|0)===1);
          ctx.fillStyle = bad ? '#d11' : (showSolution ? '#0a0' : '#2b90ff');
          ctx.fillText(String(usr),px,py);
        }
      }
      ctx.fillStyle=isActive?'#2b90ff':'#666';
      ctx.fillRect(s.x, s.y-18, 30, 18);
      ctx.fillStyle='#fff'; ctx.font='12px system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
      ctx.fillText(s.id, s.x+15, s.y-9);
      ctx.restore();
    }

    // ===== ヒット判定 =====
    const boardAt=(x,y)=>{ for(let i=squares.length-1;i>=0;i--){ const s=squares[i]; if(x>=s.x&&x<s.x+s.w&&y>=s.y&&y<s.y+s.h) return s; } return null; };
    const cellAt=(s,x,y)=>{ if(!s) return null; const cx=Math.floor((x-s.x)/CELL), cy=Math.floor((y-s.y)/CELL);
      if(cx<0||cy<0||cx>=GRID||cy>=GRID) return null; return { id:s.id, r:cy, c:cx }; };

    // ===== 入力（ドラッグ/パン）=====
    canvas.addEventListener('contextmenu', e=>e.preventDefault());
    canvas.addEventListener('mousedown',(e)=>{
      const rect=canvas.getBoundingClientRect(); const mx=e.clientX-rect.left, my=e.clientY-rect.top;
      const {x:xw,y:yw}=toWorld(mx,my);
      if (isSpaceDown || e.button===1 || e.button===2){ panning=true; panStart={mx,my,px:panX,py:panY}; return; }
      const s=boardAt(xw,yw);
      if(!s){ activeSquareId=null; activeCell=null; draw(); updateButtonStates(); return; }
      activeSquareId=s.id; activeCell=cellAt(s,xw,yw);
      drag={ id:s.id, offsetX:xw-s.x, offsetY:yw-s.y }; updateButtonStates(); draw();
    });
    canvas.addEventListener('mousemove',(e)=>{
      const rect=canvas.getBoundingClientRect(); const mx=e.clientX-rect.left, my=e.clientY-rect.top;
      if (panning && panStart){ panX=panStart.px+(mx-panStart.mx); panY=panStart.py+(my-panStart.my); applyTransform(); draw(); return; }
      if(!drag) return;
      const {x:xw,y:yw}=toWorld(mx,my); const s=squares.find(x=>String(x.id)===String(drag.id)); if(!s) return;
      let nx=snap(xw-drag.offsetX,SNAP_X), ny=snap(yw-drag.offsetY,SNAP_Y);
      nx=Math.max(0,nx); ny=Math.max(0,ny); s.x=nx; s.y=ny; draw();
    });
    window.addEventListener('mouseup',()=>{ panning=false; panStart=null; drag=null; saveState(); });
    window.addEventListener('keydown',(e)=>{
      if (e.code==='Space') isSpaceDown=true;
      if (e.key.toLowerCase()==='c'){ e.preventDefault(); checkAllAndReport(); return; }
      if (!isProblemGenerated || !activeCell || showSolution) return;
      const s=squares.find(x=>String(x.id)===String(activeCell.id)); if(!s) return;
      if (s.problemData[activeCell.r][activeCell.c] > 0) return;
      if (e.key>='1'&&e.key<='9'){ s.userData[activeCell.r][activeCell.c]=parseInt(e.key,10); s.checkData[activeCell.r][activeCell.c]=0; draw(); e.preventDefault(); saveState(); return; }
      if (e.key==='Backspace'||e.key==='Delete'||e.key==='0'){ s.userData[activeCell.r][activeCell.c]=0; s.checkData[activeCell.r][activeCell.c]=0; draw(); e.preventDefault(); saveState(); return; }
      const mv={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1]}[e.key];
      if (mv){ const nr=clamp(activeCell.r+mv[0],0,GRID-1), nc=clamp(activeCell.c+mv[1],0,GRID-1); activeCell={ id:activeCell.id, r:nr, c:nc }; draw(); e.preventDefault(); }
    });
    window.addEventListener('keyup',(e)=>{ if (e.code==='Space') isSpaceDown=false; });

    // ===== ボタン =====
    addSquareButton?.addEventListener('click',()=>{
      const s=newSquareAtWorldCenter();
      squares.push(s); activeSquareId=s.id; isProblemGenerated=false; showSolution=false;
      setStatus('盤を追加：いま見ている中心に生成しました（Spaceドラッグでパン／Ctrl+ホイールでズーム）');
      updateButtonStates(); draw(); saveState(); autoFitIfOverflow();
    });
    deleteButton?.addEventListener('click',()=>{
      if (activeSquareId==null) return;
      squares=squares.filter(s=>String(s.id)!==String(activeSquareId));
      activeSquareId=null; activeCell=null; isProblemGenerated = squares.length>0 && isProblemGenerated;
      showSolution=false; setStatus('選択中の盤を削除');
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
    checkButton?.addEventListener('click', checkAllAndReport);
    exportTextButton?.addEventListener('click', exportAsTextJSON);
    exportImageButton?.addEventListener('click', exportAsPNG);

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

    // ===== 生成（ローカル優先）=====
    async function handleGenerateProblem(){
      if (squares.length===0){ alert('まず「盤面を追加」してください'); return; }

      // 生成前：レイアウト自己矛盾チェック
      const layoutIssue = detectImpossibleLayout();
      if (!layoutIssue.ok){
        alert(`このレイアウトでは生成できません：\n${layoutIssue.reason}`);
        setStatus(`レイアウトが自己矛盾：${layoutIssue.reason}`);
        return;
      }

      for (const sq of squares){ sq.problemData=createEmptyGrid(); sq.userData=createEmptyGrid(); sq.checkData=createEmptyGrid(); sq.solutionData=createEmptyGrid(); sq._userBackup=null; }
      showSolution=false; isProblemGenerated=false; updateButtonStates(); draw();

      const diff = difficultySel ? String(difficultySel.value||'normal') : 'normal';
      const layout = squares.map(s=>({ id:String(s.id), x:Math.round(s.x), y:Math.round(s.y) }));
      generateProblemButton.disabled=true;

      try{
        setStatus(`問題を生成しています...（難易度:${diff}）`);
        let boards;
        if (USE_LOCAL_ONLY){
          boards = generateLocallyValidated(layout, diff);
        }else{
          try{
            boards = await generateFromServer(layout, false, diff);
            if (!validateBoardsClient(layout, boards)) throw new Error('server invalid');
          }catch{
            boards = generateLocallyValidated(layout, diff);
          }
        }
        renderBoards(boards);
        isProblemGenerated=true;
        const cnt=checkAllAndReport();
        setStatus(`問題を作成しました！（${boards.length}盤） / 矛盾 ${cnt} 件${cnt===0?'（OK）':''}`);
        autoFitIfOverflow();
      }catch(err){
        console.error(err); alert(err?.message||'生成に失敗しました'); setStatus('生成に失敗しました');
      }finally{
        generateProblemButton.disabled=false; updateButtonStates(); draw(); saveState();
      }
    }
    async function generateFromServer(layout, adShown=false, difficulty='normal'){
      const res = await fetch('/api/generate',{ method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({layout,adShown,difficulty}) });
      if (!res.ok) throw new Error(`API ${res.status}`);
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

    // ===== チェック（行/列/箱/共有）=====
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

    // ===== エクスポート =====
    // 画像（白背景・与えのみ・現在のレイアウトをそのまま）
    function exportAsPNG(){
      if (!isProblemGenerated){ alert('まず問題を生成してください'); return; }
      const {minX,minY,maxX,maxY}=contentBounds();
      const margin=20;
      const outW = (maxX-minX) + margin*2;
      const outH = (maxY-minY) + margin*2;

      const pr = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
      const off = document.createElement('canvas');
      off.width = Math.floor(outW * pr);
      off.height = Math.floor(outH * pr);
      const g = off.getContext('2d', { alpha:false });
      g.setTransform(pr,0,0,pr,0,0);
      g.fillStyle = '#fff';
      g.fillRect(0,0,off.width,off.height);

      // 描画（与えのみ）
      g.font = FONT;
      g.textAlign='center'; g.textBaseline='middle';
      for (const s of squares){
        const ox = margin + (s.x - minX), oy = margin + (s.y - minY);
        // 枠
        g.strokeStyle='#222'; g.lineWidth=1.5; g.strokeRect(ox-.5,oy-.5,s.w+1,s.h+1);
        // 細線
        g.lineWidth=1; g.strokeStyle='#aaa';
        for (let i=1;i<GRID;i++){
          const gx=ox+i*CELL, gy=oy+i*CELL;
          g.beginPath(); g.moveTo(gx+.5,oy); g.lineTo(gx+.5,oy+s.h); g.stroke();
          g.beginPath(); g.moveTo(ox,gy+.5); g.lineTo(ox+s.w,gy+.5); g.stroke();
        }
        // 太線
        g.lineWidth=2; g.strokeStyle='#333';
        for (let i=0;i<=GRID;i+=3){
          const gx=ox+i*CELL+.5, gy=oy+i*CELL+.5;
          g.beginPath(); g.moveTo(gx,oy); g.lineTo(gx,oy+s.h); g.stroke();
          g.beginPath(); g.moveTo(ox,gy); g.lineTo(ox+s.w,gy); g.stroke();
        }
        // 与え
        for (let r=0;r<GRID;r++) for (let c=0;c<GRID;c++){
          const v=s.problemData[r][c]|0; if (!v) continue;
          const px=ox+c*CELL+CELL/2, py=oy+r*CELL+CELL/2;
          g.fillStyle='#000'; g.fillText(String(v),px,py);
        }
      }

      const url = off.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = url;
      a.download = 'gattai_puzzle.png';
      a.click();
    }

    // テキスト（JSON）— 後で“複数解の有無チェック”に使いやすい構造
    function exportAsTextJSON(){
      if (!isProblemGenerated){ alert('まず問題を生成してください'); return; }
      const norm = normalizeLayoutFront(squares); // ox,oy（セル座標）
      const byId = new Map(norm.map(o=>[String(o.id), o]));
      const data = {
        version: 1,
        grid: 9,
        cell: CELL,
        // レイアウトは両方（ピクセル/セル）を書き出す
        layout_pixels: squares.map(s=>({ id:s.id, x:s.x, y:s.y })),
        layout_cells: norm, // {id, ox, oy(3の倍数)}
        boards: squares.map(s=>({
          id: s.id,
          ox: byId.get(String(s.id)).ox,
          oy: byId.get(String(s.id)).oy,
          givens: s.problemData // 0=空
        }))
      };
      const blob = new Blob([JSON.stringify(data,null,2)], {type:'application/json'});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href=url; a.download='gattai_puzzle.json'; a.click();
      URL.revokeObjectURL(url);
      setStatus('テキスト（JSON）を書き出しました');
    }

    // ===== レイアウト自己矛盾の検出 =====
    function detectImpossibleLayout(){
      if (squares.length===0) return { ok:true };
      const overlaps = buildOverlapsClient(squares);
      const idOf = (b,r,c)=> b*81 + r*9 + c;
      const N = squares.length * 81;
      const parent = new Int32Array(N); for (let i=0;i<N;i++) parent[i]=i;
      const find=(x)=>{ while(parent[x]!==x){ parent[x]=parent[parent[x]]; x=parent[x]; } return x; };
      const unite=(a,b)=>{ a=find(a); b=find(b); if(a!==b) parent[b]=a; };

      for (const {i,j,cells} of overlaps){
        for (const {r,c,r2,c2} of cells){ unite(idOf(i,r,c), idOf(j,r2,c2)); }
      }
      // クラス -> 盤ごとの出現を記録
      const rows=Object.create(null), cols=Object.create(null), boxes=Object.create(null);
      for (let b=0;b<squares.length;b++){
        for (let r=0;r<9;r++) for (let c=0;c<9;c++){
          const root=find(idOf(b,r,c));
          const key=String(root)+'#'+b;
          const bi = Math.floor(r/3)*3 + Math.floor(c/3);
          if (!rows[key]) rows[key]=new Set();
          if (!cols[key]) cols[key]=new Set();
          if (!boxes[key]) boxes[key]=new Set();
          if (rows[key].has(r)) return { ok:false, reason:`同一セルの共有が同一盤の同じ行に重複しています（盤#${b+1} 行${r+1}）` };
          if (cols[key].has(c)) return { ok:false, reason:`同一セルの共有が同一盤の同じ列に重複しています（盤#${b+1} 列${c+1}）` };
          if (boxes[key].has(bi)) return { ok:false, reason:`同一セルの共有が同一盤の同じブロックに重複しています（盤#${b+1} ブロック${bi+1}）` };
          rows[key].add(r); cols[key].add(c); boxes[key].add(bi);
        }
      }
      return { ok:true };
    }

    // ===== 保存/復元/初期化 =====
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
      setStatus('盤を追加 →「合体問題を作成」。Space/右ドラッグでパン、Ctrl+ホイールでズーム、ホイールで移動（Shiftで横）。');
      applyTransform(); draw();
    }else{
      setStatus(isProblemGenerated ? 'プレイ再開できます' : 'レイアウトを復元しました（縦は3セル単位）');
      applyTransform(); draw();
    }
    updateButtonStates();

    // ========= 生成ロジック（ローカル）=========
    function shuffle(a){ for(let i=a.length-1;i>0;i--){ const j=(Math.random()*(i+1))|0; [a[i],a[j]]=[a[j],a[i]]; } return a; }
    function makeGlobalPattern(){
      function makeOrder(){ const bandOrder=shuffle([0,1,2]); const order=[]; for(const b of bandOrder){ const inner=shuffle([0,1,2]); for(const k of inner) order.push(b*3+k); } return order; }
      const rowOrder=makeOrder(), colOrder=makeOrder(), digitPerm=shuffle([1,2,3,4,5,6,7,8,9]);
      const base=(r,c)=>(r*3 + Math.floor(r/3) + c) % 9;
      function valueAt(R,C){ const r=rowOrder[((R%9)+9)%9], c=colOrder[((C%9)+9)%9]; return digitPerm[ base(r,c) ]; }
      return { valueAt };
    }
    function normalizeLayout(layout){
      return layout.map(o=>{ const ox=Math.round((Number(o.x)||0)/CELL); let oy=Math.round((Number(o.y)||0)/CELL); oy -= oy%3; return { id:String(o.id), ox, oy, rawx:Number(o.x)||0, rawy:Number(o.y)||0 }; });
    }
    function buildOverlaps(nlayout){
      const n=nlayout.length, overlaps=Array.from({length:n},()=>[]);
      for(let i=0;i<n;i++) for(let j=i+1;j<n;j++){
        const A=nlayout[i], B=nlayout[j];
        const R0=Math.max(0,B.oy-A.oy), C0=Math.max(0,B.ox-A.ox);
        const R1=Math.min(8,(B.oy+8)-A.oy), C1=Math.min(8,(B.ox+8)-A.ox);
        if (R0<=R1 && C0<=C1){
          const cells=[];
          for (let r=R0;r<=R1;r++) for (let c=C0;c<=C1;c++){
            const r2=r + A.oy - B.oy, c2=c + A.ox - B.ox; cells.push({r,c,r2,c2});
          }
          overlaps[i].push({ j, cells });
          overlaps[j].push({ j:i, cells: cells.map(({r,c,r2,c2})=>({ r:r2,c:c2,r2:r,c2:c })) });
        }
      }
      return overlaps;
    }
    function carveBoard(solved, hintTarget){
      const g=solved.map(r=>r.slice()); const cells=[...Array(81).keys()]; shuffle(cells);
      let toRemove=Math.max(0,81-hintTarget);
      for(const idx of cells){
        if(toRemove<=0) break;
        const r=(idx/9)|0, c=idx%9, or=8-r, oc=8-c;
        if(g[r][c]===0 && g[or][oc]===0) continue;
        g[r][c]=0; g[or][oc]=0; toRemove -= (r===or && c===oc) ? 1 : 2;
      }
      return g;
    }
    function clampPuzzleToSolution(puzzle, solution){
      for (let r=0;r<9;r++) for(let c=0;c<9;c++){ const v=puzzle[r][c]|0; if (v!==0) puzzle[r][c]=solution[r][c]; }
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
    function puzzleHasContradiction(p){
      for (let r=0;r<9;r++){ const seen=new Set(); for (let c=0;c<9;c++){ const v=p[r][c]|0; if(!v) continue; if (seen.has(v)) return true; seen.add(v);} }
      for (let c=0;c<9;c++){ const seen=new Set(); for (let r=0;r<9;r++){ const v=p[r][c]|0; if(!v) continue; if (seen.has(v)) return true; seen.add(v);} }
      for (let br=0;br<9;br+=3) for (let bc=0;bc<9;bc+=3){
        const seen=new Set(); for (let dr=0;dr<3;dr++) for (let dc=0;dc<3;dc++){ const v=p[br+dr][bc+dc]|0; if(!v) continue; if (seen.has(v)) return true; seen.add(v); }
      }
      return false;
    }
    function validateBoardsClient(layout, boards){
      if (!Array.isArray(boards) || boards.length!==layout.length) return false;
      const L=normalizeLayout(layout); const map=new Map(boards.map(b=>[String(b.id),b]));
      const puzzles=[], solved=[];
      for (const o of L){ const b=map.get(String(o.id)); if(!b) return false; puzzles.push(cloneGrid(b.grid)); solved.push(cloneGrid(b.solution)); }
      for (let i=0;i<puzzles.length;i++) clampPuzzleToSolution(puzzles[i], solved[i]);
      for (const p of puzzles) if (puzzleHasContradiction(p)) return false;
      const overlaps=buildOverlaps(L);
      for (let i=0;i<overlaps.length;i++){
        for (const e of overlaps[i]){
          const j=e.j; for (const {r,c,r2,c2} of e.cells){ const a=puzzles[i][r][c], b=puzzles[j][r2][c2]; if (a!==0 && b!==0 && a!==b) return false; }
        }
      }
      return true;
    }
    function generateLocallyOnce(layout, difficulty='normal'){
      const hint = HINTS[difficulty] ?? HINTS.normal;
      const nlayout=normalizeLayout(layout);
      const pattern=makeGlobalPattern();
      const solved = nlayout.map(({ox,oy})=> Array.from({length:GRID},(_,r)=> Array.from({length:GRID},(_,c)=> pattern.valueAt(oy+r, ox+c))));
      let puzzles = solved.map(g=>carveBoard(g,hint));
      const overlaps=buildOverlaps(nlayout);
      unifyGivenCells(puzzles,overlaps); enforceOverlapBySolution(puzzles,solved,overlaps);
      for (let i=0;i<puzzles.length;i++) clampPuzzleToSolution(puzzles[i],solved[i]);
      return nlayout.map((o,idx)=>({ id:layout[idx].id, x:o.rawx, y:o.rawy, grid:puzzles[idx], solution:solved[idx] }));
    }
    function generateLocallyValidated(layout, difficulty='normal'){
      for (let k=0;k<20;k++){ const boards=generateLocallyOnce(layout,difficulty); if (validateBoardsClient(layout,boards)) return boards; console.warn('ローカル生成NG→再生成',k+1); }
      return generateLocallyOnce(layout,difficulty);
    }
  });
})();
