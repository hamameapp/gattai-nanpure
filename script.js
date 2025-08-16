// script.js — Cloudflare Pages フロント（置き換え可）
// ・左ドラッグ：背景なら常にパン（右/中/Space でもパン）
// ・マウスホイール＝標準でズーム（カーソル中心）、Shift+ホイールでパン
// ・ズームUI（＋/−/Fit/100%）、F/+/− ショートカット
// ・合体生成は /api/generate へ { overlapEmpty:true } を明示
// ・矛盾チェック（行/列/箱/共有）、解答トグル、JSONエクスポート、全消去
// ・保存キー: v4

(() => {
  document.addEventListener('DOMContentLoaded', () => {
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

    const zoomOutBtn = byId('zoomOut');
    const zoomInBtn = byId('zoomIn');
    const zoomFitBtn = byId('zoomFit');
    const zoom100Btn = byId('zoom100');
    const zoomPct = byId('zoomPct');

    const GRID=9, CELL=30, BOARD_PIX=GRID*CELL;
    const SNAP_X=CELL, SNAP_Y=CELL*3;
    const FONT='16px system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
    const MIN_ZOOM=0.1, MAX_ZOOM=2.0, ZOOM_STEP=0.1;
    const LS_KEY='gattai_state_v4';

    let squares=[], isProblemGenerated=false, activeSquareId=null, activeCell=null;
    let drag=null; // 盤ドラッグ
    let panning=false, isSpaceDown=false, panStart=null;
    let zoom=1.0, panX=0, panY=0;
    let devicePR=Math.max(1, Math.min(2, window.devicePixelRatio||1));
    let showSolution=false;

    function byId(id){ return document.getElementById(id)||null; }
    const clamp=(v,lo,hi)=>Math.max(lo,Math.min(hi,v));
    const snap=(v,u)=>Math.round(v/u)*u;
    const createEmptyGrid=()=>Array.from({length:GRID},()=>Array(GRID).fill(0));
    const cloneGrid=g=>g.map(r=>r.slice());
    function nextId(){ let m=0; for(const s of squares) m=Math.max(m, +s.id||0); return String(m+1); }
    function setStatus(msg){ if(statusDiv) statusDiv.textContent=msg; }

    function newSquareAtWorldCenter(){
      const rect=canvas.getBoundingClientRect();
      const world=toWorld(rect.width/2, rect.height/2);
      const nx=Math.max(0, snap(world.x-BOARD_PIX/2, SNAP_X));
      const ny=Math.max(0, snap(world.y-BOARD_PIX/2, SNAP_Y));
      const id=nextId();
      return { id, x:nx, y:ny, w:BOARD_PIX, h:BOARD_PIX,
        problemData:createEmptyGrid(), userData:createEmptyGrid(),
        checkData:createEmptyGrid(), solutionData:createEmptyGrid(), _userBackup:null };
    }

    function updateButtonStates(){
      if (zoomPct) zoomPct.textContent = `${Math.round(zoom*100)}%`;
      generateProblemButton && (generateProblemButton.disabled = squares.length===0);
      deleteButton && (deleteButton.disabled = activeSquareId==null);
      clearAllBoardsButton && (clearAllBoardsButton.disabled = squares.length===0);
      checkButton && (checkButton.disabled = squares.length===0 || !isProblemGenerated || showSolution);
      exportTextButton && (exportTextButton.disabled = squares.length===0);
      if (solveButton){ solveButton.disabled = !isProblemGenerated; solveButton.textContent = showSolution?'解答を隠す':'解答を表示'; }
    }

    /* ===== ビューポート（ズーム/パン）===== */
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
      for(const s of squares){ minX=Math.min(minX,s.x); minY=Math.min(minY,s.y); maxX=Math.max(maxX,s.x+s.w); maxY=Math.max(maxY,s.y+s.h); }
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

    // ボタン
    zoomOutBtn?.addEventListener('click',()=>setZoom(zoom-ZOOM_STEP));
    zoomInBtn?.addEventListener('click',()=>setZoom(zoom+ZOOM_STEP));
    zoom100Btn?.addEventListener('click',()=>setZoom(1));
    zoomFitBtn?.addEventListener('click',fitZoom);

    // ホイール：標準はズーム、Shift でパン（横優先）
    canvas.addEventListener('wheel', (e)=>{
      e.preventDefault();
      const rect=canvas.getBoundingClientRect();
      const mx=e.clientX-rect.left, my=e.clientY-rect.top;
      if (e.shiftKey){
        // パン
        if (Math.abs(e.deltaX) > Math.abs(e.deltaY)){
          panX -= e.deltaX;
        }else{
          panX -= e.deltaY; // 縦ホイールで横へ
        }
        applyTransform(); draw(); saveState();
      }else{
        // ズーム（カーソル中心）
        const dir = -Math.sign(e.deltaY);
        setZoomAt(zoom * (1 + dir*0.1), mx, my);
      }
    }, { passive:false });

    // キー：F=Fit、+/−=ズーム
    window.addEventListener('keydown',(e)=>{
      if (e.code==='Space') isSpaceDown=true;
      if (e.code==='KeyF'){ e.preventDefault(); fitZoom(); }
      if (e.key==='+' || e.key==='='){ e.preventDefault(); setZoom(zoom+ZOOM_STEP); }
      if (e.key==='-' || e.key==='_'){ e.preventDefault(); setZoom(zoom-ZOOM_STEP); }
      if (e.key.toLowerCase()==='c'){ e.preventDefault(); checkAllAndReport(); }
    });
    window.addEventListener('keyup',(e)=>{ if (e.code==='Space') isSpaceDown=false; });

    /* ===== 描画 ===== */
    function draw(){
      ctx.save(); ctx.setTransform(devicePR,0,0,devicePR,0,0); ctx.fillStyle='#fff'; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.restore();
      applyTransform();
      for(const s of squares) drawBoard(s);
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
      ctx.font='16px system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
      ctx.textAlign='center'; ctx.textBaseline='middle';
      for(let r=0;r<GRID;r++) for(let c=0;c<GRID;c++){
        const px=s.x+c*CELL+CELL/2, py=s.y+r*CELL+CELL/2;
        const giv=s.problemData[r][c]|0, usr=s.userData[r][c]|0;
        if (giv>0){ ctx.fillStyle='#000'; ctx.fillText(String(giv),px,py); }
        else if (usr>0){ const bad=((s.checkData[r][c]|0)===1);
          ctx.fillStyle = bad ? '#d11' : (showSolution ? '#0a0' : '#2b90ff');
          ctx.fillText(String(usr),px,py);
        }
      }
      // 盤タグ（画面のみ）
      ctx.fillStyle=isActive?'#2b90ff':'#666';
      ctx.fillRect(s.x, s.y-18, 30, 18);
      ctx.fillStyle='#fff'; ctx.font='12px system-ui,-apple-system,Segoe UI,Roboto,sans-serif';
      ctx.fillText(s.id, s.x+15, s.y-9);
      ctx.restore();
    }

    /* ===== ヒット判定 ===== */
    function boardAt(x,y){ for (let i=squares.length-1;i>=0;i--){ const s=squares[i]; if (x>=s.x&&x<s.x+s.w&&y>=s.y&&y<s.y+s.h) return s; } return null; }
    function cellAt(s,x,y){ if(!s) return null; const cx=Math.floor((x-s.x)/CELL), cy=Math.floor((y-s.y)/CELL);
      if (cx<0||cy<0||cx>=GRID||cy>=GRID) return null; return { id:s.id, r:cy, c:cx }; }

    /* ===== 入力 ===== */
    canvas.addEventListener('contextmenu', e=>e.preventDefault());

    canvas.addEventListener('mousedown',(e)=>{
      const rect=canvas.getBoundingClientRect(); const mx=e.clientX-rect.left, my=e.clientY-rect.top;
      const {x:xw,y:yw}=toWorld(mx,my);
      const s=boardAt(xw,yw);

      // 背景を左クリック → そのままパン開始（グリップ移動）
      if (!s && e.button===0){ panning=true; panStart={mx,my,px:panX,py:panY}; activeSquareId=null; activeCell=null; updateButtonStates(); return; }

      if (isSpaceDown || e.button===1 || e.button===2){ panning=true; panStart={mx,my,px:panX,py:panY}; return; }

      if(!s){ activeSquareId=null; activeCell=null; draw(); updateButtonStates(); return; }
      activeSquareId=s.id; activeCell=cellAt(s,xw,yw);
      drag={ id:s.id, offsetX:xw-s.x, offsetY:yw-s.y }; updateButtonStates(); draw();
    });

    canvas.addEventListener('mousemove',(e)=>{
      const rect=canvas.getBoundingClientRect(); const mx=e.clientX-rect.left, my=e.clientY-rect.top;
      if (panning && panStart){ panX=panStart.px+(mx-panStart.mx); panY=panStart.py+(my-panStart.my); applyTransform(); draw(); return; }
      if (!drag) return;
      const {x:xw,y:yw}=toWorld(mx,my); const s=squares.find(x=>String(x.id)===String(drag.id)); if(!s) return;
      let nx=snap(xw-drag.offsetX,SNAP_X), ny=snap(yw-drag.offsetY,SNAP_Y);
      nx=Math.max(0,nx); ny=Math.max(0,ny); s.x=nx; s.y=ny; draw();
    });

    window.addEventListener('mouseup',()=>{ panning=false; panStart=null; drag=null; saveState(); });

    window.addEventListener('keydown',(e)=>{
      if (!isProblemGenerated || !activeCell || showSolution) return;
      const s=squares.find(x=>String(x.id)===String(activeCell.id)); if(!s) return;
      if (s.problemData[activeCell.r][activeCell.c] > 0) return;
      if (e.key>='1'&&e.key<='9'){ s.userData[activeCell.r][activeCell.c]=parseInt(e.key,10); s.checkData[activeCell.r][activeCell.c]=0; draw(); e.preventDefault(); saveState(); return; }
      if (e.key==='Backspace'||e.key==='Delete'||e.key==='0'){ s.userData[activeCell.r][activeCell.c]=0; s.checkData[activeCell.r][activeCell.c]=0; draw(); e.preventDefault(); saveState(); return; }
      const mv={ArrowUp:[-1,0],ArrowDown:[1,0],ArrowLeft:[0,-1],ArrowRight:[0,1]}[e.key];
      if (mv){ const nr=clamp(activeCell.r+mv[0],0,GRID-1), nc=clamp(activeCell.c+mv[1],0,GRID-1); activeCell={ id:activeCell.id, r:nr, c:nc }; draw(); e.preventDefault(); }
    });

    /* ===== ボタン ===== */
    addSquareButton?.addEventListener('click',()=>{
      const s=newSquareAtWorldCenter();
      squares.push(s); activeSquareId=s.id; isProblemGenerated=false; showSolution=false;
      setStatus('盤を追加：中心に生成（背景左ドラッグでパン／ホイールでズーム／Shift+ホイールでパン）');
      updateButtonStates(); draw(); saveState();
    });

    deleteButton?.addEventListener('click',()=>{
      if (activeSquareId==null) return;
      squares=squares.filter(s=>String(s.id)!==String(activeSquareId));
      activeSquareId=null; activeCell=null; isProblemGenerated = squares.length>0 && isProblemGenerated;
      showSolution=false; setStatus('選択中の盤を削除');
      updateButtonStates(); draw(); saveState();
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
      if (squares.length===0 || !isProblemGenerated) return;
      for (const s of squares) runCheck(s);
      runOverlapCheck();
      draw();
      const total=countConflicts();
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

    exportTextButton?.addEventListener('click', ()=>{
      const data={ layout:squares.map(s=>({id:s.id,x:s.x,y:s.y})),
        boards:squares.map(s=>({id:s.id,problem:s.problemData,user:s.userData,solution:s.solutionData})) };
      const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'}); const url=URL.createObjectURL(blob);
      const a=document.createElement('a'); a.href=url; a.download='gattai_export.json'; a.click(); URL.revokeObjectURL(url);
    });

    /* ===== サーバ生成 ===== */
    async function handleGenerateProblem(){
      if (squares.length===0){ alert('まず「盤面を追加」してください'); return; }
      for (const sq of squares){ sq.problemData=createEmptyGrid(); sq.userData=createEmptyGrid(); sq.checkData=createEmptyGrid(); sq.solutionData=createEmptyGrid(); sq._userBackup=null; }
      showSolution=false; isProblemGenerated=false; updateButtonStates(); draw();

      const diff = difficultySel ? String(difficultySel.value||'normal') : 'normal';
      const layout = squares.map(s=>({ id:String(s.id), x:Math.round(s.x), y:Math.round(s.y) }));
      generateProblemButton.disabled=true;

      try{
        setStatus(`問題を生成しています...（難易度:${diff}）`);
        const boards = await generateFromServer(layout, diff);
        renderBoards(boards);
        isProblemGenerated=true;
        for (const s of squares) runCheck(s);
        runOverlapCheck(); draw();
        setStatus(`問題を作成しました！（${boards.length}盤）`);
      }catch(err){
        console.error(err);
        alert(err?.message||'生成に失敗しました');
        setStatus('生成に失敗しました');
      }finally{
        generateProblemButton.disabled=false; updateButtonStates(); saveState();
      }
    }

    async function generateFromServer(layout, difficulty='normal'){
      const res = await fetch('/api/generate',{
        method:'POST',
        headers:{'content-type':'application/json'},
        body: JSON.stringify({ layout, difficulty, overlapEmpty: true }) // ★共有マスは必ず空欄
      });
      if (!res.ok){
        const t = await safeText(res);
        throw new Error(`API ${res.status} ${t||''}`.trim());
      }
      const data=await res.json();
      if (!data?.ok) throw new Error(data?.reason||'ok=false');
      return data.puzzle?.boards||[];
    }

    async function safeText(res){ try{ return await res.text(); }catch{ return ''; } }

    function renderBoards(boards){
      const map=new Map(boards.map(b=>[String(b.id),b]));
      for (const sq of squares){
        const b=map.get(String(sq.id)); if(!b) continue;
        sq.problemData=cloneGrid(b.grid); sq.solutionData=cloneGrid(b.solution||createEmptyGrid());
        sq.userData=createEmptyGrid(); sq.checkData=createEmptyGrid();
      }
      updateButtonStates(); draw(); saveState();
    }

    /* ===== 矛盾チェック（行/列/箱/共有）===== */
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

    /* ===== 保存/復元 ===== */
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
    window.addEventListener('resize', ()=>{ resizeCanvasToDisplaySize(); draw(); });

    // 起動
    resizeCanvasToDisplaySize();
    if (!loadState()){
      setStatus('盤を追加 →「合体問題を作成」。背景左ドラッグでパン、ホイールでズーム、Shift+ホイールでパン、Fでフィット。');
      applyTransform(); draw();
    }else{
      setStatus(isProblemGenerated ? 'プレイ再開できます' : 'レイアウトを復元しました（縦は3セル単位）');
      applyTransform(); draw();
    }
    updateButtonStates();
  });
})();
