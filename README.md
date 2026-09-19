# Games Portal

Public launcher and central deployment console for the game VM.

## Hosts

- `https://129.146.112.160.sslip.io` — public game launcher
- `https://admin.129.146.112.160.sslip.io` — central deployment console
- `https://backgammon.129.146.112.160.sslip.io` — Backgammon
- `https://preferans.129.146.112.160.sslip.io` — Preferans

The central admin can deploy the portal, Backgammon, and Preferans through fixed privileged wrappers. It does not expose arbitrary shell execution.

## VM layout

The application installs to `/home/ubuntu/games-portal`. Nginx serves `public/` at the root host and `admin/` at the admin subdomain. A small PM2-managed Node service on `127.0.0.1:3010` handles authenticated admin APIs and starts trusted deploy wrappers.

## First installation (one time)

The first installation has to bootstrap the files and privileged wrappers once. After this, normal portal/game deployments are done from the browser at the admin subdomain.

1. Create a private GitHub repository `gh50/games-portal` with branch `main` and put this repository content in it.
2. On the VM, clone/copy the repo so that `vm/` is available, then install it as `/home/ubuntu/games-portal`.
3. Create `/home/ubuntu/games-portal/.env` from `.env.example`.
4. Generate the admin password hash:

   `sudo python3 /home/ubuntu/games-portal/install_server.py hash-password`

   Put the output in `ADMIN_PASSWORD_HASH` in `.env`. Set `ADMIN_USERNAME` as desired.
5. Set `DEPLOY_GITHUB_TOKEN` to a fine-grained token limited to `gh50/games-portal` with **Contents: read** and **Webhooks: write** permissions. The token is also needed for webhook registration even when repository contents are public.
6. Run:

   `cd /home/ubuntu/games-portal && sudo python3 install_server.py install`

   `sudo python3 install_server.py deploy`

   `sudo python3 install_server.py ssl`

7. If `nginx -t` reports a duplicate `server_name 129.146.112.160.sslip.io`, remove the old root-host redirect from the previous Backgammon nginx configuration, but keep the `backgammon.129.146.112.160.sslip.io` server block. Then rerun `sudo python3 install_server.py deploy`.

## Normal workflow after bootstrap

Automatic deployment is enabled by default for Games Portal, Backgammon, and Preferans. Each app
owns its own signed GitHub webhook, so one broken app does not depend on another app's webhook to
receive a fixing push.

1. Commit/push a change to `games-portal`, `backgammon`, or `preferans`.
2. GitHub sends a signed push event directly to that application's webhook.
3. The candidate is downloaded and validated/built in staging before live files are changed.
4. The prepared release is switched in, PM2 is restarted, and stable health checks must pass.
5. If activation fails, the previous release is restored automatically.

The admin page at `https://admin.129.146.112.160.sslip.io` shows deployment state and
**Auto deploy: Active / Disabled / Error** for each application. **Deploy latest** remains available
as a manual recovery/redeploy action. Pushes received during a deployment are coalesced to the
newest commit, while a failed candidate is not retried repeatedly.

No SSH is required for routine deployments after bootstrap.

## Security notes

- Admin sessions are signed, HTTP-only, Secure, SameSite=Strict cookies.
- Login attempts are rate limited in-process.
- The Node process can invoke only `/usr/local/sbin/games-admin-deploy` through passwordless sudo.
- That wrapper accepts only `portal`, `backgammon`, or `preferans`, and only `full` or `restart` actions.
- GitHub tokens remain only in each application's server-side `.env` and are not returned by the admin API.
