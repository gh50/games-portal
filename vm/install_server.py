#!/usr/bin/env python3
from __future__ import annotations
import argparse, getpass, hashlib, os, secrets, shlex, shutil, subprocess
from pathlib import Path

APP_ROOT=Path('/home/ubuntu/games-portal')
PUBLIC_HOST='129.146.112.160.sslip.io'
ADMIN_HOST='admin.129.146.112.160.sslip.io'
PORT=3010
PM2_NAME='games-portal-admin'

def run(cmd:list[str],cwd:Path|None=None):
    print('+',' '.join(shlex.quote(x) for x in cmd),flush=True); subprocess.run(cmd,cwd=cwd,check=True)
def hash_password(password:str)->str:
    salt=secrets.token_bytes(16); digest=hashlib.scrypt(password.encode(),salt=salt,n=2**14,r=8,p=1,dklen=32); return f"scrypt${salt.hex()}${digest.hex()}"
def ensure_layout(root:Path):
    for name in ('public','admin','server','deploy','data','logs'): (root/name).mkdir(parents=True,exist_ok=True)
def nginx_config(root:Path)->str:
    return f'''server {{
    listen 80;
    listen [::]:80;
    server_name {PUBLIC_HOST};
    root {root/'public'};
    index index.html;
    access_log {root/'logs'/'nginx_public_access.log'};
    error_log {root/'logs'/'nginx_public_error.log'};
    location / {{ try_files $uri $uri/ /index.html; }}
}}

server {{
    listen 80;
    listen [::]:80;
    server_name {ADMIN_HOST};
    root {root/'admin'};
    index index.html;
    access_log {root/'logs'/'nginx_admin_access.log'};
    error_log {root/'logs'/'nginx_admin_error.log'};
    location /api/ {{
        proxy_pass http://127.0.0.1:{PORT};
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }}
    location / {{ try_files $uri $uri/ /index.html; }}
}}
'''
def configure_nginx(root:Path):
    available=Path('/etc/nginx/sites-available/games-portal'); enabled=Path('/etc/nginx/sites-enabled/games-portal')
    available.write_text(nginx_config(root))
    if not enabled.exists(): enabled.symlink_to(available)
    default=Path('/etc/nginx/sites-enabled/default')
    if default.is_symlink():
        try:
            text=default.resolve().read_text()
            if 'default_server' in text: default.unlink()
        except OSError: pass
    run(['nginx','-t']); run(['systemctl','reload','nginx'])
def install_helpers(root:Path,user:str):
    lib=Path('/usr/local/lib/games-portal'); lib.mkdir(parents=True,exist_ok=True)
    src=root/'deploy'/'deploy_from_github.py'; dst=lib/'deploy_from_github.py'; dst.write_text(src.read_text()); os.chmod(dst,0o755)
    portal=Path('/usr/local/sbin/games-portal-web-deploy')
    portal.write_text(f'''#!/bin/sh
set -eu
action=${{1:-full}}
case "$action" in full|restart) ;; *) exit 2 ;; esac
unit=games-portal-deploy-$(date +%s)
exec /usr/bin/systemd-run --quiet --collect --unit="$unit" --property=Type=oneshot --property=TimeoutStartSec=30min /usr/bin/python3 /usr/local/lib/games-portal/deploy_from_github.py --app-root {root} --run-as {user} --action "$action"
'''); os.chmod(portal,0o755)
    central=Path('/usr/local/sbin/games-admin-deploy')
    central.write_text('''#!/bin/sh
set -eu
app=${1:-}; action=${2:-full}
case "$action" in full|restart) ;; *) exit 2 ;; esac
case "$app" in
  portal) exec /usr/local/sbin/games-portal-web-deploy "$action" ;;
  backgammon) exec /usr/local/sbin/backgammon-web-deploy "$action" ;;
  preferans) exec /usr/local/sbin/preferans-web-deploy "$action" ;;
  *) exit 2 ;;
esac
'''); os.chmod(central,0o755)
    sudoers=Path('/etc/sudoers.d/games-portal-web-deploy'); sudoers.write_text(f'{user} ALL=(root) NOPASSWD: {portal}, {central}\n'); os.chmod(sudoers,0o440); run(['visudo','-cf',str(sudoers)])
def deploy(root:Path,user:str):
    for static in (root/'public',root/'admin'):
        run(['chmod','-R','a+rX',str(static)])
    install_helpers(root,user)
    run(['sudo','-u',user,'pm2','startOrReload',str(root/'deploy'/'ecosystem.config.cjs'),'--update-env']); run(['sudo','-u',user,'pm2','save'])
    configure_nginx(root)
def main():
    p=argparse.ArgumentParser(); sub=p.add_subparsers(dest='cmd',required=True)
    for name in ('install','deploy','ssl'): sub.add_parser(name)
    hp=sub.add_parser('hash-password'); hp.add_argument('--password')
    a=p.parse_args(); root=APP_ROOT; user=os.environ.get('SUDO_USER') or 'ubuntu'
    if a.cmd=='hash-password': print(hash_password(a.password or getpass.getpass('Password: '))); return
    if os.geteuid()!=0: raise SystemExit('Run with sudo.')
    ensure_layout(root)
    if a.cmd=='install':
        missing=[pkg for pkg,cmd in [('nginx','nginx'),('certbot','certbot')] if shutil.which(cmd) is None]
        if missing: run(['apt-get','update']); run(['apt-get','install','-y','nginx','certbot','python3-certbot-nginx'])
        if shutil.which('node') is None: raise SystemExit('Node.js is required.')
        if shutil.which('pm2') is None: run(['npm','install','-g','pm2'])
        configure_nginx(root); print('Install complete. Create .env, then run deploy and ssl.')
    elif a.cmd=='deploy': deploy(root,user)
    elif a.cmd=='ssl':
        configure_nginx(root)
        run(['certbot','--nginx','--expand','--cert-name',PUBLIC_HOST,'-d',PUBLIC_HOST,'-d',ADMIN_HOST,'--non-interactive','--agree-tos','--redirect','--register-unsafely-without-email'])
        run(['nginx','-t']); run(['systemctl','reload','nginx']); run(['systemctl','enable','--now','certbot.timer'])
        print(f'https://{PUBLIC_HOST}'); print(f'https://{ADMIN_HOST}')
if __name__=='__main__': main()
