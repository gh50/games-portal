'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = process.env.GAMES_PORTAL_ROOT || '/home/ubuntu/games-portal';
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3010);
const cookieName = 'games_portal_admin';
const sessionMs = 12 * 60 * 60 * 1000;
const targets = {
  portal: { name:'Games Portal', url:'https://129.146.112.160.sslip.io', root:'/home/ubuntu/games-portal', process:'games-portal-admin' },
  backgammon: { name:'Backgammon', url:'https://backgammon.129.146.112.160.sslip.io', root:'/home/ubuntu/backgammon', process:'backgammon-server' },
  preferans: { name:'Preferans', url:'https://preferans.129.146.112.160.sslip.io', root:'/home/ubuntu/preferans', process:'preferans-server' }
};
const attempts = new Map();

function loadEnv(){
  const out={}; const file=path.join(root,'.env'); if(!fs.existsSync(file)) return out;
  for(const raw of fs.readFileSync(file,'utf8').split(/\r?\n/)){const line=raw.trim();if(!line||line.startsWith('#')||!line.includes('='))continue;const i=line.indexOf('=');out[line.slice(0,i).trim()]=line.slice(i+1).trim().replace(/^['"]|['"]$/g,'');} return out;
}
function parseCookies(req){const out={};for(const part of String(req.headers.cookie||'').split(';')){const i=part.indexOf('=');if(i>0)out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim());}return out;}
function verifyPassword(password,stored){try{const [kind,saltHex,digestHex]=stored.split('$');if(kind!=='scrypt'||!saltHex||!digestHex)return false;const actual=crypto.scryptSync(password,Buffer.from(saltHex,'hex'),32,{N:2**14,r:8,p:1});return crypto.timingSafeEqual(actual,Buffer.from(digestHex,'hex'));}catch{return false;}}
function sessionValid(req){const token=parseCookies(req)[cookieName];if(!token)return false;const secret=loadEnv().ADMIN_PASSWORD_HASH;if(!secret)return false;const [expires,signature]=token.split('.');if(!expires||!signature||Number(expires)<Date.now())return false;const expected=crypto.createHmac('sha256',secret).update(expires).digest('hex');try{return crypto.timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(expected,'hex'));}catch{return false;}}
function readJson(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}}
function tail(file,max=50000){try{const text=fs.readFileSync(file,'utf8');return text.slice(-max);}catch{return 'No deployment log yet.';}}
function appSnapshot(id){const t=targets[id];return{id,...t,deployed:readJson(path.join(t.root,'data','deployed-version.json')),deploy:readJson(path.join(t.root,'data','deploy-status.json'))||{state:'idle'}};}
function json(res,status,payload,extra={}){const body=JSON.stringify(payload);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store',...extra});res.end(body);}
function text(res,status,body){res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end(body);}
async function bodyJson(req){return new Promise((resolve,reject)=>{let data='';req.on('data',c=>{data+=c;if(data.length>32768){reject(new Error('Body too large'));req.destroy();}});req.on('end',()=>{try{resolve(data?JSON.parse(data):{});}catch{reject(new Error('Invalid JSON'));}});req.on('error',reject);});}
function unauthorized(res){json(res,401,{error:'Unauthorized'});}
function clientIp(req){return String(req.headers['x-real-ip']||req.socket.remoteAddress||'unknown');}

const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`); const method=req.method||'GET';
    if(method==='GET'&&url.pathname==='/api/health') return json(res,200,{ok:true,service:'games-portal-admin'});
    if(method==='POST'&&url.pathname==='/api/admin/login'){
      const ip=clientIp(req),now=Date.now(),attempt=attempts.get(ip);if(attempt&&attempt.until>now&&attempt.count>=10)return json(res,429,{error:'Too many attempts. Try again later.'});
      const body=await bodyJson(req),env=loadEnv(),username=String(body.username||''),password=String(body.password||'');
      if(!env.ADMIN_USERNAME||username!==env.ADMIN_USERNAME||!verifyPassword(password,env.ADMIN_PASSWORD_HASH||'')){attempts.set(ip,{count:attempt&&attempt.until>now?attempt.count+1:1,until:now+10*60_000});return json(res,401,{error:'Invalid credentials'});}
      attempts.delete(ip);const expires=String(Date.now()+sessionMs),sig=crypto.createHmac('sha256',env.ADMIN_PASSWORD_HASH).update(expires).digest('hex');
      return json(res,200,{ok:true},{'Set-Cookie':`${cookieName}=${expires}.${sig}; Max-Age=${Math.floor(sessionMs/1000)}; Path=/; HttpOnly; Secure; SameSite=Strict`});
    }
    if(!url.pathname.startsWith('/api/admin/')) return json(res,404,{error:'Not found'});
    if(!sessionValid(req)) return unauthorized(res);
    if(method==='POST'&&url.pathname==='/api/admin/logout') return json(res,200,{ok:true},{'Set-Cookie':`${cookieName}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`});
    if(method==='GET'&&url.pathname==='/api/admin/status') return json(res,200,{service:'games-portal-admin',host:'admin.129.146.112.160.sslip.io',apps:Object.keys(targets).map(appSnapshot)});
    const deployMatch=url.pathname.match(/^\/api\/admin\/apps\/(portal|backgammon|preferans)\/deploy$/);
    if(method==='POST'&&deployMatch){const id=deployMatch[1],body=await bodyJson(req),action=String(body.action||'full');if(!['full','restart'].includes(action))return json(res,400,{error:'Invalid action'});const child=spawn('/usr/bin/sudo',['-n','/usr/local/sbin/games-admin-deploy',id,action],{detached:true,stdio:'ignore'});child.unref();return json(res,202,{ok:true,app:id,action});}
    const logMatch=url.pathname.match(/^\/api\/admin\/apps\/(portal|backgammon|preferans)\/deploy-log$/);
    if(method==='GET'&&logMatch)return text(res,200,tail(path.join(targets[logMatch[1]].root,'logs','admin-deploy.log')));
    return json(res,404,{error:'Not found'});
  }catch(e){console.error(e);return json(res,500,{error:'Internal server error'});}
});
server.listen(port,host,()=>console.log(JSON.stringify({level:'info',message:'Games portal admin started',host,port})));
