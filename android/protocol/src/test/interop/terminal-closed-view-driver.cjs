// Actual shipped xterm5.5 and terminal page; jsdom supplies layout/canvas stubs only.
'use strict'
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), assert = require('node:assert/strict')
const { JSDOM } = require('jsdom')
const scriptPath = process.argv[2]
assert.ok(scriptPath, 'pass the actual terminal.js asset as argv[2]')
const assets = process.argv[3] || path.dirname(scriptPath)
const script = fs.readFileSync(scriptPath, 'utf8')
const digestBytes = bytes => crypto.createHash('sha256').update(bytes).digest('hex')
const digest = file => digestBytes(fs.readFileSync(file))
const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'terminal-closed-view-raw.json'), 'utf8'))
assert.equal(fixture.schema, 1)
const EXPECTED_RAW = [
  ['immediate', 'b84c4363df8ad30e0d409866ed9b03ada01464c1b2dc58e2aa3685594c31eeb7', 1542, 1387, 0],
  ['delayed', '1e5a93d7e6bac2546005f9ecd937584662e4d85d75de9d6e02aa1606ee48aff4', 1538, 1383, 150]
]
assert.equal(fixture.records.length, EXPECTED_RAW.length)
const rawRecords = fixture.records.map((record, i) => {
  const raw = Buffer.from(record.base64, 'base64')
  assert.equal(raw.toString('base64'), record.base64, 'canonical exact raw bytes')
  assert.deepEqual([record.variant, record.rawSha256, record.bytes, record.beforeOffset, record.requestedFinalWriteDelayMs], EXPECTED_RAW[i])
  assert.equal(digestBytes(raw), record.rawSha256, 'original native raw fixture hash')
  assert.equal(raw.length, record.bytes)
  assert.equal(record.cols, 49); assert.equal(record.rows, 48)
  return {...record, raw}
})
// Capture timing is provenance only: replay deliberately uses coalesced or one-byte writes.
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const cases = []
const EXPECTED_CASES = Object.freeze([
  "immediate real suffix coalesced",
  "immediate real suffix byte splits",
  "delayed real suffix coalesced",
  "delayed real suffix byte splits",
  "relay/native opt-out uses unchanged live parser",
  "queued EOF cancelled by begin",
  "queued EOF cancelled by pagehide",
  "queued EOF cancelled by suspend",
  "live ED2 repaint and later teardown retain current pane",
  "latest blank ED2 replaces an older populated capture",
  "drop without outer mode restore keeps active pane unchanged",
  "Unicode wrap Copy and OSC8/plain URL touch are captured without input",
  "closed user-origin event cannot turn next viewer DA into typed input",
  "closed display invalidates on paint",
  "closed display invalidates on reset",
  "settled closed rows and Copy survive refit",
  "settled closed rows and Copy survive setFontSize",
  "settled closed rows and Copy survive resize",
  "geometry invalidates only a pending EOF promotion",
  "old closed link touch cannot activate a successor snapshot",
  "same-view JS submit keeps separated Enter",
  "same-view delayed Enter survives refit font and resize barriers",
  "delayed JS Enter cannot cross begin",
  "delayed JS Enter cannot cross retire",
  "settled snapshot redraw uses changed layout and font for its owned link touch",
  "stationary closed touch on wrapped plain URL offers the exact complete URL",
  "generated tmux TUI repaint keeps live alternate modes and reports before EOF"
])
async function environment(cols = 49, rows = 48) {
  const style = fs.readFileSync(path.join(assets, 'index.html'), 'utf8').match(/<style>([\s\S]*?)<\/style>/)[1]
  const dom = new JSDOM('<!doctype html><style>' + fs.readFileSync(path.join(assets,'xterm.css'),'utf8') + style + '*{padding:0}</style><div id="term"></div>', {url:'https://terminal.test/',runScripts:'outside-only',pretendToBeVisual:true})
  const win = dom.window
  win.TextDecoder = TextDecoder; win.TextEncoder = TextEncoder
  win.matchMedia = () => ({matches:false,addListener(){},removeListener(){}})
  win.HTMLCanvasElement.prototype.getContext = () => ({measureText:() => ({width:10,actualBoundingBoxAscent:16,actualBoundingBoxDescent:4}),fillRect(){},clearRect(){},getImageData:() => ({data:new Uint8Array([0,0,0,255])}),createLinearGradient:() => ({addColorStop(){}})})
  let layout={left:4,top:2,width:520,height:900,clientWidth:526,clientHeight:906}
  Object.defineProperties(win.HTMLElement.prototype,{clientWidth:{get(){return layout.clientWidth}},clientHeight:{get(){return layout.clientHeight}},offsetWidth:{get(){return (this.textContent||'').length*10}},offsetHeight:{get(){return 20}}})
  win.HTMLElement.prototype.getBoundingClientRect = () => ({left:layout.left,top:layout.top,width:layout.width,height:layout.height,right:layout.left+layout.width,bottom:layout.top+layout.height})
  let term, ready = false, copied
  const inputs = [], reports = [], opened = [], scrolls = []
  win.NodetermBridge = {copyLimit:() => 400000,onResize(){},onInput(d){inputs.push(d)},onReport(d){reports.push(d)},onScroll(...a){scrolls.push(a)},onScrollStop(){},onScrollView(...a){scrolls.push(a)},onHistoryClose(){},onCopy(){},onCopyTooLarge(){},onCopySheet(raw){copied=JSON.parse(raw)},openUrl(uri){opened.push(uri)},onReady(){ready=true}}
  win.eval(fs.readFileSync(path.join(assets,'xterm.js'),'utf8'))
  const Original = win.Terminal
  win.Terminal = class extends Original {constructor(options){super(options);term=this}}
  win.eval(fs.readFileSync(path.join(assets,'addon-fit.js'),'utf8'))
  win.eval(script)
  for (let n=0;!ready&&n<100;n++) await pause(5)
  assert.ok(ready,'actual page ready')
  term.resize(cols, rows)
  const drain = () => new Promise(resolve => term.write('',resolve))
  const write = text => {win.nt.write(Buffer.from(text).toString('base64'))}
  const parsed = async text => {write(text);await drain()}
  const begin = async (token='one',known=true) => {win.nt.beginViewer(token,known);await drain()}
  const copy = () => {win.nt.copySheet();return copied}
  const visible = () => !win.document.getElementById('closed-view').hidden
  const screen = () => Array.from({length:term.buffer.active.length},(_,r)=>term.buffer.active.getLine(r).translateToString(true))
  function touch(type,x,y,moved=false) {
    const e = new win.Event(type,{bubbles:true,cancelable:true})
    const t = {clientX:x,clientY:y,identifier:1}
    Object.defineProperties(e,{touches:{value:(type==='touchend'||type==='touchcancel')?[]:[t]},changedTouches:{value:[t]}})
    win.document.getElementById('closed-view').dispatchEvent(e)
    return e.defaultPrevented
  }
  const setLayout = next => {layout={...layout,...next};const host=win.document.getElementById('term');host.style.width=layout.clientWidth+'px';host.style.height=layout.clientHeight+'px'}
  return {win,term,inputs,reports,opened,scrolls,drain,write,parsed,begin,copy,visible,screen,touch,setLayout,close:()=>dom.window.close()}
}
async function test(name,fn) {
  const started=performance.now()
  try {const detail=await fn();cases.push({name,passed:true,elapsedMs:+(performance.now()-started).toFixed(3),detail})}
  catch(error){cases.push({name,passed:false,elapsedMs:+(performance.now()-started).toFixed(3),errorType:error.name,error:String(error.message).slice(0,2000),stack:String(error.stack).slice(0,4000)})}
}
const ALT='\x1b[?1049h', CLEAR='\x1b[2J', CURSOR_HOME='\x1b[H', END=CLEAR+'\x1b[?1049l[exited]\r\n'
async function closedSimple(e,text='CURRENT_VISIBLE') {await e.begin();await e.parsed(ALT+CURSOR_HOME+text);e.write(END);e.win.nt.endViewer('one');await e.drain();assert.ok(e.visible(),'closed pane promoted after parser drain')}
async function rawCase(record, split, known=true, cancel=null) {
  const e=await environment(record.cols,record.rows)
  try {
    const raw=record.raw
    await e.begin('one',known)
    await e.parsed(raw.subarray(0,record.beforeOffset))
    assert.ok(e.screen().some(row=>row.includes('A133_BEFORE_EXIT')),'calibrated real prefix')
    const priorRows=Array.from({length:12},(_,n)=>'A133_ROW_'+String(n).padStart(2,'0')+' Ω🧭')
    for(const row of priorRows) assert.ok(e.screen().some(line=>line.includes(row)), 'original prefix retains '+row)
    const suffix=raw.subarray(record.beforeOffset)
    if(split) for(const b of suffix) e.write(Uint8Array.of(b)); else e.write(suffix)
    // Do not await the pending bytes: end must supply its own parse barrier.
    e.win.nt.endViewer('one')
    if(cancel==='begin') e.win.nt.beginViewer('two',true)
    if(cancel==='pagehide') e.win.dispatchEvent(new e.win.Event('pagehide'))
    if(cancel==='suspend') e.win.nt.suspendScroll()
    await e.drain()
    assert.equal(e.term.buffer.active.type,'normal','real tmux mode restore still parsed')
    assert.ok(e.screen().some(row=>row.includes('[exited]')),'live parser retains real trailer')
    assert.equal(e.visible(),known&&!cancel,'explicit current SSH EOF only')
    const copied=e.copy()
    if(known&&!cancel) {
      const displayed=e.win.document.getElementById('closed-view').textContent
      for(const row of [...priorRows,'A133_FINAL_TAIL']) {
        assert.ok(copied.lines.some(line=>line.includes(row)), 'closed Copy retains '+row)
        assert.ok(displayed.includes(row), 'closed display retains '+row)
      }
      e.win.nt.closeScrollView();assert.ok(e.visible(),'action retirement keeps closed display')
    } else assert.ok(!copied.lines.some(line=>line.includes('A133_FINAL_TAIL')),'retired/opt-out capture not adopted')
    return {rawSha256:digestBytes(raw),splitAtEveryByte:split,knownSshTmux:known,cancel,liveType:e.term.buffer.active.type,copy:copied}
  } finally {e.close()}
}
async function main() {
  for(const record of rawRecords) for(const split of [false,true]) await test(record.variant+' real suffix '+(split?'byte splits':'coalesced'),()=>rawCase(record,split))
  await test('relay/native opt-out uses unchanged live parser',()=>rawCase(rawRecords[0],false,false))
  for(const cancel of ['begin','pagehide','suspend']) await test('queued EOF cancelled by '+cancel,()=>rawCase(rawRecords[0],false,true,cancel))
  await test('live ED2 repaint and later teardown retain current pane',async()=>{
    const e=await environment();try {await e.begin();await e.parsed(ALT+CURSOR_HOME+'OLD');await e.parsed(CLEAR+CURSOR_HOME+'NEW');assert.equal(e.visible(),false);assert.ok(e.screen()[0].includes('NEW'));e.write(END);e.win.nt.endViewer('one');await e.drain();assert.ok(e.visible());assert.ok(e.copy().lines[0].includes('NEW'));assert.ok(!e.copy().lines.join('').includes('OLD'));return {copy:e.copy()}} finally {e.close()}
  })
  await test('latest blank ED2 replaces an older populated capture',async()=>{
    const e=await environment();try {await e.begin();await e.parsed(ALT+CURSOR_HOME+'STALE');await e.parsed(CLEAR);e.write(END);e.win.nt.endViewer('one');await e.drain();assert.ok(e.visible());assert.deepEqual(e.copy().lines,[]);return {copy:e.copy()}} finally {e.close()}
  })
  await test('drop without outer mode restore keeps active pane unchanged',async()=>{
    const e=await environment();try {await e.begin();await e.parsed(ALT+CURSOR_HOME+'LIVE_PANE');e.win.nt.endViewer('one');await e.drain();assert.equal(e.visible(),false);assert.equal(e.term.buffer.active.type,'alternate');assert.ok(e.copy().lines[0].includes('LIVE_PANE'));return {copy:e.copy()}} finally {e.close()}
  })
  await test('Unicode wrap Copy and OSC8/plain URL touch are captured without input',async()=>{
    const e=await environment(40,12);try {
      await e.begin();const uri='https://example.test/osc8';const long='https://example.test/long/'+ 'segment'.repeat(8)
      await e.parsed(ALT+CURSOR_HOME+'Ω 🧭 日本語\r\n\x1b]8;;'+uri+'\x1b\\LABEL\x1b]8;;\x1b\\\r\n'+long)
      const before=e.copy();assert.ok(before.links.includes(uri));assert.ok(before.links.includes(long));assert.ok(e.term.buffer.active.getLine(3).isWrapped)
      e.write(END);e.win.nt.endViewer('one');await e.drain();assert.ok(e.visible());assert.deepEqual(e.copy(),before)
      const x=4+(0.5*520/40), y=2+(1.5*900/12)
      e.touch('touchstart',x,y);assert.ok(e.touch('touchend',x,y));assert.deepEqual(e.opened,[uri])
      e.touch('touchstart',x,y);e.touch('touchmove',x,y+50);e.touch('touchend',x,y+50);assert.equal(e.opened.length,1,'moved touch inert')
      e.win.nt.raw(Buffer.from('never').toString('base64'));e.win.nt.key('enter');e.win.nt.submit(Buffer.from('never').toString('base64'),true);e.term.paste('ignored');e.win.nt.resumeScroll();await pause(180)
      assert.deepEqual(e.inputs,[]);assert.deepEqual(e.scrolls,[]);assert.ok(e.visible());return {beforeCopy:before,closedCopy:e.copy(),offered:e.opened,inputCount:e.inputs.length}
    } finally {e.close()}
  })
  await test('closed user-origin event cannot turn next viewer DA into typed input',async()=>{
    const e=await environment();try {await closedSimple(e);e.term.paste('ignored');await e.begin('two');e.inputs.length=0;e.reports.length=0;await e.parsed('\x1b[c');assert.deepEqual(e.inputs,[]);assert.ok(e.reports.some(d=>d.endsWith('c')));return {inputs:e.inputs,reports:e.reports}} finally {e.close()}
  })
  for(const action of ['paint','reset']) await test('closed display invalidates on '+action,async()=>{
    const e=await environment();try {await closedSimple(e);if(action==='paint')e.win.nt.paint(Buffer.from('NEW_SNAPSHOT').toString('base64'));else if(action==='setFontSize')e.win.nt.setFontSize(19);else e.win.nt[action]();await e.drain();assert.equal(e.visible(),false);assert.ok(!e.copy().lines.join('').includes('CURRENT_VISIBLE'));return {action,copy:e.copy()}} finally {e.close()}
  })
  for(const action of ['refit','setFontSize','resize']) await test('settled closed rows and Copy survive '+action,async()=>{
    const e=await environment();try {await closedSimple(e);const before=e.copy();if(action==='resize')e.win.dispatchEvent(new e.win.Event('resize'));else if(action==='setFontSize')e.win.nt.setFontSize(19);else e.win.nt.refit();await e.drain();assert.ok(e.visible());assert.deepEqual(e.copy(),before);assert.deepEqual(e.inputs,[]);return {action,copy:e.copy()}} finally {e.close()}
  })
  await test('geometry invalidates only a pending EOF promotion',async()=>{
    const e=await environment();try {await e.begin();await e.parsed(ALT+CURSOR_HOME+'PENDING');e.write(END);e.win.nt.endViewer('one');e.win.nt.refit();await e.drain();assert.equal(e.visible(),false);return {copy:e.copy()}} finally {e.close()}
  })
  await test('old closed link touch cannot activate a successor snapshot',async()=>{
    const e=await environment();try {
      const label=uri=>'\x1b]8;;'+uri+'\x1b\\LABEL\x1b]8;;\x1b\\'
      await closedSimple(e,label('https://example.test/old'))
      const x=4+520/49/2,y=2+900/48/2;e.touch('touchstart',x,y)
      await e.begin('two');await e.parsed(ALT+CURSOR_HOME+label('https://example.test/new'));e.write(END);e.win.nt.endViewer('two');await e.drain();assert.ok(e.visible())
      e.touch('touchend',x,y);assert.deepEqual(e.opened,[]);return {opened:e.opened}
    } finally {e.close()}
  })
  await test('same-view JS submit keeps separated Enter',async()=>{
    const e=await environment();try {await e.begin();e.win.nt.submit(Buffer.from('TEXT').toString('base64'),true);assert.deepEqual(e.inputs,['TEXT']);await pause(180);assert.deepEqual(e.inputs,['TEXT','\r']);return {inputs:e.inputs}} finally {e.close()}
  })
  await test('same-view delayed Enter survives refit font and resize barriers',async()=>{
    const e=await environment();try {
      await e.begin();e.win.nt.submit(Buffer.from('TEXT').toString('base64'),true)
      e.win.nt.refit();e.win.nt.setFontSize(19);e.win.dispatchEvent(new e.win.Event('resize'))
      await e.drain();await pause(180)
      assert.deepEqual(e.inputs,['TEXT','\r']);assert.deepEqual(e.scrolls,[])
      return {inputs:e.inputs,sameViewerLayoutChanges:true}
    } finally {e.close()}
  })
  for(const action of ['begin','retire']) await test('delayed JS Enter cannot cross '+action,async()=>{
    const e=await environment();try {await e.begin();e.win.nt.submit(Buffer.from('TEXT').toString('base64'),true);if(action==='begin')e.win.nt.beginViewer('two',true);else e.win.nt.retireViewer();await pause(180);assert.deepEqual(e.inputs,['TEXT']);return {inputs:e.inputs}} finally {e.close()}
  })
  await test('settled snapshot redraw uses changed layout and font for its owned link touch',async()=>{
    const e=await environment(40,12);try {
      const uri='https://example.test/changed-layout'
      await closedSimple(e,'Ω 🧭 ROW_ZERO\r\n\x1b]8;;'+uri+'\x1b\\LABEL\x1b]8;;\x1b\\')
      const before=e.copy(),oldGrid={cols:e.term.cols,rows:e.term.rows}
      e.setLayout({left:104,top:202,width:300,height:240,clientWidth:306,clientHeight:246})
      e.win.nt.setFontSize(19);e.win.dispatchEvent(new e.win.Event('resize'));await e.drain()
      assert.ok(e.visible());assert.deepEqual(e.copy(),before)
      const layer=e.win.document.getElementById('closed-view')
      assert.ok(layer.textContent.includes('Ω 🧭 ROW_ZERO'));assert.ok(layer.textContent.includes('LABEL'))
      assert.equal(layer.children[1].style.fontSize,'19px')
      const screen=e.term.element.querySelector('.xterm-screen').getBoundingClientRect()
      assert.equal(screen.left,104);assert.equal(screen.top,202);assert.equal(screen.width,300);assert.equal(screen.height,240)
      assert.ok(e.term.cols!==oldGrid.cols||e.term.rows!==oldGrid.rows,'actual fit admits the changed grid')
      assert.equal(parseFloat(layer.children[1].style.lineHeight),screen.height/e.term.rows)
      const x=screen.left+0.5*screen.width/e.term.cols,y=screen.top+1.5*screen.height/e.term.rows
      e.touch('touchstart',x,y);assert.ok(e.touch('touchend',x,y));assert.deepEqual(e.opened,[uri])
      assert.deepEqual(e.inputs,[]);assert.deepEqual(e.scrolls,[])
      return {beforeGrid:oldGrid,currentGrid:{cols:e.term.cols,rows:e.term.rows},screen,touch:{x,y},offered:e.opened,copy:e.copy(),componentLayoutOnly:true}
    } finally {e.close()}
  })
  await test('stationary closed touch on wrapped plain URL offers the exact complete URL',async()=>{
    const e=await environment(30,10);try {
      const uri='https://example.test/plain/'+ 'segment'.repeat(8)
      await closedSimple(e,'HEADER\r\n'+uri)
      assert.ok(e.copy().links.includes(uri));assert.ok(e.copy().lines.some(line=>line.includes(uri)))
      const x=4+5.5*520/30,y=2+2.5*900/10
      e.touch('touchstart',x,y);assert.ok(e.touch('touchend',x,y));assert.deepEqual(e.opened,[uri])
      assert.deepEqual(e.inputs,[]);assert.deepEqual(e.scrolls,[])
      return {completeUrl:uri,touchedCapturedPhysicalRow:2,touchedCapturedColumn:5,offered:e.opened,copy:e.copy()}
    } finally {e.close()}
  })
  await test('generated tmux TUI repaint keeps live alternate modes and reports before EOF',async()=>{
    const e=await environment();try {
      await e.begin()
      // Generated outer-tmux painter frames, not an actual inner-TUI or SSH runtime recording.
      await e.parsed(ALT+'\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[?1h'+CLEAR+CURSOR_HOME+'TUI_FRAME\r\n> choice one\x1b[5n')
      assert.equal(e.term.buffer.active.type,'alternate');assert.equal(e.term.modes.mouseTrackingMode,'vt200')
      assert.equal(e.term.modes.applicationCursorKeysMode,true);assert.equal(e.term.modes.bracketedPasteMode,true)
      assert.ok(e.reports.includes('\x1b[0n'));assert.equal(e.visible(),false);assert.ok(e.copy().lines[0].includes('TUI_FRAME'))
      e.reports.length=0
      await e.parsed(CLEAR+CURSOR_HOME+'SHELL_REPAINT\r\n$ ready'+'\x1b[?1000l\x1b[?1006l\x1b[?2004l\x1b[?1l\x1b[5n')
      assert.equal(e.term.buffer.active.type,'alternate');assert.equal(e.term.modes.mouseTrackingMode,'none')
      assert.equal(e.term.modes.applicationCursorKeysMode,false);assert.equal(e.term.modes.bracketedPasteMode,false)
      assert.ok(e.reports.includes('\x1b[0n'));assert.equal(e.visible(),false)
      assert.ok(e.copy().lines[0].includes('SHELL_REPAINT'));assert.ok(!e.copy().lines.join('').includes('TUI_FRAME'));assert.deepEqual(e.inputs,[])
      const liveCopy=e.copy();e.write(END);e.win.nt.endViewer('one');await e.drain()
      assert.ok(e.visible());assert.deepEqual(e.copy(),liveCopy)
      return {generatedComponentFrames:true,innerTuiRuntimeAcceptance:false,liveCopy,queryReports:e.reports,typedInputs:e.inputs,closedOnlyAfterExplicitEof:true}
    } finally {e.close()}
  })
  const names=cases.map(c=>c.name)
  assert.equal(names.length,EXPECTED_CASES.length,'exact component case count')
  assert.equal(new Set(names).size,names.length,'unique component case names')
  assert.deepEqual(names,EXPECTED_CASES,'exact ordered component case inventory')
  const passed=cases.every(c=>c.passed)
  process.stdout.write(JSON.stringify({schema:1,passed,fixtureSourceRevision:fixture.provenance.sourceRevision,candidateSha256:digest(scriptPath),harnessSha256:digest(__filename),parser:'actual shipped xterm5.5',environment:'jsdom layout/canvas stubs',cases,physicalAcceptance:false,sshRuntimeAcceptance:false,transientPaintTimingAcceptance:false})+'\n')
  process.exitCode=passed?0:1
}
main().catch(error=>{process.stderr.write(error.stack+'\n');process.exitCode=1})
