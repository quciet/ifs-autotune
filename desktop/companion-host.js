// Reuse the desktop IPC handlers behind a token-protected loopback service.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function createBridge(ipcMain) {
  const handlers = new Map();
  const register = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = (name, handler) => { handlers.set(name, handler); register(name, handler); };
  let sequence = 0;
  const events = [];
  const emit = (channel, payload) => {
    events.push({id: ++sequence, channel, payload});
    if (events.length > 2000) events.splice(0, events.length - 2000);
  };
  return {
    emit,
    start({directory, busy, quit}) {
      const token = process.env.IFS_TOOL_TOKEN;
      if (!token || !process.env.IFS_TOOL_READY_FILE) throw Error('Missing Companion launch configuration.');
      const send = (res, status, value, type='application/json') => {
        res.writeHead(status, {'Content-Type': type, 'Cache-Control': 'no-store'});
        res.end(type==='application/json' ? JSON.stringify(value) : value);
      };
      const server = http.createServer(async (req, res) => {
        try {
          const supplied = Buffer.from(req.headers['x-ifs-tool-token'] || '');
          const expected = Buffer.from(token);
          if (supplied.length!==expected.length || !crypto.timingSafeEqual(supplied,expected)) return send(res,403,{error:'Companion authentication required.'});
          const url = new URL(req.url, 'http://127.0.0.1');
          if(req.method==='POST' && url.pathname==='/bridge/shutdown') {
            send(res,200,{ok:true});setImmediate(()=>{server.close();quit();});return;
          }
          if(req.method==='GET' && url.pathname==='/bridge/status') return send(res,200,{running:busy()});
          if(req.method==='GET' && url.pathname==='/bridge/events') {
            const since=Number(url.searchParams.get('since'))||0;
            return send(res,200,{events:events.filter(e=>e.id>since),cursor:sequence});
          }
          if(req.method==='POST' && url.pathname==='/bridge/invoke') {
            let body='', size=0;
            for await (const chunk of req) {size+=chunk.length;if(size>8*1024*1024)throw Error('Request too large.');body+=chunk;}
            const {channel,data}=JSON.parse(body);
            if(channel==='app:quit') return send(res,200,{ok:false,message:'Close this tool from Companion’s Manage tools screen.'});
            const handler=handlers.get(channel);
            if(!handler || channel==='debug:pythonPath') return send(res,404,{error:'Unknown tool action.'});
            const result=await handler({},data);
            return send(res,200,result===undefined?null:result);
          }
          if(req.method!=='GET') return send(res,405,{error:'Unsupported request.'});
          if(url.pathname==='/companion-bridge.js') {
            const config='window.ifsCompanionInstallation='+JSON.stringify(process.env.IFS_INSTALLATION||'')+';\n';
            return send(res,200,config+fs.readFileSync(path.join(__dirname,'companion-bridge.js'),'utf8'),'text/javascript');
          }
          const decoded=decodeURIComponent(url.pathname);
          const file=path.resolve(directory,'.'+(decoded==='/'?'/index.html':decoded));
          if(!file.startsWith(path.resolve(directory)+path.sep)) return send(res,403,{error:'Invalid path.'});
          if(!fs.existsSync(file)||!fs.statSync(file).isFile())return send(res,404,{error:'File not found.'});
          const types={'.html':'text/html','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.woff2':'font/woff2'};
          let content=fs.readFileSync(file);
          if(path.extname(file)==='.html') content=content.toString().replace('<head>','<head><script src="./companion-bridge.js"></script>');
          send(res,200,content,types[path.extname(file)]||'application/octet-stream');
        }catch(error){send(res,400,{error:error.message});}
      });
      server.listen(0,'127.0.0.1',()=>{
        const target=process.env.IFS_TOOL_READY_FILE;
        fs.writeFileSync(target+'.tmp',JSON.stringify({port:server.address().port}));
        fs.renameSync(target+'.tmp',target);
      });
      // Windows GUI executables do not reliably expose inherited stdin in Node.
      // Watch the owning Companion process and also support graceful HTTP shutdown.
      const owner=Number(process.env.IFS_COMPANION_PID);
      if(!Number.isInteger(owner)||owner<=0)throw Error('Missing Companion process ID.');
      const watch=setInterval(()=>{
        try{process.kill(owner,0);}catch{clearInterval(watch);server.close();quit();}
      },1000);
      return server;
    }
  };
}
module.exports={createBridge};
