"""Agent-owned entry wrapper around the unchanged THETA script.

Guards the engine's urllib embedding transport; not an OS security sandbox.
All approved HTTP attempts count against one persisted per-job budget, including failures.
"""
import json
import hashlib
import os
from pathlib import Path
import runpy
import sqlite3
from contextlib import closing
import sys
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise PermissionError('外部请求禁止重定向到未经批准的地址')


def guarded_urlopen(original, database: str, job_id: str):
    def open_request(request, *args, **kwargs):
        with closing(sqlite3.connect(database, timeout=10)) as db, db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT request,state,cancel FROM jobs WHERE id=?', (job_id,)).fetchone()
            if not row or row[1] != 'running' or row[2]:
                raise PermissionError('任务未运行或已请求取消，禁止新的外部调用')
            payload = json.loads(row[0])
            policy = payload['execution']
            embedding = policy['embedding']
            if embedding['mode'] != 'cloud' or not isinstance(request, urllib.request.Request) or request.full_url != embedding['endpoint'] or request.get_method() != 'POST':
                raise PermissionError('此计算任务没有批准该外部请求')
            body = json.loads(request.data or b'{}')
            if body.get('model') != embedding['model'] or body.get('dimensions') != embedding.get('dimensions'):
                raise PermissionError('Embedding 模型或维度与批准内容不一致')
            credential = (request.get_header('Authorization') or '').removeprefix('Bearer ')
            if hashlib.sha256(credential.encode()).hexdigest() != embedding['credentialFingerprint']:
                raise PermissionError('Embedding 凭据与批准内容不一致')
            db.execute('CREATE TABLE IF NOT EXISTS external_usage (job_id TEXT PRIMARY KEY, calls INTEGER NOT NULL)')
            db.execute('INSERT OR IGNORE INTO external_usage VALUES (?,0)', (job_id,))
            used = db.execute('SELECT calls FROM external_usage WHERE job_id=?', (job_id,)).fetchone()[0]
            if used >= policy['maxExternalRequests']:
                raise PermissionError('本次外部调用额度已用完，请重新确认新的操作范围')
            db.execute('UPDATE external_usage SET calls=calls+1 WHERE job_id=?', (job_id,))
        return original(request, *args, **kwargs)
    def guarded(request, *args, **kwargs):
        try:
            return open_request(request, *args, **kwargs)
        except PermissionError as exc:
            with closing(sqlite3.connect(database, timeout=10)) as db, db:
                db.execute('CREATE TABLE IF NOT EXISTS external_denials (job_id TEXT PRIMARY KEY, reason TEXT NOT NULL)')
                db.execute('INSERT OR REPLACE INTO external_denials VALUES (?,?)', (job_id, str(exc)[:500]))
            raise
    return guarded


if __name__ == '__main__':
    database, job_id = os.environ['THETA_COMPUTE_DATABASE'], os.environ['THETA_COMPUTE_JOB_ID']
    opener = urllib.request.build_opener(NoRedirect)
    urllib.request.urlopen = guarded_urlopen(opener.open, database, job_id)
    script = Path(sys.argv[1]).resolve()
    root = Path(os.environ['THETA_PROJECT_ROOT']).resolve() / 'src/models'
    script.relative_to(root)
    # Each entry (including THETA's child main.py) uses the same approved immutable plan.
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    sys.path.insert(0, str(root.parent.parent / 'trainning'))
    with closing(sqlite3.connect(database)) as db:
        row = db.execute('SELECT request FROM jobs WHERE id=?', (job_id,)).fetchone()
        plan = json.loads(row[0]).get('plan')
    if plan and script.name in {'prepare_data.py', 'run_pipeline.py', 'main.py'}:
        from workers.api_overrides import install
        sys.path.insert(0, str(root))
        install(plan, script, root.parent.parent)
    sys.argv = sys.argv[1:]
    sys.path.insert(0, str(root))
    runpy.run_path(str(script), run_name='__main__')
