#!/usr/bin/env python3
"""按下游的读法把 hub ops export 的导出文件加载一遍（只读）。

下游是 vcat-backfill/backfill.py（读 posts）和 kinso-dashboard/refresh.py（读 posts、accounts）。
不 import、不运行它们：它们会写知识库和看板。这里照它们读的字段和写法检查，字段说明见 spikes/results/06-works.md。

用法：python3 scripts/ops-export-check.py --posts <文件> --accounts <文件>（至少给一个）
退出码：0 通过；1 不通过（逐条列出）；2 参数不对。
"""
import argparse
import json
import re
import sys
from datetime import datetime

POST_PLATFORMS = {'Bili', 'Douyin', 'XiaoHongShu', 'Channels'}   # refresh.py 的 POST_PLATFORM
METRICS = ['view', 'like', 'comment', 'favorite', 'forward', 'fansAdd']
OPTIONAL_NUMBERS = ['fullView', 'viewTime']
# refresh.py 的 ACCOUNTS 登记的 uid（公众号归 S4，不在这份导出里）；视频号是 finderUser.uniqId，sph 开头
FIXED_UIDS = {'478358005', '106707338905', '5944af205e87e701889da649'}
DATE = re.compile(r'^\d{4}-\d{2}-\d{2}$')


def is_num(v):
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def parse_time(v):
    if not isinstance(v, str) or not v:
        return False
    try:
        datetime.fromisoformat(v)
        return True
    except ValueError:
        return False


def load(path, problems):
    try:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        problems.append(f'{path}：读不了（{e}）')
        return None
    if not isinstance(data, list):
        problems.append(f'{path}：顶层要是数组，实际 {type(data).__name__}')
        return None
    return data


def check_posts(path):
    problems = []
    data = load(path, problems)
    seen = set()
    for i, p in enumerate(data or []):
        label = f'posts 第 {i + 1} 条'
        if not isinstance(p, dict):
            problems.append(f'{label}：不是对象')
            continue
        label += f'（{p.get("platform")} {p.get("postId")}）'
        if p.get('platform') not in POST_PLATFORMS:
            problems.append(f'{label} platform：不在 {sorted(POST_PLATFORMS)}')
        if not isinstance(p.get('postId'), str) or not p.get('postId'):
            problems.append(f'{label} postId：要是非空字符串')
        if not parse_time(p.get('postTime')):
            problems.append(f'{label} postTime：datetime.fromisoformat 解析不了：{p.get("postTime")!r}')
        if not isinstance(p.get('statusText'), str):
            problems.append(f'{label} statusText：要有、要是字符串')
        for k in METRICS:
            if p.get(k) is not None and not is_num(p[k]):
                problems.append(f'{label} {k}：要是数字、-1 或 null，实际 {p[k]!r}')
        for k in OPTIONAL_NUMBERS:
            if p.get(k) is not None and not is_num(p[k]):
                problems.append(f'{label} {k}：要是数字或 null，实际 {p[k]!r}')
        key = (p.get('platform'), p.get('postId'))
        if key in seen:
            problems.append(f'{label} postId：同一平台重复')
        seen.add(key)
    return problems, len(data or [])


def check_accounts(path):
    problems = []
    data = load(path, problems)
    for i, a in enumerate(data or []):
        label = f'accounts 第 {i + 1} 条'
        if not isinstance(a, dict):
            problems.append(f'{label}：不是对象')
            continue
        uid = a.get('uid')
        label += f'（{uid}）'
        if not (uid in FIXED_UIDS or (isinstance(uid, str) and uid.startswith('sph'))):
            problems.append(f'{label} uid：不是 refresh.py 给这四个平台登记的 uid（B站、抖音、小红书、sph 开头的视频号），会被丢掉或混进别的账号')
        if a.get('loginStatus') != '登录有效':
            problems.append(f'{label} loginStatus：要是「登录有效」，实际 {a.get("loginStatus")!r}')
        if not is_num(a.get('fans')):
            problems.append(f'{label} fans：要是数字，实际 {a.get("fans")!r}')
        if not parse_time(a.get('updateTime')):
            problems.append(f'{label} updateTime：解析不了：{a.get("updateTime")!r}')
        daily = a.get('daily')
        if not isinstance(daily, list):
            problems.append(f'{label} daily：要是数组')
            continue
        for j, d in enumerate(daily):
            if not isinstance(d, dict) or not isinstance(d.get('date'), str) or not DATE.match(d['date']):
                problems.append(f'{label} daily[{j}].date：要是 YYYY-MM-DD')
                continue
            for k in ('fansTotal', 'fansNet'):
                if d.get(k) is not None and not is_num(d[k]):
                    problems.append(f'{label} daily[{j}].{k}：要是数字或 null，实际 {d[k]!r}')
    return problems, len(data or [])


def main():
    ap = argparse.ArgumentParser(description='按下游读法检查 hub ops export 的导出文件（只读）')
    ap.add_argument('--posts')
    ap.add_argument('--accounts')
    args = ap.parse_args()
    if not args.posts and not args.accounts:
        ap.error('至少给 --posts 或 --accounts 之一')
    problems = []
    for path, check in ((args.posts, check_posts), (args.accounts, check_accounts)):
        if path:
            p, n = check(path)
            problems += p
            print(f'{path}：{n} 条，{"通过" if not p else f"{len(p)} 处不合格"}')
    for p in problems:
        print(f'  {p}')
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
