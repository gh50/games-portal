'use strict';

const crypto=require('node:crypto');
const fs=require('node:fs');
const path=require('node:path');
const {spawn}=require('node:child_process');

const FALSE_VALUES=new Set(['0','false','no','off','disabled']);

function createAutoDeploy(options){
  const root=options.root;
  const webhookUrl=options.webhookUrl;
  const deployCommand=options.deployCommand;
  const defaultBranch=options.defaultBranch||'main';

  function readEnv(){
    const out={};const file=path.join(root,'.env');if(!fs.existsSync(file))return out;
    for(const raw of fs.readFileSync(file,'utf8').split(/\r?\n/)){
      const line=raw.trim();if(!line||line.startsWith('#')||!line.includes('='))continue;
      const i=line.indexOf('=');out[line.slice(0,i).trim()]=line.slice(i+1).trim().replace(/^['"]|['"]$/g,'');
    }
    return out;
  }
  function enabled(env=readEnv()){
    const value=process.env.AUTO_DEPLOY_ENABLED??env.AUTO_DEPLOY_ENABLED??'true';
    return !FALSE_VALUES.has(String(value).trim().toLowerCase());
  }
  function repository(env=readEnv()){
    const raw=String(env.DEPLOY_GITHUB_REPO??'').trim();
    const match=raw.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/);
    if(!match)throw new Error('DEPLOY_GITHUB_REPO must be an HTTPS github.com repository URL.');
    return `${match[1]}/${match[2]}`;
  }
  function branch(env=readEnv()){return String(env.DEPLOY_GITHUB_BRANCH??defaultBranch).trim()||defaultBranch;}
  function dataPath(name){const dir=path.join(root,'data');fs.mkdirSync(dir,{recursive:true});return path.join(dir,name);}
  function secret(){
    const file=dataPath('.github-webhook-secret');
    try{const value=fs.readFileSync(file,'utf8').trim();if(value)return value;}catch{}
    const value=crypto.randomBytes(48).toString('base64url');fs.writeFileSync(file,value+'\n',{encoding:'utf8',mode:0o600});return value;
  }
  function writeStatus(patch){
    const file=dataPath('auto-deploy-status.json');let current={};
    try{current=JSON.parse(fs.readFileSync(file,'utf8'));}catch{}
    const env=readEnv();
    const next={enabled:enabled(env),webhookState:enabled(env)?'pending':'disabled',webhookUrl,...current,...patch};
    const temp=`${file}.${process.pid}.tmp`;fs.writeFileSync(temp,JSON.stringify(next,null,2)+'\n','utf8');fs.renameSync(temp,file);
  }
  function verify(body,signature,shared){
    if(!signature||!String(signature).startsWith('sha256='))return false;
    const expected=Buffer.from('sha256='+crypto.createHmac('sha256',shared).update(body).digest('hex')),received=Buffer.from(String(signature));
    return expected.length===received.length&&crypto.timingSafeEqual(expected,received);
  }
  function reply(res,status,payload){
    const body=JSON.stringify(payload);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store'});res.end(body);
  }
  function readBody(req){
    return new Promise((resolve,reject)=>{const chunks=[];let size=0;req.on('data',chunk=>{size+=chunk.length;if(size>256*1024){reject(new Error('Body too large'));req.destroy();return;}chunks.push(chunk);});req.on('end',()=>resolve(Buffer.concat(chunks)));req.on('error',reject);});
  }
  function requestDeploy(sha){
    fs.writeFileSync(dataPath('deploy-requested-sha'),sha+'\n','utf8');
    if(fs.existsSync(dataPath('deploy.lock')))return;
    const child=spawn(deployCommand[0],deployCommand.slice(1),{detached:true,stdio:'ignore',env:{...process.env,DEPLOY_REQUESTED_SHA:sha,DEPLOY_SOURCE:'github-push'}});
    child.unref();
  }
  async function api(apiPath,init={},env=readEnv(),permissionHint='Token needs repository Webhooks: write permission.'){
    const token=String(env.DEPLOY_GITHUB_TOKEN??'').trim();
    if(!token)throw new Error('DEPLOY_GITHUB_TOKEN is required to register the auto-deploy webhook.');
    const response=await fetch(`https://api.github.com${apiPath}`,{...init,headers:{Accept:'application/vnd.github+json',Authorization:`Bearer ${token}`,'Content-Type':'application/json','User-Agent':'games-portal-auto-deploy','X-GitHub-Api-Version':'2022-11-28',...(init.headers||{})}});
    if(!response.ok){const text=await response.text();const hint=response.status===403?` ${permissionHint}`:'';throw new Error(`GitHub webhook API returned HTTP ${response.status}: ${text.slice(0,300)}.${hint}`);}
    if(response.status===204)return null;return response.json();
  }
  function readJsonObject(file){
    try{const parsed=JSON.parse(fs.readFileSync(file,'utf8'));return parsed&&typeof parsed==='object'&&!Array.isArray(parsed)?parsed:{};}catch{return {};}
  }
  async function pollOnce(){
    const env=readEnv();
    if(!enabled(env)){writeStatus({pollState:'disabled',pollCheckedAt:new Date().toISOString(),pollError:''});return;}
    if(fs.existsSync(dataPath('deploy.lock'))){writeStatus({pollState:'waiting',pollCheckedAt:new Date().toISOString(),pollError:''});return;}
    let repo='';
    try{
      repo=repository(env);const targetBranch=branch(env);
      const payload=await api(`/repos/${repo}/commits/${encodeURIComponent(targetBranch)}`,{},env,'Token needs repository Contents: read permission for automatic deployment polling.');
      const headSha=String(payload&&payload.sha||'').trim().toLowerCase();
      if(!/^[0-9a-f]{40}$/.test(headSha))throw new Error('GitHub did not return a valid branch-head SHA.');
      const deployed=readJsonObject(dataPath('deployed-version.json')),deployStatus=readJsonObject(dataPath('deploy-status.json'));
      const deployedSha=typeof deployed.revision==='string'?deployed.revision.toLowerCase():'';
      const failedSha=typeof deployStatus.failedRevision==='string'?deployStatus.failedRevision.toLowerCase():'';
      writeStatus({pollState:'active',pollCheckedAt:new Date().toISOString(),pollHeadSha:headSha,pollError:'',repository:repo,branch:targetBranch});
      if(headSha===deployedSha||headSha===failedSha)return;
      requestDeploy(headSha);
    }catch(error){writeStatus({pollState:'error',pollCheckedAt:new Date().toISOString(),pollError:error instanceof Error?error.message:String(error),repository:repo||undefined});}
  }
  function startPolling(){
    const env=readEnv();
    if(!enabled(env)){writeStatus({pollState:'disabled',pollError:''});return;}
    writeStatus({pollState:'starting',pollError:''});
    const timer=setInterval(()=>{void pollOnce();},60_000);timer.unref();
  }

  async function register(){
    const env=readEnv();
    if(!enabled(env)){writeStatus({enabled:false,webhookState:'disabled',error:''});return;}
    let repo='';
    try{
      repo=repository(env);const targetBranch=branch(env),shared=secret();
      const hooks=await api(`/repos/${repo}/hooks?per_page=100`,{},env);
      const existing=Array.isArray(hooks)?hooks.find(h=>h&&h.config&&h.config.url===webhookUrl):null;
      const config={url:webhookUrl,content_type:'json',insecure_ssl:'0',secret:shared};
      let webhookId;
      if(existing&&existing.id){webhookId=existing.id;await api(`/repos/${repo}/hooks/${existing.id}`,{method:'PATCH',body:JSON.stringify({active:true,events:['push'],config})},env);}
      else{const created=await api(`/repos/${repo}/hooks`,{method:'POST',body:JSON.stringify({name:'web',active:true,events:['push'],config})},env);webhookId=created&&created.id;}
      writeStatus({enabled:true,webhookState:'active',repository:repo,branch:targetBranch,webhookId,error:''});
    }catch(error){writeStatus({enabled:true,webhookState:'error',repository:repo||undefined,error:error instanceof Error?error.message:String(error)});}
  }
  async function handle(req,res,url){
    if(req.method!=='POST'||url.pathname!=='/api/github/webhook')return false;
    let body;
    try{body=await readBody(req);}catch(error){reply(res,413,{error:error instanceof Error?error.message:'Invalid body'});return true;}
    const shared=secret();
    if(!verify(body,req.headers['x-hub-signature-256'],shared)){reply(res,401,{error:'Invalid GitHub webhook signature.'});return true;}
    const event=String(req.headers['x-github-event']||'').toLowerCase();
    if(event==='ping'){writeStatus({lastWebhookAt:new Date().toISOString(),lastEvent:'ping'});reply(res,200,{ok:true});return true;}
    if(event!=='push'){writeStatus({lastWebhookAt:new Date().toISOString(),lastEvent:event||'unknown'});reply(res,202,{ignored:true});return true;}
    let payload;try{payload=JSON.parse(body.toString('utf8'));}catch{reply(res,400,{error:'Invalid JSON payload.'});return true;}
    const env=readEnv();if(!enabled(env)){reply(res,202,{ignored:true,reason:'automatic deployment disabled'});return true;}
    let expected;try{expected=repository(env);}catch{reply(res,503,{error:'Deployment repository is not configured.'});return true;}
    if(payload?.repository?.full_name!==expected){reply(res,403,{error:'Repository mismatch.'});return true;}
    if(payload.deleted||payload.ref!==`refs/heads/${branch(env)}`){reply(res,202,{ignored:true,reason:'different branch'});return true;}
    const sha=String(payload.after||'').trim().toLowerCase();if(!/^[0-9a-f]{40}$/.test(sha)){reply(res,400,{error:'Invalid commit SHA.'});return true;}
    writeStatus({lastWebhookAt:new Date().toISOString(),lastWebhookSha:sha,lastEvent:'push'});requestDeploy(sha);reply(res,202,{ok:true,commit:sha});return true;
  }

  startPolling();
  return {handle,register};
}

module.exports={createAutoDeploy};
