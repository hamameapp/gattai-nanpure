// script.js — Cloudflare Pages フロント（置き換え可）
//
// ・サーバ生成(/api/generate overlapEmpty:true)
// ・ズーム（ホイールでカーソル中心 / ボタン / + − キー）、パン（掴んで移動 / 右中ボタン / Space / 背景左ドラッグ）← 改善
// ・盤追加は「今見ている中心」に生成、Yは3セル単位でスナップ
// ・矛盾チェック（行 / 列 / 箱 / 共有）と解答トグル
// ・エクスポート(JSON / 全体PNG：ラベル非表示)
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
    const checkButton = byId('checkButton');     // 矛盾チェック
    const solveButton = byId('solveButton');     // 解答トグル
    const exportTextButton = byId('exportTextButton');   // JSON保存
    const saveAllPngButton = byId('exportImageAllButton');   // 全体PNG保存（ID修正）
    const difficultySel = document.getElementById('difficulty');

    // ズームUI
    const zoomOutBtn = byId('zoomOut');
    const zoomInBtn = byId('zoomIn');
    const zoomFitBtn = byId('zoomFit');
    const zoom100Btn = byId('zoom100');
    const zoomPct = byId('zoomPct');

    // ===== 定数 =====
    const GRID = 9;
    const CELL = 30;
    const GAP = 16;
    const LABEL_H = 22;

    const SNAP_X = CELL;        // Xは1セル単位スナップ
    const SNAP_Y = CELL * 3;    // Yは3セル単位スナップ（見た目が揃う）

    // ===== 状態 =====
    let squares = []; // { id, x, y, problemData[9][9], solutionData[9][9], userData[9][9], checkData[9][9] }
    let nextId = 1;
    let activeSquareId = null;
    let activeCell = null;
    let zoom = 1;
    let panX = 0, panY = 0;
    let drag = null;
    let panning = false;
    let panStart = null;
    let isSpaceDown = false;

    // DPI対応
    const DPR = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
    let showSolution = false;

    // ===== Utils =====
    function byId(id){ return document.getElementById(id) || null; }
    const clamp = (v,lo,hi)=>Math.max(lo,Math.min(hi,v));
    const snap = (v,u)=>Math.round(v/u)*u;
    const createEmptyGrid = ()=>Array.from({length:GRID},()=>Array.from({length:GRID},()=>0));
    const deepClone = (v)=>JSON.parse(JSON.stringify(v));

    // ===== 永続化 =====
    const STORE_KEY = 'gattai_v4';
    function saveState(){
      const st = {
        squares: squares.map(s=>({
          id:s.id, x:s.x, y:s.y,
          problemData:s.problemData, solutionData:s.solutionData,
          userData:s.userData
        })),
        nextId, zoom, panX, panY
      };
      localStorage.setItem(STORE_KEY, JSON.stringify(st));
    }
    function loadState(){
      try{
        const raw = localStorage.getItem(STORE_KEY);
        if(!raw) return;
        const st = JSON.parse(raw);
        squares = st.squares || [];
        nextId = st.nextId || 1;
        zoom = st.zoom || 1;
        panX = st.panX || 0; panY = st.panY || 0;
      }catch{}
    }

    // ===== レイアウト / ワールド座標変換 =====
    function applyTransform(){
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      canvas.width = Math.round(w * DPR);
      canvas.height = Math.round(h * DPR);
      ctx.setTransform(DPR,0,0,DPR,0,0);
      zoomPct.textContent = `${Math.round(zoom*100)}%`;
    }
    function toWorld(mx,my){
      const rect=canvas.getBoundingClientRect();
      const x = (mx) - rect.left;
      const y = (my) - rect.top;
      return { x: (x - panX)/zoom, y: (y - panY)/zoom };
    }
    function setZoom(z){
      zoom = clamp(z, 0.2, 4);
      applyTransform();
      draw();
      saveState();
    }
    function setZoomAt(z, mx, my){
      // ズーム中心を保つ（スクリーン→ワールド→新ズーム→スクリーン）
      const before = toWorld(mx,my);
      zoom = clamp(z, 0.2, 4);
      const after = toWorld(mx,my);
      panX += (after.x - before.x) * zoom;
      panY += (after.y - before.y) * zoom;
      applyTransform(); draw(); saveState();
    }
    function fitZoom(){
      // すべての盤のバウンディングを見てフィット
      if (squares.length===0){ setZoom(1); panX=panY=0; applyTransform(); draw(); saveState(); return; }
      const {minX,minY,maxX,maxY}=contentBounds();
      const pad=40;
      const W = maxX-minX + pad*2;
      const H = maxY-minY + pad*2;
      const cw = canvas.clientWidth, ch = canvas.clientHeight;
      const zx = cw/W, zy = ch/H;
      zoom = clamp(Math.min(zx,zy), 0.2, 4);
      panX = (cw - (minX*zoom)) - (W*zoom - cw)/2;
      panY = (ch - (minY*zoom)) - (H*zoom - ch)/2;
      applyTransform(); draw(); saveState();
    }

    // ===== 盤ユーティリティ =====
    function contentBounds(){
      let minX=Infinity, minY=Infinity, maxX=-Infinity, maxY=-Infinity;
      for (const s of squares){
        const w = GRID*CELL;
        const h = LABEL_H + GRID*CELL;
        minX = Math.min(minX, s.x);
        minY = Math.min(minY, s.y);
        maxX = Math.max(maxX, s.x + w);
        maxY = Math.max(maxY, s.y + h);
      }
      if (!isFinite(minX)){
        minX=minY=0; maxX=canvas.clientWidth; maxY=canvas.clientHeight;
      }
      return {minX,minY,maxX,maxY};
    }
    function boardAt(xw,yw){
      // 上から描画している順（後勝ち）でヒットテスト
      for (let i=squares.length-1;i>=0;i--){
        const s = squares[i];
        const w = GRID*CELL, h = LABEL_H + GRID*CELL;
        if (xw>=s.x && xw<=s.x+w && yw>=s.y && yw<=s.y+h) return s;
      }
      return null;
    }
    function cellAt(s,xw,yw){
      const gx = Math.floor((xw - s.x)/CELL);
      const gy = Math.floor((yw - s.y - LABEL_H)/CELL);
      if (gx<0||gy<0||gx>=GRID||gy>=GRID) return null;
      return { id:s.id, r:gy, c:gx };
    }

    // ===== 入力（ドラッグ/パン）=====
    canvas.addEventListener('contextmenu', e=>e.preventDefault());
    canvas.addEventListener('mousedown',(e)=>{
      const rect=canvas.getBoundingClientRect();
      const mx=e.clientX-rect.left, my=e.clientY-rect.top;
      const {x:xw,y:yw}=toWorld(mx,my);

      // ビューを掴む（Space / 中 / 右）
      if (isSpaceDown || e.button===1 || e.button===2){
        panning=true; panStart={mx,my,px:panX,py:panY}; return;
      }

      // 盤を選択/移動（背景ヒット時は左ドラッグでもパン開始に変更）
      const s=boardAt(xw,yw);
      if(!s){
        // 盤面ヒットなし → 左ドラッグでもパン開始
        panning=true; panStart={mx,my,px:panX,py:panY};
        activeSquareId=null; activeCell=null; draw(); updateButtonStates(); return;
      }
      activeSquareId=s.id; activeCell=cellAt(s,xw,yw);
      drag={ id:s.id, offsetX:xw-s.x, offsetY:yw-s.y }; updateButtonStates(); draw();
    });
    canvas.addEventListener('mousemove',(e)=>{
      const rect=canvas.getBoundingClientRect(); const mx=e.clientX-rect.left, my=e.clientY-rect.top;

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
    });
    window.addEventListener('mouseup',()=>{ panning=false; panStart=null; drag=null; saveState(); });

    window.addEventListener('keydown',(e)=>{
      if (e.code==='Space') isSpaceDown=true;

      // ズームのキーボードショートカット
      if (e.key==='+' || e.key=== '='){ e.preventDefault(); setZoom(zoom+0.1); }
      if (e.key==='-' || e.key=== '_'){ e.preventDefault(); setZoom(zoom-0.1); }
      if (e.key==='0'){ e.preventDefault(); setZoom(1); }
    });
    window.addEventListener('keyup',(e)=>{ if(e.code==='Space') isSpaceDown=false; });

    // ホイール：ズーム（トラックパッドのピンチは ctrlKey=true で来る）
    canvas.addEventListener('wheel', (e)=>{
      e.preventDefault();
      const rect=canvas.getBoundingClientRect();
      const mx=e.clientX-rect.left, my=e.clientY-rect.top;
      const delta = -Math.sign(e.deltaY); // 下スクロールで縮小
      const factor = 1 + delta * 0.1;
      setZoomAt(zoom * factor, mx, my);
    }, { passive:false });

    // ===== 描画 =====
    function draw(){
      ctx.save(); ctx.setTransform(DPR,0,0,DPR,0,0);
      const cw = canvas.clientWidth, ch = canvas.clientHeight;
      ctx.clearRect(0,0,cw,ch);

      ctx.save();
      ctx.translate(panX, panY);
      ctx.scale(zoom, zoom);

      // 背景
      ctx.fillStyle='#fff';
      ctx.fillRect(-panX/zoom,-panY/zoom, cw/zoom, ch/zoom);

      // 盤描画
      for (const s of squares) drawBoard(s, { showLabel:true });

      ctx.restore();
      ctx.restore();
    }

    function drawBoard(s, { showLabel } = { showLabel:true }){
      const x=s.x, y=s.y;

      // ラベル
      if (showLabel){
        ctx.fillStyle = (activeSquareId===s.id) ? '#111827' : '#374151';
        ctx.font='600 14px "Inter","Noto Sans JP",system-ui';
        ctx.textBaseline='top';
        ctx.fillText(`Board #${s.id}`, x, y+2);
      }

      const ox=x, oy=y+LABEL_H;
      ctx.save(); ctx.translate(ox, oy);

      // マス背景
      ctx.fillStyle='#ffffff';
      ctx.fillRect(0,0,GRID*CELL,GRID*CELL);

      // 罫線
      ctx.strokeStyle='#cbd5e1'; ctx.lineWidth=1;
      for (let i=0;i<=GRID;i++){
        ctx.beginPath(); ctx.moveTo(0,i*CELL); ctx.lineTo(GRID*CELL, i*CELL); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(i*CELL,0); ctx.lineTo(i*CELL, GRID*CELL); ctx.stroke();
      }
      ctx.strokeStyle='#334155'; ctx.lineWidth=2;
      for (let i=0;i<=GRID;i+=3){
        ctx.beginPath(); ctx.moveTo(0,i*CELL); ctx.lineTo(GRID*CELL, i*CELL); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(i*CELL,0); ctx.lineTo(i*CELL, GRID*CELL); ctx.stroke();
      }

      // 問題数字
      ctx.fillStyle='#111827';
      ctx.font='700 18px "Inter","Noto Sans JP",system-ui';
      ctx.textAlign='center'; ctx.textBaseline='middle';
      for (let r=0;r<GRID;r++){
        for (let c=0;c<GRID;c++){
          const v = s.problemData?.[r]?.[c] || 0;
          if (!v) continue;
          ctx.fillText(String(v), c*CELL+CELL/2, r*CELL+CELL/2);
        }
      }

      // ユーザ入力（解答モード時のみオーバレイ）
      if (showSolution){
        ctx.fillStyle='#2563eb';
        ctx.font='600 16px "Inter","Noto Sans JP",system-ui';
        for (let r=0;r<GRID;r++){
          for (let c=0;c<GRID;c++){
            const v = s.solutionData?.[r]?.[c] || 0;
            if (!v) continue;
            ctx.fillText(String(v), c*CELL+CELL/2, r*CELL+CELL/2);
          }
        }
      }

      // 矛盾マーク
      if (s.checkData){
        ctx.fillStyle='rgba(239,68,68,.25)';
        for (let r=0;r<GRID;r++){
          for (let c=0;c<GRID;c++){
            if (s.checkData[r][c]) ctx.fillRect(c*CELL, r*CELL, CELL, CELL);
          }
        }
      }

      ctx.restore();
    }

    // ===== UIボタン =====
    function updateButtonStates(){
      const has = squares.length>0;
      deleteButton.disabled = !activeSquareId;
      clearAllBoardsButton.disabled = !has;
      generateProblemButton.disabled = !has;
      checkButton.disabled = !has;
      solveButton.disabled = !has;
      exportTextButton.disabled = !has;
      saveAllPngButton.disabled = !has;
    }

    addSquareButton?.addEventListener('click', ()=>{
      // 画面中心に追加
      const cx = (canvas.clientWidth/2 - panX)/zoom;
      const cy = (canvas.clientHeight/2 - panY)/zoom;

      const s = {
        id: nextId++,
        x: Math.max(0, snap(cx - (GRID*CELL)/2, SNAP_X)),
        y: Math.max(0, snap(cy - (LABEL_H + GRID*CELL)/2, SNAP_Y)),
        problemData: createEmptyGrid(),
        solutionData: createEmptyGrid(),
        userData: createEmptyGrid(),
        checkData: createEmptyGrid()
      };
      squares.push(s); activeSquareId=s.id;
      saveState(); updateButtonStates(); draw();
    });

    deleteButton?.addEventListener('click', ()=>{
      if (!activeSquareId) return;
      squares = squares.filter(s=>s.id!==activeSquareId);
      activeSquareId=null;
      saveState(); updateButtonStates(); draw();
    });

    clearAllBoardsButton?.addEventListener('click', ()=>{
      if (!confirm('すべて削除します。よろしいですか？')) return;
      squares=[]; nextId=1; activeSquareId=null; showSolution=false;
      panX=panY=0; zoom=1;
      saveState(); updateButtonStates(); draw();
    });

    // ===== 生成（サーバ）=====
    async function handleGenerateProblem(){
      if (squares.length===0){ alert('まず「盤面を追加」してください'); return; }
      for (const sq of squares){ sq.problemData=createEmptyGrid(); sq.userData=createEmptyGrid(); sq.checkData=createEmptyGrid(); }
      updateButtonStates(); draw();

      const layout = squares.map(s=>({
        id:s.id, x:s.x, y:s.y, w:GRID, h:GRID, labelH:LABEL_H
      }));

      statusDiv.textContent='生成中…（唯一解＆共有マス空欄）';
      generateProblemButton.disabled=true;
      try{
        const data = await generateFromServer(layout, difficultySel.value || 'normal');
        // 反映
        for (const b of data.boards){
          const s = squares.find(x=>String(x.id)===String(b.id)); if (!s) continue;
          s.problemData = deepClone(b.grid);
          s.solutionData = deepClone(b.solution);
        }
        statusDiv.textContent='生成完了';
      }catch(err){
        console.error(err);
        alert('生成に失敗しました。少し難易度を下げるか、配置を調整して再試行してください。');
        statusDiv.textContent='生成に失敗しました';
      }finally{
        generateProblemButton.disabled=false; updateButtonStates(); draw(); saveState();
      }
    }

    async function generateFromServer(layout, difficulty='normal'){
      const res = await fetch('/api/generate', {
        method:'POST',
        headers:{ 'content-type':'application/json' },
        body: JSON.stringify({ layout, difficulty, overlapEmpty: true }) // ★共有マスは必ず空欄
      });
      if (!res.ok){
        let msg=''; try{ msg = await res.text(); }catch{}
        throw new Error(`API ${res.status} ${msg}`);
      }
      const data = await res.json();
      if (!data?.ok) throw new Error(data?.reason || 'unknown failure');
      return data;
    }

    generateProblemButton?.addEventListener('click', handleGenerateProblem);

    // ===== 矛盾チェック =====
    checkButton?.addEventListener('click', ()=>{
      for (const s of squares){
        s.checkData = createEmptyGrid();
        // 行/列/箱の単純衝突を塗る
        const seenRow = Array.from({length:GRID},()=>new Map());
        const seenCol = Array.from({length:GRID},()=>new Map());
        const seenBox = Array.from({length:GRID},()=>new Map());
        for (let r=0;r<GRID;r++){
          for (let c=0;c<GRID;c++){
            const v = s.problemData[r][c];
            if (!v) continue;
            const b = Math.floor(r/3)*3 + Math.floor(c/3);
            const key = String(v);

            if (seenRow[r].has(key)){
              s.checkData[r][c]=1; const {r:rr,c:cc}=seenRow[r].get(key); s.checkData[rr][cc]=1;
            }else seenRow[r].set(key, {r,c});

            if (seenCol[c].has(key)){
              s.checkData[r][c]=1; const {r:rr,c:cc}=seenCol[c].get(key); s.checkData[rr][cc]=1;
            }else seenCol[c].set(key, {r,c});

            if (seenBox[b].has(key)){
              s.checkData[r][c]=1; const {r:rr,c:cc}=seenBox[b].get(key); s.checkData[rr][cc]=1;
            }else seenBox[b].set(key, {r,c});
          }
        }
      }
      draw();
    });

    // ===== 解答トグル =====
    solveButton?.addEventListener('click', ()=>{
      showSolution = !showSolution;
      draw();
    });

    // ===== エクスポート =====
    exportTextButton?.addEventListener('click', ()=>{
      const payload = squares.map(s=>({
        id:s.id, x:s.x, y:s.y, grid:s.problemData, solution:s.solutionData
      }));
      const blob = new Blob([JSON.stringify(payload,null,2)], { type:'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      const ts = new Date();
      a.href = url;
      a.download = `gattai_${ts.getFullYear()}${String(ts.getMonth()+1).padStart(2,'0')}${String(ts.getDate()).padStart(2,'0')}.json`;
      a.click(); URL.revokeObjectURL(url);
    });

    // 全体PNG保存（ラベル非表示）
    saveAllPngButton?.addEventListener('click', ()=>{
      if (squares.length===0) return;
      const {minX,minY,maxX,maxY}=contentBounds();
      const pad = 10;
      const W = Math.ceil(maxX-minX) + pad*2;
      const H = Math.ceil(maxY-minY) + pad*2;

      const off = document.createElement('canvas');
      const scale = 2; // 高解像度
      off.width = W*scale; off.height = H*scale;
      const octx = off.getContext('2d', { alpha:false });

      // 背景
      octx.fillStyle='#fff'; octx.fillRect(0,0,off.width,off.height);
      octx.scale(scale, scale);
      octx.translate(pad - minX, pad - minY);

      // 盤描画（ラベル非表示・ハイライトなし）
      for (const s of squares){
        // 一時的に現在のユーザ入力をそのまま描画（チェック赤も無効）
        const copy = { ...s, checkData:createEmptyGrid() };
        drawBoard.call({ ctx:octx }, copy, { showLabel:false });
      }

      // ダウンロード
      off.toBlob((blob)=>{
        const ts = new Date();
        const name = `gattai_all_${ts.getFullYear()}${String(ts.getMonth()+1).padStart(2,'0')}${String(ts.getDate()).padStart(2,'0')}_${String(ts.getHours()).padStart(2,'0')}${String(ts.getMinutes()).padStart(2,'0')}${String(ts.getSeconds()).padStart(2,'0')}.png`;
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url);
      }, 'image/png');
    });

    // ===== 初期化 =====
    loadState();
    applyTransform();
    updateButtonStates();
    draw();

    // フィットボタンたち
    zoomOutBtn?.addEventListener('click',()=>setZoom(zoom-0.1));
    zoomInBtn?.addEventListener('click',()=>setZoom(zoom+0.1));
    zoom100Btn?.addEventListener('click',()=>setZoom(1));
    zoomFitBtn?.addEventListener('click',fitZoom);

    // 画面リサイズでキャンバス更新
    const ro = new ResizeObserver(()=>{ applyTransform(); draw(); });
    ro.observe(canvas);
  });
})();
