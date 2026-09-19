#!/usr/bin/env python3
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import pwd
import re
import shutil
import socket
import sqlite3
import subprocess
import tarfile
import time
import urllib.request
from pathlib import Path

MANAGED = ("public", "admin", "server", "deploy", "install_server.py", ".env.example")
PM2_NAME = "games-portal-admin"
DATABASE_FILE = "platform.sqlite"
HEALTH_URL = "http://127.0.0.1:3010/api/health"
FOLLOW_UP_COMMAND = "/usr/local/sbin/games-portal-web-deploy"
INSTALLED_HELPER = Path("/usr/local/lib/games-portal/deploy_from_github.py")


def now() -> str:
    return dt.datetime.now(dt.UTC).isoformat()


def envfile(path: Path) -> dict[str, str]:
    result: dict[str, str] = {}
    if not path.exists():
        raise RuntimeError(f"Missing configuration file: {path}")
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        result[key.strip()] = value.strip().strip('"').strip("'")
    return result


def repo_parts(url: str) -> tuple[str, str]:
    match = re.fullmatch(r"https://github\.com/([^/]+)/([^/]+?)(?:\.git)?/?", url.strip())
    if not match:
        raise RuntimeError("DEPLOY_GITHUB_REPO must be an HTTPS github.com repository URL.")
    return match.group(1), match.group(2)


def request(url: str, token: str) -> urllib.request.Request:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "games-portal-safe-deployer",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return urllib.request.Request(url, headers=headers)


def write_json(path: Path, payload: dict[str, object], uid: int, gid: int) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temp.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    os.chown(temp, uid, gid)
    temp.replace(path)
    os.chown(path, uid, gid)


def chown_tree(path: Path, uid: int, gid: int) -> None:
    if not path.exists():
        return
    os.chown(path, uid, gid)
    if path.is_dir():
        for child in path.rglob("*"):
            if not child.is_symlink():
                os.chown(child, uid, gid)


def run(command: list[str], cwd: Path, env: dict[str, str], log, *, check: bool = True) -> int:
    log.write("+ " + " ".join(command) + "\n")
    log.flush()
    result = subprocess.run(command, cwd=cwd, env=env, stdout=log, stderr=subprocess.STDOUT, text=True, check=False)
    if check and result.returncode:
        raise RuntimeError(f"Command failed ({result.returncode}): {' '.join(command)}")
    return result.returncode


def _backup_sqlite(source: Path, destination: Path) -> bool:
    if not source.exists():
        return False
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.unlink(missing_ok=True)
    with sqlite3.connect(f"file:{source}?mode=ro", uri=True, timeout=10) as source_db, sqlite3.connect(destination) as destination_db:
        source_db.backup(destination_db)
    return True


def prepare_candidate_runtime_data(root: Path, candidate: Path, log) -> None:
    source = root / "data" / DATABASE_FILE
    destination = candidate / "data" / DATABASE_FILE
    destination.parent.mkdir(parents=True, exist_ok=True)
    if _backup_sqlite(source, destination):
        log.write("Candidate smoke test will use an isolated snapshot of the live Games Portal database.\n")
    else:
        log.write("No live Games Portal database exists yet; candidate smoke test will use a fresh isolated database.\n")
    log.flush()


def _free_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def _json_response(url: str, timeout: float = 2.0) -> dict[str, object] | None:
    try:
        with urllib.request.urlopen(url, timeout=timeout) as response:
            if response.status != 200:
                return None
            payload = json.load(response)
        return payload if isinstance(payload, dict) else None
    except Exception:
        return None


def _runtime_probes_ok(base_url: str) -> bool:
    health = _json_response(base_url + "/api/health")
    session = _json_response(base_url + "/api/account/session")
    return bool(
        health
        and health.get("ok") is True
        and health.get("service") == "games-portal"
        and session
        and isinstance(session.get("authenticated"), bool)
        and isinstance(session.get("roles"), list)
    )


def smoke_candidate(candidate: Path, env: dict[str, str], log) -> None:
    port = _free_loopback_port()
    smoke_env = {
        **env,
        "HOST": "127.0.0.1",
        "PORT": str(port),
        "GAMES_PORTAL_ROOT": str(candidate),
        "AUTO_DEPLOY_ENABLED": "false",
    }
    process = subprocess.Popen(
        ["node", "index.cjs"],
        cwd=candidate / "server",
        env=smoke_env,
        stdout=log,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    try:
        base_url = f"http://127.0.0.1:{port}"
        for _ in range(30):
            if process.poll() is not None:
                raise RuntimeError(f"Candidate server exited during smoke test ({process.returncode}).")
            if _runtime_probes_ok(base_url):
                log.write("Candidate runtime smoke test passed.\n")
                log.flush()
                return
            time.sleep(0.5)
        raise RuntimeError("Candidate server did not pass runtime smoke probes.")
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)


def validate_candidate(root: Path, candidate: Path, env: dict[str, str], log) -> None:
    for name in MANAGED:
        if not (candidate / name).exists():
            raise RuntimeError(f"Downloaded repository is missing required vm/{name}.")
    for file in [candidate / "install_server.py", *sorted((candidate / "deploy").glob("*.py"))]:
        if file.exists():
            run(["/usr/bin/python3", "-m", "py_compile", str(file)], candidate, env, log)
    for file in sorted((candidate / "server").glob("*.cjs")):
        run(["node", "--check", str(file)], candidate / "server", env, log)
    admin_script = candidate / "admin" / "admin.js"
    if admin_script.exists():
        run(["node", "--check", str(admin_script)], candidate / "admin", env, log)
    ecosystem = candidate / "deploy" / "ecosystem.config.cjs"
    if ecosystem.exists():
        run(["node", "--check", str(ecosystem)], candidate, env, log)
    public_index = candidate / "public" / "index.html"
    admin_index = candidate / "admin" / "index.html"
    if not public_index.exists() or public_index.stat().st_size < 256:
        raise RuntimeError("Candidate public portal is missing or incomplete public/index.html.")
    if not admin_index.exists() or admin_index.stat().st_size < 256:
        raise RuntimeError("Candidate admin portal is missing or incomplete admin/index.html.")
    prepare_candidate_runtime_data(root, candidate, log)
    smoke_candidate(candidate, env, log)


def download_candidate(root: Path, owner: str, repo: str, branch: str, token: str, uid: int, gid: int, requested_revision: str = "") -> tuple[Path, str, Path]:
    target = requested_revision if re.fullmatch(r"[0-9a-f]{40}", requested_revision) else branch
    with urllib.request.urlopen(request(f"https://api.github.com/repos/{owner}/{repo}/commits/{target}", token), timeout=30) as response:
        revision = json.load(response)["sha"]
    if not isinstance(revision, str) or not re.fullmatch(r"[0-9a-f]{40}", revision):
        raise RuntimeError("GitHub did not return a valid commit SHA.")
    staging = root / "data" / f".deploy-staging-{revision[:12]}-{os.getpid()}"
    shutil.rmtree(staging, ignore_errors=True)
    staging.mkdir(parents=True)
    archive = staging / "repo.tgz"
    with urllib.request.urlopen(request(f"https://api.github.com/repos/{owner}/{repo}/tarball/{revision}", token), timeout=90) as response, archive.open("wb") as output:
        shutil.copyfileobj(response, output)
    source = staging / "source"
    source.mkdir()
    with tarfile.open(archive, "r:gz") as package:
        package.extractall(source, filter="data")
    roots = [item for item in source.iterdir() if item.is_dir()]
    if len(roots) != 1 or not (roots[0] / "vm").is_dir():
        raise RuntimeError("Downloaded repository does not contain a root vm directory.")
    chown_tree(staging, uid, gid)
    return roots[0] / "vm", revision, staging


def rollback_dir(root: Path) -> Path:
    return root / "data" / "deploy-rollback"


def switch_release(root: Path, candidate: Path, uid: int, gid: int) -> None:
    rollback = rollback_dir(root)
    shutil.rmtree(rollback, ignore_errors=True)
    rollback.mkdir(parents=True)
    moved_live: list[str] = []
    moved_new: list[str] = []
    try:
        for name in MANAGED:
            live, old, new = root / name, rollback / name, candidate / name
            if live.exists() or live.is_symlink():
                os.replace(live, old)
                moved_live.append(name)
            os.replace(new, live)
            moved_new.append(name)
            chown_tree(live, uid, gid)
    except Exception:
        for name in reversed(moved_new):
            live = root / name
            if live.is_dir() and not live.is_symlink():
                shutil.rmtree(live, ignore_errors=True)
            elif live.exists() or live.is_symlink():
                live.unlink()
        for name in reversed(moved_live):
            old = rollback / name
            if old.exists() or old.is_symlink():
                os.replace(old, root / name)
        raise


def snapshot_runtime_data(root: Path, uid: int, gid: int) -> None:
    rollback_data = rollback_dir(root) / "runtime-data"
    shutil.rmtree(rollback_data, ignore_errors=True)
    rollback_data.mkdir(parents=True, exist_ok=True)
    live = root / "data" / DATABASE_FILE
    if _backup_sqlite(live, rollback_data / DATABASE_FILE):
        os.chown(rollback_data / DATABASE_FILE, uid, gid)
    else:
        (rollback_data / ".database-absent").write_text("1\n", encoding="utf-8")
        os.chown(rollback_data / ".database-absent", uid, gid)
    os.chown(rollback_data, uid, gid)


def restore_runtime_data(root: Path, uid: int, gid: int) -> None:
    rollback_data = rollback_dir(root) / "runtime-data"
    snapshot = rollback_data / DATABASE_FILE
    absent = rollback_data / ".database-absent"
    live = root / "data" / DATABASE_FILE
    live.parent.mkdir(parents=True, exist_ok=True)
    for suffix in ("-wal", "-shm"):
        Path(str(live) + suffix).unlink(missing_ok=True)
    if absent.exists():
        live.unlink(missing_ok=True)
        return
    if not snapshot.exists():
        return
    temporary = live.with_name(f".{live.name}.rollback.{os.getpid()}")
    temporary.unlink(missing_ok=True)
    if not _backup_sqlite(snapshot, temporary):
        raise RuntimeError("Rollback database snapshot is missing.")
    os.chown(temporary, uid, gid)
    os.replace(temporary, live)
    os.chown(live, uid, gid)


def restore_previous(root: Path, uid: int, gid: int) -> None:
    rollback = rollback_dir(root)
    if not rollback.exists():
        raise RuntimeError("Rollback release is missing.")
    for name in MANAGED:
        live, old = root / name, rollback / name
        if live.is_dir() and not live.is_symlink():
            shutil.rmtree(live, ignore_errors=True)
        elif live.exists() or live.is_symlink():
            live.unlink()
        if old.exists() or old.is_symlink():
            os.replace(old, live)
            chown_tree(live, uid, gid)


def stop_pm2(root: Path, username: str, env: dict[str, str], log) -> None:
    run(["sudo", "-u", username, "pm2", "stop", PM2_NAME], root, env, log, check=False)


def restart_pm2(root: Path, username: str, env: dict[str, str], log) -> None:
    run(["sudo", "-u", username, "pm2", "startOrReload", str(root / "deploy" / "ecosystem.config.cjs"), "--update-env"], root, env, log)
    run(["sudo", "-u", username, "pm2", "save"], root, env, log)


def health_ok(root: Path) -> bool:
    stable = 0
    for _ in range(60):
        public_index = root / "public" / "index.html"
        admin_index = root / "admin" / "index.html"
        static_ok = (
            public_index.exists()
            and public_index.stat().st_size >= 256
            and admin_index.exists()
            and admin_index.stat().st_size >= 256
        )
        good = static_ok and _runtime_probes_ok("http://127.0.0.1:3010")
        stable = stable + 1 if good else 0
        if stable >= 3:
            return True
        time.sleep(1)
    return False


def install_next_helper(root: Path) -> None:
    source = root / "deploy" / "deploy_from_github.py"
    if not source.exists():
        return
    INSTALLED_HELPER.parent.mkdir(parents=True, exist_ok=True)
    temp = INSTALLED_HELPER.with_name(f".{INSTALLED_HELPER.name}.{os.getpid()}.tmp")
    shutil.copy2(source, temp)
    os.chmod(temp, 0o755)
    os.replace(temp, INSTALLED_HELPER)


def requested_sha(path: Path) -> str:
    try:
        value = path.read_text(encoding="utf-8").strip().lower()
        return value if re.fullmatch(r"[0-9a-f]{40}", value) else ""
    except Exception:
        return ""


def schedule_follow_up(path: Path, attempted: str | None, succeeded: bool, log) -> None:
    requested = requested_sha(path)
    if not requested:
        return
    if attempted and requested == attempted:
        if succeeded:
            path.unlink(missing_ok=True)
        return
    log.write(f"Newer requested commit {requested[:12]} remains queued; scheduling follow-up deployment.\n")
    log.flush()
    subprocess.Popen([FOLLOW_UP_COMMAND, "full"], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, start_new_session=True, env={**os.environ, "DEPLOY_REQUESTED_SHA": requested, "DEPLOY_SOURCE": "github-push-followup"})


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app-root", type=Path, required=True)
    parser.add_argument("--run-as", required=True)
    parser.add_argument("--action", choices=("full", "restart"), default="full")
    args = parser.parse_args()

    root = args.app_root.resolve()
    account = pwd.getpwnam(args.run_as)
    uid, gid = account.pw_uid, account.pw_gid
    app_env = envfile(root / ".env")
    process_env = os.environ.copy()
    process_env["SUDO_USER"] = args.run_as
    log_path = root / "logs" / "admin-deploy.log"
    status_path = root / "data" / "deploy-status.json"
    lock_path = root / "data" / "deploy.lock"
    requested_path = root / "data" / "deploy-requested-sha"
    started = now()
    source = os.environ.get("DEPLOY_SOURCE", "manual")
    revision: str | None = None
    trigger_revision = os.environ.get("DEPLOY_REQUESTED_SHA", "").strip().lower()
    if not re.fullmatch(r"[0-9a-f]{40}", trigger_revision):
        trigger_revision = ""
    if source == "manual":
        requested_path.unlink(missing_ok=True)
        trigger_revision = ""
    staging: Path | None = None
    switched = False
    status: dict[str, object] = {
        "state": "running", "action": args.action, "stage": "starting",
        "message": "Starting guarded deployment.", "startedAt": started,
        "updatedAt": started, "steps": [], "source": source,
    }

    def stage(name: str, message: str) -> None:
        status.update({"state": "running", "stage": name, "message": message, "updatedAt": now()})
        steps = status.setdefault("steps", [])
        assert isinstance(steps, list)
        steps.append({"id": name, "state": "running", "message": message})
        write_json(status_path, status, uid, gid)

    try:
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
        os.close(fd)
        os.chown(lock_path, uid, gid)
    except FileExistsError:
        status.update({"state": "running", "stage": "queued", "message": "Another deployment is running; newest push remains queued.", "updatedAt": now()})
        write_json(status_path, status, uid, gid)
        return 2

    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        log_path.touch(exist_ok=True)
        os.chown(log_path, uid, gid)
        with log_path.open("a", encoding="utf-8") as log:
            log.write(f"\n===== Guarded {args.action} deployment {started} =====\n")
            log.flush()
            if args.action == "full":
                stage("download", "Downloading candidate release from GitHub.")
                owner, repo = repo_parts(app_env.get("DEPLOY_GITHUB_REPO", ""))
                target_branch = app_env.get("DEPLOY_GITHUB_BRANCH", "main").strip() or "main"
                token = app_env.get("DEPLOY_GITHUB_TOKEN", "").strip()
                candidate, revision, staging = download_candidate(root, owner, repo, target_branch, token, uid, gid, trigger_revision)
                stage("validate", f"Validating candidate {revision[:12]} before changing live files.")
                validate_candidate(root, candidate, process_env, log)
                stage("switch", "Candidate passed validation; switching prepared release into place.")
                switch_release(root, candidate, uid, gid)
                switched = True
                snapshot_runtime_data(root, uid, gid)
                for static in (root / "public", root / "admin"):
                    subprocess.run(["chmod", "-R", "a+rX", str(static)], check=True)

            stage("activate", "Restarting Games Portal administration service and requiring stable health.")
            restart_pm2(root, args.run_as, process_env, log)
            if not health_ok(root):
                if switched:
                    stage("rollback", "Candidate failed health checks; restoring previous release and runtime data.")
                    stop_pm2(root, args.run_as, process_env, log)
                    restore_previous(root, uid, gid)
                    restore_runtime_data(root, uid, gid)
                    restart_pm2(root, args.run_as, process_env, log)
                    if health_ok(root):
                        raise RuntimeError("Candidate failed health checks and was rolled back; previous release is healthy.")
                    raise RuntimeError("Candidate failed health checks and rollback did not restore a healthy server.")
                raise RuntimeError("Restarted portal did not pass health checks.")

            if args.action == "full":
                assert revision is not None
                stage("finalize", "Health checks passed; finalizing deployed revision.")
                write_json(root / "data" / "deployed-version.json", {"revision": revision, "deployedAt": now(), "repository": app_env.get("DEPLOY_GITHUB_REPO", ""), "branch": app_env.get("DEPLOY_GITHUB_BRANCH", "main")}, uid, gid)
                install_next_helper(root)

            status.update({"state": "succeeded", "stage": "complete", "message": "Guarded deployment completed successfully.", "finishedAt": now(), "updatedAt": now(), "revision": revision})
            write_json(status_path, status, uid, gid)
            return 0
    except Exception as error:
        if switched and "rolled back" not in str(error).lower():
            try:
                with log_path.open("a", encoding="utf-8") as log:
                    stop_pm2(root, args.run_as, process_env, log)
                    restore_previous(root, uid, gid)
                    restore_runtime_data(root, uid, gid)
                    restart_pm2(root, args.run_as, process_env, log)
                if health_ok(root):
                    error = RuntimeError(f"{error} Previous release was restored and is healthy.")
                else:
                    error = RuntimeError(f"{error} Rollback was attempted but health did not recover.")
            except Exception as rollback_error:
                error = RuntimeError(f"{error} Rollback failed: {rollback_error}")
        status.update({"state": "failed", "stage": "failed", "message": str(error), "finishedAt": now(), "updatedAt": now(), "failedRevision": revision})
        steps = status.setdefault("steps", [])
        assert isinstance(steps, list)
        steps.append({"id": "failed", "state": "failed", "message": str(error)})
        write_json(status_path, status, uid, gid)
        return 1
    finally:
        if staging is not None:
            shutil.rmtree(staging, ignore_errors=True)
        try:
            lock_path.unlink()
        except FileNotFoundError:
            pass
        try:
            with log_path.open("a", encoding="utf-8") as log:
                schedule_follow_up(requested_path, revision or trigger_revision or None, status.get("state") == "succeeded", log)
        except Exception:
            pass


if __name__ == "__main__":
    raise SystemExit(main())
