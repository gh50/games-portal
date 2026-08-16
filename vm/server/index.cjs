'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const { getVmSnapshot } = require('./telemetry.cjs');

const root = process.env.GAMES_PORTAL_ROOT || '/home/ubuntu/games-portal';
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 3010);
const adminCookie = 'games_portal_admin';
const platformCookie = 'games_platform_session';
const cookieDomain = '.129.146.112.160.sslip.io';
const adminSessionMs = 12 * 60 * 60 * 1000;
const playerSessionMs = 30 * 24 * 60 * 60 * 1000;
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
function normalizeUsername(value){return String(value||'').trim().toLowerCase();}
function validUsername(value){return /^[a-z0-9][a-z0-9_.-]{2,23}$/.test(value);}
function cleanDisplayName(value){const name=String(value||'').trim().replace(/\s+/g,' ');if(name.length<1||name.length>32)throw new Error('Display name must be 1-32 characters.');return name;}
// Eight characters is the platform compatibility floor because existing Preferans
// accounts may have been created under the previous 8-character minimum.
function validPassword(value){return typeof value==='string'&&value.length>=8&&value.length<=200;}
function hashPassword(password){const salt=crypto.randomBytes(16);const digest=crypto.scryptSync(password,salt,32,{N:2**14,r:8,p:1});return `scrypt$${salt.toString('hex')}$${digest.toString('hex')}`;}
function verifyPassword(password,stored){try{const parts=String(stored||'').split('$');if(parts.length===3&&parts[0]==='scrypt'){const actual=crypto.scryptSync(password,Buffer.from(parts[1],'hex'),32,{N:2**14,r:8,p:1});return crypto.timingSafeEqual(actual,Buffer.from(parts[2],'hex'));}if(parts.length===6&&parts[0]==='scrypt'){const actual=crypto.scryptSync(password,parts[4],parts[5].length/2,{N:Number(parts[1]),r:Number(parts[2]),p:Number(parts[3]),maxmem:64*1024*1024});return crypto.timingSafeEqual(actual,Buffer.from(parts[5],'hex'));}if(parts.length===7&&parts[0]==='scrypt'&&parts[1]==='v=1'){const n=Number(parts[2].slice(2)),r=Number(parts[3].slice(2)),p=Number(parts[4].slice(2));const actual=crypto.scryptSync(password,parts[5],32,{N:n,r,p,maxmem:64*1024*1024});return crypto.timingSafeEqual(actual,Buffer.from(parts[6],'hex'));}return false;}catch{return false;}}
function tokenHash(token){return crypto.createHash('sha256').update(token).digest('hex');}
function publicUser(row){return{id:String(row.id),username:String(row.username),displayName:String(row.display_name),avatar:String(row.avatar||'cards-1'),createdAt:String(row.created_at),lastLoginAt:row.last_login_at?String(row.last_login_at):null,status:String(row.status)};}

const dbPath=path.join(root,'data','platform.sqlite');fs.mkdirSync(path.dirname(dbPath),{recursive:true});
const db=new DatabaseSync(dbPath);db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');
db.exec(`CREATE TABLE IF NOT EXISTS platform_users(id TEXT PRIMARY KEY,username TEXT NOT NULL UNIQUE COLLATE NOCASE,display_name TEXT NOT NULL,password_hash TEXT NOT NULL,avatar TEXT NOT NULL DEFAULT 'cards-1',status TEXT NOT NULL DEFAULT 'active',created_at TEXT NOT NULL,updated_at TEXT NOT NULL,last_login_at TEXT);
CREATE TABLE IF NOT EXISTS platform_sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,expires_at INTEGER NOT NULL,created_at TEXT NOT NULL,last_seen_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS platform_roles(user_id TEXT NOT NULL REFERENCES platform_users(id) ON DELETE CASCADE,role TEXT NOT NULL,PRIMARY KEY(user_id,role));
CREATE INDEX IF NOT EXISTS platform_sessions_user_idx ON platform_sessions(user_id,expires_at);`);

function userById(id){const row=db.prepare('SELECT * FROM platform_users WHERE id=?').get(id);return row?publicUser(row):null;}
function findUser(username){return db.prepare('SELECT * FROM platform_users WHERE username=? COLLATE NOCASE').get(normalizeUsername(username));}
function rolesFor(id){return db.prepare('SELECT role FROM platform_roles WHERE user_id=? ORDER BY role').all(id).map(x=>String(x.role));}
function grantAdminRoles(id){const s=db.prepare('INSERT OR IGNORE INTO platform_roles(user_id,role) VALUES (?,?)');for(const role of ['platform.admin','backgammon.admin','preferans.admin'])s.run(id,role);}
function createUser(usernameValue,displayName,password,avatar='cards-1'){
  const username=normalizeUsername(usernameValue);if(!validUsername(username))throw new Error('Username must be 3-24 lowercase letters, numbers, dot, dash or underscore.');if(!validPassword(password))throw new Error('Password must be 8-200 characters.');const name=cleanDisplayName(displayName||username);const now=new Date().toISOString(),id=crypto.randomUUID();
  try{db.prepare('INSERT INTO platform_users(id,username,display_name,password_hash,avatar,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(id,username,name,hashPassword(password),String(avatar||'cards-1').slice(0,64),now,now);}catch(e){if(String(e).includes('UNIQUE'))throw new Error('Username is already registered.');throw e;}return userById(id);
}
function loginUser(username,password){const row=findUser(username);if(!row||String(row.status)!=='active'||!verifyPassword(password,String(row.password_hash)))return null;const now=new Date().toISOString();db.prepare('UPDATE platform_users SET last_login_at=?,updated_at=? WHERE id=?').run(now,now,row.id);return userById(row.id);}
function createSession(userId){const token=crypto.randomBytes(32).toString('base64url'),now=Date.now(),expiresAt=now+playerSessionMs;db.prepare('INSERT INTO platform_sessions(token_hash,user_id,expires_at,created_at,last_seen_at) VALUES (?,?,?,?,?)').run(tokenHash(token),userId,expiresAt,new Date(now).toISOString(),new Date(now).toISOString());return{token,expiresAt};}
function resolveSession(token){if(!token)return null;const row=db.prepare(`SELECT u.*,s.expires_at FROM platform_sessions s JOIN platform_users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>? AND u.status='active'`).get(tokenHash(token),Date.now());if(!row)return null;db.prepare('UPDATE platform_sessions SET last_seen_at=? WHERE token_hash=?').run(new Date().toISOString(),tokenHash(token));return{user:publicUser(row),expiresAt:Number(row.expires_at),roles:rolesFor(row.id)};}
function revokeSession(token){if(token)db.prepare('DELETE FROM platform_sessions WHERE token_hash=?').run(tokenHash(token));}
function requestToken(req){const auth=String(req.headers.authorization||'');if(auth.startsWith('Bearer '))return auth.slice(7).trim();return parseCookies(req)[platformCookie];}
function playerCookie(token,maxAge){return `${platformCookie}=${encodeURIComponent(token)}; Max-Age=${Math.floor(maxAge/1000)}; Path=/; Domain=${cookieDomain}; HttpOnly; Secure; SameSite=Lax`;}
function clearPlayerCookie(){return `${platformCookie}=; Max-Age=0; Path=/; Domain=${cookieDomain}; HttpOnly; Secure; SameSite=Lax`;}
function sessionValid(req){const token=parseCookies(req)[adminCookie];if(!token)return false;const secret=loadEnv().ADMIN_PASSWORD_HASH;if(!secret)return false;const [expires,signature]=token.split('.');if(!expires||!signature||Number(expires)<Date.now())return false;const expected=crypto.createHmac('sha256',secret).update(expires).digest('hex');try{return crypto.timingSafeEqual(Buffer.from(signature,'hex'),Buffer.from(expected,'hex'));}catch{return false;}}
function readJson(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}}
function tail(file,max=50000){try{const text=fs.readFileSync(file,'utf8');return text.slice(-max);}catch{return 'No deployment log yet.';}}
function appSnapshot(id){const t=targets[id];return{id,...t,deployed:readJson(path.join(t.root,'data','deployed-version.json')),deploy:readJson(path.join(t.root,'data','deploy-status.json'))||{state:'idle'}};}
function json(res,status,payload,extra={}){const body=JSON.stringify(payload);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':Buffer.byteLength(body),'Cache-Control':'no-store',...extra});res.end(body);}
function text(res,status,body){res.writeHead(status,{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'});res.end(body);}
async function bodyJson(req){return new Promise((resolve,reject)=>{let data='';req.on('data',c=>{data+=c;if(data.length>32768){reject(new Error('Body too large'));req.destroy();}});req.on('end',()=>{try{resolve(data?JSON.parse(data):{});}catch{reject(new Error('Invalid JSON'));}});req.on('error',reject);});}
function unauthorized(res){json(res,401,{error:'Unauthorized'});}
function clientIp(req){return String(req.headers['x-real-ip']||req.socket.remoteAddress||'unknown');}
function rateLimited(key,limit=10){const now=Date.now(),a=attempts.get(key);if(!a||a.until<=now){attempts.set(key,{count:1,until:now+10*60_000});return false;}a.count+=1;return a.count>limit;}
function ensureLegacyAdminPlatformAccount(username,password){
  let row=findUser(username);
  if(!row){const user=createUser(username,username,password,'cards-1');grantAdminRoles(user.id);return;}
  // The configured infrastructure admin is authoritative for the bootstrap name.
  // If a platform account with that name already exists, align its credential before
  // granting the administrative roles instead of allowing a name collision to block migration.
  if(!verifyPassword(password,String(row.password_hash))){db.prepare('UPDATE platform_users SET password_hash=?,status=?,updated_at=? WHERE id=?').run(hashPassword(password),'active',new Date().toISOString(),row.id);}
  grantAdminRoles(row.id);
}

const server=http.createServer(async(req,res)=>{
  try{
    const url=new URL(req.url||'/',`http://${req.headers.host||'localhost'}`),method=req.method||'GET';
    if(method==='GET'&&url.pathname==='/api/health')return json(res,200,{ok:true,service:'games-portal'});
    if(url.pathname.startsWith('/api/account/')){
      if(method==='POST'&&url.pathname==='/api/account/register'){
        if(rateLimited(`player-register:${clientIp(req)}`))return json(res,429,{error:'Too many attempts. Try again later.'});const body=await bodyJson(req);try{const user=createUser(body.username,body.displayName,body.password,body.avatar);const s=createSession(user.id);return json(res,201,{user,roles:[],token:s.token,expiresAt:s.expiresAt},{'Set-Cookie':playerCookie(s.token,s.expiresAt-Date.now())});}catch(e){return json(res,String(e).includes('already registered')?409:400,{error:e instanceof Error?e.message:'Registration failed.'});}
      }
      if(method==='POST'&&url.pathname==='/api/account/login'){
        if(rateLimited(`player-login:${clientIp(req)}`))return json(res,429,{error:'Too many attempts. Try again later.'});const body=await bodyJson(req),user=loginUser(body.username,String(body.password||''));if(!user)return json(res,401,{error:'Invalid username or password.'});const s=createSession(user.id);return json(res,200,{user,roles:rolesFor(user.id),token:s.token,expiresAt:s.expiresAt},{'Set-Cookie':playerCookie(s.token,s.expiresAt-Date.now())});
      }
      if(method==='POST'&&url.pathname==='/api/account/logout'){const token=requestToken(req);revokeSession(token);return json(res,200,{ok:true},{'Set-Cookie':clearPlayerCookie()});}
      if(method==='GET'&&(url.pathname==='/api/account/session'||url.pathname==='/api/account/verify')){const session=resolveSession(requestToken(req));return session?json(res,200,{authenticated:true,...session}):json(res,url.pathname.endsWith('/verify')?401:200,{authenticated:false,user:null,roles:[]});}
      if(method==='PATCH'&&url.pathname==='/api/account/profile'){const token=requestToken(req),session=resolveSession(token);if(!session)return unauthorized(res);const body=await bodyJson(req);const name=body.displayName===undefined?session.user.displayName:cleanDisplayName(body.displayName),avatar=body.avatar===undefined?session.user.avatar:String(body.avatar).slice(0,64);db.prepare('UPDATE platform_users SET display_name=?,avatar=?,updated_at=? WHERE id=?').run(name,avatar,new Date().toISOString(),session.user.id);return json(res,200,{user:userById(session.user.id)});}
      if(method==='POST'&&url.pathname==='/api/account/password'){const token=requestToken(req),session=resolveSession(token);if(!session)return unauthorized(res);const body=await bodyJson(req),row=findUser(session.user.username);if(!row||!verifyPassword(String(body.currentPassword||''),String(row.password_hash)))return json(res,400,{error:'Current password is incorrect.'});if(!validPassword(String(body.newPassword||'')))return json(res,400,{error:'Password must be 8-200 characters.'});db.prepare('UPDATE platform_users SET password_hash=?,updated_at=? WHERE id=?').run(hashPassword(String(body.newPassword)),new Date().toISOString(),session.user.id);db.prepare('DELETE FROM platform_sessions WHERE user_id=?').run(session.user.id);return json(res,200,{ok:true},{'Set-Cookie':clearPlayerCookie()});}
      return json(res,404,{error:'Not found'});
    }
    if(method==='POST'&&url.pathname==='/api/admin/login'){
      const body=await bodyJson(req),env=loadEnv(),username=String(body.username||''),password=String(body.password||'');let valid=false;
      const platform=loginUser(username,password);if(platform&&rolesFor(platform.id).includes('platform.admin'))valid=true;
      if(!valid&&env.ADMIN_USERNAME&&username===env.ADMIN_USERNAME&&verifyPassword(password,env.ADMIN_PASSWORD_HASH||'')){valid=true;try{ensureLegacyAdminPlatformAccount(username,password);}catch(e){console.error('platform admin bootstrap failed',e);}}
      if(!valid){if(rateLimited(`admin:${clientIp(req)}`))return json(res,429,{error:'Too many attempts. Try again later.'});return json(res,401,{error:'Invalid credentials'});}attempts.delete(`admin:${clientIp(req)}`);const expires=String(Date.now()+adminSessionMs),secret=env.ADMIN_PASSWORD_HASH||hashPassword(password),sig=crypto.createHmac('sha256',secret).update(expires).digest('hex');return json(res,200,{ok:true},{'Set-Cookie':`${adminCookie}=${expires}.${sig}; Max-Age=${Math.floor(adminSessionMs/1000)}; Path=/; HttpOnly; Secure; SameSite=Strict`});
    }
    if(!url.pathname.startsWith('/api/admin/'))return json(res,404,{error:'Not found'});
    if(!sessionValid(req))return unauthorized(res);
    if(method==='POST'&&url.pathname==='/api/admin/logout')return json(res,200,{ok:true},{'Set-Cookie':`${adminCookie}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`});
    if(method==='GET'&&url.pathname==='/api/admin/status'){const vm=await getVmSnapshot(root,targets);return json(res,200,{service:'games-portal-admin',host:'admin.129.146.112.160.sslip.io',apps:Object.keys(targets).map(appSnapshot),vm});}
    if(method==='GET'&&url.pathname==='/api/admin/users'){const q=`%${String(url.searchParams.get('q')||'').toLowerCase()}%`;const users=db.prepare(`SELECT id,username,display_name,avatar,status,created_at,last_login_at FROM platform_users WHERE lower(username) LIKE ? OR lower(display_name) LIKE ? ORDER BY created_at DESC LIMIT 200`).all(q,q).map(row=>({...publicUser(row),roles:rolesFor(row.id)}));return json(res,200,{users});}
    const roleMatch=url.pathname.match(/^\/api\/admin\/users\/([^/]+)\/roles$/);if(method==='PUT'&&roleMatch){const body=await bodyJson(req),id=decodeURIComponent(roleMatch[1]),allowed=new Set(['platform.admin','backgammon.admin','preferans.admin']),roles=Array.isArray(body.roles)?body.roles.filter(x=>allowed.has(String(x))).map(String):[];db.exec('BEGIN IMMEDIATE');try{db.prepare('DELETE FROM platform_roles WHERE user_id=?').run(id);const s=db.prepare('INSERT INTO platform_roles(user_id,role) VALUES (?,?)');for(const role of roles)s.run(id,role);db.exec('COMMIT');}catch(e){db.exec('ROLLBACK');throw e;}return json(res,200,{user:userById(id),roles:rolesFor(id)});}
    const deployMatch=url.pathname.match(/^\/api\/admin\/apps\/(portal|backgammon|preferans)\/deploy$/);if(method==='POST'&&deployMatch){const id=deployMatch[1],body=await bodyJson(req),action=String(body.action||'full');if(!['full','restart'].includes(action))return json(res,400,{error:'Invalid action'});const child=spawn('/usr/bin/sudo',['-n','/usr/local/sbin/games-admin-deploy',id,action],{detached:true,stdio:'ignore'});child.unref();return json(res,202,{ok:true,app:id,action});}
    const logMatch=url.pathname.match(/^\/api\/admin\/apps\/(portal|backgammon|preferans)\/deploy-log$/);if(method==='GET'&&logMatch)return text(res,200,tail(path.join(targets[logMatch[1]].root,'logs','admin-deploy.log')));
    return json(res,404,{error:'Not found'});
  }catch(e){console.error(e);return json(res,500,{error:'Internal server error'});}
});
server.listen(port,host,()=>console.log(JSON.stringify({level:'info',message:'Games portal started',host,port,identityDatabase:dbPath})));
