#!/usr/bin/env python3
"""批量预热转码：把曲库中所有 >30MB 的本地歌曲通过 ?prefetch=1&format=mp3 转成 mp3 缓存。

原理：服务端 /api/v1/songs/{id}/play?prefetch=1 异步触发转码（202 立即返回，ffmpeg 后台跑，
     结果落盘到 music_cache/{id}.tc.mp3）。已缓存的歌 prefetch 直接命中、不重复转（幂等）。
     脚本先并发触发全部（快），再轮询容器内缓存文件出现，直到全部转完（慢，156 首约 2-3 小时）。

用法：nohup python3 precache_large.py > precache_large.log 2>&1 &
      tail -f precache_large.log   # 看进度
重跑：安全（已缓存的秒过，断点续传）。

阈值与插件 LARGE_FILE_TRANSCODE_BYTES (30MB) 保持一致。
"""
import json, subprocess, sys, time, urllib.request, urllib.error, threading
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE = "http://localhost:58091"
THRESHOLD = 30 * 1024 * 1024  # 30MB，与插件 url_builder.ts 一致
THREADS = 3
POLL_INTERVAL = 60  # 秒，进度轮询间隔

# SSH 非交互 shell 的 PATH 不含 /usr/local/bin（docker 在那边），显式全路径
DOCKER = "/usr/local/bin/docker"

DB_TMP = "/tmp/precache-db.db"


def login():
    req = urllib.request.Request(
        BASE + "/api/v1/auth/login",
        data=json.dumps({"username": "admin", "password": "admin"}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.loads(r.read())["access_token"]


def get_large_song_ids():
    subprocess.run([DOCKER, "cp", "songloft:/app/data/songloft.db", DB_TMP],
                   check=True, capture_output=True)
    out = subprocess.check_output(
        ["sqlite3", DB_TMP,
         "SELECT id FROM songs WHERE type='local' AND file_size > %d ORDER BY id" % THRESHOLD],
        text=True)
    return [int(x) for x in out.split() if x.strip()]


def get_cached_ids():
    """一条命令列出全部转码缓存文件，返回已缓存的 song id 集合。
    文件名形如 {id}.{key}.tc.mp3 或 {id}.tc.mp3，从文件名前缀提取 id。"""
    out = subprocess.run(
        [DOCKER, "exec", "songloft", "sh", "-c",
         "find /app/data/music_cache -name '*.tc.mp3' 2>/dev/null"],
        capture_output=True, text=True)
    ids = set()
    for line in out.stdout.splitlines():
        name = line.split("/")[-1]
        # 前缀可能是 "1234" 或 "1234.somekey"，取数字部分
        num = name.split(".")[0]
        if num.isdigit():
            ids.add(int(num))
    return ids


def trigger(song_id, token):
    """触发单首 prefetch 转码（202 立即返回；已缓存也直接命中）"""
    url = "%s/api/v1/songs/%d/play?prefetch=1&format=mp3&access_token=%s" % (BASE, song_id, token)
    req = urllib.request.Request(url)
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return r.status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception as e:
        return "ERR:%s" % e


def main():
    log = lambda msg: print("[%s] %s" % (time.strftime("%m-%d %H:%M:%S"), msg), flush=True)

    log("step 1/3 登录…")
    token = login()
    log("step 1/3 登录成功 (token len=%d)" % len(token))

    log("step 2/3 查询 >30MB 本地歌曲…")
    song_ids = get_large_song_ids()
    log("step 2/3 共 %d 首大文件待转码: %s" % (len(song_ids), song_ids[:20]))

    cached_ids = get_cached_ids()
    already = [s for s in song_ids if s in cached_ids]
    todo = [s for s in song_ids if s not in cached_ids]
    log("已缓存 %d 首（跳过），待转 %d 首" % (len(already), len(todo)))

    # 并发触发全部（prefetch 立即返回，ffmpeg 在服务端后台排队转）
    done = list(already)
    fail = []
    with ThreadPoolExecutor(max_workers=THREADS) as ex:
        futs = {ex.submit(trigger, s, token): s for s in todo}
        for f in as_completed(futs):
            s = futs[f]
            try:
                code = f.result()
                if code in (200, 202):
                    done.append(s)
                else:
                    fail.append((s, code))
                    log("触发失败 song=%d http=%s" % (s, code))
            except Exception as e:
                fail.append((s, str(e)))
                log("触发异常 song=%d %s" % (s, e))

    log("step 3/3 触发完毕：%d 首已转/触发，%d 首失败；开始轮询等待 ffmpeg 转码落盘…" % (len(done), len(fail)))

    # 轮询进度：等待全部缓存文件出现
    t0 = time.time()
    remaining = set(todo)
    last_report = 0
    while remaining:
        time.sleep(POLL_INTERVAL)
        cached_ids = get_cached_ids()
        still = [s for s in remaining if s not in cached_ids]
        finished_now = len(remaining) - len(still)
        remaining = set(still)
        elapsed = (time.time() - t0) / 60
        log("进度：已转 %d/%d 首（%.1f%%），剩余 %d 首，已运行 %.0f 分钟"
            % (len(done) + len(already), len(song_ids),
               100 * (len(done) + len(already)) / len(song_ids), len(remaining), elapsed))
        if not remaining:
            break
        # 超过 5 分钟无进展，提示可能 ffmpeg 卡住
        if finished_now == 0:
            if last_report and time.time() - last_report > 300:
                log("⚠️ 连续 5 分钟无新缓存产出，请检查 ffmpeg 是否卡住（docker exec songloft ps aux | grep ffmpeg）")
                last_report = time.time()
        else:
            last_report = time.time()

    log("✅ 全部 %d 首大文件转码完成，用时 %.0f 分钟" % (len(song_ids), (time.time() - t0) / 60))
    if fail:
        log("⚠️ %d 首触发失败：%s" % (len(fail), fail))
    sys.exit(0)


if __name__ == "__main__":
    main()
