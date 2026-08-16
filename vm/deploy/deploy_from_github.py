#!/usr/bin/env python3
from __future__ import annotations
import argparse, datetime as dt, json, os, pwd, re, shutil, subprocess, tarfile, tempfile, urllib.request
from pathlib import Path

MANAGED=('public','admin','server','deploy','install_server.py','.env.example')
def now(): return dt.datetime.now(dt.UTC).isoformat()
def envfile(path:Path):
    out={}
    for raw in path.read_text().splitlines():
        line=raw.strip()
        if line and not line.startswith('#') and '=' in line:
            k,v=line.split('=',1); out[k.strip()]=v.strip().strip('"').strip("'")
    return out
def write_json(path:Path,payload,uid,gid):
    path.parent.mkdir(parents=True,exist_ok=True); tmp=path.with_suffix('.tmp')
    tmp.write_text(json.dumps(payload)); os.chown(tmp,uid,gid); tmp.replace(path); os.chown(path,uid,gid)
def repo_parts(url:str):
    m=re.fullmatch(r'https://github\.com/([^/]+)/([^/]+?)(?:\.git)?/?',url.strip())
    if not m: raise RuntimeError('Invalid DEPLOY_GITHUB_REPO')
    return m.group(1),m.group(2)
def request(url,token):
    return urllib.request.Request(url,headers={'Accept':'application/vnd.github+json','User-Agent':'games-portal-deployer',**({'Authorization':f'Bearer {token}'} if token else {})})
def run(cmd,cwd,env,log):
    r=subprocess.run(cmd,cwd=cwd,env=env,stdout=log,stderr=subprocess.STDOUT,text=True)
    if r.returncode: raise RuntimeError(f"Command failed ({r.returncode}): {' '.join(cmd)}")
def main():
    p=argparse.ArgumentParser(); p.add_argument('--app-root',type=Path,required=True); p.add_argument('--run-as',required=True); p.add_argument('--action',choices=('full','restart'),default='full'); a=p.parse_args()
    root=a.app_root.resolve(); account=pwd.getpwnam(a.run_as); uid,gid=account.pw_uid,account.pw_gid
    env=envfile(root/'.env'); procenv=os.environ.copy(); procenv['SUDO_USER']=a.run_as
    logpath=root/'logs'/'admin-deploy.log'; statuspath=root/'data'/'deploy-status.json'; lockpath=root/'data'/'deploy.lock'
    started=now(); status={'state':'running','action':a.action,'stage':'starting','message':'Starting deployment.','startedAt':started,'updatedAt':started,'steps':[]}
    def stage(name,message):
        status.update({'state':'running','stage':name,'message':message,'updatedAt':now()}); status['steps'].append({'id':name,'state':'running','message':message}); write_json(statuspath,status,uid,gid)
    try:
        lockpath.parent.mkdir(parents=True,exist_ok=True); fd=os.open(lockpath,os.O_CREAT|os.O_EXCL|os.O_WRONLY,0o644); os.close(fd); os.chown(lockpath,uid,gid)
    except FileExistsError:
        status.update({'state':'failed','message':'Another deployment is already running.','finishedAt':now(),'updatedAt':now()}); write_json(statuspath,status,uid,gid); return 2
    try:
        logpath.parent.mkdir(parents=True,exist_ok=True)
        with logpath.open('a') as log:
            log.write(f"\n===== Web action {a.action} {started} =====\n"); log.flush(); revision=None
            if a.action=='full':
                stage('connect','Connecting to GitHub.')
                owner,repo=repo_parts(env['DEPLOY_GITHUB_REPO']); branch=env.get('DEPLOY_GITHUB_BRANCH','main'); token=env.get('DEPLOY_GITHUB_TOKEN','')
                with urllib.request.urlopen(request(f'https://api.github.com/repos/{owner}/{repo}/commits/{branch}',token),timeout=30) as r: revision=json.load(r)['sha']
                stage('download','Downloading repository archive.')
                with tempfile.TemporaryDirectory(prefix='games-portal-deploy-') as td:
                    td=Path(td); archive=td/'repo.tgz'
                    with urllib.request.urlopen(request(f'https://api.github.com/repos/{owner}/{repo}/tarball/{branch}',token),timeout=60) as r, archive.open('wb') as f: shutil.copyfileobj(r,f)
                    stage('extract','Extracting repository archive.'); srcdir=td/'src'; srcdir.mkdir()
                    with tarfile.open(archive,'r:gz') as t: t.extractall(srcdir,filter='data')
                    roots=[x for x in srcdir.iterdir() if x.is_dir()]
                    if len(roots)!=1 or not (roots[0]/'vm').is_dir(): raise RuntimeError('Repository has no vm directory')
                    stage('update','Updating managed portal files.'); src=roots[0]/'vm'
                    for name in MANAGED:
                        s=src/name; d=root/name
                        if not s.exists(): raise RuntimeError(f'Missing vm/{name}')
                        if d.is_dir() and not d.is_symlink(): shutil.rmtree(d)
                        elif d.exists() or d.is_symlink(): d.unlink()
                        shutil.copytree(s,d,ignore=shutil.ignore_patterns('node_modules','dist','.env')) if s.is_dir() else shutil.copy2(s,d)
                    for name in MANAGED:
                        d=root/name
                        if d.exists():
                            os.chown(d,uid,gid)
                            if d.is_dir():
                                for x in d.rglob('*'):
                                    if not x.is_symlink(): os.chown(x,uid,gid)
                write_json(root/'data'/'deployed-version.json',{'revision':revision,'deployedAt':now(),'repository':env.get('DEPLOY_GITHUB_REPO',''),'branch':branch},uid,gid)
                stage('deploy','Installing portal files and restarting administration service.')
                run(['/usr/bin/python3',str(root/'install_server.py'),'deploy'],root,procenv,log)
            else:
                stage('restart','Restarting portal administration service.')
                run(['sudo','-u',a.run_as,'pm2','startOrReload',str(root/'deploy'/'ecosystem.config.cjs'),'--update-env'],root,procenv,log)
                run(['sudo','-u',a.run_as,'pm2','save'],root,procenv,log)
            stage('complete','Operation completed successfully.')
        status.update({'state':'succeeded','stage':'complete','message':'Operation completed successfully.','finishedAt':now(),'updatedAt':now()}); write_json(statuspath,status,uid,gid); return 0
    except Exception as e:
        status.update({'state':'failed','stage':'failed','message':str(e),'finishedAt':now(),'updatedAt':now()}); status['steps'].append({'id':'failed','state':'failed','message':str(e)}); write_json(statuspath,status,uid,gid); return 1
    finally:
        try: lockpath.unlink()
        except FileNotFoundError: pass
if __name__=='__main__': raise SystemExit(main())
