// Browser equivalent of preload.js, scoped to this tool's Companion route.
(() => {
  const listeners=new Map();
  const base=new URL('.',location.href);
  async function invoke(channel,data) {
    if(channel==='app:quit'){
      parent.document.querySelector('[data-view=manage]').click();
      return {ok:true};
    }
    const token=parent.document.querySelector('meta[name="companion-token"]').content;
    const response=await fetch(new URL('bridge/invoke',base),{method:'POST',headers:{'Content-Type':'application/json','X-Companion-Token':token},body:JSON.stringify({channel,data})});
    const result=await response.json();if(!response.ok)throw Error(result.error||'Tool request failed.');return result;
  }
  function on(channel,callback){if(!listeners.has(channel))listeners.set(channel,new Set());listeners.get(channel).add(callback);return()=>listeners.get(channel)?.delete(callback);}
  window.electron={
    invoke,on,
    selectFolder:(type,defaultPath)=>invoke('select-folder',{type,defaultPath}),
    getDesktopCapabilities:()=>invoke('desktop:getCapabilities'),
    getDefaultOutputDir:()=>invoke('get-default-output-dir'),
    quitApp:()=>invoke('app:quit'),
    getMLJobStatus:()=>invoke('ml:jobStatus'),
    getTrendDatasetOptions:outputDir=>invoke('analysis:getTrendDatasetOptions',{outputDir}),
    getImagePreview:(targetPath,allowedRoot)=>invoke('analysis:getImagePreview',{targetPath,allowedRoot}),
    runTrendAnalysis:(outputDir,datasetId,limit,window)=>invoke('analysis:runTrendAnalysis',{outputDir,datasetId,limit,window}),
    getMLProgressHistory:(outputDir,datasetId,modelId,sinceRunId)=>invoke('ml:getProgressHistory',{outputDir,datasetId,modelId,sinceRunId}),
    openPath:targetPath=>invoke('shell:openPath',{targetPath}),
    requestMLStop:()=>invoke('ml:requestStop'),
    onMLProgress:callback=>on('ml-progress',callback),
    onMLLog:callback=>on('ml-log',callback)
  };
  let cursor=0,closed=false;
  window.addEventListener('pagehide',()=>{closed=true;});
  async function poll(){
    try{const response=await fetch(new URL('bridge/events?since='+cursor,base));if(!response.ok)return;const data=await response.json();cursor=data.cursor;for(const event of data.events)for(const callback of listeners.get(event.channel)||[])callback(event.payload);}
    catch(error){console.warn('Tool connection interrupted:',error.message);}
    finally{if(!closed)setTimeout(poll,500);}
  }
  poll();
})();
