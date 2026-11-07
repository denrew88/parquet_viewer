import assert from 'node:assert/strict';
import path from 'node:path';

export async function runLayoutChecks({page,region,editor,text,document,poll,output}) {
  const separator=region().getByRole('separator',{name:'Resize tables and columns',exact:true});
  await separator.waitFor({state:'visible'});
  const value=async()=>Number(await separator.getAttribute('aria-valuenow'));
  const initial=await value(), box=await separator.boundingBox();
  assert.ok(box&&box.height>=6);
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);await page.mouse.down();
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2+60,{steps:8});await page.mouse.up();
  const dragged=await value();assert.ok(dragged>initial+10,'Splitter did not increase Tables height');
  await separator.press('Home');assert.equal(await value(),Number(await separator.getAttribute('aria-valuemin')));
  await separator.press('End');assert.equal(await value(),Number(await separator.getAttribute('aria-valuemax')));
  await separator.dblclick();
  const reset=await value();assert.ok(Math.abs(reset-initial)<=1,'Splitter did not restore default height');
  const help=region().getByRole('button',{name:'Examples & help',exact:true});
  const originalHelp=await help.getAttribute('aria-expanded');
  const longSql="SELECT '"+'x'.repeat(600)+"END_MARKER' AS value;";
  const horizontal=[];
  for(const open of [true,false]) {
    if((await help.getAttribute('aria-expanded')==='true')!==open)await help.click();
    await document(longSql);await editor().press('Control+Home');
    const scroller=region().locator('.sql-code-editor .cm-scroller');
    // CodeMirror may retain a small gutter/caret margin at the start. Verify
    // visible content rather than requiring an engine-specific scrollLeft=0.
    await poll(()=>scroller.evaluate(e=>{
      const first=e.querySelector('.cm-line')?.firstChild;
      if(!first)return false;
      const walker=document.createTreeWalker(first,NodeFilter.SHOW_TEXT);
      const node=first.nodeType===Node.TEXT_NODE?first:walker.nextNode();
      if(!node)return false;
      const range=document.createRange();range.setStart(node,0);range.setEnd(node,Math.min(6,node.textContent.length));
      const r=range.getBoundingClientRect(),v=e.getBoundingClientRect();
      return r.width>0&&r.left>=v.left-1&&r.right<=v.right+1;
    }),visible=>visible);
    await editor().press('Control+End');
    await poll(()=>scroller.evaluate(e=>e.scrollLeft),left=>left>0);
    const geometry=await scroller.evaluate(e=>{
      const bounds=e.getBoundingClientRect(),host=e.closest('.sql-code-editor').getBoundingClientRect();
      const walker=document.createTreeWalker(e,NodeFilter.SHOW_TEXT);let node,marker=null;
      while((node=walker.nextNode())){const start=node.textContent.indexOf('END_MARKER');if(start<0)continue;
        const range=document.createRange();range.setStart(node,start);range.setEnd(node,start+10);const r=range.getBoundingClientRect();
        marker={left:r.left,right:r.right,top:r.top,bottom:r.bottom};break;}
      return{clientWidth:e.clientWidth,scrollWidth:e.scrollWidth,scrollLeft:e.scrollLeft,bounds:{left:bounds.left,right:bounds.right,bottom:bounds.bottom},hostBottom:host.bottom,marker};
    });
    assert.ok(geometry.scrollWidth>geometry.clientWidth);
    assert.ok(geometry.marker&&geometry.marker.left>=geometry.bounds.left-1&&geometry.marker.right<=geometry.bounds.right+1,'Long-line ending is clipped');
    assert.ok(geometry.bounds.bottom<=geometry.hostBottom+1,'Editor scrollbar is below clipping boundary');
    horizontal.push({helpOpen:open,...geometry});
  }
  await page.screenshot({path:path.join(output,'native-sql-layout-horizontal.png')});
  if((await help.getAttribute('aria-expanded'))!==originalHelp)await help.click();
  const newlines=[];
  for(const indent of ['', '  ', '\t']) {
    const before=indent+'SELECT *';await document(before);await editor().press('Enter');
    assert.equal(await text(),before+'\n'+indent);newlines.push({indent,after:await text()});
  }
  await document('SELECT *');await editor().press('Shift+Enter');assert.equal(await text(),'SELECT *\n');
  return{splitter:{initial,dragged,reset,keyboardBounds:true},horizontal,newlines,shiftEnter:true};
}
